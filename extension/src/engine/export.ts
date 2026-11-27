import { zipSync, type Zippable } from 'fflate';
import type { BlobRef } from '@/protocol/BlobRef';
import type { Capture } from '@/protocol/Capture';
import type { Evidence } from '@/protocol/Evidence';
import type { Exported } from '@/protocol/Exported';
import type { Review } from '@/protocol/Review';
import type { ReviewItem } from '@/protocol/ReviewItem';
import type { ReviewRequest } from '@/protocol/ReviewRequest';
import type { ReviewVoice } from '@/protocol/ReviewVoice';
import type { Shot } from '@/protocol/Shot';
import {
  getBlob,
  getBlobJson,
  getObservation,
  getStoredReview,
  listCaptures,
  listVoiceNotes,
  putBlob,
  saveReview,
} from './db';
import { digestRecording, pointingFromRecording, trimRecording, type RrEvent } from './digest';
import { badRequest, conflict } from './errors';
import { bytesToBase64, insideKept, isEditsDefault, isHidingShape, keptRanges, slugify } from './helpers';
import { maskWebpShot, renderAnnotatedPng } from './render';
import {
  buildHar,
  buildLensCapture,
  buildPlaywrightSpec,
  buildTimeline,
  evidenceForReview,
  filesEndScreenshot,
  findingsFromEvidence,
  markTargets,
  shareShots,
  spokenInKept,
} from './repro';

const MAX_ATTACHMENTS = 64;

function getExtensionVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return '0.13.0';
  }
}

/** Freezes an observation into an immutable Review (matching Rust `daemon/review.rs`). */
export async function createReview(req: ReviewRequest): Promise<Review> {
  if (!req.screenshotsChecked) {
    throw badRequest('Confirm screenshots before creating a review.');
  }
  const uniqueIds = [...new Set(req.captures)];
  if (uniqueIds.length === 0 || uniqueIds.length > 50) {
    throw badRequest('A review must include between 1 and 50 captures.');
  }

  const obs = await getObservation(req.observation);
  if (obs.revision !== req.revision) {
    throw conflict(`Observation ${obs.id} changed (expected revision ${req.revision}, found ${obs.revision})`);
  }

  const allCaptures = await listCaptures(obs.id);
  const byId = new Map<number, Capture>(allCaptures.map((c) => [c.id, c]));
  const selectedCaptures = uniqueIds.map((id) => {
    const found = byId.get(id);
    if (!found) throw badRequest(`Capture ${id} does not belong to observation ${obs.id}`);
    return found;
  });

  const requestedRecordings = new Set(req.recordings);
  const voiceNotes = await listVoiceNotes(obs.id);

  const items: ReviewItem[] = [];
  const allKeptForVoice: Array<{ from: number; to: number }> = [];

  for (const capture of selectedCaptures) {
    const origPng = await getBlob(capture.screenshot.sha256);
    if (!origPng) throw badRequest(`Missing screenshot blob for capture ${capture.id}`);

    const rendered = await renderAnnotatedPng(origPng.bytes, capture.annotations);
    const screenshotRef =
      capture.annotations.length > 0 ? await putBlob(rendered.bytes, 'image/png') : capture.screenshot;

    const rawEvidence = await getBlobJson<Evidence>(capture.evidence);
    const viewportW = Number((rawEvidence.page as { viewport?: { width?: number } } | null)?.viewport?.width ?? 0);
    const scale = viewportW > 0 ? rendered.width / viewportW : 1;
    const marks = markTargets(capture.annotations, rawEvidence.elements, scale);

    const hasEdits = !isEditsDefault(capture.edits);
    const kept = hasEdits ? keptRanges(capture.edits, capture.startedAt, capture.createdAt) : [];
    if (hasEdits && kept.length === 0) {
      throw badRequest(`Edits on capture ${capture.id} leave nothing to share.`);
    }
    if (capture.kind === 'session' && capture.recording) {
      if (kept.length > 0) allKeptForVoice.push(...kept);
      else allKeptForVoice.push({ from: capture.startedAt, to: capture.createdAt });
    }

    const masked = capture.annotations.some(isHidingShape);
    const includeRecording = !masked && capture.recording !== null && requestedRecordings.has(capture.id);
    const stripVideo = masked || !requestedRecordings.has(capture.id);

    const filteredAnnotations = capture.edits.annotations.filter((a) => insideKept(kept, a.at));

    let screen: ReviewItem['screen'] = [];
    let pointing: ReviewItem['pointing'] = [];
    let recordingRef: BlobRef | null = null;

    if (includeRecording && capture.recording) {
      const rrEvents = await getBlobJson<RrEvent[]>(capture.recording);
      screen = digestRecording(rrEvents, kept);
      pointing = pointingFromRecording(rrEvents, kept);
      if (kept.length > 0) {
        const trimmed = trimRecording(rrEvents, kept);
        recordingRef = await putBlob(new TextEncoder().encode(JSON.stringify(trimmed)), 'application/json');
      } else {
        recordingRef = capture.recording;
      }
    }

    const { evidence: sharedEvidence, cut } = evidenceForReview(rawEvidence, req.typedValues, kept, stripVideo);
    const sharedEvidenceRef = await putBlob(
      new TextEncoder().encode(JSON.stringify(sharedEvidence)),
      'application/json',
    );
    const findings = findingsFromEvidence(sharedEvidence);

    // Filter and burn shot masks
    const hiddenSet = new Set(capture.edits.hiddenShots);
    const maskMap = new Map<number, typeof capture.edits.shotMasks[number]['areas']>();
    for (const sm of capture.edits.shotMasks) maskMap.set(sm.at, sm.areas);

    const shots: Shot[] = [];
    if (req.typedValues && capture.kind === 'session' && capture.recording) {
      for (const shot of capture.shots) {
        if (hiddenSet.has(shot.at) || !insideKept(kept, shot.at)) continue;
        const masks = maskMap.get(shot.at);
        if (masks && masks.length > 0) {
          const origShot = await getBlob(shot.image.sha256);
          if (origShot) {
            const burned = await maskWebpShot(origShot.bytes, masks);
            const maskedRef = await putBlob(burned, 'image/webp');
            shots.push({ ...shot, image: maskedRef });
            continue;
          }
        }
        shots.push(shot);
      }
    }

    items.push({
      capture: capture.id,
      pageUrl: capture.pageUrl,
      pageTitle: capture.pageTitle,
      mode: capture.mode,
      screenshot: screenshotRef,
      evidence: sharedEvidenceRef,
      recording: recordingRef,
      findings,
      marks,
      kind: capture.kind,
      kept,
      annotations: filteredAnnotations,
      screen,
      pointing,
      shots,
      cut,
      shotsDropped: 0,
      capturedAt: capture.createdAt,
      startedAt: capture.startedAt,
    });
  }

  // Fit total VibeQ attachment budget (<= 64)
  const baseFiles = items.reduce(
    (sum, it) => sum + 1 + (filesEndScreenshot(it) ? 1 : 0) + (it.recording ? 1 : 0),
    0,
  );
  if (baseFiles > MAX_ATTACHMENTS) {
    throw badRequest(`Too many captures in one review (${baseFiles} base files > ${MAX_ATTACHMENTS}).`);
  }
  shareShots(items, MAX_ATTACHMENTS - baseFiles);

  // Freeze done voice notes clipped to kept session ranges
  const doneVoices = voiceNotes.filter((v) => v.state === 'done');
  const voice: ReviewVoice[] = doneVoices
    .map((v) => ({
      startedAt: v.startedAt,
      durationMs: v.durationMs,
      language: v.language,
      segments: v.segments.filter((seg) =>
        spokenInKept(allKeptForVoice, v.startedAt + seg.startMs, v.startedAt + seg.endMs),
      ),
    }))
    .filter((v) => v.segments.length > 0);

  const mp4Voice = doneVoices.map((v) => ({
    startedAt: v.startedAt,
    durationMs: v.durationMs,
    audio: v.audio,
  }));

  return saveReview(
    {
      observation: obs.id,
      revision: obs.revision,
      createdAt: Date.now(),
      title: obs.title,
      notes: obs.notes,
      tags: [...obs.tags],
      items,
      voice,
      mp4Voice,
    },
    req.revision,
  );
}

function fmtVoiceClock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function escapeMdHeading(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[#`]/g, '').trim();
}

export interface ReviewBundle {
  reportMarkdown: string;
  files: Map<string, { bytes: Uint8Array<ArrayBuffer>; contentType: string }>;
}

const textEncoder = new TextEncoder();

/** Materializes every export/filing/MCP file for a frozen Review. */
export async function buildReviewBundle(review: Review): Promise<ReviewBundle> {
  const files = new Map<string, { bytes: Uint8Array<ArrayBuffer>; contentType: string }>();
  const addText = (name: string, text: string, contentType: string) => {
    const u8 = textEncoder.encode(text) as Uint8Array<ArrayBuffer>;
    files.set(name, { bytes: u8, contentType });
  };

  const md: string[] = [`# ${escapeMdHeading(review.title)}`];
  if (review.notes.trim()) md.push('', review.notes.trim());

  if (review.voice.length > 0) {
    md.push('', '## What the person said');
    review.voice.forEach((v, idx) => {
      const voiceText = v.segments.map((s) => `[${fmtVoiceClock(s.startMs)}] ${s.text.trim()}`).join('\n');
      addText(`voice-${idx + 1}.txt`, voiceText, 'text/plain; charset=utf-8');
      md.push('', '```text', voiceText, '```');
    });
  }

  for (let i = 0; i < review.items.length; i += 1) {
    const n = i + 1;
    const item = review.items[i]!;
    const evidence = await getBlobJson<Evidence>(item.evidence);
    const timeline = buildTimeline(evidence, {
      kept: item.kept,
      voice: review.voice,
      screen: item.screen,
      pointing: item.pointing,
      annotations: item.annotations,
    });
    const har = buildHar(evidence);
    const hasHar = har.log.entries.length > 0;
    const spec = buildPlaywrightSpec(evidence, n, review.title, item.pageUrl, { hasHar });
    const lensCapture = await buildLensCapture(review, item, evidence, getExtensionVersion(), n);

    addText(`capture-${n}-evidence.json`, JSON.stringify(evidence, null, 2), 'application/json');
    addText(`capture-${n}.lens.json`, lensCapture, 'application/vnd.sirv.lens-capture+json');
    addText(`capture-${n}-timeline.txt`, timeline, 'text/plain; charset=utf-8');
    addText(`capture-${n}.spec.ts`, spec, 'text/typescript; charset=utf-8');
    if (hasHar) addText(`capture-${n}.har`, JSON.stringify(har, null, 2), 'application/json');

    // Fetch binary attachments in parallel instead of serially awaiting IndexedDB.
    let videoSha: string | null = null;
    for (const ev of evidence.events) {
      if (ev.kind === 'video' && ev.data && typeof ev.data === 'object') {
        const d = ev.data as Record<string, unknown>;
        const blob = (d.blob ?? d.video ?? d) as Record<string, unknown>;
        if (typeof blob.sha256 === 'string') {
          videoSha = blob.sha256;
          break;
        }
      }
    }

    const [png, rec, webm, shotBlobs] = await Promise.all([
      filesEndScreenshot(item) ? getBlob(item.screenshot.sha256) : Promise.resolve(null),
      item.recording ? getBlob(item.recording.sha256) : Promise.resolve(null),
      videoSha ? getBlob(videoSha) : Promise.resolve(null),
      Promise.all(item.shots.map((s) => getBlob(s.image.sha256))),
    ]);

    if (png) files.set(`capture-${n}.png`, { bytes: png.bytes, contentType: 'image/png' });
    if (rec) files.set(`capture-${n}.rrweb.json`, { bytes: rec.bytes, contentType: 'application/vnd.rrweb+json' });
    shotBlobs.forEach((shot, k) => {
      if (shot) files.set(`capture-${n}-shot-${k + 1}.webp`, { bytes: shot.bytes, contentType: 'image/webp' });
    });
    const hasVideo = Boolean(webm);
    if (webm) files.set(`capture-${n}.webm`, { bytes: webm.bytes, contentType: 'video/webm' });

    md.push('', `## ${item.kind === 'session' ? 'Recording' : 'Capture'} ${n}`);
    if (item.pageUrl) md.push(`Page: ${item.pageTitle ? `${item.pageTitle} (${item.pageUrl})` : item.pageUrl}`);
    if (filesEndScreenshot(item)) md.push('', `![Capture ${n}](capture-${n}.png)`);
    if (hasVideo) md.push('', `[Tab video](capture-${n}.webm)`);
    if (item.annotations.length > 0) {
      md.push('', 'Notes on the recording:');
      for (const ann of item.annotations) {
        if (ann.text?.trim()) md.push(`- ${ann.text.trim()}`);
      }
    }
    if (item.findings.length > 0) {
      md.push('', 'What the browser recorded:');
      for (const f of item.findings) md.push(`- ${f}`);
    }
    if (timeline) {
      md.push('', '### Timeline', '', '```text', timeline, '```');
    }
  }

  const reportMarkdown = `${md.join('\n')}\n`;
  addText('report.md', reportMarkdown, 'text/markdown; charset=utf-8');
  addText('review.json', JSON.stringify(review, null, 2), 'application/json');

  return { reportMarkdown, files };
}

const ALREADY_COMPRESSED_EXT = /\.(png|webp|webm|mp4|jpe?g|gif|woff2?)$/i;

/** Creates the evidence ZIP bytes (`lens-review-<id>-evidence.zip`) in pure JS via fflate. */
export async function buildEvidenceZip(reviewId: number): Promise<{ filename: string; bytes: Uint8Array<ArrayBuffer> }> {
  const stored = await getStoredReview(reviewId);
  const { mp4Voice: _m, ...review } = stored;
  const bundle = await buildReviewBundle(review);
  const folder = `lens-review-${review.id}-${slugify(review.title)}`;

  const entries: Zippable = {};
  for (const [name, entry] of bundle.files) {
    // Store already-compressed binary media (PNG/WebP/WebM) at level 0 to avoid seconds of wasted JS deflate CPU.
    entries[`${folder}/${name}`] = ALREADY_COMPRESSED_EXT.test(name)
      ? [entry.bytes, { level: 0 }]
      : [entry.bytes, { level: 6 }];
  }
  const zipped = zipSync(entries) as Uint8Array<ArrayBuffer>;
  return { filename: `lens-review-${review.id}-evidence.zip`, bytes: zipped };
}

/** Triggers a browser download of a Blob (works in any extension page with zero extra permissions). */
export function triggerDownload(filename: string, bytes: Uint8Array<ArrayBuffer>, mimeType: string): string {
  if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return filename;
}

export async function exportReviewToDownloads(reviewId: number): Promise<Exported> {
  const { filename, bytes } = await buildEvidenceZip(reviewId);
  triggerDownload(filename, bytes, 'application/zip');
  return { folder: filename };
}

export async function exportAttachmentToDownloads(
  reviewId: number,
  captureId: number | null,
): Promise<string> {
  if (captureId !== null) {
    // Check if the capture has a recorded WebM tab video we can export directly!
    const stored = await getStoredReview(reviewId);
    const item = stored.items.find((it) => it.capture === captureId);
    if (item) {
      const evidence = await getBlobJson<Evidence>(item.evidence);
      for (const ev of evidence.events) {
        if (ev.kind === 'video' && ev.data && typeof ev.data === 'object') {
          const d = ev.data as Record<string, unknown>;
          const blob = (d.blob ?? d.video ?? d) as Record<string, unknown>;
          if (typeof blob.sha256 === 'string') {
            const webm = await getBlob(blob.sha256);
            if (webm) {
              const name = `lens-review-${reviewId}-capture-${captureId}.webm`;
              return triggerDownload(name, webm.bytes, 'video/webm');
            }
          }
        }
      }
    }
    throw badRequest('To export a video file, turn on Video mode when recording. Otherwise use Save evidence ZIP.');
  }
  const { filename, bytes } = await buildEvidenceZip(reviewId);
  return triggerDownload(filename, bytes, 'application/zip');
}

const attachmentCache = new Map<string, Uint8Array<ArrayBuffer>>();

/** Streams a review ZIP attachment in 512 KiB base64 chunks (for basecamp-handoff.ts). */
export async function readAttachmentChunk(
  reviewId: number,
  captureId: number | null,
  offset: number,
): Promise<{ data: string; totalSize: number }> {
  const key = `${reviewId}:${captureId ?? 'zip'}`;
  let bytes = attachmentCache.get(key);
  if (!bytes || offset === 0) {
    if (captureId !== null) {
      throw badRequest('MP4 rendering was removed in extension-only mode; attach the Evidence ZIP instead.');
    }
    const zip = await buildEvidenceZip(reviewId);
    bytes = zip.bytes;
    attachmentCache.set(key, bytes);
    // Evict cached zip after 5 minutes
    setTimeout(() => attachmentCache.delete(key), 300_000);
  }
  const CHUNK = 512 * 1024;
  const slice = bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK));
  const totalSize = bytes.length;
  if (offset + slice.length >= totalSize) attachmentCache.delete(key);
  return { data: bytesToBase64(slice), totalSize };
}

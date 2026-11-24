import { countRedactions } from '@/collector/sanitize';
import { splitNotes } from '@/findings';
import type { Action } from '@/protocol/Action';
import type { BlobRef } from '@/protocol/BlobRef';
import type { Capture } from '@/protocol/Capture';
import type { Edits } from '@/protocol/Edits';
import type { Locator } from '@/protocol/Locator';
import type { PrivacySettings } from '@/protocol/PrivacySettings';
import type { TimeRange } from '@/protocol/TimeRange';
import type { VoiceSegment } from '@/protocol/VoiceSegment';

export type EvidenceEvent = { timestamp: number; kind: string; data: Record<string, unknown> };

/** A playback position as m:ss. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Seconds as m:ss; nothing for no time. */
export const seconds = (s: number | null) => (s === null ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

export function describeTarget(l: Locator | null) {
  if (!l) return 'the page';
  if (l.testId) return `[data-testid=${l.testId}]`;
  if (l.role && l.name) return `${l.role} “${l.name}”`;
  if (l.text) return `“${l.text}”`;
  return l.css;
}

export function describeStep(a: Action, hideValues: boolean) {
  const target = describeTarget(a.target);
  const hidden = a.masked || hideValues;
  switch (a.kind) {
    case 'click':
      return `Click ${target}`;
    case 'fill':
      return hidden ? `Type a private value into ${target}` : `Type “${a.value}” into ${target}`;
    case 'press':
      return `Press ${a.value} in ${target}`;
    case 'select':
      return hidden ? `Choose a private option in ${target}` : `Choose “${a.value}” in ${target}`;
    case 'check':
      return `Check ${target}`;
    case 'uncheck':
      return `Uncheck ${target}`;
    case 'upload':
      return `Choose files (${a.value}) in ${target}`;
    case 'navigate':
      return `Go to ${a.url}`;
    default:
      return `Scroll to ${a.value}`;
  }
}

/** The site a page belongs to, for settings remembered per site. */
export function siteOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').origin;
  } catch {
    return '';
  }
}

/** Remembered hand-off folder: the site's own first, then the last used folder on any site. */
export function rememberedFolder(site: string, folders: Record<string, string>, lastFolder: string): string {
  if (site && folders[site]?.trim()) return folders[site].trim();
  if (lastFolder.trim()) return lastFolder.trim();
  const any = Object.values(folders).filter((v) => v?.trim()).at(-1);
  return any?.trim() ?? '';
}

/** The findings lines at the top of the notes, as the person reads them. */
export function findingsOf(notes: string): string[] {
  return splitNotes(notes).findings ?? [];
}

export function sameStep(a: { text: string; error: boolean }, b: { text: string; error: boolean }) {
  return a.text === b.text && a.error === b.error;
}

/** Ruler labels: about eight of them, at round steps. Offsets in milliseconds. */
export function ticks(total: number): number[] {
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].map((s) => s * 1000).find((s) => total / s <= 8) ?? 1_200_000;
  const out: number[] = [];
  for (let t = 0; t <= total; t += step) out.push(t);
  return out;
}

export function keptRanges(edits: Edits, span: { start: number; end: number }): TimeRange[] {
  const from = Math.max(edits.trimStart ?? span.start, span.start);
  const to = Math.min(edits.trimEnd ?? span.end, span.end);
  const cuts = [...edits.cuts].sort((a, b) => a.from - b.from);
  const kept: TimeRange[] = [];
  let cursor = from;
  for (const cut of cuts) {
    if (cut.to <= cursor || cut.from >= to) continue;
    if (cut.from > cursor) kept.push({ from: cursor, to: cut.from });
    cursor = Math.max(cursor, cut.to);
  }
  if (cursor < to) kept.push({ from: cursor, to });
  return kept;
}

/** Closer than this to the playhead is "here", not the next one: a jump always moves. */
const HERE_MS = 250;

/** The next (or previous) moment after the playhead, or null when there is none. */
export function jumpTarget(times: number[], now: number, direction: 1 | -1): number | null {
  const sorted = [...times].sort((a, b) => a - b);
  return direction === 1 ? (sorted.find((t) => t > now + HERE_MS) ?? null) : (sorted.findLast((t) => t < now - HERE_MS) ?? null);
}

export type Marker = { at: number; label: string };

/**
 * The person's markers: from the evidence (`marker` events) and from the recording (`lens-marker`
 * custom events). Lens writes both for one marker, so a marker of the same label within a second
 * shows once.
 */
export function markersOf(events: EvidenceEvent[], recorded: unknown[]): Marker[] {
  const found: Marker[] = [];
  const add = (at: number, label: unknown) => {
    const text = typeof label === 'string' && label.trim() ? label.trim() : 'Marker';
    if (!Number.isFinite(at) || found.some((m) => m.label === text && Math.abs(m.at - at) < 1000)) return;
    found.push({ at, label: text });
  };
  for (const e of events) if (e.kind === 'marker') add(e.timestamp, e.data?.label);
  for (const e of recorded as { type?: number; timestamp?: number; data?: { tag?: string; payload?: { label?: unknown } } }[]) {
    if (e?.type === 5 && e.data?.tag === 'lens-marker') add(Number(e.timestamp), e.data.payload?.label);
  }
  return found.sort((a, b) => a.at - b.at);
}

export type Video = { blob: BlobRef; startedAt: number; truncated: boolean };

/** The tab video the recording kept, when there is one. */
export function videoOf(events: EvidenceEvent[]): Video | null {
  const found = events.find((e) => e.kind === 'video' && e.data?.blob && typeof (e.data.blob as BlobRef).sha256 === 'string');
  if (!found) return null;
  return { blob: found.data.blob as BlobRef, startedAt: Number(found.data.startedAt ?? found.timestamp), truncated: found.data.truncated === true };
}

/** Quiet time kept before the first activity and after the last one. */
export const TRIM_BEFORE_MS = 1000;
export const TRIM_AFTER_MS = 1500;

/**
 * Trim bounds that drop the idle start and end: one second before the first activity, a second
 * and a half after the last, inside the range. At least a second stays, as the trim handles keep.
 * Null when nothing happened.
 */
export function autoTrimBounds(activity: number[], range: { start: number; end: number }): { trimStart: number; trimEnd: number } | null {
  const inside = activity.filter((t) => Number.isFinite(t) && t >= range.start && t <= range.end);
  if (!inside.length) return null;
  let trimStart = Math.max(range.start, Math.min(...inside) - TRIM_BEFORE_MS);
  let trimEnd = Math.min(range.end, Math.max(...inside) + TRIM_AFTER_MS);
  if (trimEnd - trimStart < 1000) {
    trimEnd = Math.min(range.end, trimStart + 1000);
    trimStart = Math.max(range.start, trimEnd - 1000);
  }
  return { trimStart, trimEnd };
}

/** A transcript with one line as the person wrote it; null when nothing changed. */
export function correctSegment(segments: VoiceSegment[], index: number, text: string): VoiceSegment[] | null {
  const clean = text.trim();
  const old = segments[index];
  if (!old || old.text === clean) return null;
  return segments.map((s, i) => (i === index ? { ...s, text: clean, corrected: true } : s));
}

export type PrivacyCounts = {
  /** Values the redaction pass replaced in the evidence. */
  redacted: number;
  /** Mask and blur boxes on screenshots and shots. */
  masks: number;
  /** The person's own rules in Settings. */
  rules: number;
  /** Screenshots and kept shots without a mask or blur. */
  unmasked: number;
};

/** What the review hides and what it may still show, counted honestly from the captures. */
export function privacyCounts(
  captures: Capture[],
  evidence: string[],
  settings: PrivacySettings | null,
  /** The shots after the steps leave too (with what the person typed). */
  shots = true,
): PrivacyCounts {
  let masks = 0;
  let unmasked = 0;
  for (const c of captures) {
    const boxes = c.annotations.filter((s) => s.kind === 'mask' || s.kind === 'blur').length;
    masks += boxes + c.edits.shotMasks.reduce((n, m) => n + m.areas.length, 0);
    if (c.kind !== 'session' && boxes === 0) unmasked += 1;
    if (!shots) continue;
    for (const shot of c.shots) {
      const at = Number(shot.at);
      if (c.edits.hiddenShots.includes(at)) continue;
      if (!c.edits.shotMasks.some((m) => Number(m.at) === at && m.areas.length > 0)) unmasked += 1;
    }
  }
  return {
    redacted: evidence.reduce((n, text) => n + countRedactions(text), 0),
    masks,
    rules: settings ? settings.maskSelectors.length + settings.sensitiveHeaders.length + settings.sensitivePatterns.length : 0,
    unmasked,
  };
}

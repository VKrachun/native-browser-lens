import type { BlobRef } from '@/protocol/BlobRef';
import type { Capture } from '@/protocol/Capture';
import type { Edits } from '@/protocol/Edits';
import type { Evidence } from '@/protocol/Evidence';
import type { Issue } from '@/protocol/Issue';
import type { NewCapture } from '@/protocol/NewCapture';
import type { NewVoiceNote } from '@/protocol/NewVoiceNote';
import type { Observation } from '@/protocol/Observation';
import type { ObservationSummary } from '@/protocol/ObservationSummary';
import type { ObservationUpdate } from '@/protocol/ObservationUpdate';
import type { Project } from '@/protocol/Project';
import type { ProjectInput } from '@/protocol/ProjectInput';
import type { PruneResult } from '@/protocol/PruneResult';
import type { Review } from '@/protocol/Review';
import type { ReviewSummary } from '@/protocol/ReviewSummary';
import type { Shape } from '@/protocol/Shape';
import type { StorageUsage } from '@/protocol/StorageUsage';
import type { VoiceNote } from '@/protocol/VoiceNote';
import type { VoiceSegment } from '@/protocol/VoiceSegment';
import { badRequest, conflict, notFound } from './errors';
import {
  MAX_NOTES_BYTES,
  base64ToBytes,
  cleanTags,
  defaultEdits,
  headlineOf,
  keptRanges,
  normalizeOrigin,
  plainTitle,
  sha256Hex,
  splitFindingsBlock,
  validateEdits,
  validateShapes,
  wavDurationMs,
} from './helpers';

const DB_NAME = 'sirv-lens-v1';
const DB_VERSION = 1;

export interface StoredBlob {
  sha256: string;
  size: number;
  mediaType: string;
  bytes: ArrayBuffer;
  createdAt: number;
}

export interface StoredCapture extends Capture {
  /** WebM blobs referenced by video events so blob GC retains them. */
  videos?: BlobRef[];
}

export interface StoredReview extends Review {
  /** Local-only voice audio sources for optional audio export. */
  mp4Voice?: Array<{ startedAt: number; durationMs: number; audio: BlobRef }>;
}

export interface StoredFilingAttempt {
  review: number;
  observation: number;
  reviewedRevision: number;
  endpoint: string;
  projectId: string;
  submissionId: string;
  observationUuid: string;
  vibeqRevision: number;
  memberId: string | null;
  receipt: {
    submissionId: string;
    observationId: string;
    revision: number;
    taskId: string;
    taskUrl: string;
    createdAt?: string;
    attachmentStatus?: string;
    missingAttachments: string[];
  } | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function resetDbForTests(): void {
  if (dbPromise) {
    void dbPromise.then((db) => db.close()).catch(() => {});
  }
  dbPromise = null;
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('counters')) db.createObjectStore('counters', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'sha256' });
      if (!db.objectStoreNames.contains('observations')) db.createObjectStore('observations', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('captures')) {
        const s = db.createObjectStore('captures', { keyPath: 'id' });
        s.createIndex('observation', 'observation', { unique: false });
      }
      if (!db.objectStoreNames.contains('voiceNotes')) {
        const s = db.createObjectStore('voiceNotes', { keyPath: 'id' });
        s.createIndex('observation', 'observation', { unique: false });
      }
      if (!db.objectStoreNames.contains('reviews')) {
        const s = db.createObjectStore('reviews', { keyPath: 'id' });
        s.createIndex('observation', 'observation', { unique: false });
      }
      if (!db.objectStoreNames.contains('filings')) {
        const s = db.createObjectStore('filings', { keyPath: 'review' });
        s.createIndex('observation', 'observation', { unique: false });
      }
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('Failed to open IndexedDB'));
    };
  });
  return dbPromise;
}

function reqPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function nextId(tx: IDBTransaction, name: string): Promise<number> {
  const store = tx.objectStore('counters');
  const existing = (await reqPromise(store.get(name))) as { name: string; value: number } | undefined;
  const next = (existing?.value ?? 0) + 1;
  await reqPromise(store.put({ name, value: next }));
  return next;
}

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

export async function putBlob(data: Blob | Uint8Array | ArrayBuffer, mediaType: string): Promise<BlobRef> {
  let bytes: ArrayBuffer;
  if (data instanceof Blob) {
    bytes = await data.arrayBuffer();
  } else if (data instanceof Uint8Array) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    bytes = copy.buffer;
  } else {
    bytes = data.slice(0);
  }
  const sha256 = await sha256Hex(bytes);
  const size = bytes.byteLength;
  const db = await openDb();
  const tx = db.transaction('blobs', 'readwrite');
  const record: StoredBlob = { sha256, size, mediaType, bytes, createdAt: Date.now() };
  await reqPromise(tx.objectStore('blobs').put(record));
  await txDone(tx);
  return { sha256, size, mediaType };
}

export async function getBlob(sha256: string): Promise<{ ref: BlobRef; bytes: Uint8Array<ArrayBuffer> } | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw badRequest(`Invalid blob sha256: ${sha256}`);
  const db = await openDb();
  const tx = db.transaction('blobs', 'readonly');
  const found = (await reqPromise(tx.objectStore('blobs').get(sha256))) as StoredBlob | undefined;
  if (!found) return null;
  const bytes = new Uint8Array(found.bytes.slice(0));
  return {
    ref: { sha256: found.sha256, size: found.size, mediaType: found.mediaType },
    bytes,
  };
}

export async function getBlobAsBlob(ref: BlobRef): Promise<Blob> {
  const found = await getBlob(ref.sha256);
  if (!found) throw notFound(`Blob ${ref.sha256} not found`);
  return new Blob([found.bytes], { type: ref.mediaType || found.ref.mediaType });
}

export async function getBlobJson<T = unknown>(ref: BlobRef): Promise<T> {
  const found = await getBlob(ref.sha256);
  if (!found) throw notFound(`Blob ${ref.sha256} not found`);
  return JSON.parse(new TextDecoder().decode(found.bytes)) as T;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const db = await openDb();
  const tx = db.transaction('settings', 'readonly');
  const row = (await reqPromise(tx.objectStore('settings').get(key))) as { key: string; value: T } | undefined;
  return row === undefined ? fallback : row.value;
}

export async function setSetting<T>(key: string, value: T): Promise<T> {
  const db = await openDb();
  const tx = db.transaction('settings', 'readwrite');
  await reqPromise(tx.objectStore('settings').put({ key, value }));
  await txDone(tx);
  return value;
}

export async function deleteSetting(key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('settings', 'readwrite');
  await reqPromise(tx.objectStore('settings').delete(key));
  await txDone(tx);
}

export async function getInstallId(): Promise<string> {
  const existing = await getSetting<string | null>('install.id', null);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await setSetting('install.id', id);
  return id;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  const db = await openDb();
  const tx = db.transaction('projects', 'readonly');
  const all = (await reqPromise(tx.objectStore('projects').getAll())) as Project[];
  return all.sort((a, b) => a.id - b.id);
}

export async function saveProject(input: ProjectInput): Promise<Project> {
  const name = input.name.trim();
  if (!name) throw badRequest('Project name cannot be empty');
  const origins = [...new Set(input.origins.map(normalizeOrigin))];
  if (origins.length === 0) throw badRequest('Project must include at least one origin');

  const db = await openDb();
  const tx = db.transaction(['counters', 'projects'], 'readwrite');
  const id = input.id !== null ? input.id : await nextId(tx, 'projects');
  const project: Project = { id, name, origins, enabled: input.enabled };
  await reqPromise(tx.objectStore('projects').put(project));
  await txDone(tx);
  return project;
}

export async function deleteProject(id: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('projects', 'readwrite');
  await reqPromise(tx.objectStore('projects').delete(id));
  await txDone(tx);
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export async function createObservation(title: string, url: string | null): Promise<Observation> {
  const now = Date.now();
  const db = await openDb();
  const tx = db.transaction(['counters', 'observations'], 'readwrite');
  const id = await nextId(tx, 'observations');
  const obs: Observation = {
    id,
    title: title.trim() || url || 'Untitled observation',
    url,
    notes: '',
    revision: 1,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
  await reqPromise(tx.objectStore('observations').put(obs));
  await txDone(tx);
  return obs;
}

export async function getObservation(id: number): Promise<Observation> {
  const db = await openDb();
  const tx = db.transaction('observations', 'readonly');
  const found = (await reqPromise(tx.objectStore('observations').get(id))) as Observation | undefined;
  if (!found) throw notFound(`Observation ${id} not found`);
  return found;
}

export async function updateObservation(update: ObservationUpdate): Promise<Observation> {
  if (new TextEncoder().encode(update.notes).byteLength > MAX_NOTES_BYTES) {
    throw badRequest(`Notes exceed ${MAX_NOTES_BYTES} bytes`);
  }
  const db = await openDb();
  const tx = db.transaction('observations', 'readwrite');
  const store = tx.objectStore('observations');
  const found = (await reqPromise(store.get(update.id))) as Observation | undefined;
  if (!found) throw notFound(`Observation ${update.id} not found`);
  if (found.revision !== update.revision) {
    throw conflict(`Observation ${update.id} changed (expected revision ${update.revision}, found ${found.revision})`);
  }
  const updated: Observation = {
    ...found,
    title: update.title.trim() || found.title,
    notes: update.notes,
    tags: update.tags !== undefined ? cleanTags(update.tags) : found.tags,
    revision: found.revision + 1,
    updatedAt: Date.now(),
  };
  await reqPromise(store.put(updated));
  await txDone(tx);
  return updated;
}

export async function deleteObservation(id: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['observations', 'captures', 'voiceNotes', 'reviews', 'filings', 'settings'], 'readwrite');
  const obs = (await reqPromise(tx.objectStore('observations').get(id))) as Observation | undefined;
  if (!obs) throw notFound(`Observation ${id} not found`);

  const captures = (await reqPromise(tx.objectStore('captures').index('observation').getAll(id))) as StoredCapture[];
  for (const c of captures) await reqPromise(tx.objectStore('captures').delete(c.id));

  const voices = (await reqPromise(tx.objectStore('voiceNotes').index('observation').getAll(id))) as VoiceNote[];
  for (const v of voices) await reqPromise(tx.objectStore('voiceNotes').delete(v.id));

  const reviews = (await reqPromise(tx.objectStore('reviews').index('observation').getAll(id))) as StoredReview[];
  for (const r of reviews) {
    await reqPromise(tx.objectStore('reviews').delete(r.id));
    await reqPromise(tx.objectStore('filings').delete(r.id));
  }

  const filings = (await reqPromise(tx.objectStore('filings').index('observation').getAll(id))) as StoredFilingAttempt[];
  for (const f of filings) await reqPromise(tx.objectStore('filings').delete(f.review));

  await reqPromise(tx.objectStore('settings').delete(`issues.${id}`));
  await reqPromise(tx.objectStore('settings').delete(`title.auto.${id}`));
  await reqPromise(tx.objectStore('observations').delete(id));
  await txDone(tx);
}

export async function listObservations(): Promise<ObservationSummary[]> {
  const db = await openDb();
  const tx = db.transaction(['observations', 'captures', 'voiceNotes', 'reviews', 'filings'], 'readonly');
  const [observations, captures, voices, reviews, filings] = await Promise.all([
    reqPromise(tx.objectStore('observations').getAll()) as Promise<Observation[]>,
    reqPromise(tx.objectStore('captures').getAll()) as Promise<StoredCapture[]>,
    reqPromise(tx.objectStore('voiceNotes').getAll()) as Promise<VoiceNote[]>,
    reqPromise(tx.objectStore('reviews').getAll()) as Promise<StoredReview[]>,
    reqPromise(tx.objectStore('filings').getAll()) as Promise<StoredFilingAttempt[]>,
  ]);

  const capturesByObs = new Map<number, StoredCapture[]>();
  for (const c of captures) {
    const arr = capturesByObs.get(c.observation) ?? [];
    arr.push(c);
    capturesByObs.set(c.observation, arr);
  }
  const voicesByObs = new Map<number, number>();
  for (const v of voices) {
    voicesByObs.set(v.observation, (voicesByObs.get(v.observation) ?? 0) + 1);
  }
  const reviewsByObs = new Map<number, StoredReview[]>();
  for (const r of reviews) {
    const arr = reviewsByObs.get(r.observation) ?? [];
    arr.push(r);
    reviewsByObs.set(r.observation, arr);
  }
  const filingsByReview = new Map<number, StoredFilingAttempt>();
  for (const f of filings) filingsByReview.set(f.review, f);

  return observations
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
    .map((obs): ObservationSummary => {
      const obsCaptures = (capturesByObs.get(obs.id) ?? []).sort((a, b) => a.id - b.id);
      const obsReviews = (reviewsByObs.get(obs.id) ?? []).sort((a, b) => b.id - a.id);
      const hasSession = obsCaptures.some((c) => c.kind === 'session');
      const durationMs = obsCaptures
        .filter((c) => c.kind === 'session')
        .reduce((sum, c) => sum + Math.max(0, c.createdAt - c.startedAt), 0);

      let taskUrl: string | null = null;
      let filed = false;
      for (const r of obsReviews) {
        const f = filingsByReview.get(r.id);
        if (f?.receipt?.taskUrl) {
          taskUrl = f.receipt.taskUrl;
          filed = true;
          break;
        }
      }
      const status = filed ? 'filed' : obsReviews.length > 0 ? 'reviewed' : 'draft';
      const newestCapture = obsCaptures.at(-1) ?? null;

      return {
        id: obs.id,
        title: obs.title,
        url: obs.url,
        createdAt: obs.createdAt,
        updatedAt: obs.updatedAt,
        captureCount: obsCaptures.length,
        kind: hasSession ? 'session' : 'moment',
        durationMs,
        voiceCount: voicesByObs.get(obs.id) ?? 0,
        status,
        thumbnail: newestCapture?.screenshot ?? null,
        headline: headlineOf(obs.notes),
        taskUrl,
      };
    });
}

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

function extractVideoBlobs(evidence: Evidence): BlobRef[] {
  const out: BlobRef[] = [];
  for (const ev of evidence.events) {
    if (ev.kind === 'video' && ev.data && typeof ev.data === 'object') {
      const d = ev.data as Record<string, unknown>;
      const blob = (d.blob ?? d.video ?? d) as Record<string, unknown>;
      if (typeof blob.sha256 === 'string' && typeof blob.size === 'number') {
        out.push({
          sha256: blob.sha256,
          size: blob.size,
          mediaType: typeof blob.mediaType === 'string' ? blob.mediaType : 'video/webm',
        });
      }
    }
  }
  return out;
}

export async function createCapture(input: NewCapture): Promise<Capture> {
  const now = Date.now();
  let screenshotRef: BlobRef;
  if (input.screenshotBlob) {
    screenshotRef = input.screenshotBlob;
  } else if (input.screenshot) {
    screenshotRef = await putBlob(base64ToBytes(input.screenshot), 'image/png');
  } else {
    // 1x1 transparent PNG fallback when browser couldn't grab a screenshot
    const emptyPng = base64ToBytes(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    );
    screenshotRef = await putBlob(emptyPng, 'image/png');
  }

  const evidenceBytes = new TextEncoder().encode(JSON.stringify(input.evidence));
  const evidenceRef = await putBlob(evidenceBytes, 'application/json');
  const videos = extractVideoBlobs(input.evidence);

  const db = await openDb();
  const tx = db.transaction(['counters', 'observations', 'captures'], 'readwrite');

  let observationId = input.observation;
  if (observationId === null) {
    observationId = await nextId(tx, 'observations');
    const obs: Observation = {
      id: observationId,
      title: input.pageTitle.trim() || input.pageUrl || 'Recording',
      url: input.pageUrl || null,
      notes: '',
      revision: 1,
      tags: [],
      createdAt: now,
      updatedAt: now,
    };
    await reqPromise(tx.objectStore('observations').put(obs));
  } else {
    const obs = (await reqPromise(tx.objectStore('observations').get(observationId))) as Observation | undefined;
    if (!obs) throw notFound(`Observation ${observationId} not found`);
    obs.updatedAt = now;
    await reqPromise(tx.objectStore('observations').put(obs));
  }

  const captureId = await nextId(tx, 'captures');
  const capture: StoredCapture = {
    id: captureId,
    observation: observationId,
    createdAt: now,
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    mode: input.evidence.mode,
    screenshot: screenshotRef,
    evidence: evidenceRef,
    eventCount: input.evidence.events.length,
    gapCount: input.evidence.gaps.length,
    annotations: [],
    recording: input.recording,
    kind: input.kind,
    startedAt: input.startedAt || now,
    edits: defaultEdits(),
    shots: input.shots.slice(0, 60),
    videos,
  };
  await reqPromise(tx.objectStore('captures').put(capture));
  await txDone(tx);
  const { videos: _v, ...publicCapture } = capture;
  return publicCapture;
}

export async function listCaptures(observationId: number): Promise<Capture[]> {
  const db = await openDb();
  const tx = db.transaction('captures', 'readonly');
  const list = (await reqPromise(tx.objectStore('captures').index('observation').getAll(observationId))) as StoredCapture[];
  return list
    .sort((a, b) => a.id - b.id)
    .map(({ videos: _v, ...c }) => c);
}

export async function getCapture(id: number): Promise<Capture> {
  const db = await openDb();
  const tx = db.transaction('captures', 'readonly');
  const found = (await reqPromise(tx.objectStore('captures').get(id))) as StoredCapture | undefined;
  if (!found) throw notFound(`Capture ${id} not found`);
  const { videos: _v, ...c } = found;
  return c;
}

export async function saveAnnotations(captureId: number, shapes: Shape[]): Promise<Capture> {
  validateShapes(shapes);
  const db = await openDb();
  const tx = db.transaction(['captures', 'observations'], 'readwrite');
  const found = (await reqPromise(tx.objectStore('captures').get(captureId))) as StoredCapture | undefined;
  if (!found) throw notFound(`Capture ${captureId} not found`);
  found.annotations = shapes;
  await reqPromise(tx.objectStore('captures').put(found));
  const obs = (await reqPromise(tx.objectStore('observations').get(found.observation))) as Observation | undefined;
  if (obs) {
    obs.updatedAt = Date.now();
    await reqPromise(tx.objectStore('observations').put(obs));
  }
  await txDone(tx);
  const { videos: _v, ...c } = found;
  return c;
}

export async function saveEdits(captureId: number, edits: Edits): Promise<Capture> {
  const db = await openDb();
  const tx = db.transaction(['captures', 'observations'], 'readwrite');
  const found = (await reqPromise(tx.objectStore('captures').get(captureId))) as StoredCapture | undefined;
  if (!found) throw notFound(`Capture ${captureId} not found`);
  validateEdits(edits, found);
  found.edits = edits;
  await reqPromise(tx.objectStore('captures').put(found));
  const obs = (await reqPromise(tx.objectStore('observations').get(found.observation))) as Observation | undefined;
  if (obs) {
    obs.updatedAt = Date.now();
    await reqPromise(tx.objectStore('observations').put(obs));
  }
  await txDone(tx);
  const { videos: _v, ...c } = found;
  return c;
}

// ---------------------------------------------------------------------------
// Voice notes
// ---------------------------------------------------------------------------

export async function addVoiceNote(input: NewVoiceNote): Promise<VoiceNote> {
  const audioBlob = await getBlob(input.audio.sha256);
  if (!audioBlob) throw notFound(`Audio blob ${input.audio.sha256} not found`);
  const durationMs = wavDurationMs(audioBlob.bytes);

  const db = await openDb();
  const tx = db.transaction(['counters', 'observations', 'voiceNotes'], 'readwrite');
  const obs = (await reqPromise(tx.objectStore('observations').get(input.observation))) as Observation | undefined;
  if (!obs) throw notFound(`Observation ${input.observation} not found`);

  const id = await nextId(tx, 'voiceNotes');
  const note: VoiceNote = {
    id,
    observation: input.observation,
    startedAt: input.startedAt,
    durationMs,
    audio: input.audio,
    state: 'waiting',
    language: null,
    segments: [],
    detail: null,
  };
  await reqPromise(tx.objectStore('voiceNotes').put(note));
  obs.updatedAt = Date.now();
  await reqPromise(tx.objectStore('observations').put(obs));
  await txDone(tx);
  return note;
}

export async function listVoiceNotes(observationId: number): Promise<VoiceNote[]> {
  const db = await openDb();
  const tx = db.transaction('voiceNotes', 'readonly');
  const list = (await reqPromise(tx.objectStore('voiceNotes').index('observation').getAll(observationId))) as VoiceNote[];
  return list.sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
}

export async function getVoiceNote(id: number): Promise<VoiceNote> {
  const db = await openDb();
  const tx = db.transaction('voiceNotes', 'readonly');
  const found = (await reqPromise(tx.objectStore('voiceNotes').get(id))) as VoiceNote | undefined;
  if (!found) throw notFound(`Voice note ${id} not found`);
  return found;
}

export async function patchVoiceNote(id: number, patch: Partial<VoiceNote>): Promise<VoiceNote> {
  const db = await openDb();
  const tx = db.transaction('voiceNotes', 'readwrite');
  const found = (await reqPromise(tx.objectStore('voiceNotes').get(id))) as VoiceNote | undefined;
  if (!found) throw notFound(`Voice note ${id} not found`);
  const updated: VoiceNote = { ...found, ...patch, id };
  await reqPromise(tx.objectStore('voiceNotes').put(updated));
  await txDone(tx);
  return updated;
}

export async function updateVoiceNoteSegments(id: number, segments: VoiceSegment[]): Promise<VoiceNote> {
  return patchVoiceNote(id, { segments });
}

export async function deleteVoiceNote(id: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('voiceNotes', 'readwrite');
  await reqPromise(tx.objectStore('voiceNotes').delete(id));
  await txDone(tx);
}

// ---------------------------------------------------------------------------
// Split Observation & Split Into Tasks
// ---------------------------------------------------------------------------

export async function splitObservation(
  observationId: number,
  revision: number,
  findingIndexes: number[],
  rawTitle: string,
): Promise<Observation> {
  const title = plainTitle(rawTitle);
  if (!title) throw badRequest('Title cannot be empty');

  const db = await openDb();
  const tx = db.transaction(['counters', 'observations', 'captures', 'voiceNotes', 'settings'], 'readwrite');
  const obs = (await reqPromise(tx.objectStore('observations').get(observationId))) as Observation | undefined;
  if (!obs) throw notFound(`Observation ${observationId} not found`);
  if (obs.revision !== revision) throw conflict(`Observation ${observationId} changed before splitting`);

  const { header, findings, own } = splitFindingsBlock(obs.notes);
  const picked = new Set(findingIndexes);
  const moved = findings.filter((_, i) => picked.has(i));
  const kept = findings.filter((_, i) => !picked.has(i));

  const formatNotes = (list: string[]) => {
    const block = list.length > 0 && header ? `${header}\n${list.map((f) => `- ${f}`).join('\n')}` : '';
    return [block, own].filter(Boolean).join('\n\n');
  };

  const now = Date.now();
  const updatedOrig: Observation = {
    ...obs,
    notes: formatNotes(kept),
    revision: obs.revision + 1,
    updatedAt: now,
  };
  await reqPromise(tx.objectStore('observations').put(updatedOrig));

  const newId = await nextId(tx, 'observations');
  const created: Observation = {
    id: newId,
    title,
    url: obs.url,
    notes: formatNotes(moved),
    revision: 1,
    tags: [...obs.tags],
    createdAt: now,
    updatedAt: now,
  };
  await reqPromise(tx.objectStore('observations').put(created));

  const captures = (await reqPromise(tx.objectStore('captures').index('observation').getAll(observationId))) as StoredCapture[];
  for (const c of captures) {
    const cid = await nextId(tx, 'captures');
    await reqPromise(tx.objectStore('captures').put({ ...c, id: cid, observation: newId }));
  }

  const voices = (await reqPromise(tx.objectStore('voiceNotes').index('observation').getAll(observationId))) as VoiceNote[];
  for (const v of voices) {
    const vid = await nextId(tx, 'voiceNotes');
    await reqPromise(tx.objectStore('voiceNotes').put({ ...v, id: vid, observation: newId }));
  }

  await reqPromise(tx.objectStore('settings').put({ key: `title.auto.${observationId}`, value: '' }));
  await reqPromise(tx.objectStore('settings').put({ key: `title.auto.${newId}`, value: '' }));
  await txDone(tx);
  return created;
}

export async function splitIntoTasks(
  observationId: number,
  revision: number,
  issues: Issue[],
): Promise<Observation[]> {
  if (issues.length < 2 || issues.length > 8) {
    throw badRequest('Splitting into tasks requires between 2 and 8 issues');
  }
  const db = await openDb();
  const tx = db.transaction(['counters', 'observations', 'captures', 'voiceNotes', 'reviews', 'filings', 'settings'], 'readwrite');
  const obs = (await reqPromise(tx.objectStore('observations').get(observationId))) as Observation | undefined;
  if (!obs) throw notFound(`Observation ${observationId} not found`);
  if (obs.revision !== revision) throw conflict(`Observation ${observationId} changed before splitting`);

  const captures = (await reqPromise(tx.objectStore('captures').index('observation').getAll(observationId))) as StoredCapture[];
  const voices = (await reqPromise(tx.objectStore('voiceNotes').index('observation').getAll(observationId))) as VoiceNote[];
  const doneVoices = voices.filter((v) => v.state === 'done');
  const voiceOrigin = doneVoices.length > 0 ? Math.min(...doneVoices.map((v) => v.startedAt)) : null;

  const createdList: Observation[] = [];
  const now = Date.now();

  for (const issue of issues) {
    const title = plainTitle(issue.title);
    if (!title) throw badRequest('Each split task needs a non-empty title');
    const newId = await nextId(tx, 'observations');
    const notes = issue.findings.length > 0 ? `Findings:\n${issue.findings.map((f) => `- ${f}`).join('\n')}` : '';
    const newObs: Observation = {
      id: newId,
      title,
      url: obs.url,
      notes,
      revision: 1,
      tags: cleanTags(issue.tags),
      createdAt: now,
      updatedAt: now,
    };
    await reqPromise(tx.objectStore('observations').put(newObs));

    // Trim session captures to issue's [fromSeconds, toSeconds] ± 3s when available
    const trimmedCaptures: StoredCapture[] = [];
    for (const c of captures) {
      let edits: Edits = structuredClone(c.edits);
      if (
        c.kind === 'session' &&
        voiceOrigin !== null &&
        issue.fromSeconds !== null &&
        issue.toSeconds !== null &&
        issue.toSeconds > issue.fromSeconds
      ) {
        const trimStart = Math.max(c.startedAt, voiceOrigin + Math.round(issue.fromSeconds * 1000) - 3000);
        const trimEnd = Math.min(c.createdAt, voiceOrigin + Math.round(issue.toSeconds * 1000) + 3000);
        edits = { ...edits, trimStart, trimEnd };
        if (keptRanges(edits, c.startedAt, c.createdAt).length === 0) continue;
      }
      trimmedCaptures.push({ ...c, edits });
    }
    const toCopy = trimmedCaptures.length > 0 ? trimmedCaptures : captures;
    for (const c of toCopy) {
      const cid = await nextId(tx, 'captures');
      await reqPromise(tx.objectStore('captures').put({ ...c, id: cid, observation: newId }));
    }
    for (const v of voices) {
      const vid = await nextId(tx, 'voiceNotes');
      await reqPromise(tx.objectStore('voiceNotes').put({ ...v, id: vid, observation: newId }));
    }
    await reqPromise(tx.objectStore('settings').put({ key: `title.auto.${newId}`, value: '' }));
    createdList.push(newObs);
  }

  // Delete original observation and its children
  for (const c of captures) await reqPromise(tx.objectStore('captures').delete(c.id));
  for (const v of voices) await reqPromise(tx.objectStore('voiceNotes').delete(v.id));
  const reviews = (await reqPromise(tx.objectStore('reviews').index('observation').getAll(observationId))) as StoredReview[];
  for (const r of reviews) {
    await reqPromise(tx.objectStore('reviews').delete(r.id));
    await reqPromise(tx.objectStore('filings').delete(r.id));
  }
  const filings = (await reqPromise(tx.objectStore('filings').index('observation').getAll(observationId))) as StoredFilingAttempt[];
  for (const f of filings) await reqPromise(tx.objectStore('filings').delete(f.review));
  await reqPromise(tx.objectStore('settings').delete(`issues.${observationId}`));
  await reqPromise(tx.objectStore('settings').delete(`title.auto.${observationId}`));
  await reqPromise(tx.objectStore('observations').delete(observationId));
  await txDone(tx);

  return createdList;
}

// ---------------------------------------------------------------------------
// Reviews & Filings
// ---------------------------------------------------------------------------

export async function saveReview(
  reviewData: Omit<StoredReview, 'id'>,
  expectedRevision: number,
): Promise<Review> {
  const db = await openDb();
  const tx = db.transaction(['counters', 'observations', 'reviews'], 'readwrite');
  const obs = (await reqPromise(tx.objectStore('observations').get(reviewData.observation))) as Observation | undefined;
  if (!obs) throw notFound(`Observation ${reviewData.observation} not found`);
  if (obs.revision !== expectedRevision) {
    throw conflict(`Observation ${reviewData.observation} changed while creating review`);
  }
  const id = await nextId(tx, 'reviews');
  const stored: StoredReview = { ...reviewData, id };
  await reqPromise(tx.objectStore('reviews').put(stored));
  await txDone(tx);
  const { mp4Voice: _m, ...pub } = stored;
  return pub;
}

export async function getStoredReview(id: number): Promise<StoredReview> {
  const db = await openDb();
  const tx = db.transaction('reviews', 'readonly');
  const found = (await reqPromise(tx.objectStore('reviews').get(id))) as StoredReview | undefined;
  if (!found) throw notFound(`Review ${id} not found`);
  return found;
}

export async function getReview(id: number): Promise<Review> {
  const { mp4Voice: _m, ...pub } = await getStoredReview(id);
  return pub;
}

export async function listReviewsPage(
  before: number | null,
  limit: number,
  observation: number | null,
): Promise<ReviewSummary[]> {
  const db = await openDb();
  const tx = db.transaction(['reviews', 'filings'], 'readonly');
  const rawReviews = (
    observation !== null
      ? await reqPromise(tx.objectStore('reviews').index('observation').getAll(observation))
      : await reqPromise(tx.objectStore('reviews').getAll())
  ) as StoredReview[];
  const filings = (await reqPromise(tx.objectStore('filings').getAll())) as StoredFilingAttempt[];
  const filingsByReview = new Map<number, StoredFilingAttempt>();
  for (const f of filings) filingsByReview.set(f.review, f);

  return rawReviews
    .filter((r) => before === null || r.id < before)
    .sort((a, b) => b.id - a.id)
    .slice(0, Math.max(1, limit))
    .map((r): ReviewSummary => {
      const f = filingsByReview.get(r.id);
      return {
        id: r.id,
        observation: r.observation,
        revision: r.revision,
        createdAt: r.createdAt,
        title: r.title,
        captures: r.items.length,
        pageUrl: r.items[0]?.pageUrl ?? null,
        vibeqTaskId: f?.receipt?.taskId ?? null,
        vibeqTaskUrl: f?.receipt?.taskUrl ?? null,
      };
    });
}

export async function getFilingAttempt(reviewId: number): Promise<StoredFilingAttempt | null> {
  const db = await openDb();
  const tx = db.transaction('filings', 'readonly');
  const found = (await reqPromise(tx.objectStore('filings').get(reviewId))) as StoredFilingAttempt | undefined;
  return found ?? null;
}

export async function listObservationFilings(observationId: number): Promise<StoredFilingAttempt[]> {
  const db = await openDb();
  const tx = db.transaction('filings', 'readonly');
  return (await reqPromise(tx.objectStore('filings').index('observation').getAll(observationId))) as StoredFilingAttempt[];
}

export async function saveFilingAttempt(attempt: StoredFilingAttempt): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('filings', 'readwrite');
  await reqPromise(tx.objectStore('filings').put(attempt));
  await txDone(tx);
}

// ---------------------------------------------------------------------------
// Storage usage, retention, pruning, and orphan blob sweep
// ---------------------------------------------------------------------------

export async function getStorageUsage(): Promise<StorageUsage> {
  const db = await openDb();
  const tx = db.transaction(['blobs', 'observations', 'reviews', 'settings'], 'readonly');
  const [blobs, obsCount, reviewCount, retDaysRow, retFiledRow] = await Promise.all([
    reqPromise(tx.objectStore('blobs').getAll()) as Promise<StoredBlob[]>,
    reqPromise(tx.objectStore('observations').count()),
    reqPromise(tx.objectStore('reviews').count()),
    reqPromise(tx.objectStore('settings').get('storage.retention.days')) as Promise<{ value: number | null } | undefined>,
    reqPromise(tx.objectStore('settings').get('storage.retention.filedOnly')) as Promise<{ value: boolean } | undefined>,
  ]);

  let recordingsBytes = 0;
  let audioBytes = 0;
  let screenshotsBytes = 0;
  let otherBytes = 0;

  for (const b of blobs) {
    if (b.mediaType === 'audio/wav' || b.mediaType.startsWith('audio/')) {
      audioBytes += b.size;
    } else if (b.mediaType === 'image/png' || b.mediaType === 'image/webp') {
      screenshotsBytes += b.size;
    } else if (b.mediaType === 'video/webm') {
      recordingsBytes += b.size;
    } else if (b.mediaType === 'application/json') {
      // Heuristic: rrweb recordings tend to be larger JSON blobs, evidence is smaller; count recordings + other cleanly
      if (b.size > 64 * 1024) recordingsBytes += b.size;
      else otherBytes += b.size;
    } else {
      otherBytes += b.size;
    }
  }

  let modelsBytes = 0;
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open('transformers-cache');
      const keys = await cache.keys();
      for (const req of keys) {
        const res = await cache.match(req);
        const len = Number(res?.headers.get('content-length') ?? 0);
        if (len > 0) modelsBytes += len;
      }
    }
  } catch {
    // Ignore cache estimation errors in non-browser/test environments
  }

  const totalBytes = recordingsBytes + audioBytes + screenshotsBytes + modelsBytes + otherBytes;
  return {
    recordingsBytes,
    audioBytes,
    screenshotsBytes,
    modelsBytes,
    otherBytes,
    totalBytes,
    observationCount: obsCount,
    reviewCount,
    retentionDays: retDaysRow?.value ?? null,
    retentionFiledOnly: retFiledRow?.value ?? false,
  };
}

export async function setRetention(days: number | null, filedOnly: boolean): Promise<StorageUsage> {
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
    throw badRequest('Retention days must be between 1 and 3650');
  }
  await setSetting('storage.retention.days', days);
  await setSetting('storage.retention.filedOnly', filedOnly);
  return getStorageUsage();
}

const SHA_RE = /[0-9a-f]{64}/g;

export async function sweepOrphanBlobs(graceMs = 3600_000): Promise<number> {
  const db = await openDb();
  const readTx = db.transaction(['captures', 'voiceNotes', 'reviews', 'filings', 'blobs'], 'readonly');
  const [captures, voices, reviews, filings, blobs] = await Promise.all([
    reqPromise(readTx.objectStore('captures').getAll()),
    reqPromise(readTx.objectStore('voiceNotes').getAll()),
    reqPromise(readTx.objectStore('reviews').getAll()),
    reqPromise(readTx.objectStore('filings').getAll()),
    reqPromise(readTx.objectStore('blobs').getAll()) as Promise<StoredBlob[]>,
  ]);

  const keep = new Set<string>();
  const scan = (val: unknown) => {
    const json = JSON.stringify(val);
    let m: RegExpExecArray | null;
    SHA_RE.lastIndex = 0;
    while ((m = SHA_RE.exec(json)) !== null) keep.add(m[0]);
  };
  scan(captures);
  scan(voices);
  scan(reviews);
  scan(filings);

  const cutoff = Date.now() - graceMs;
  const toDelete = blobs.filter((b) => !keep.has(b.sha256) && b.createdAt <= cutoff);
  if (toDelete.length === 0) return 0;

  let freed = 0;
  const writeTx = db.transaction('blobs', 'readwrite');
  for (const b of toDelete) {
    freed += b.size;
    await reqPromise(writeTx.objectStore('blobs').delete(b.sha256));
  }
  await txDone(writeTx);
  return freed;
}

export async function pruneStorage(olderThanDays: number, filedOnly: boolean): Promise<PruneResult> {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650) {
    throw badRequest('olderThanDays must be between 1 and 3650');
  }
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const db = await openDb();
  const tx = db.transaction(['observations', 'filings'], 'readonly');
  const [observations, filings] = await Promise.all([
    reqPromise(tx.objectStore('observations').getAll()) as Promise<Observation[]>,
    reqPromise(tx.objectStore('filings').getAll()) as Promise<StoredFilingAttempt[]>,
  ]);
  const filedObs = new Set(filings.filter((f) => Boolean(f.receipt?.taskUrl)).map((f) => f.observation));

  let deletedObservations = 0;
  for (const obs of observations) {
    if (obs.updatedAt >= cutoff) continue;
    if (filedOnly && !filedObs.has(obs.id)) continue;
    await deleteObservation(obs.id);
    deletedObservations += 1;
  }

  // Immediate sweep (graceMs = 0 for explicit manual prune)
  const freedBytes = await sweepOrphanBlobs(0);
  return { deletedObservations, freedBytes };
}

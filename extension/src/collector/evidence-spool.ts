// A browser can stop the background worker in the middle of a recording, and with it everything
// the recording held in memory. So while a recording runs, what it collects is also written here,
// in small batches; a new worker reads it back and loses only the last batch. IndexedDB: it holds
// large data, and it outlives the worker.
import type { Action } from '@/protocol/Action';
import type { CoverageGap } from '@/protocol/CoverageGap';
import type { EvidenceEvent } from '@/protocol/EvidenceEvent';
import type { ReplayEvent } from './buffer';

export type Shot = { at: number; data: string };
export type Batch = { events: EvidenceEvent[]; actions: Action[]; replay: ReplayEvent[]; shots: Shot[] };
export const KINDS = ['events', 'actions', 'replay', 'shots'] as const;
export type Kind = (typeof KINDS)[number];

/** One batch of one kind for one recording; recordings are named by their start time. */
export interface Chunk {
  session: number;
  kind: Kind;
  items: unknown[];
  bytes: number;
}
/** The last word on a recording: its gaps and counts, and when it was last written. */
export interface State {
  session: number;
  tab: number;
  savedAt: number;
  gaps: CoverageGap[];
  dropped: Record<string, number>;
}
export type Spooled = Batch & { gaps: CoverageGap[]; dropped: Record<string, number>; savedAt: number; bytes: number };

/** A recording's spool past this is written again from memory, which already keeps to its caps. */
export const MAX_SPOOL_BYTES = 160 * 1024 * 1024;
/** Spools older than this belong to no recording anyone can still stop. */
export const STALE_MS = 24 * 60 * 60_000;

export const emptyBatch = (): Batch => ({ events: [], actions: [], replay: [], shots: [] });

export function chunk(session: number, kind: Kind, items: unknown[]): Chunk {
  return { session, kind, items, bytes: JSON.stringify(items).length };
}

/** The chunks of one recording, in the order they were written, as one batch. */
export function gather(chunks: Chunk[], state: State): Spooled {
  const out: Spooled = { ...emptyBatch(), gaps: state.gaps, dropped: state.dropped, savedAt: state.savedAt, bytes: 0 };
  for (const c of chunks) {
    (out[c.kind] as unknown[]).push(...c.items);
    out.bytes += c.bytes;
  }
  return out;
}

/** The spooled recordings to delete: old ones, and ones no running recording owns. */
export function stale(states: Pick<State, 'session' | 'savedAt'>[], live: Set<number>, now: number): number[] {
  return states.filter((s) => !live.has(s.session) || now - s.savedAt > STALE_MS).map((s) => s.session);
}

const CHUNKS = 'chunks';
const STATES = 'states';

function database(): Promise<IDBDatabase> {
  return new Promise((done, fail) => {
    const request = indexedDB.open('lens-evidence', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(CHUNKS, { autoIncrement: true }).createIndex('session', 'session');
      db.createObjectStore(STATES, { keyPath: 'session' });
    };
    request.onsuccess = () => done(request.result);
    request.onerror = () => fail(request.error);
  });
}

/** Runs `work` in one transaction; done when it commits, so a write counts only once it is on disk. */
async function transact<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => () => T): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((done, fail) => {
      const tx = db.transaction([CHUNKS, STATES], mode);
      const result = work(tx);
      tx.oncomplete = () => done(result());
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error ?? new Error('the spool write was aborted'));
    });
  } finally {
    db.close();
  }
}

function removeIn(tx: IDBTransaction, session: number) {
  // The keys as they are now, in one request: a cursor would go on into chunks this same
  // transaction adds after it (write with `fresh`), and delete those too.
  tx.objectStore(CHUNKS).index('session').getAllKeys(IDBKeyRange.only(session)).onsuccess = (event) => {
    for (const key of (event.target as IDBRequest<IDBValidKey[]>).result) tx.objectStore(CHUNKS).delete(key);
  };
  tx.objectStore(STATES).delete(session);
}

/** Adds chunks and replaces states; with `fresh`, those recordings' older chunks go first. */
export function write(chunks: Chunk[], states: State[], fresh: number[] = []) {
  return transact('readwrite', (tx) => {
    for (const session of fresh) removeIn(tx, session);
    for (const c of chunks) tx.objectStore(CHUNKS).add(c);
    for (const s of states) tx.objectStore(STATES).put(s);
    return () => undefined;
  });
}

/** One recording's spool, or null when there is none. */
export function read(session: number): Promise<Spooled | null> {
  return transact('readonly', (tx) => {
    let chunks: Chunk[] = [];
    let state: State | undefined;
    tx.objectStore(CHUNKS).index('session').getAll(IDBKeyRange.only(session)).onsuccess = (event) => {
      // The index lists chunks by key order within the session: the order they were added.
      chunks = (event.target as IDBRequest<Chunk[]>).result;
    };
    tx.objectStore(STATES).get(session).onsuccess = (event) => {
      state = (event.target as IDBRequest<State | undefined>).result;
    };
    return () => (state ? gather(chunks, state) : null);
  });
}

export function remove(sessions: number[]) {
  if (!sessions.length) return Promise.resolve();
  return transact('readwrite', (tx) => {
    for (const session of sessions) removeIn(tx, session);
    return () => undefined;
  });
}

export function list(): Promise<State[]> {
  return transact('readonly', (tx) => {
    let states: State[] = [];
    tx.objectStore(STATES).getAll().onsuccess = (event) => {
      states = (event.target as IDBRequest<State[]>).result;
    };
    return () => states;
  });
}

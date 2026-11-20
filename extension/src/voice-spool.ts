// The voice of a recording that must outlive a page: Firefox records it in the sidebar, which can
// close mid-recording, and the voice of a Stop the app did not take must wait for Stop again (also
// in Chrome's background, which the browser can restart). IndexedDB: it holds blobs, and it
// outlives the page. One entry for each recording (its tab and its start), so the voice of one
// recording can never join another.

export interface Spooled {
  tab: number;
  /** When the recording started: with the tab, which recording the voice belongs to. */
  session: number;
  startedAt: number;
  /** audio/wav for a finished voice; else what MediaRecorder writes, to decode at Stop. */
  type: string;
  parts: Blob[];
}

const STORE = 'voice';
/** An entry this old belongs to a recording nobody stopped: it is removed. */
const ABANDONED_MS = 24 * 60 * 60 * 1000;

export const spoolKey = (tab: number, session: number) => `${tab}:${session}`;

function database(): Promise<IDBDatabase> {
  return new Promise((done, fail) => {
    // Version 2 keys by recording; version 1 kept one entry for each tab.
    const request = indexedDB.open('lens-voice', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE);
    };
    request.onsuccess = () => done(request.result);
    request.onerror = () => fail(request.error);
  });
}

/** Resolves once the transaction committed: a write that only succeeded can still be lost. */
async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await database();
  try {
    return await new Promise<T | undefined>((done, fail) => {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => done(request ? request.result : undefined);
      transaction.onerror = () => fail(transaction.error ?? new Error('the browser did not keep the voice'));
      transaction.onabort = () => fail(transaction.error ?? new Error('the browser did not keep the voice'));
    });
  } finally {
    db.close();
  }
}

/** Rejects when the browser did not keep it (a full disk, say): the caller still has the audio. */
export const spool = (entry: Spooled) => run('readwrite', (store) => store.put(entry, spoolKey(entry.tab, entry.session))).then(() => {});

export const spooled = (tab: number, session: number) =>
  run<Spooled | undefined>('readonly', (store) => store.get(spoolKey(tab, session))).catch(() => undefined);

export const unspool = (tab: number, session: number) =>
  run('readwrite', (store) => void store.delete(spoolKey(tab, session))).catch(() => {});

/** Removes every entry of a tab that `keep` does not want, and every abandoned one. */
export function purge(keep: (entry: Spooled) => boolean, now = Date.now()) {
  return run('readwrite', (store) => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at) return;
      const entry = at.value as Spooled;
      if (now - entry.session > ABANDONED_MS || !keep(entry)) at.delete();
      at.continue();
    };
  }).catch(() => {});
}

// Firefox records the voice in the sidebar, and closing the sidebar ends that page mid-recording.
// The audio so far, and the voice of a Stop the app did not take, wait here for the next Stop of
// that tab's recording. IndexedDB: it holds blobs, and it outlives the page.

export interface Spooled {
  tab: number;
  startedAt: number;
  /** audio/wav for a finished voice; else what MediaRecorder writes, to decode at Stop. */
  type: string;
  parts: Blob[];
}

const STORE = 'voice';

function database(): Promise<IDBDatabase> {
  return new Promise((done, fail) => {
    const request = indexedDB.open('lens-voice', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'tab' });
    request.onsuccess = () => done(request.result);
    request.onerror = () => fail(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((done, fail) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => done(request.result);
      request.onerror = () => fail(request.error);
    });
  } finally {
    db.close();
  }
}

export const spool = (entry: Spooled) => run('readwrite', (store) => store.put(entry)).catch(() => {});
export const spooled = (tab: number) => run<Spooled | undefined>('readonly', (store) => store.get(tab)).catch(() => undefined);
export const unspool = (tab: number) => run('readwrite', (store) => store.delete(tab)).catch(() => {});

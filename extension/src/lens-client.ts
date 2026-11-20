import type { ReplyFrame } from './protocol/ReplyFrame';
import type { Request } from './protocol/Request';
import type { Reply } from './protocol/Reply';
import type { BlobRef } from './protocol/BlobRef';

export const HOST_NAME = 'studio.sirv.lens';
/** Must equal PROTOCOL_VERSION in src/protocol.rs; a Rust test reads this line. */
export const PROTOCOL_VERSION = 1;

/** The reply type that answers each request method. */
type ReplyTo = {
  hello: 'hello';
  createObservation: 'observation';
  listObservations: 'observations';
  deleteObservation: 'deleted';
  splitObservation: 'observation';
  startSirvant: 'sirvant';
  listIssues: 'issues';
  splitIntoTasks: 'split';
  findDuplicates: 'duplicates';
  getDestination: 'destination';
  setDestination: 'destination';
  getSummaryAgent: 'summaryAgent';
  setSummaryAgent: 'done';
  getObservation: 'observation';
  updateObservation: 'observation';
  listProjects: 'projects';
  saveProject: 'project';
  deleteProject: 'deleted';
  createCapture: 'capture';
  listCaptures: 'captures';
  getCapture: 'capture';
  saveAnnotations: 'capture';
  saveEdits: 'capture';
  readBlob: 'blob';
  listReviews: 'reviews';
  getReview: 'review';
  createReview: 'review';
  exportReview: 'exported';
  exportAttachment: 'attachment';
  listHandoffApps: 'handoffApps';
  connectAgents: 'agentSetup';
  recentEvidence: 'liveEvidence';
  waitForAsk: 'ask';
  provideEvidence: 'done';
  retryVoiceNote: 'voiceNote';
  setupPage: 'setupPage';
  disconnectAgents: 'agentSetup';
  handOff: 'handedOff';
  getVibeQ: 'vibeQ';
  setVibeQ: 'vibeQ';
  listMembers: 'members';
  fileReview: 'filing';
  getFiling: 'filing';
  listAgents: 'agents';
  investigate: 'suggestion';
  announce: 'done';
  installService: 'done';
  setupStatus: 'setup';
  getUpdates: 'updates';
  setAutomaticUpdates: 'updates';
  updateNow: 'updates';
  setPaused: 'done';
  uploadChunk: 'uploaded';
  addVoiceNote: 'voiceNote';
  listVoiceNotes: 'voiceNotes';
  deleteVoiceNote: 'deleted';
  updateVoiceNote: 'voiceNote';
  summarize: 'summary';
  speechStatus: 'speech';
  installSpeech: 'speech';
  shutdown: 'stopping';
};
// Every protocol method must name its reply here; a new Rust request fails this line first.
type MissingReplies = Exclude<Request['method'], keyof ReplyTo>;
const everyMethodHasAReply: [MissingReplies] extends [never] ? true : MissingReplies = true;
void everyMethodHasAReply;
type ReplyData<M extends Request['method']> = Extract<Reply, { type: ReplyTo[M] }> extends { data: infer D } ? D : never;

export class LensError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A native messaging port to the shim, which relays to `lensd`. When the app restarts (an update
 * does), the requests in flight fail and the next request opens a new port, which starts the app
 * again when it is not running.
 */
export class LensClient {
  private port: Browser.runtime.Port | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();

  constructor(private readonly onClose: (error: LensError) => void = () => {}) {
    this.open();
  }

  private open(): Browser.runtime.Port {
    const port = browser.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener((frame: ReplyFrame) => {
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      if (frame.status === 'ok') waiter.resolve(frame.result);
      else waiter.reject(new LensError(frame.error.code, frame.error.message));
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      const closed = new LensError('disconnected', browser.runtime.lastError?.message ?? 'Lens closed the connection');
      for (const waiter of this.pending.values()) waiter.reject(closed);
      this.pending.clear();
      this.onClose(closed);
    });
    this.port = port;
    return port;
  }

  request<M extends Request['method']>(request: Extract<Request, { method: M }>): Promise<ReplyData<M>> {
    const port = this.port ?? this.open();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (reply) => resolve((reply as { data?: unknown }).data as ReplyData<M>), reject });
      try {
        port.postMessage({ id, ...request });
      } catch (error) {
        this.pending.delete(id);
        this.port = null;
        reject(new LensError('disconnected', (error as Error).message));
      }
    });
  }

  /** Closes the port; a later request opens a new one. */
  disconnect() {
    const port = this.port;
    this.port = null;
    port?.disconnect();
    // The browser reports no disconnect for a port this side closed: end what still waits.
    const closed = new LensError('disconnected', 'the connection to Lens was closed');
    for (const waiter of this.pending.values()) waiter.reject(closed);
    this.pending.clear();
  }

  /** Sends a file in chunks (requests stay under 16 MiB); the last reply names the stored blob. */
  async upload(file: Blob, mediaType: 'audio/wav' | 'application/json' | 'image/webp'): Promise<BlobRef> {
    const CHUNK = 3 * 1024 * 1024;
    const id = crypto.randomUUID();
    for (let offset = 0; ; offset += CHUNK) {
      const done = offset + CHUNK >= file.size;
      const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const stored = await this.request({
        method: 'uploadChunk',
        params: { upload: id, offset, data: btoa(binary), done, mediaType },
      });
      if (done) {
        if (!stored) throw new Error('Lens did not store the upload');
        return stored;
      }
    }
  }

  /** A stored blob, read in chunks because host replies stay under 1 MiB. */
  async readBlob(ref: BlobRef): Promise<Blob> {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let offset = 0; offset < ref.size; ) {
      const chunk = await this.request({ method: 'readBlob', params: { sha256: ref.sha256, offset, length: 512 * 1024 } });
      const bytes = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
      if (bytes.length === 0) break;
      parts.push(bytes);
      offset += bytes.length;
    }
    return new Blob(parts, { type: ref.mediaType });
  }
}

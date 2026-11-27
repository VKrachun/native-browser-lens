import type { BlobRef } from './protocol/BlobRef';
import type { Reply } from './protocol/Reply';
import type { Request } from './protocol/Request';
import { getBlobAsBlob, putBlob } from './engine/db';
import { LensError } from './engine/errors';
import { dispatchRequest, PROTOCOL_VERSION } from './engine/index';

export { LensError, PROTOCOL_VERSION };

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
  listReviewsPage: 'reviews';
  getReview: 'review';
  createReview: 'review';
  exportReview: 'exported';
  exportAttachment: 'attachment';
  readAttachment: 'blob';
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
  checkUpdates: 'updates';
  setPaused: 'done';
  uploadChunk: 'uploaded';
  addVoiceNote: 'voiceNote';
  listVoiceNotes: 'voiceNotes';
  deleteVoiceNote: 'deleted';
  updateVoiceNote: 'voiceNote';
  summarize: 'summary';
  speechStatus: 'speech';
  installSpeech: 'speech';
  cancelSpeechDownload: 'speech';
  getSpeechSettings: 'speechSettings';
  setSpeechSettings: 'speechSettings';
  getVideoTools: 'videoTools';
  installVideoTools: 'videoTools';
  getStorage: 'storage';
  pruneStorage: 'pruned';
  setRetention: 'storage';
  getPrivacySettings: 'privacySettings';
  setPrivacySettings: 'privacySettings';
  getFindingsSettings: 'findingsSettings';
  setFindingsSettings: 'findingsSettings';
  shutdown: 'stopping';
};

type MissingReplies = Exclude<Request['method'], keyof ReplyTo>;
const everyMethodHasAReply: [MissingReplies] extends [never] ? true : MissingReplies = true;
void everyMethodHasAReply;
type ReplyData<M extends Request['method']> = Extract<Reply, { type: ReplyTo[M] }> extends { data: infer D } ? D : never;

/** A capture that is gone (its recording was split into tasks or deleted) says so in words. */
export function captureProblem(error: Error): string {
  return error instanceof LensError && error.code === 'notFound'
    ? 'This capture no longer exists: its recording was split into separate tasks or deleted.'
    : error.message;
}

/**
 * Local in-extension client backed directly by IndexedDB + WebGPU/WASM Whisper + BYOK LLM APIs.
 * No companion app or native messaging host is required.
 */
export class LensClient {
  constructor(_onClose: (error: LensError) => void = () => {}) {}

  async request<M extends Request['method']>(request: Extract<Request, { method: M }>): Promise<ReplyData<M>> {
    const reply = await dispatchRequest(request);
    return (reply as { data?: unknown }).data as ReplyData<M>;
  }

  disconnect() {
    // Nothing to tear down for direct IndexedDB calls.
  }

  /** Stores a blob directly into content-addressed IndexedDB storage (no chunking overhead). */
  async upload(
    file: Blob,
    mediaType: 'audio/wav' | 'application/json' | 'image/webp' | 'image/png' | 'video/webm',
  ): Promise<BlobRef> {
    return putBlob(file, mediaType);
  }

  /** Reads a stored blob directly from IndexedDB. */
  async readBlob(ref: BlobRef): Promise<Blob> {
    return getBlobAsBlob(ref);
  }
}

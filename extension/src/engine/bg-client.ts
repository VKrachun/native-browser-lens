import type { BlobRef } from '@/protocol/BlobRef';
import type { Capture } from '@/protocol/Capture';
import type { NewCapture } from '@/protocol/NewCapture';
import type { NewVoiceNote } from '@/protocol/NewVoiceNote';
import type { PrivacySettings } from '@/protocol/PrivacySettings';
import type { Project } from '@/protocol/Project';
import type { StorageUsage } from '@/protocol/StorageUsage';
import type { VoiceNote } from '@/protocol/VoiceNote';
import {
  addVoiceNote,
  createCapture,
  getSetting,
  getStorageUsage,
  listProjects,
  pruneStorage,
  putBlob,
} from './db';

const DEFAULT_PRIVACY: PrivacySettings = {
  maskSelectors: [],
  sensitiveHeaders: [],
  sensitivePatterns: [],
};

type BgRequest =
  | { method: 'hello' }
  | { method: 'listProjects' }
  | { method: 'getPrivacySettings' }
  | { method: 'announce'; params: unknown }
  | { method: 'createCapture'; params: NewCapture }
  | { method: 'addVoiceNote'; params: NewVoiceNote }
  | { method: 'getStorage' }
  | { method: 'pruneStorage'; params: { olderThanDays: number; filedOnly: boolean } };

type BgReply<M extends BgRequest['method']> = M extends 'hello'
  ? { version: string; protocol: number; paused: boolean }
  : M extends 'listProjects'
    ? Project[]
    : M extends 'getPrivacySettings'
      ? PrivacySettings
      : M extends 'createCapture'
        ? Capture
        : M extends 'addVoiceNote'
          ? VoiceNote
          : M extends 'getStorage'
            ? StorageUsage
            : M extends 'pruneStorage'
              ? { deletedObservations: number; freedBytes: number }
              : void;

/**
 * Lightweight IndexedDB-only client for the MV3 background service worker.
 * Keeps background.js small (~100 KB) by never pulling in Transformers.js / ONNX WASM.
 */
export class BackgroundLensClient {
  constructor(_onClose?: () => void) {}

  async request<M extends BgRequest['method']>(req: Extract<BgRequest, { method: M }>): Promise<BgReply<M>> {
    const r = req as BgRequest;
    switch (r.method) {
      case 'hello': {
        const paused = await getSetting<boolean>('collection.paused', false);
        const version = (() => {
          try {
            return browser.runtime.getManifest().version;
          } catch {
            return '1.0.0';
          }
        })();
        return { version, protocol: 1, paused } as BgReply<M>;
      }
      case 'listProjects':
        return (await listProjects()) as BgReply<M>;
      case 'getPrivacySettings':
        return (await getSetting<PrivacySettings>('privacy.settings', DEFAULT_PRIVACY)) as BgReply<M>;
      case 'announce':
        return undefined as BgReply<M>;
      case 'createCapture':
        return (await createCapture(r.params)) as BgReply<M>;
      case 'addVoiceNote':
        return (await addVoiceNote(r.params)) as BgReply<M>;
      case 'getStorage':
        return (await getStorageUsage()) as BgReply<M>;
      case 'pruneStorage':
        return (await pruneStorage(r.params.olderThanDays, r.params.filedOnly)) as BgReply<M>;
    }
  }

  async upload(
    file: Blob,
    mediaType: 'audio/wav' | 'application/json' | 'image/webp' | 'image/png' | 'video/webm',
  ): Promise<BlobRef> {
    return putBlob(file, mediaType);
  }
}

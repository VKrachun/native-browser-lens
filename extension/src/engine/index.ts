import type { DestinationSettings } from '@/protocol/DestinationSettings';
import type { Issue } from '@/protocol/Issue';
import type { PrivacySettings } from '@/protocol/PrivacySettings';
import type { Reply } from '@/protocol/Reply';
import type { Request } from '@/protocol/Request';
import type { TaskDestination } from '@/protocol/TaskDestination';
import {
  addVoiceNote,
  createCapture,
  createObservation,
  deleteObservation,
  deleteProject,
  deleteVoiceNote,
  getBlob,
  getCapture,
  getObservation,
  getReview,
  getSetting,
  getStorageUsage,
  listCaptures,
  listObservations,
  listProjects,
  listReviewsPage,
  listVoiceNotes,
  patchVoiceNote,
  pruneStorage,
  putBlob,
  saveAnnotations,
  saveEdits,
  saveProject,
  setRetention,
  setSetting,
  splitIntoTasks,
  splitObservation,
  updateObservation,
  updateVoiceNoteSegments,
} from './db';
import { badRequest, notFound } from './errors';
import {
  createReview,
  exportAttachmentToDownloads,
  exportReviewToDownloads,
  readAttachmentChunk,
} from './export';
import { base64ToBytes, bytesToBase64 } from './helpers';
import {
  getFindingsSettings,
  getLlmConfig,
  investigateReview,
  judgeDuplicatesWithLlm,
  listLegacyAgents,
  saveLlmConfig,
  setFindingsSettings,
  summarizeObservation,
} from './llm';
import { getRemoteMcpConfig, syncReviewToRemoteMcp } from './mcp-sync';
import {
  cancelSpeechDownload,
  enqueueTranscription,
  getLegacySpeechSettings,
  getSpeechStatus,
  installLocalSpeechModel,
  setLegacySpeechSettings,
} from './speech';
import {
  fileReview,
  findDuplicates,
  getFiling,
  getVibeQ,
  listMembers,
  setVibeQ,
  startSirvant,
} from './vibeq';

export const PROTOCOL_VERSION = 1;

function extensionVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return '1.0.0';
  }
}

const DEFAULT_PRIVACY: PrivacySettings = {
  maskSelectors: [],
  sensitiveHeaders: [],
  sensitivePatterns: [],
};

// In-memory upload buffer for any caller still using chunked `uploadChunk`
const pendingUploads = new Map<string, { chunks: Uint8Array[]; mediaType: string }>();

/** Dispatches any legacy/current Lens RPC Request locally inside the browser extension. */
export async function dispatchRequest(req: Request): Promise<Reply> {
  switch (req.method) {
    case 'hello': {
      const paused = await getSetting<boolean>('collection.paused', false);
      return {
        type: 'hello',
        data: {
          version: extensionVersion(),
          protocol: PROTOCOL_VERSION,
          dataDir: 'IndexedDB (browser)',
          secretStore: { state: 'available' },
          paused,
        },
      };
    }

    case 'setPaused': {
      await setSetting('collection.paused', req.params.paused);
      return { type: 'done' };
    }

    // Observations
    case 'createObservation':
      return { type: 'observation', data: await createObservation(req.params.title, req.params.url) };
    case 'listObservations':
      return { type: 'observations', data: await listObservations() };
    case 'getObservation':
      return { type: 'observation', data: await getObservation(req.params.id) };
    case 'updateObservation':
      return { type: 'observation', data: await updateObservation(req.params) };
    case 'deleteObservation':
      await deleteObservation(req.params.id);
      return { type: 'deleted' };
    case 'splitObservation':
      return {
        type: 'observation',
        data: await splitObservation(
          req.params.observation,
          req.params.revision,
          req.params.findings,
          req.params.title,
        ),
      };
    case 'listIssues': {
      const issues = await getSetting<Issue[]>(`issues.${req.params.observation}`, []);
      return { type: 'issues', data: issues };
    }
    case 'splitIntoTasks':
      return {
        type: 'split',
        data: await splitIntoTasks(req.params.observation, req.params.revision, req.params.issues),
      };

    // Projects
    case 'listProjects':
      return { type: 'projects', data: await listProjects() };
    case 'saveProject':
      return { type: 'project', data: await saveProject(req.params) };
    case 'deleteProject':
      await deleteProject(req.params.id);
      return { type: 'deleted' };

    // Captures
    case 'createCapture':
      return { type: 'capture', data: await createCapture(req.params) };
    case 'listCaptures':
      return { type: 'captures', data: await listCaptures(req.params.observation) };
    case 'getCapture':
      return { type: 'capture', data: await getCapture(req.params.id) };
    case 'saveAnnotations':
      return { type: 'capture', data: await saveAnnotations(req.params.capture, req.params.shapes) };
    case 'saveEdits':
      return { type: 'capture', data: await saveEdits(req.params.capture, req.params.edits) };

    // Blobs
    case 'uploadChunk': {
      const { upload, data, done, mediaType } = req.params;
      const bytes = base64ToBytes(data);
      const entry = pendingUploads.get(upload) ?? { chunks: [], mediaType };
      entry.chunks.push(bytes);
      pendingUploads.set(upload, entry);
      if (!done) return { type: 'uploaded', data: null };
      pendingUploads.delete(upload);
      const total = entry.chunks.reduce((sum, c) => sum + c.byteLength, 0);
      const merged = new Uint8Array(total);
      let pos = 0;
      for (const c of entry.chunks) {
        merged.set(c, pos);
        pos += c.byteLength;
      }
      const ref = await putBlob(merged, mediaType);
      return { type: 'uploaded', data: ref };
    }
    case 'readBlob': {
      const found = await getBlob(req.params.sha256);
      if (!found) throw notFound(`Blob ${req.params.sha256} not found`);
      const slice = found.bytes.subarray(req.params.offset, req.params.offset + req.params.length);
      return {
        type: 'blob',
        data: {
          data: bytesToBase64(slice),
          totalSize: found.bytes.byteLength,
        },
      };
    }

    // Voice notes & Speech
    case 'addVoiceNote': {
      const note = await addVoiceNote(req.params);
      enqueueTranscription(note.id);
      return { type: 'voiceNote', data: note };
    }
    case 'listVoiceNotes':
      return { type: 'voiceNotes', data: await listVoiceNotes(req.params.observation) };
    case 'deleteVoiceNote':
      await deleteVoiceNote(req.params.id);
      return { type: 'deleted' };
    case 'retryVoiceNote': {
      const reset = await patchVoiceNote(req.params.id, { state: 'waiting', detail: null });
      enqueueTranscription(reset.id);
      return { type: 'voiceNote', data: reset };
    }
    case 'updateVoiceNote':
      return { type: 'voiceNote', data: await updateVoiceNoteSegments(req.params.id, req.params.segments) };
    case 'speechStatus':
      return { type: 'speech', data: await getSpeechStatus() };
    case 'installSpeech':
      return { type: 'speech', data: await installLocalSpeechModel() };
    case 'cancelSpeechDownload':
      return { type: 'speech', data: await cancelSpeechDownload() };
    case 'getSpeechSettings':
      return { type: 'speechSettings', data: await getLegacySpeechSettings() };
    case 'setSpeechSettings':
      return { type: 'speechSettings', data: await setLegacySpeechSettings(req.params) };

    // Reviews & Export
    case 'createReview': {
      const review = await createReview(req.params);
      // Fire-and-forget auto-sync to Remote HTTP MCP if configured
      void getRemoteMcpConfig().then((cfg) => {
        if (cfg.enabled && cfg.autoSync && cfg.token) {
          void syncReviewToRemoteMcp(review.id).catch(() => {});
        }
      });
      return { type: 'review', data: review };
    }
    case 'listReviews':
      return { type: 'reviews', data: await listReviewsPage(null, 100, null) };
    case 'listReviewsPage':
      return {
        type: 'reviews',
        data: await listReviewsPage(req.params.before, req.params.limit, req.params.observation),
      };
    case 'getReview':
      return { type: 'review', data: await getReview(req.params.review) };
    case 'exportReview':
      return { type: 'exported', data: await exportReviewToDownloads(req.params.review) };
    case 'exportAttachment':
      return { type: 'attachment', data: await exportAttachmentToDownloads(req.params.review, req.params.capture) };
    case 'readAttachment':
      return {
        type: 'blob',
        data: await readAttachmentChunk(req.params.review, req.params.capture, req.params.offset),
      };

    // Destination & VibeQ
    case 'getDestination': {
      const [choice, vibeq] = await Promise.all([
        getSetting<TaskDestination | null>('task.destination', null),
        getVibeQ(),
      ]);
      const data: DestinationSettings = { choice, vibeqConnected: vibeq.hasToken && Boolean(vibeq.endpoint) };
      return { type: 'destination', data };
    }
    case 'setDestination': {
      const current = await getSetting<TaskDestination | null>('task.destination', null);
      if (!req.params.onlyIfUnset || current === null) {
        await setSetting('task.destination', req.params.choice);
      }
      const [choice, vibeq] = await Promise.all([
        getSetting<TaskDestination | null>('task.destination', null),
        getVibeQ(),
      ]);
      return { type: 'destination', data: { choice, vibeqConnected: vibeq.hasToken && Boolean(vibeq.endpoint) } };
    }
    case 'getVibeQ':
      return { type: 'vibeQ', data: await getVibeQ() };
    case 'setVibeQ':
      return { type: 'vibeQ', data: await setVibeQ(req.params) };
    case 'listMembers':
      return { type: 'members', data: await listMembers() };
    case 'fileReview': {
      const filing = await fileReview(req.params.review, req.params.assignee);
      // Re-sync remote MCP with the newly filed VibeQ task URL if enabled
      void getRemoteMcpConfig().then((cfg) => {
        if (cfg.enabled && cfg.autoSync && cfg.token) {
          void syncReviewToRemoteMcp(req.params.review).catch(() => {});
        }
      });
      return { type: 'filing', data: filing };
    }
    case 'getFiling': {
      const filing = await getFiling(req.params.review);
      if (!filing) throw notFound(`No filing for review ${req.params.review}`);
      return { type: 'filing', data: filing };
    }
    case 'startSirvant':
      return { type: 'sirvant', data: await startSirvant(req.params.review) };
    case 'findDuplicates':
      return { type: 'duplicates', data: await findDuplicates(req.params.observation, judgeDuplicatesWithLlm) };

    // BYOK AI (Anthropic / OpenAI / Gemini)
    case 'listAgents':
      return { type: 'agents', data: await listLegacyAgents() };
    case 'getSummaryAgent': {
      const cfg = await getLlmConfig();
      const mapped = cfg.provider === 'anthropic' ? 'claude' : cfg.provider === 'openai' || cfg.provider === 'gemini' ? 'codex' : null;
      return { type: 'summaryAgent', data: mapped };
    }
    case 'setSummaryAgent': {
      const mapped = req.params.agent === 'claude' ? 'anthropic' : req.params.agent === 'codex' ? 'openai' : null;
      await saveLlmConfig({ provider: mapped });
      return { type: 'done' };
    }
    case 'getFindingsSettings':
      return { type: 'findingsSettings', data: await getFindingsSettings() };
    case 'setFindingsSettings':
      return { type: 'findingsSettings', data: await setFindingsSettings(req.params) };
    case 'summarize':
      return { type: 'summary', data: await summarizeObservation(req.params.observation) };
    case 'investigate':
      return { type: 'suggestion', data: await investigateReview(req.params.review, req.params.agent) };

    // Storage & Privacy
    case 'getStorage':
      return { type: 'storage', data: await getStorageUsage() };
    case 'pruneStorage':
      return { type: 'pruned', data: await pruneStorage(req.params.olderThanDays, req.params.filedOnly) };
    case 'setRetention':
      return { type: 'storage', data: await setRetention(req.params.days, req.params.filedOnly) };
    case 'getPrivacySettings':
      return { type: 'privacySettings', data: await getSetting<PrivacySettings>('privacy.settings', DEFAULT_PRIVACY) };
    case 'setPrivacySettings': {
      const clean: PrivacySettings = {
        maskSelectors: req.params.maskSelectors.slice(0, 100),
        sensitiveHeaders: req.params.sensitiveHeaders.slice(0, 100),
        sensitivePatterns: req.params.sensitivePatterns.slice(0, 100),
      };
      await setSetting('privacy.settings', clean);
      return { type: 'privacySettings', data: clean };
    }

    // Native-only / retired daemon methods (safe no-ops or empty responses)
    case 'announce':
    case 'installService':
    case 'provideEvidence':
      return { type: 'done' };
    case 'setupStatus': {
      const [projects, obs, vibeq, mcp] = await Promise.all([
        listProjects(),
        listObservations(),
        getVibeQ(),
        getRemoteMcpConfig(),
      ]);
      return {
        type: 'setup',
        data: {
          version: extensionVersion(),
          protocol: PROTOCOL_VERSION,
          binary: 'browser-extension',
          service: 'browser',
          browsers: [],
          extensions: [],
          projects: projects.length,
          captures: obs.reduce((s, o) => s + o.captureCount, 0),
          vibeqConfigured: vibeq.hasToken && Boolean(vibeq.endpoint),
          codingAgentsConnected: mcp.enabled && Boolean(mcp.token),
          steps: [],
        },
      };
    }
    case 'setupPage':
      return { type: 'setupPage', data: '' };
    case 'connectAgents':
    case 'disconnectAgents':
      return { type: 'agentSetup', data: [] };
    case 'listHandoffApps':
      return { type: 'handoffApps', data: [] };
    case 'handOff':
      throw badRequest('Local CLI handoff was replaced by Remote HTTP MCP and copyable prompts.');
    case 'getUpdates':
    case 'setAutomaticUpdates':
    case 'updateNow':
    case 'checkUpdates':
      return {
        type: 'updates',
        data: {
          current: extensionVersion(),
          available: null,
          checkedAt: null,
          automatic: true,
          managedBy: 'Browser Web Store',
          lastError: null,
        },
      };
    case 'getVideoTools':
    case 'installVideoTools':
      return {
        type: 'videoTools',
        data: {
          ready: false,
          installing: false,
          node: false,
          ffmpeg: false,
          detail: 'Use Video mode while recording to save WebM directly.',
          progress: null,
        },
      };
    case 'recentEvidence':
      return { type: 'liveEvidence', data: [] };
    case 'waitForAsk':
      return { type: 'ask', data: null };
    case 'shutdown':
      return { type: 'stopping' };
  }
}

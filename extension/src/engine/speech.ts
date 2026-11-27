import type { SpeechSettings } from '@/protocol/SpeechSettings';
import type { SpeechStatus } from '@/protocol/SpeechStatus';
import type { VoiceSegment } from '@/protocol/VoiceSegment';
import { getBlob, getSetting, getVoiceNote, patchVoiceNote, setSetting } from './db';

export type SpeechBackend = 'local' | 'openai' | 'groq';

export interface SpeechConfig {
  backend: SpeechBackend;
  model: string;
  language: string | null;
  prompt: string | null;
  openaiApiKey: string;
  groqApiKey: string;
}

export interface LocalSpeechModelSpec {
  engine: 'parakeet' | 'whisper';
  repo: string;
  label: string;
  bytes: number;
}

export const LOCAL_SPEECH_MODELS: Record<string, LocalSpeechModelSpec> = {
  'parakeet-v3': {
    engine: 'parakeet',
    repo: 'parakeet-tdt-0.6b-v3',
    label: 'NVIDIA Parakeet TDT 0.6B v3 (25 EU languages · ~650 MB — fastest & best)',
    bytes: 650_000_000,
  },
  'parakeet-v2': {
    engine: 'parakeet',
    repo: 'parakeet-tdt-0.6b-v2',
    label: 'NVIDIA Parakeet TDT 0.6B v2 (English · ~650 MB — top English accuracy)',
    bytes: 650_000_000,
  },
  base: {
    engine: 'whisper',
    repo: 'onnx-community/whisper-base',
    label: 'Whisper base (99 languages · ~75 MB — lightweight)',
    bytes: 75_000_000,
  },
  small: {
    engine: 'whisper',
    repo: 'onnx-community/whisper-small',
    label: 'Whisper small (99 languages · ~215 MB)',
    bytes: 215_000_000,
  },
  tiny: {
    engine: 'whisper',
    repo: 'onnx-community/whisper-tiny',
    label: 'Whisper tiny (99 languages · ~45 MB)',
    bytes: 45_000_000,
  },
};

/** Alias kept for any callers referencing the previous export name. */
export const LOCAL_WHISPER_MODELS = LOCAL_SPEECH_MODELS;

function isFirefoxBrowser(): boolean {
  if ((import.meta.env as { FIREFOX?: unknown } | undefined)?.FIREFOX === true) return true;
  return typeof navigator !== 'undefined' && /Firefox\//i.test(navigator.userAgent ?? '');
}

export function defaultLocalSpeechModel(): string {
  // Firefox shares a single WebExtensions process across all extension tabs and lacks WebGPU stability for 650 MB+ ONNX graphs;
  // default Firefox to lightweight Whisper base (~75 MB) while keeping Parakeet TDT 0.6B v3 as default on Chromium.
  return isFirefoxBrowser() ? 'base' : 'parakeet-v3';
}

const DEFAULT_SPEECH_CONFIG: SpeechConfig = {
  backend: 'local',
  model: 'parakeet-v3',
  language: null,
  prompt: null,
  openaiApiKey: '',
  groqApiKey: '',
};

interface ParakeetLike {
  encoderSession?: { release?: () => Promise<void> | void };
  joinerSession?: { release?: () => Promise<void> | void };
  transcribe(audio: Float32Array, sampleRate: number, opts?: Record<string, unknown>): Promise<{
    utterance_text?: string;
    words?: Array<{ text: string; start_time: number; end_time: number }>;
  }>;
  transcribeLongAudio?(audio: Float32Array, sampleRate: number, opts?: Record<string, unknown>): Promise<{
    utterance_text?: string;
    words?: Array<{ text: string; start_time: number; end_time: number }>;
  }>;
}

interface WhisperPipeLike {
  (audio: Float32Array, options?: Record<string, unknown>): Promise<unknown>;
  dispose?: () => Promise<void> | void;
}

let modelState: SpeechStatus['model'] = { state: 'missing' };
let loadedModelKey: string | null = null;
let loadedWhisper: WhisperPipeLike | null = null;
let loadedParakeet: ParakeetLike | null = null;
let loadingPromise: Promise<void> | null = null;
let idleReleaseTimer: ReturnType<typeof setTimeout> | null = null;
let cancelRequested = false;

/** Releases compiled ONNX Runtime sessions so Firefox's shared WebExtensions process does not OOM across tabs. */
export async function releaseLoadedSpeechModels(): Promise<void> {
  if (idleReleaseTimer) {
    clearTimeout(idleReleaseTimer);
    idleReleaseTimer = null;
  }
  const parakeet = loadedParakeet;
  const whisper = loadedWhisper;
  loadedParakeet = null;
  loadedWhisper = null;
  loadedModelKey = null;
  try {
    await parakeet?.encoderSession?.release?.();
  } catch {
    // ignore release errors
  }
  try {
    await parakeet?.joinerSession?.release?.();
  } catch {
    // ignore release errors
  }
  try {
    await whisper?.dispose?.();
  } catch {
    // ignore dispose errors
  }
}

function scheduleIdleRelease(): void {
  if (idleReleaseTimer) clearTimeout(idleReleaseTimer);
  idleReleaseTimer = setTimeout(() => {
    idleReleaseTimer = null;
    if (transcriptionQueueRunning) return;
    void releaseLoadedSpeechModels();
  }, 60_000);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => {
    void releaseLoadedSpeechModels();
  });
}

let webGpuCache: Promise<{ ok: boolean; f16: boolean }> | null = null;

async function detectWebGpu(): Promise<{ ok: boolean; f16: boolean }> {
  // Firefox's experimental wgpu backend can crash tabs or GPU processes on large ONNX compute shaders; stick to WASM on Firefox.
  if (isFirefoxBrowser()) return { ok: false, f16: false };
  if (webGpuCache) return webGpuCache;
  webGpuCache = (async () => {
    try {
      const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features?: Set<string> } | null> } }) : null;
      if (!nav?.gpu) return { ok: false, f16: false };
      const adapter = await nav.gpu.requestAdapter();
      if (!adapter) return { ok: false, f16: false };
      return { ok: true, f16: Boolean(adapter.features?.has('shader-f16')) };
    } catch {
      return { ok: false, f16: false };
    }
  })();
  return webGpuCache;
}

function resolveLocalModel(key: string): LocalSpeechModelSpec & { key: string } {
  const fallback = defaultLocalSpeechModel();
  const normalized = key in LOCAL_SPEECH_MODELS ? key : key === 'large-v3-turbo' ? fallback : fallback;
  return { key: normalized, ...LOCAL_SPEECH_MODELS[normalized]! };
}

export async function getSpeechConfig(): Promise<SpeechConfig> {
  const saved = await getSetting<Partial<SpeechConfig> | null>('speech.config', null);
  return {
    backend: saved?.backend ?? DEFAULT_SPEECH_CONFIG.backend,
    model: saved?.model ?? defaultLocalSpeechModel(),
    language: saved?.language ?? null,
    prompt: saved?.prompt ?? null,
    openaiApiKey: saved?.openaiApiKey ?? '',
    groqApiKey: saved?.groqApiKey ?? '',
  };
}

export async function saveSpeechConfig(patch: Partial<SpeechConfig>): Promise<SpeechConfig> {
  const cur = await getSpeechConfig();
  const next: SpeechConfig = {
    backend: patch.backend ?? cur.backend,
    model: patch.model ?? cur.model,
    language: patch.language !== undefined ? patch.language : cur.language,
    prompt: patch.prompt !== undefined ? patch.prompt : cur.prompt,
    openaiApiKey: patch.openaiApiKey !== undefined ? patch.openaiApiKey.trim() : cur.openaiApiKey,
    groqApiKey: patch.groqApiKey !== undefined ? patch.groqApiKey.trim() : cur.groqApiKey,
  };
  await setSetting('speech.config', next);
  if (next.backend === 'local' && next.model !== cur.model) {
    await releaseLoadedSpeechModels();
    modelState = { state: 'missing' };
  }
  return next;
}

export async function getLegacySpeechSettings(): Promise<SpeechSettings> {
  const cfg = await getSpeechConfig();
  return { model: cfg.model, language: cfg.language, prompt: cfg.prompt };
}

export async function setLegacySpeechSettings(settings: SpeechSettings): Promise<SpeechSettings> {
  const saved = await saveSpeechConfig({
    model: settings.model,
    language: settings.language,
    prompt: settings.prompt,
  });
  return { model: saved.model, language: saved.language, prompt: saved.prompt };
}

export async function getSpeechStatus(): Promise<SpeechStatus> {
  const cfg = await getSpeechConfig();
  if (cfg.backend === 'openai') {
    const ready = Boolean(cfg.openaiApiKey);
    return {
      model: ready ? { state: 'ready' } : { state: 'failed', reason: 'Add your OpenAI API key in Settings.' },
      engines: ['OpenAI Cloud STT'],
      modelName: cfg.model || 'whisper-1',
      downloadBytes: 0,
    };
  }
  if (cfg.backend === 'groq') {
    const ready = Boolean(cfg.groqApiKey);
    return {
      model: ready ? { state: 'ready' } : { state: 'failed', reason: 'Add your Groq API key in Settings.' },
      engines: ['Groq Cloud STT'],
      modelName: cfg.model || 'whisper-large-v3-turbo',
      downloadBytes: 0,
    };
  }

  const info = resolveLocalModel(cfg.model);
  const cachedReady = await getSetting<boolean>(`speech.cached.${info.key}`, false);
  const loaded = loadedModelKey === info.key && (loadedWhisper !== null || loadedParakeet !== null);
  const effectiveState = loaded
    ? { state: 'ready' as const }
    : modelState.state === 'downloading'
      ? modelState
      : cachedReady
        ? { state: 'ready' as const }
        : modelState;

  const gpu = await detectWebGpu();
  return {
    model: effectiveState,
    engines: gpu.ok ? ['WebGPU', 'WASM'] : ['WASM'],
    modelName: info.label,
    downloadBytes: info.bytes,
  };
}

export async function installLocalSpeechModel(keepLoaded = false): Promise<SpeechStatus> {
  const cfg = await getSpeechConfig();
  if (cfg.backend !== 'local') return getSpeechStatus();
  const info = resolveLocalModel(cfg.model);
  if (keepLoaded && loadedModelKey === info.key && (loadedWhisper || loadedParakeet)) {
    modelState = { state: 'ready' };
    return getSpeechStatus();
  }
  if (!keepLoaded && (await getSetting<boolean>(`speech.cached.${info.key}`, false))) {
    modelState = { state: 'ready' };
    return getSpeechStatus();
  }
  if (!loadingPromise) {
    cancelRequested = false;
    modelState = { state: 'downloading', received: 0, total: info.bytes };
    const loader =
      info.engine === 'parakeet'
        ? loadParakeetModel(info.key, info.repo, info.bytes, keepLoaded)
        : loadWhisperPipeline(info.key, info.repo, info.bytes, keepLoaded);
    loadingPromise = loader.finally(() => {
      loadingPromise = null;
    });
  }
  return getSpeechStatus();
}

export async function cancelSpeechDownload(): Promise<SpeechStatus> {
  cancelRequested = true;
  modelState = { state: 'missing' };
  return getSpeechStatus();
}

function revokeParakeetUrls(urls: Record<string, string | null | undefined> | undefined): void {
  if (!urls || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  for (const val of Object.values(urls)) {
    if (typeof val === 'string' && val.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(val);
      } catch {
        // ignore
      }
    }
  }
}

async function loadParakeetModel(key: string, repo: string, fallbackBytes: number, keepLoaded: boolean): Promise<void> {
  try {
    const { getParakeetModel, ParakeetModel } = await import('parakeet.js');
    const wasmPaths =
      typeof browser !== 'undefined' && browser.runtime?.getURL
        ? browser.runtime.getURL('/ort-parakeet/' as '/')
        : undefined;

    const fileTotals = new Map<string, { loaded: number; total: number }>();
    const progress = (p: { file?: string; loaded?: number; total?: number }) => {
      if (cancelRequested) return;
      if (p.file && typeof p.loaded === 'number') {
        fileTotals.set(p.file, { loaded: p.loaded, total: p.total ?? p.loaded });
        let received = 0;
        let total = 0;
        for (const entry of fileTotals.values()) {
          received += entry.loaded;
          total += entry.total;
        }
        modelState = { state: 'downloading', received, total: Math.max(total, fallbackBytes) };
      }
    };

    const gpu = await detectWebGpu();
    const useGpu = gpu.ok && gpu.f16;
    const downloadAndBuild = async (backend: 'webgpu-hybrid' | 'wasm', encoderQuant: 'fp16' | 'int8') => {
      const downloaded = await getParakeetModel(repo, {
        backend,
        encoderQuant,
        decoderQuant: 'int8',
        preprocessorBackend: 'js',
        progress,
      });
      try {
        if (!keepLoaded || cancelRequested) return null;
        return (await ParakeetModel.fromUrls({
          ...downloaded.urls,
          filenames: downloaded.filenames,
          preprocessorBackend: downloaded.preprocessorBackend,
          backend,
          wasmPaths,
          cpuThreads: 1,
        })) as unknown as ParakeetLike;
      } finally {
        // Always revoke the 652 MB / 1.24 GB blob URLs once cached/loaded so they are never pinned in RAM.
        revokeParakeetUrls(downloaded.urls as Record<string, string | null | undefined>);
      }
    };

    let model: ParakeetLike | null;
    if (useGpu) {
      try {
        model = await downloadAndBuild('webgpu-hybrid', 'fp16');
      } catch {
        model = await downloadAndBuild('wasm', 'int8');
      }
    } else {
      model = await downloadAndBuild('wasm', 'int8');
    }

    if (cancelRequested) {
      await model?.encoderSession?.release?.();
      await model?.joinerSession?.release?.();
      modelState = { state: 'missing' };
      return;
    }

    await releaseLoadedSpeechModels();
    if (keepLoaded && model) {
      loadedParakeet = model;
      loadedModelKey = key;
    }
    modelState = { state: 'ready' };
    await setSetting(`speech.cached.${key}`, true);
  } catch (error) {
    modelState = { state: 'failed', reason: (error as Error).message };
    throw error;
  }
}

async function loadWhisperPipeline(key: string, repo: string, fallbackBytes: number, keepLoaded: boolean): Promise<void> {
  try {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    // Point ONNX Runtime Web at our bundled /ort/ loader + WASM so MV3 CSP never fetches from cdn.jsdelivr.net.
    const wasm = (env.backends as { onnx?: { wasm?: Record<string, unknown> } }).onnx?.wasm;
    if (wasm && typeof browser !== 'undefined' && browser.runtime?.getURL) {
      const ortBase = browser.runtime.getURL('/ort/' as '/');
      wasm.wasmPaths = {
        mjs: `${ortBase}ort-wasm-simd-threaded.asyncify.mjs`,
        wasm: `${ortBase}ort-wasm-simd-threaded.asyncify.wasm`,
      };
      wasm.numThreads = 1;
      wasm.proxy = false;
    }

    const fileTotals = new Map<string, { loaded: number; total: number }>();
    const progress_callback = (progress: { file?: string; loaded?: number; total?: number }) => {
      if (cancelRequested) return;
      if (progress.file && typeof progress.loaded === 'number') {
        fileTotals.set(progress.file, {
          loaded: progress.loaded,
          total: progress.total ?? progress.loaded,
        });
        let downloaded = 0;
        let total = 0;
        for (const entry of fileTotals.values()) {
          downloaded += entry.loaded;
          total += entry.total;
        }
        modelState = {
          state: 'downloading',
          received: downloaded,
          total: Math.max(total, fallbackBytes),
        };
      }
    };

    const tryLoad = async (device: 'webgpu' | 'wasm') => {
      const dtype = device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';
      return pipeline('automatic-speech-recognition', repo, {
        device,
        dtype,
        progress_callback,
      } as Record<string, unknown>);
    };

    const gpu = await detectWebGpu();
    let pipe: WhisperPipeLike;
    if (gpu.ok) {
      try {
        pipe = (await tryLoad('webgpu')) as unknown as WhisperPipeLike;
      } catch {
        pipe = (await tryLoad('wasm')) as unknown as WhisperPipeLike;
      }
    } else {
      pipe = (await tryLoad('wasm')) as unknown as WhisperPipeLike;
    }

    if (cancelRequested) {
      await pipe.dispose?.();
      modelState = { state: 'missing' };
      return;
    }

    await releaseLoadedSpeechModels();
    if (keepLoaded) {
      loadedWhisper = pipe;
      loadedModelKey = key;
    } else {
      // Download-only (from Settings): release the ONNX session immediately so Settings holds 0 MB of model RAM.
      await pipe.dispose?.();
    }
    modelState = { state: 'ready' };
    await setSetting(`speech.cached.${key}`, true);
  } catch (error) {
    modelState = { state: 'failed', reason: (error as Error).message };
    throw error;
  }
}

/** Groups Parakeet word-level timestamps into readable sentence/pause VoiceSegments. */
export function wordsToSegments(
  words: Array<{ text: string; start_time: number; end_time: number }>,
  fallbackText: string,
  durationMs: number,
): VoiceSegment[] {
  if (!words.length) {
    return fallbackText.trim()
      ? [{ startMs: 0, endMs: Math.max(1000, durationMs), text: fallbackText.trim(), corrected: false }]
      : [];
  }
  const segments: VoiceSegment[] = [];
  let buf: string[] = [];
  let start = words[0]!.start_time;
  let end = words[0]!.end_time;

  const flush = () => {
    const text = buf.join(' ').replace(/\s+([.,!?;:])/g, '$1').trim();
    if (text) {
      segments.push({
        startMs: Math.max(0, Math.round(start * 1000)),
        endMs: Math.max(0, Math.round(end * 1000)),
        text,
        corrected: false,
      });
    }
    buf = [];
  };

  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    const gap = buf.length > 0 ? w.start_time - end : 0;
    if (buf.length > 0 && (gap >= 1.2 || end - start >= 12)) {
      flush();
      start = w.start_time;
    }
    if (buf.length === 0) start = w.start_time;
    buf.push(w.text.trim());
    end = w.end_time;
    if (/[.!?]$/.test(w.text.trim()) && buf.length >= 4) {
      flush();
    }
  }
  flush();
  return segments;
}

/** Decodes a PCM16/IEEE-float WAV buffer into mono 16 kHz Float32Array without AudioContext. */
export function decodeWavToMono16k(bytes: Uint8Array): Float32Array {
  if (bytes.length < 44) return new Float32Array(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let channels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let audioFormat = 1;
  let dataStart = 44;
  let dataLen = bytes.length - 44;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 8 + 16 <= bytes.length) {
      audioFormat = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true) || 1;
      sampleRate = view.getUint32(offset + 12, true) || 16000;
      bitsPerSample = view.getUint16(offset + 22, true) || 16;
    } else if (id === 'data') {
      dataStart = offset + 8;
      dataLen = Math.min(size, bytes.length - dataStart);
      break;
    }
    offset += 8 + size + (size % 2);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLen / (bytesPerSample * channels));
  const mono = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      const pos = dataStart + (i * channels + ch) * bytesPerSample;
      if (audioFormat === 3 && bitsPerSample === 32) {
        sum += view.getFloat32(pos, true);
      } else if (bitsPerSample === 16) {
        sum += view.getInt16(pos, true) / 32768;
      } else if (bitsPerSample === 8) {
        sum += (bytes[pos]! - 128) / 128;
      }
    }
    mono[i] = sum / channels;
  }

  if (sampleRate === 16000 || frameCount === 0) return mono;
  const targetLen = Math.max(1, Math.round((frameCount * 16000) / sampleRate));
  const out = new Float32Array(targetLen);
  const ratio = sampleRate / 16000;
  for (let i = 0; i < targetLen; i += 1) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(frameCount - 1, i0 + 1);
    const frac = src - i0;
    out[i] = mono[i0]! * (1 - frac) + mono[i1]! * frac;
  }
  return out;
}

async function transcribeWithCloudApi(
  backend: 'openai' | 'groq',
  apiKey: string,
  model: string,
  language: string | null,
  prompt: string | null,
  wavBytes: Uint8Array<ArrayBuffer>,
  durationMs: number,
): Promise<{ language: string | null; segments: VoiceSegment[] }> {
  const endpoint =
    backend === 'groq'
      ? 'https://api.groq.com/openai/v1/audio/transcriptions'
      : 'https://api.openai.com/v1/audio/transcriptions';
  const defaultModel = backend === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';

  const form = new FormData();
  form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'voice.wav');
  form.append('model', model || defaultModel);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`${backend === 'groq' ? 'Groq' : 'OpenAI'} STT failed (${res.status}): ${err.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    language?: string;
    text?: string;
    segments?: Array<{ start?: number; end?: number; text?: string }>;
  };

  const segments: VoiceSegment[] = (data.segments ?? [])
    .map((s) => ({
      startMs: Math.max(0, Math.round((s.start ?? 0) * 1000)),
      endMs: Math.max(0, Math.round((s.end ?? 0) * 1000)),
      text: String(s.text ?? '').trim(),
      corrected: false,
    }))
    .filter((s) => s.text.length > 0);

  if (segments.length === 0 && data.text?.trim()) {
    segments.push({ startMs: 0, endMs: Math.max(1000, durationMs), text: data.text.trim(), corrected: false });
  }
  return { language: data.language ?? language, segments };
}

async function transcribeLocally(
  cfg: SpeechConfig,
  wavBytes: Uint8Array<ArrayBuffer>,
  durationMs: number,
): Promise<{ language: string | null; segments: VoiceSegment[] }> {
  const info = resolveLocalModel(cfg.model);
  if (loadedModelKey !== info.key || (!loadedWhisper && !loadedParakeet)) {
    await installLocalSpeechModel(true);
    if (loadingPromise) await loadingPromise;
  }

  const pcm = decodeWavToMono16k(wavBytes);
  if (pcm.length === 0) return { language: cfg.language, segments: [] };

  try {
    if (info.engine === 'parakeet') {
      if (!loadedParakeet) throw new Error('Parakeet model is not loaded.');
      const res = loadedParakeet.transcribeLongAudio
        ? await loadedParakeet.transcribeLongAudio(pcm, 16000, { returnTimestamps: true })
        : await loadedParakeet.transcribe(pcm, 16000, { returnTimestamps: true });
      const segments = wordsToSegments(res.words ?? [], res.utterance_text ?? '', durationMs);
      return { language: info.key === 'parakeet-v2' ? 'en' : cfg.language, segments };
    }

    if (!loadedWhisper) throw new Error('Whisper model is not loaded.');
    const result = (await loadedWhisper(pcm, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      ...(cfg.language ? { language: cfg.language, task: 'transcribe' } : {}),
    })) as {
      text?: string;
      chunks?: Array<{ timestamp?: [number | null, number | null]; text?: string }>;
    };

    const segments: VoiceSegment[] = (result.chunks ?? [])
      .map((ch) => {
        const startSec = ch.timestamp?.[0] ?? 0;
        const endSec = ch.timestamp?.[1] ?? durationMs / 1000;
        return {
          startMs: Math.max(0, Math.round(startSec * 1000)),
          endMs: Math.max(0, Math.round(endSec * 1000)),
          text: String(ch.text ?? '').trim(),
          corrected: false,
        };
      })
      .filter((s) => s.text.length > 0);

    if (segments.length === 0 && result.text?.trim()) {
      segments.push({ startMs: 0, endMs: Math.max(1000, durationMs), text: result.text.trim(), corrected: false });
    }
    return { language: cfg.language, segments };
  } finally {
    // On Firefox, immediately release large Parakeet sessions after transcribing to keep WebExtensions RAM low.
    if (isFirefoxBrowser() && info.engine === 'parakeet') {
      void releaseLoadedSpeechModels();
    } else {
      scheduleIdleRelease();
    }
  }
}

const queuedTranscriptions = new Set<number>();
const transcriptionQueue: number[] = [];
let transcriptionQueueRunning = false;

async function runWithSpeechLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('sirv-lens-speech-transcribe', fn);
  }
  return fn();
}

async function drainTranscriptionQueue(): Promise<void> {
  if (transcriptionQueueRunning) return;
  transcriptionQueueRunning = true;
  try {
    while (transcriptionQueue.length > 0) {
      const voiceNoteId = transcriptionQueue.shift()!;
      try {
        await runWithSpeechLock(async () => {
          const note = await getVoiceNote(voiceNoteId);
          // Another tab (e.g. replay.html vs review.html) may have already transcribed or started this note.
          if (note.state === 'done' || note.state === 'transcribing') return;
          const blob = await getBlob(note.audio.sha256);
          if (!blob) throw new Error('Audio blob missing');
          const cfg = await getSpeechConfig();

          await patchVoiceNote(voiceNoteId, { state: 'transcribing', detail: null });

          let out: { language: string | null; segments: VoiceSegment[] };
          if (cfg.backend === 'openai') {
            if (!cfg.openaiApiKey) throw new Error('Add your OpenAI API key in Settings → Voice notes.');
            out = await transcribeWithCloudApi('openai', cfg.openaiApiKey, cfg.model, cfg.language, cfg.prompt, blob.bytes, note.durationMs);
          } else if (cfg.backend === 'groq') {
            if (!cfg.groqApiKey) throw new Error('Add your Groq API key in Settings → Voice notes.');
            out = await transcribeWithCloudApi('groq', cfg.groqApiKey, cfg.model, cfg.language, cfg.prompt, blob.bytes, note.durationMs);
          } else {
            out = await transcribeLocally(cfg, blob.bytes, note.durationMs);
          }

          await patchVoiceNote(voiceNoteId, {
            state: 'done',
            language: out.language,
            segments: out.segments,
            detail: null,
          });
        });
      } catch (error) {
        await patchVoiceNote(voiceNoteId, {
          state: 'failed',
          detail: (error as Error).message,
        }).catch(() => {});
      } finally {
        queuedTranscriptions.delete(voiceNoteId);
      }
    }
  } finally {
    transcriptionQueueRunning = false;
  }
}

/** Schedules serialized asynchronous transcription for a saved VoiceNote (avoids concurrent ONNX/WASM OOM). */
export function enqueueTranscription(voiceNoteId: number): void {
  if (queuedTranscriptions.has(voiceNoteId)) return;
  queuedTranscriptions.add(voiceNoteId);
  transcriptionQueue.push(voiceNoteId);
  void drainTranscriptionQueue();
}

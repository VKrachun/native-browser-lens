// Tab video: records the chosen tab/window via getDisplayMedia (no extension permissions needed),
// capped at 200 MiB WebM, so canvas, WebGL and video elements appear in the review alongside rrweb.
// Includes tab audio (when shared) and optionally mixes in the microphone so exported WebMs have sound.

export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export interface RecordedVideo {
  startedAt: number;
  truncated: boolean;
  webm: Blob;
}

export interface VideoRecording {
  startedAt: number;
  stop(): Promise<RecordedVideo>;
  cancel(): void;
}

export interface RecordTabVideoOptions {
  /** Mix microphone audio into the WebM recording (e.g. when "Record my voice" is enabled). */
  includeMic?: boolean;
  /** Request tab/system audio from getDisplayMedia when supported by the browser (default true). */
  includeTabAudio?: boolean;
}

/** The person cancelled Chrome/Firefox's screen-sharing picker. */
export class VideoCancelled extends Error {}

function buildMixedStream(
  displayStream: MediaStream,
  micStream: MediaStream | null,
): { stream: MediaStream; cleanup: () => void } {
  const videoTracks = displayStream.getVideoTracks();
  const displayAudio = typeof displayStream.getAudioTracks === 'function' ? displayStream.getAudioTracks() : [];
  const micAudio = micStream && typeof micStream.getAudioTracks === 'function' ? micStream.getAudioTracks() : [];
  const allAudio = [...displayAudio, ...micAudio];

  if (allAudio.length === 0) {
    return { stream: displayStream, cleanup: () => {} };
  }

  // Single audio source (just mic or just tab audio): attach directly without AudioContext overhead.
  if (allAudio.length === 1 || typeof AudioContext === 'undefined' || typeof MediaStream === 'undefined') {
    const stream =
      typeof MediaStream !== 'undefined'
        ? new MediaStream([...videoTracks, allAudio[0]!])
        : displayStream;
    return { stream, cleanup: () => {} };
  }

  // Both tab audio and microphone are present: mix them into a single audio track so MediaRecorder captures both.
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  for (const track of allAudio) {
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    src.connect(dest);
  }
  const mixedAudio = dest.stream.getAudioTracks();
  const stream = new MediaStream([...videoTracks, ...mixedAudio]);
  return {
    stream,
    cleanup: () => {
      for (const t of mixedAudio) t.stop();
      void ctx.close().catch(() => {});
    },
  };
}

export async function recordTabVideo(options: RecordTabVideoOptions = {}): Promise<VideoRecording> {
  const includeTabAudio = options.includeTabAudio ?? true;
  const includeMic = options.includeMic ?? false;

  const videoConstraints = {
    width: { max: 1920 },
    height: { max: 1080 },
    frameRate: { ideal: 15, max: 15 },
  };
  const baseDisplayOpts = {
    video: videoConstraints,
    // Exclude the extension's own side panel from the picker so the person shares the web page tab.
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
  };

  let displayStream: MediaStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      audio: includeTabAudio,
      ...baseDisplayOpts,
    } as DisplayMediaStreamOptions);
  } catch (error) {
    const name = (error as DOMException).name;
    if (name === 'NotAllowedError' || name === 'AbortError') {
      throw new VideoCancelled((error as Error).message);
    }
    // Some platforms/browsers (e.g. Firefox Linux Wayland window capture) reject audio: true on getDisplayMedia;
    // fall back cleanly to video-only display capture (mic can still be mixed in below).
    if (!includeTabAudio) throw error;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        ...baseDisplayOpts,
      } as DisplayMediaStreamOptions);
    } catch (retryError) {
      const retryName = (retryError as DOMException).name;
      if (retryName === 'NotAllowedError' || retryName === 'AbortError') {
        throw new VideoCancelled((retryError as Error).message);
      }
      throw retryError;
    }
  }

  let micStream: MediaStream | null = null;
  if (includeMic && typeof navigator.mediaDevices.getUserMedia === 'function') {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      // Non-fatal: continue recording tab video (+ tab audio if present) even if microphone is unavailable.
      micStream = null;
    }
  }

  const { stream: recordStream, cleanup: cleanupMixer } = buildMixedStream(displayStream, micStream);
  const hasAudio =
    (typeof recordStream.getAudioTracks === 'function' ? recordStream.getAudioTracks().length : 0) > 0;

  const candidates = hasAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mimeType = candidates.find(
    (type) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type),
  );
  const recorder = new MediaRecorder(recordStream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: 1_500_000,
    ...(hasAudio ? { audioBitsPerSecond: 128_000 } : {}),
  });
  const chunks: Blob[] = [];
  let bytes = 0;
  let truncated = false;
  const release = () => {
    cleanupMixer();
    displayStream.getTracks().forEach((track) => track.stop());
    micStream?.getTracks().forEach((track) => track.stop());
  };
  const ended = new Promise<void>((done) => {
    recorder.onstop = () => done();
  });

  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    chunks.push(event.data);
    bytes += event.data.size;
    if (bytes > MAX_VIDEO_BYTES && recorder.state !== 'inactive') {
      truncated = true;
      recorder.stop();
    }
  };

  // If the person clicks the browser's own "Stop sharing" bar mid-recording, keep everything filmed so far.
  for (const track of displayStream.getVideoTracks()) {
    track.onended = () => {
      if (recorder.state !== 'inactive') recorder.stop();
    };
  }

  try {
    await new Promise((started, fail) => {
      recorder.onstart = started;
      recorder.onerror = (event) => fail((event as ErrorEvent).error ?? new Error('The video recorder failed'));
      recorder.start(1000);
    });
  } catch (error) {
    release();
    throw error;
  }

  const startedAt = Date.now();
  return {
    startedAt,
    cancel: () => {
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
    stop: async () => {
      if (recorder.state !== 'inactive') recorder.stop();
      await ended;
      release();
      return { startedAt, truncated, webm: new Blob(chunks, { type: 'video/webm' }) };
    },
  };
}

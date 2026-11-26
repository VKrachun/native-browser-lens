// Tab video: records the chosen tab/window via getDisplayMedia (no extension permissions needed),
// capped at 200 MiB WebM, so canvas, WebGL and video elements appear in the review alongside rrweb.

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

/** The person cancelled Chrome/Firefox's screen-sharing picker. */
export class VideoCancelled extends Error {}

export async function recordTabVideo(): Promise<VideoRecording> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: {
        width: { max: 1920 },
        height: { max: 1080 },
        frameRate: { ideal: 15, max: 15 },
      },
      // Exclude the extension's own side panel from the picker so the person shares the web page tab.
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
    } as DisplayMediaStreamOptions);
  } catch (error) {
    const name = (error as DOMException).name;
    if (name === 'NotAllowedError' || name === 'AbortError') {
      throw new VideoCancelled((error as Error).message);
    }
    throw error;
  }

  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
    (type) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type),
  );
  const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 1_500_000 });
  const chunks: Blob[] = [];
  let bytes = 0;
  let truncated = false;
  const release = () => stream.getTracks().forEach((track) => track.stop());
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
  for (const track of stream.getVideoTracks()) {
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

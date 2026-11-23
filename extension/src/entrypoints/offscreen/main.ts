// Chrome: the microphone of a Record mode session lives here, not in the side panel, so closing
// the panel does not end it. The background starts and stops it; nothing else talks to this page.
import { OFFSCREEN_PART_BYTES, type OffscreenRequest, type OffscreenReply } from '@/messages';
import { MicrophoneBlocked, record, type Recording } from '@/voice';

let current: Recording | null = null;
/** The WAV of the last Stop, until the background has read all of its parts. */
let stopped: { id: number; startedAt: number; wav: Uint8Array } | null = null;
let stops = 0;
/** Counts starts and cancels: a start that one of them overtook lets its microphone go. */
let starts = 0;

/** Video mode: the tab filmed as WebM, at most this many bytes; past it the video ends there. */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
type Filming = { recorder: MediaRecorder; ended: Promise<unknown>; release(): void; chunks: Blob[]; bytes: number; startedAt: number; truncated: boolean };
let filming: Filming | null = null;
/** The WebM of the last video Stop, until the background has read all of its parts. */
let film: { id: number; startedAt: number; webm: Uint8Array; truncated: boolean } | null = null;
let films = 0;

async function startFilming(streamId: string): Promise<Filming> {
  // Chrome's own constraints for a tabCapture stream: no standard name exists for them.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 15 } },
  } as unknown as MediaStreamConstraints);
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_500_000 });
  const release = () => stream.getTracks().forEach((track) => track.stop());
  const filming: Filming = { recorder, release, ended: new Promise((done) => (recorder.onstop = done)), chunks: [], bytes: 0, startedAt: 0, truncated: false };
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    filming.chunks.push(event.data);
    filming.bytes += event.data.size;
    if (filming.bytes > MAX_VIDEO_BYTES && recorder.state !== 'inactive') {
      filming.truncated = true;
      recorder.stop();
    }
  };
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
  filming.startedAt = Date.now();
  return filming;
}

/** Ends the video; a recorder that ended by itself (the tab closed, the size limit) keeps what it wrote. */
async function endFilming(filming: Filming): Promise<Blob> {
  if (filming.recorder.state !== 'inactive') filming.recorder.stop();
  await filming.ended;
  filming.release();
  return new Blob(filming.chunks, { type: 'video/webm' });
}

/** Bytes from `offset` on, in base64: extension messages carry JSON only, and at most 64 MiB. */
function part(bytes: Uint8Array, offset: number): string {
  const slice = bytes.subarray(offset, offset + OFFSCREEN_PART_BYTES);
  let binary = '';
  for (let i = 0; i < slice.length; i += 0x8000) binary += String.fromCharCode(...slice.subarray(i, i + 0x8000));
  return btoa(binary);
}

browser.runtime.onMessage.addListener((message: OffscreenRequest, _sender, reply) => {
  if (message?.target !== 'offscreen') return;
  handle(message).then(reply, (error: Error) => reply({ ok: false, error: error.message } satisfies OffscreenReply));
  return true;
});

async function handle(message: OffscreenRequest): Promise<OffscreenReply> {
  switch (message.kind) {
    case 'mic-start': {
      current?.cancel();
      current = stopped = null;
      const start = ++starts;
      try {
        const started = await record();
        // A cancel or another start came while the microphone started: this one records for nobody.
        if (start !== starts) {
          started.cancel();
          return { ok: false, error: 'The microphone start was cancelled.' };
        }
        current = started;
        return { ok: true, startedAt: current.startedAt };
      } catch (error) {
        return { ok: false, error: (error as Error).message, blocked: error instanceof MicrophoneBlocked };
      }
    }
    case 'mic-stop': {
      const spoken = current;
      current = null;
      if (!spoken) return { ok: false, error: 'No microphone runs.' };
      stopped = { id: ++stops, startedAt: spoken.startedAt, wav: new Uint8Array(await (await spoken.stop()).arrayBuffer()) };
      return { ok: true, startedAt: spoken.startedAt, size: stopped.wav.length, id: stopped.id };
    }
    case 'mic-part': {
      // Parts of another WAV would make one broken file of two recordings.
      if (!stopped || stopped.id !== message.id) return { ok: false, error: 'The voice is no longer here.' };
      const reply = { ok: true as const, startedAt: stopped.startedAt, wav: part(stopped.wav, message.offset) };
      if (message.offset + OFFSCREEN_PART_BYTES >= stopped.wav.length) stopped = null;
      return reply;
    }
    case 'video-start': {
      if (filming) void endFilming(filming);
      filming = film = null;
      filming = await startFilming(message.streamId);
      return { ok: true, startedAt: filming.startedAt };
    }
    case 'video-stop': {
      const ending = filming;
      filming = null;
      if (!ending) return { ok: false, error: 'No video runs.' };
      const webm = new Uint8Array(await (await endFilming(ending)).arrayBuffer());
      film = { id: ++films, startedAt: ending.startedAt, webm, truncated: ending.truncated };
      return { ok: true, startedAt: film.startedAt, size: webm.length, id: film.id, truncated: film.truncated };
    }
    case 'video-part': {
      if (!film || film.id !== message.id) return { ok: false, error: 'The video is no longer here.' };
      const reply = { ok: true as const, startedAt: film.startedAt, wav: part(film.webm, message.offset) };
      if (message.offset + OFFSCREEN_PART_BYTES >= film.webm.length) film = null;
      return reply;
    }
    case 'video-cancel':
      if (filming) void endFilming(filming);
      filming = film = null;
      return { ok: true, startedAt: 0 };
    case 'mic-cancel':
      starts++;
      current?.cancel();
      current = stopped = null;
      return { ok: true, startedAt: 0 };
  }
}

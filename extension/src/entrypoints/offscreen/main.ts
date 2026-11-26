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
    case 'mic-cancel':
      starts++;
      current?.cancel();
      current = stopped = null;
      return { ok: true, startedAt: 0 };
  }
}

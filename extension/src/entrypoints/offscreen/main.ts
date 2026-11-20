// Chrome: the microphone of a Record mode session lives here, not in the side panel, so closing
// the panel does not end it. The background starts and stops it; nothing else talks to this page.
import { OFFSCREEN_PART_BYTES, type OffscreenRequest, type OffscreenReply } from '@/messages';
import { MicrophoneBlocked, record, type Recording } from '@/voice';

let current: Recording | null = null;
/** The WAV of the last Stop, until the background has read all of its parts. */
let stopped: { id: number; startedAt: number; wav: Uint8Array } | null = null;
let stops = 0;

browser.runtime.onMessage.addListener((message: OffscreenRequest, _sender, reply) => {
  if (message?.target !== 'offscreen') return;
  handle(message).then(reply, (error: Error) => reply({ ok: false, error: error.message } satisfies OffscreenReply));
  return true;
});

async function handle(message: OffscreenRequest): Promise<OffscreenReply> {
  switch (message.kind) {
    case 'mic-start':
      current?.cancel();
      current = stopped = null;
      try {
        current = await record();
        return { ok: true, startedAt: current.startedAt };
      } catch (error) {
        return { ok: false, error: (error as Error).message, blocked: error instanceof MicrophoneBlocked };
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
      // Extension messages carry JSON only, and at most 64 MiB: a long note goes in parts.
      const part = stopped.wav.subarray(message.offset, message.offset + OFFSCREEN_PART_BYTES);
      let binary = '';
      for (let i = 0; i < part.length; i += 0x8000) binary += String.fromCharCode(...part.subarray(i, i + 0x8000));
      const reply = { ok: true as const, startedAt: stopped.startedAt, wav: btoa(binary) };
      if (message.offset + part.length >= stopped.wav.length) stopped = null;
      return reply;
    }
    case 'mic-cancel':
      current?.cancel();
      current = stopped = null;
      return { ok: true, startedAt: 0 };
  }
}

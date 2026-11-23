// Voice notes: the microphone in an extension page, a 16 kHz mono WAV, and an upload in chunks.

const SAMPLE_RATE = 16_000;

export interface Recording {
  startedAt: number;
  stop(): Promise<Blob>;
  cancel(): void;
}

/** The microphone is refused here: a side panel cannot ask, so a tab must ask once. */
export class MicrophoneBlocked extends Error {}

/**
 * `onData` hears the encoded audio so far, about once a second: a page that may close before
 * Stop (Firefox's sidebar) keeps it somewhere that outlives the page.
 */
export async function record(onData?: (parts: Blob[], type: string, startedAt: number) => void): Promise<Recording> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    if ((error as DOMException).name === 'NotAllowedError') throw new MicrophoneBlocked((error as Error).message);
    throw error;
  }
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  let startedAt = 0;
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    chunks.push(event.data);
    if (startedAt) onData?.(chunks.slice(), recorder.mimeType, startedAt);
  };
  const release = () => stream.getTracks().forEach((track) => track.stop());
  // The clock starts with the first sample, not the call: speech then lines up with the replay.
  try {
    await new Promise((started, fail) => {
      recorder.onstart = started;
      recorder.onerror = (event) => fail((event as ErrorEvent).error ?? new Error('The microphone recorder failed'));
      recorder.start(1000);
    });
  } catch (error) {
    release();
    throw error;
  }
  startedAt = Date.now();
  return {
    startedAt,
    cancel: () => (recorder.state !== 'inactive' && recorder.stop(), release()),
    stop: () =>
      new Promise<Blob>((done, fail) => {
        const finish = () => {
          release();
          toWav(new Blob(chunks, { type: recorder.mimeType })).then(done, fail);
        };
        // The recorder ended by itself (the microphone went away): what it wrote is all there is.
        if (recorder.state === 'inactive') return finish();
        recorder.onstop = finish;
        recorder.stop();
      }),
  };
}

/** Decodes what MediaRecorder wrote and resamples it to 16 kHz mono, as Whisper reads it. */
export async function toWav(encoded: Blob): Promise<Blob> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const audio = await context.decodeAudioData(await encoded.arrayBuffer());
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const channel = audio.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i]! += channel[i]! / audio.numberOfChannels;
    }
    return encodeWav(mono);
  } finally {
    void context.close();
  }
}

export function encodeWav(samples: Float32Array): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

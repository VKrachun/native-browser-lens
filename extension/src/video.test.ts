import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordTabVideo, VideoCancelled } from './video';

class FakeMediaStream {
  private tracks: Array<{ kind?: string; stop: () => void; onended?: (() => void) | null }>;
  constructor(tracks: Array<{ kind?: string; stop: () => void; onended?: (() => void) | null }> = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind !== 'audio');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

function makeFakeRecorder(supported: string[]) {
  const created: Array<{ stream: unknown; options: { mimeType?: string; videoBitsPerSecond?: number; audioBitsPerSecond?: number } }> = [];
  class FakeRecorder {
    static isTypeSupported = (t: string) => supported.includes(t);
    state = 'inactive';
    onstart: (() => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    constructor(
      public stream: MediaStream,
      public options: { mimeType?: string; videoBitsPerSecond?: number; audioBitsPerSecond?: number },
    ) {
      created.push({ stream, options });
    }
    start() {
      this.state = 'recording';
      this.onstart?.();
      this.ondataavailable?.({ data: new Blob(['chunk-1'], { type: 'video/webm' }) });
    }
    stop() {
      this.state = 'inactive';
      this.onstop?.();
    }
  }
  return { FakeRecorder, created };
}

describe('recordTabVideo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requests display audio, excludes the side panel, and returns a WebM blob on stop', async () => {
    const stoppedTracks: boolean[] = [];
    const track = { kind: 'video', stop: () => stoppedTracks.push(true), onended: null as (() => void) | null };
    const stream = new FakeMediaStream([track]) as unknown as MediaStream;
    const getDisplayMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
    vi.stubGlobal('MediaStream', FakeMediaStream);
    const { FakeRecorder } = makeFakeRecorder(['video/webm;codecs=vp8']);
    vi.stubGlobal('MediaRecorder', FakeRecorder);

    const rec = await recordTabVideo();
    expect(getDisplayMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: true,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
      }),
    );

    const out = await rec.stop();
    expect(out.truncated).toBe(false);
    expect(out.webm.type).toBe('video/webm');
    expect(await out.webm.text()).toBe('chunk-1');
    expect(stoppedTracks).toEqual([true]);
  });

  it('attaches microphone audio with opus codec when includeMic is enabled and stops both streams', async () => {
    const stopped: string[] = [];
    const videoTrack = { kind: 'video', stop: () => stopped.push('video'), onended: null as (() => void) | null };
    const micTrack = { kind: 'audio', stop: () => stopped.push('mic') };
    const displayStream = new FakeMediaStream([videoTrack]) as unknown as MediaStream;
    const micStream = new FakeMediaStream([micTrack]) as unknown as MediaStream;
    const getDisplayMedia = vi.fn().mockResolvedValue(displayStream);
    const getUserMedia = vi.fn().mockResolvedValue(micStream);
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia, getUserMedia } });
    vi.stubGlobal('MediaStream', FakeMediaStream);
    const { FakeRecorder, created } = makeFakeRecorder(['video/webm;codecs=vp9,opus']);
    vi.stubGlobal('MediaRecorder', FakeRecorder);

    const rec = await recordTabVideo({ includeMic: true });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(created[0]?.options.mimeType).toBe('video/webm;codecs=vp9,opus');
    expect(created[0]?.options.audioBitsPerSecond).toBe(128_000);
    expect((created[0]?.stream as FakeMediaStream).getAudioTracks()).toHaveLength(1);

    await rec.stop();
    expect(stopped).toEqual(['video', 'mic']);
  });

  it('falls back to audio:false when getDisplayMedia rejects audio:true on unsupported platforms', async () => {
    const videoTrack = { kind: 'video', stop: vi.fn(), onended: null as (() => void) | null };
    const displayStream = new FakeMediaStream([videoTrack]) as unknown as MediaStream;
    const getDisplayMedia = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Not supported'), { name: 'NotSupportedError' }))
      .mockResolvedValueOnce(displayStream);
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
    vi.stubGlobal('MediaStream', FakeMediaStream);
    const { FakeRecorder } = makeFakeRecorder(['video/webm']);
    vi.stubGlobal('MediaRecorder', FakeRecorder);

    const rec = await recordTabVideo();
    expect(getDisplayMedia).toHaveBeenCalledTimes(2);
    expect(getDisplayMedia).toHaveBeenNthCalledWith(1, expect.objectContaining({ audio: true }));
    expect(getDisplayMedia).toHaveBeenNthCalledWith(2, expect.objectContaining({ audio: false }));
    await rec.stop();
  });

  it('throws VideoCancelled when the person dismisses the screen-share picker', async () => {
    const err = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn().mockRejectedValue(err) } });
    await expect(recordTabVideo()).rejects.toBeInstanceOf(VideoCancelled);
  });
});

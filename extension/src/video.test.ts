import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordTabVideo, VideoCancelled } from './video';

describe('recordTabVideo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses getDisplayMedia without tabCapture, excludes the side panel, and returns a WebM blob on stop', async () => {
    const stoppedTracks: boolean[] = [];
    const track = { stop: () => stoppedTracks.push(true), onended: null as (() => void) | null };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    const getDisplayMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });

    class FakeRecorder {
      static isTypeSupported = (t: string) => t === 'video/webm;codecs=vp8';
      state = 'inactive';
      onstart: (() => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      constructor(
        public stream: MediaStream,
        public options: { mimeType?: string; videoBitsPerSecond?: number },
      ) {}
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
    vi.stubGlobal('MediaRecorder', FakeRecorder);

    const rec = await recordTabVideo();
    expect(getDisplayMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: false,
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

  it('throws VideoCancelled when the person dismisses the screen-share picker', async () => {
    const err = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn().mockRejectedValue(err) } });
    await expect(recordTabVideo()).rejects.toBeInstanceOf(VideoCancelled);
  });
});

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LensClient } from '@/lens-client';
import { resetDbForTests } from './db';
import { saveLlmConfig, listProviderModels } from './llm';
import { decodeWavToMono16k, saveSpeechConfig, wordsToSegments } from './speech';

beforeEach(async () => {
  resetDbForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('sirv-lens-v1');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('in-extension LensClient + engine', () => {
  it('handles hello, projects, observations, captures, and reviews with zero nativeMessaging', async () => {
    const client = new LensClient();
    const hello = await client.request({ method: 'hello' });
    expect(hello.protocol).toBe(1);
    expect(hello.paused).toBe(false);

    await client.request({ method: 'setPaused', params: { paused: true } });
    expect((await client.request({ method: 'hello' })).paused).toBe(true);

    const proj = await client.request({
      method: 'saveProject',
      params: { id: null, name: 'Shop', origins: ['https://shop.test'], enabled: true },
    });
    expect(proj.origins).toEqual(['https://shop.test']);

    const pngBlob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])], { type: 'image/png' });
    const ref = await client.upload(pngBlob, 'image/png');
    const back = await client.readBlob(ref);
    expect(back.size).toBe(8);

    const cap = await client.request({
      method: 'createCapture',
      params: {
        observation: null,
        pageUrl: 'https://shop.test/cart',
        pageTitle: 'Cart',
        screenshot: '',
        screenshotBlob: ref,
        evidence: { mode: 'deep', events: [], gaps: [], page: null, actions: [], elements: [], dropped: {} },
        recording: null,
        kind: 'moment',
        startedAt: Date.now(),
        shots: [],
      },
    });
    const obs = await client.request({ method: 'getObservation', params: { id: cap.observation } });
    const review = await client.request({
      method: 'createReview',
      params: {
        observation: obs.id,
        revision: obs.revision,
        captures: [cap.id],
        recordings: [],
        typedValues: true,
        screenshotsChecked: true,
      },
    });
    expect(review.items).toHaveLength(1);
  });

  it('summarizes observations via BYOK Anthropic / OpenAI / Gemini APIs', async () => {
    const client = new LensClient();
    const cap = await client.request({
      method: 'createCapture',
      params: {
        observation: null,
        pageUrl: 'https://shop.test/checkout',
        pageTitle: 'Checkout',
        screenshot: '',
        evidence: { mode: 'deep', events: [], gaps: [], page: null, actions: [], elements: [], dropped: {} },
        recording: null,
        kind: 'session',
        startedAt: 1000,
        shots: [],
      },
    });

    await saveLlmConfig({
      enabled: true,
      provider: 'anthropic',
      keys: { openrouter: '', anthropic: 'sk-ant-test', openai: '', gemini: '' },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                title: 'Checkout: Pay button returns 500',
                findings: ['Clicking Pay returns HTTP 500'],
                tags: ['checkout', 'bug'],
                issues: [],
              }),
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const summary = await client.request({ method: 'summarize', params: { observation: cap.observation } });
    expect(summary.title).toBe('Checkout: Pay button returns 500');
    expect(summary.findings).toEqual(['Clicking Pay returns HTTP 500']);
    expect(summary.tags).toEqual(['checkout', 'bug']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('files reviews to VibeQ durably via fetch', async () => {
    const client = new LensClient();
    const fetchMock = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s.endsWith('/auth/me')) {
        return new Response(JSON.stringify({ id: 'u1', name: 'Igor' }), { status: 200 });
      }
      if (s.includes('/api/capture/v1/submissions/')) {
        return new Response('not found', { status: 404 });
      }
      if (s.endsWith('/api/attachments/stage')) {
        return new Response(JSON.stringify({ stagedKey: 'stage-key-1' }), { status: 200 });
      }
      if (s.endsWith('/api/capture/v1/submissions')) {
        return new Response(
          JSON.stringify({
            submissionId: 'sub-1',
            observationId: 'obs-1',
            revision: 1,
            taskId: 'TASK-42',
            taskUrl: 'https://work.sirv.studio/?task=TASK-42',
            missingAttachments: [],
          }),
          { status: 201 },
        );
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const vq = await client.request({
      method: 'setVibeQ',
      params: { endpoint: 'https://work.sirv.studio', token: 'tok_123' },
    });
    expect(vq.hasToken).toBe(true);
    expect(vq.account).toBe('Igor');

    const cap = await client.request({
      method: 'createCapture',
      params: {
        observation: null,
        pageUrl: 'https://shop.test',
        pageTitle: 'Shop',
        screenshot: '',
        evidence: { mode: 'deep', events: [], gaps: [], page: null, actions: [], elements: [], dropped: {} },
        recording: null,
        kind: 'moment',
        startedAt: 1000,
        shots: [],
      },
    });
    const obs = await client.request({ method: 'getObservation', params: { id: cap.observation } });
    const review = await client.request({
      method: 'createReview',
      params: {
        observation: obs.id,
        revision: obs.revision,
        captures: [cap.id],
        recordings: [],
        typedValues: true,
        screenshotsChecked: true,
      },
    });
    const filing = await client.request({ method: 'fileReview', params: { review: review.id, assignee: null } });
    expect(filing.taskUrl).toBe('https://work.sirv.studio/?task=TASK-42');
    expect(filing.missingFiles).toBe(0);
  });

  it('decodes PCM16 WAV to 16kHz Float32Array and reports cloud STT status', async () => {
    const wav = new Uint8Array(44 + 8);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    wav.set([0x57, 0x41, 0x56, 0x45], 8);
    wav.set([0x66, 0x6d, 0x74, 0x20], 12);
    const dv = new DataView(wav.buffer);
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, 1, true); // mono
    dv.setUint32(24, 16000, true);
    dv.setUint32(28, 32000, true);
    dv.setUint16(34, 16, true);
    wav.set([0x64, 0x61, 0x74, 0x61], 36);
    dv.setUint32(40, 8, true);
    dv.setInt16(44, 16384, true);
    dv.setInt16(46, -16384, true);
    const samples = decodeWavToMono16k(wav);
    expect(samples.length).toBe(4);
    expect(samples[0]).toBeCloseTo(0.5, 3);
    expect(samples[1]).toBeCloseTo(-0.5, 3);

    await saveSpeechConfig({ backend: 'groq', groqApiKey: 'gsk_test', model: 'whisper-large-v3-turbo' });
    const client = new LensClient();
    const st = await client.request({ method: 'speechStatus' });
    expect(st.model.state).toBe('ready');
    expect(st.engines).toEqual(['Groq Cloud STT']);
  });

  it('defaults local speech to Parakeet TDT 0.6B v3 and groups Parakeet word timestamps', async () => {
    const client = new LensClient();
    const st = await client.request({ method: 'speechStatus' });
    expect(st.modelName).toContain('Parakeet TDT 0.6B v3');

    const segs = wordsToSegments(
      [
        { text: 'Checkout', start_time: 0.1, end_time: 0.5 },
        { text: 'button', start_time: 0.5, end_time: 0.9 },
        { text: 'is', start_time: 0.9, end_time: 1.0 },
        { text: 'broken.', start_time: 1.0, end_time: 1.4 },
        { text: 'Returns', start_time: 3.0, end_time: 3.4 },
        { text: '500.', start_time: 3.4, end_time: 3.8 },
      ],
      'Checkout button is broken. Returns 500.',
      4000,
    );
    expect(segs).toEqual([
      { startMs: 100, endMs: 1400, text: 'Checkout button is broken.', corrected: false },
      { startMs: 3000, endMs: 3800, text: 'Returns 500.', corrected: false },
    ]);
  });

  it('routes OpenRouter BYOK requests and lists live provider models', async () => {
    const client = new LensClient();
    const cap = await client.request({
      method: 'createCapture',
      params: {
        observation: null,
        pageUrl: 'https://shop.test/pay',
        pageTitle: 'Pay',
        screenshot: '',
        evidence: { mode: 'deep', events: [], gaps: [], page: null, actions: [], elements: [], dropped: {} },
        recording: null,
        kind: 'moment',
        startedAt: 1000,
        shots: [],
      },
    });

    await saveLlmConfig({
      enabled: true,
      provider: 'openrouter',
      keys: { openrouter: 'sk-or-v1-test', anthropic: '', openai: '', gemini: '' },
    });

    const fetchMock = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s === 'https://openrouter.ai/api/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-haiku-5.5' }, { id: 'openai/gpt-5.4-mini' }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: 'Pay: card declined silently',
                  findings: ['No toast shown after 402'],
                  tags: ['payments', 'bug'],
                  issues: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const models = await listProviderModels('openrouter', 'sk-or-v1-test');
    expect(models).toEqual(['anthropic/claude-haiku-5.5', 'openai/gpt-5.4-mini']);

    const summary = await client.request({ method: 'summarize', params: { observation: cap.observation } });
    expect(summary.title).toBe('Pay: card declined silently');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

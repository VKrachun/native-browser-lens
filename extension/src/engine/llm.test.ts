import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeLlmSummary,
  getLlmConfig,
  listProviderModels,
  normalizeCustomBaseUrl,
  saveLlmConfig,
  testLlmConnection,
  verifyLlmApiKey,
} from './llm';

describe('custom OpenAI-compatible LLM endpoint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('normalizes trailing slashes and endpoint suffixes', () => {
    expect(normalizeCustomBaseUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1');
    expect(normalizeCustomBaseUrl('http://127.0.0.1:1234/v1/chat/completions')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeCustomBaseUrl('http://127.0.0.1:4000/v1/models')).toBe('http://127.0.0.1:4000/v1');
  });

  it('persists customBaseUrl and resolves custom provider without requiring an API key', async () => {
    await saveLlmConfig({
      provider: 'custom',
      customBaseUrl: 'http://127.0.0.1:11434/v1/',
      model: 'qwen2.5-coder:7b',
      keys: { openrouter: '', anthropic: '', openai: '', gemini: '', custom: '' },
    });
    const cfg = await getLlmConfig();
    expect(cfg.provider).toBe('custom');
    expect(cfg.customBaseUrl).toBe('http://127.0.0.1:11434/v1/');
    expect(activeLlmSummary(cfg)).toEqual({
      provider: 'custom',
      label: '127.0.0.1:11434',
      model: 'qwen2.5-coder:7b',
    });
  });

  it('verifies and lists models from a custom endpoint without Authorization when key is empty, and sends Bearer when set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3.2' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const verified = await verifyLlmApiKey('custom', '', 'http://127.0.0.1:11434/v1/');
    expect(verified.models).toEqual(['qwen2.5-coder:7b', 'llama3.2']);
    expect(verified.detail).toContain('Connected (2 models');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/models',
      expect.objectContaining({ headers: {} }),
    );

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const models = await listProviderModels('custom', 'secret-token', 'http://127.0.0.1:4000/v1');
    expect(models).toEqual(['claude-sonnet-4-5']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:4000/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer secret-token' } }),
    );
  });

  it('completes testLlmConnection against a local custom OpenAI-compatible server', async () => {
    await saveLlmConfig({
      provider: 'custom',
      customBaseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3.2',
      keys: { openrouter: '', anthropic: '', openai: '', gemini: '', custom: '' },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await testLlmConnection();
    expect(res).toEqual({ provider: 'custom', model: 'llama3.2' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

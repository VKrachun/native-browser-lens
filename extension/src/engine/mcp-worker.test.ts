import { describe, expect, it } from 'vitest';
import worker, { type Env, type KVNamespaceLike } from '../../../site/worker/index';

function memoryKv(): KVNamespaceLike {
  const map = new Map<string, string>();
  return {
    async get(key, type) {
      const val = map.get(key);
      if (val === undefined) return null;
      return type === 'json' ? JSON.parse(val) : val;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

describe('Remote HTTP MCP Cloudflare Worker', () => {
  it('syncs reviews and serves MCP tools, prompts, and resources isolated by Bearer token', async () => {
    const env: Env = { LENS_MCP_KV: memoryKv() };
    const token = 'lens_0123456789abcdef0123456789abcdef';
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Sync a review
    const putRes = await worker.fetch(
      new Request('https://lens.sirv.studio/api/mcp/reviews/7', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          review: {
            id: 7,
            observation: 3,
            revision: 2,
            createdAt: Date.now(),
            title: 'Checkout returns 500',
            notes: 'Happens on submit',
            tags: ['checkout', 'bug'],
            items: [
              {
                capture: 1,
                pageUrl: 'https://shop.test/checkout',
                pageTitle: 'Checkout',
                mode: 'deep',
                findings: ['HTTP 500 POST https://shop.test/api/pay'],
                marks: [],
                kind: 'session',
                annotations: [],
                shots: [],
                recording: null,
                capturedAt: 5000,
                startedAt: 1000,
              },
            ],
            voice: [],
          },
          vibeqTaskId: 'VQ-99',
          vibeqTaskUrl: 'https://work.sirv.studio/?task=VQ-99',
          files: {
            'report.md': { contentType: 'text/markdown', encoding: 'utf8', body: '# Checkout returns 500' },
            'capture-1.spec.ts': {
              contentType: 'text/typescript',
              encoding: 'utf8',
              body: `await page.goto("https://shop.test/checkout");`,
            },
            'capture-1-evidence.json': {
              contentType: 'application/json',
              encoding: 'utf8',
              body: JSON.stringify({
                events: [
                  { timestamp: 1200, kind: 'request', data: { requestId: 'r1', url: 'https://shop.test/api/pay' } },
                  { timestamp: 1300, kind: 'response', data: { requestId: 'r1', status: 500 } },
                ],
                actions: [],
              }),
            },
          },
        }),
      }),
      env,
    );
    expect(putRes.status).toBe(200);

    const mcp = async (method: string, params?: unknown, customToken = token) => {
      const res = await worker.fetch(
        new Request('https://lens.sirv.studio/mcp', {
          method: 'POST',
          headers: { Authorization: `Bearer ${customToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
        env,
      );
      return res.json() as Promise<{ result?: any; error?: any }>;
    };

    const init = await mcp('initialize');
    expect(init.result.serverInfo.name).toBe('sirv-lens-remote-mcp');

    const listed = await mcp('tools/call', { name: 'list_reviews', arguments: {} });
    expect(listed.result.content[1].text).toContain('Checkout returns 500');

    // Different user token cannot see this review
    const otherListed = await mcp('tools/call', { name: 'list_reviews', arguments: {} }, 'lens_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(JSON.parse(otherListed.result.content[1].text)).toEqual([]);

    const queried = await mcp('tools/call', { name: 'query_review_evidence', arguments: { review: 7, kind: 'failures' } });
    const qBody = JSON.parse(queried.result.content[1].text);
    expect(qBody.matched).toBe(1);

    const spec = await mcp('tools/call', {
      name: 'playwright_test',
      arguments: { review: 7, base_url: 'http://localhost:3000' },
    });
    expect(spec.result.content[1].text).toContain('http://localhost:3000/checkout');

    const prompt = await mcp('prompts/get', { name: 'fix', arguments: { review: 'VQ-99' } });
    expect(prompt.result.messages[0].content.text).toContain('Checkout returns 500');

    const resource = await mcp('resources/read', { uri: 'lens://review/7' });
    expect(resource.result.contents[0].text).toContain('UNTRUSTED DATA');
  });
});

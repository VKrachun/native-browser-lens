import 'fake-indexeddb/auto';
import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Evidence } from '@/protocol/Evidence';
import { createCapture, getObservation, putBlob, resetDbForTests, saveAnnotations } from './db';
import { digestRecording, trimRecording, type RrEvent } from './digest';
import { buildEvidenceZip, buildReviewBundle, createReview } from './export';
import { buildHar, buildPlaywrightSpec } from './repro';

beforeEach(async () => {
  resetDbForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('sirv-lens-v1');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
});

describe('engine/export + digest + repro', () => {
  it('freezes a review, generates Playwright spec + HAR + lens.json + ZIP', async () => {
    const rrEvents: RrEvent[] = [
      { type: 4, timestamp: 1000, data: { href: 'https://shop.test/checkout', width: 1280, height: 800 } },
      {
        type: 2,
        timestamp: 1000,
        data: {
          node: {
            id: 1,
            type: 0,
            childNodes: [
              {
                id: 2,
                type: 2,
                tagName: 'body',
                childNodes: [
                  { id: 3, type: 2, tagName: 'button', childNodes: [{ id: 4, type: 3, textContent: 'Pay now' }] },
                ],
              },
            ],
          },
        },
      },
      { type: 3, timestamp: 2000, data: { source: 2, type: 2, id: 3 } },
      {
        type: 3,
        timestamp: 2500,
        data: {
          source: 0,
          adds: [{ parentId: 2, nextId: null, node: { id: 5, type: 3, textContent: 'Payment failed' } }],
        },
      },
    ];
    const recRef = await putBlob(new TextEncoder().encode(JSON.stringify(rrEvents)), 'application/json');

    const cap = await createCapture({
      observation: null,
      pageUrl: 'https://shop.test/checkout',
      pageTitle: 'Checkout',
      screenshot: '',
      evidence: {
        mode: 'deep',
        events: [
          {
            timestamp: 2100,
            kind: 'request',
            data: { requestId: 'r1', method: 'POST', url: 'https://shop.test/api/pay', resourceType: 'Fetch' },
          },
          {
            timestamp: 2300,
            kind: 'response',
            data: { requestId: 'r1', status: 500, url: 'https://shop.test/api/pay', mimeType: 'application/json' },
          },
          {
            timestamp: 2310,
            kind: 'responseBody',
            data: { requestId: 'r1', format: 'json', body: '{"error":"card_declined"}' },
          },
        ],
        gaps: [],
        page: { viewport: { width: 1280, height: 800 } },
        actions: [
          {
            timestamp: 2000,
            kind: 'click',
            url: 'https://shop.test/checkout',
            target: {
              role: 'button',
              name: 'Pay now',
              text: 'Pay now',
              css: 'button.pay',
              testId: 'pay-btn',
              nth: 0,
            },
            value: null,
            masked: false,
          },
        ],
        elements: [],
        dropped: {},
      },
      recording: recRef,
      kind: 'session',
      startedAt: 1000,
      shots: [],
    });

    const obs = await getObservation(cap.observation);
    const review = await createReview({
      observation: obs.id,
      revision: obs.revision,
      captures: [cap.id],
      recordings: [cap.id],
      typedValues: true,
      screenshotsChecked: true,
    });

    expect(review.items).toHaveLength(1);
    expect(review.items[0]!.findings).toContain('HTTP 500 POST https://shop.test/api/pay');
    expect(review.items[0]!.screen.some((s) => s.text.includes('Pay now'))).toBe(true);

    const { filename, bytes } = await buildEvidenceZip(review.id);
    expect(filename).toBe(`lens-review-${review.id}-evidence.zip`);
    const entries = unzipSync(bytes);
    const names = Object.keys(entries);
    expect(names.some((n) => n.endsWith('/report.md'))).toBe(true);
    expect(names.some((n) => n.endsWith('/capture-1.spec.ts'))).toBe(true);
    expect(names.some((n) => n.endsWith('/capture-1.har'))).toBe(true);
    expect(names.some((n) => n.endsWith('/capture-1.lens.json'))).toBe(true);
    expect(names.some((n) => n.endsWith('/capture-1.rrweb.json'))).toBe(true);

    const specName = names.find((n) => n.endsWith('/capture-1.spec.ts'))!;
    const specText = new TextDecoder().decode(entries[specName]);
    expect(specText).toContain(`page.getByTestId("pay-btn").click()`);
  });

  it('omits recording and screen notes when screenshot has a privacy mask', async () => {
    const recRef = await putBlob(new TextEncoder().encode('[]'), 'application/json');
    const cap = await createCapture({
      observation: null,
      pageUrl: 'https://shop.test/account',
      pageTitle: 'Account',
      screenshot: '',
      evidence: { mode: 'deep', events: [], gaps: [], page: null, actions: [], elements: [], dropped: {} },
      recording: recRef,
      kind: 'moment',
      startedAt: 1000,
      shots: [],
    });
    await saveAnnotations(cap.id, [{ kind: 'mask', x: 0, y: 0, width: 50, height: 50 }]);
    const obs = await getObservation(cap.observation);
    const review = await createReview({
      observation: obs.id,
      revision: obs.revision,
      captures: [cap.id],
      recordings: [cap.id],
      typedValues: true,
      screenshotsChecked: true,
    });
    expect(review.items[0]!.recording).toBeNull();
    expect(review.items[0]!.screen).toEqual([]);
  });

  it('trims rrweb recordings with synthesized snapshot at kept entry', () => {
    const events: RrEvent[] = [
      { type: 4, timestamp: 100, data: { href: 'https://a.test', width: 800, height: 600 } },
      { type: 2, timestamp: 100, data: { node: { id: 1, type: 0, childNodes: [{ id: 2, type: 3, textContent: 'Hi' }] } } },
      { type: 3, timestamp: 200, data: { source: 0, texts: [{ id: 2, value: 'Updated' }] } },
      { type: 3, timestamp: 500, data: { source: 2, type: 2, id: 2 } },
    ];
    const trimmed = trimRecording(events, [{ from: 400, to: 600 }]);
    expect(trimmed[0]!.type).toBe(4);
    expect(trimmed[1]!.type).toBe(2);
    expect(trimmed.at(-1)!.data?.tag).toBe('lens-end');
    const notes = digestRecording(trimmed);
    expect(notes[0]!.text).toContain('Updated');
  });

  it('generates project Playwright tests and HAR with origin rewrite', () => {
    const ev: Evidence = {
      mode: 'deep',
      events: [
        { timestamp: 10, kind: 'request', data: { requestId: '1', method: 'GET', url: 'https://prod.test/api/me' } },
        { timestamp: 20, kind: 'response', data: { requestId: '1', status: 200, url: 'https://prod.test/api/me' } },
        { timestamp: 21, kind: 'responseBody', data: { requestId: '1', format: 'json', body: '{"ok":true}' } },
      ],
      gaps: [],
      page: { viewport: { width: 1024, height: 768 } },
      actions: [],
      elements: [],
      dropped: {},
    };
    const spec = buildPlaywrightSpec(ev, 1, 'Me bug', 'https://prod.test/me', {
      baseUrl: 'http://localhost:3000',
      name: 'lens-review-1',
      hasHar: true,
    });
    expect(spec).toContain('http://localhost:3000/me');
    expect(spec).toContain('lensBlocked');
    const har = buildHar(ev, { from: 'https://prod.test', to: 'http://localhost:3000' });
    expect(har.log.entries).toHaveLength(1);
    expect(JSON.stringify(har)).toContain('http://localhost:3000/api/me');
  });

  it('emits lens-capture.v1 records matching VibeQ Worker & frontend contract', async () => {
    const pngRef = await putBlob(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), 'image/png');
    const recRef = await putBlob(new TextEncoder().encode(JSON.stringify([])), 'application/json');
    const cap = await createCapture({
      observation: null,
      pageUrl: 'https://shop.test/pay',
      pageTitle: 'Pay',
      screenshot: '',
      screenshotBlob: pngRef,
      evidence: {
        mode: 'deep',
        events: [
          { timestamp: 1795790001000, kind: 'request', data: { requestId: 'r1', method: 'POST', url: 'https://shop.test/api/pay' } },
          { timestamp: 1795790001200, kind: 'response', data: { requestId: 'r1', status: 500 } },
          { timestamp: 1795790001250, kind: 'console', data: { level: 'error', text: 'Uncaught 500' } },
        ],
        gaps: [],
        page: { viewport: { width: 1280, height: 800, devicePixelRatio: 2 } },
        actions: [{ timestamp: 1795790000900, kind: 'click', url: 'https://shop.test/pay', target: { css: '#pay', role: 'button', name: 'Pay', testId: null, nth: null, text: 'Pay' }, value: null, masked: false }],
        elements: [],
        dropped: {},
      },
      recording: recRef,
      kind: 'moment',
      startedAt: 1795790000000,
      shots: [],
    });
    const obs = await getObservation(cap.observation);
    const review = await createReview({
      observation: obs.id,
      revision: obs.revision,
      captures: [cap.id],
      recordings: [cap.id],
      typedValues: true,
      screenshotsChecked: true,
    });
    const bundle = await buildReviewBundle(review);
    const parsed = JSON.parse(new TextDecoder().decode(bundle.files.get('capture-1.lens.json')!.bytes));
    expect(parsed.version).toBe(1);
    expect(typeof parsed.capture.startedAt).toBe('string');
    expect(parsed.capture.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.steps[0].seq).toBe(1);
    expect(parsed.network[0].id).toBe('s1r1');
    expect(parsed.shots[0]).toMatchObject({ id: 'end', file: 'capture-1.png', contentType: 'image/png' });
    expect(parsed.recording).toMatchObject({ file: 'capture-1.rrweb.json', sha256: recRef.sha256 });
  });
});

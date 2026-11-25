import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { EvidenceBuffer } from './buffer';
import { DeepCollector, MAX_FRAME_CHARS, MAX_FRAMES_PER_MINUTE, framePayload, graphqlErrors, graphqlOperation } from './deep';

describe('graphqlOperation', () => {
  it('reads operationName, else the name in the query', () => {
    expect(graphqlOperation(JSON.stringify({ operationName: 'GetCart', query: 'query GetCart { cart { id } }' }))).toBe('GetCart');
    expect(graphqlOperation(JSON.stringify({ query: 'mutation AddItem($id: ID!) { add(id: $id) }' }))).toBe('AddItem');
    expect(graphqlOperation(JSON.stringify({ query: '{ me { id } }' }))).toBe('anonymous query');
    expect(graphqlOperation(JSON.stringify([{ query: 'query A { a }' }, { query: 'query B { b }' }]))).toBe('A, B');
  });

  it('ignores bodies that are not GraphQL', () => {
    expect(graphqlOperation(JSON.stringify({ query: 42 }))).toBeUndefined();
    expect(graphqlOperation('query=shoes')).toBeUndefined();
    expect(graphqlOperation(undefined)).toBeUndefined();
  });
});

describe('graphqlErrors', () => {
  const answer = JSON.stringify({ data: null, errors: [{ message: 'Bad token=abc123', path: ['cart', 0], extensions: { code: 'UNAUTHENTICATED' } }] });

  it('summarizes errors, redacted', () => {
    const [error] = graphqlErrors(answer, true)!;
    expect(error).toEqual({ message: expect.not.stringContaining('abc123'), path: 'cart.0', code: 'UNAUTHENTICATED' });
  });

  it('keeps out the text of another site', () => {
    expect(graphqlErrors(answer, false)![0]!.message).toBeUndefined();
  });

  it('finds nothing in an answer without errors', () => {
    expect(graphqlErrors(JSON.stringify({ data: {}, errors: [] }), true)).toBeUndefined();
    expect(graphqlErrors(JSON.stringify({ data: {} }), true)).toBeUndefined();
  });
});

describe('framePayload', () => {
  it('redacts by field name and caps the length', () => {
    expect(framePayload(JSON.stringify({ password: 'hunter2', text: 'hi' }))).not.toContain('hunter2');
    expect(framePayload('x'.repeat(10_000)).length).toBeLessThan(MAX_FRAME_CHARS + 40);
  });
});

describe('DeepCollector', () => {
  let emit: (source: { tabId?: number }, method: string, params: unknown) => void;
  let detachEvent: (source: { tabId?: number }, reason: string) => void;
  let attachCalls: number[];
  const responses = new Map<string, unknown>();
  beforeEach(() => {
    fakeBrowser.reset();
    responses.clear();
    attachCalls = [];
    Object.assign(fakeBrowser, {
      debugger: {
        onEvent: { addListener: (fn: typeof emit) => (emit = fn) },
        onDetach: { addListener: (fn: typeof detachEvent) => (detachEvent = fn) },
        attach: async (target: { tabId: number }) => {
          attachCalls.push(target.tabId);
        },
        detach: async () => {},
        sendCommand: async (_target: unknown, method: string, params?: { requestId?: string }) =>
          method === 'Network.getResponseBody' ? responses.get(params!.requestId!) : undefined,
      },
    });
  });

  async function collector(page = 'https://app.test/') {
    const buffer = new EvidenceBuffer();
    buffer.start(1, 'deep');
    const deep = new DeepCollector(buffer, () => page);
    await deep.attach(1);
    const send = async (method: string, params: unknown) => {
      emit({ tabId: 1 }, method, params);
      await new Promise((done) => setTimeout(done, 0));
    };
    return { buffer, send, events: () => buffer.snapshot(1)!.events };
  }

  it('names the GraphQL operation and fails a 200 answer with errors', async () => {
    const { send, events } = await collector();
    const body = JSON.stringify({ operationName: 'GetCart', query: 'query GetCart { cart }' });
    await send('Network.requestWillBeSent', { requestId: 'r', type: 'Fetch', request: { url: 'https://app.test/graphql', method: 'POST', postData: body, headers: { 'Content-Type': 'application/json' } } });
    await send('Network.responseReceived', { requestId: 'r', response: { url: 'https://app.test/graphql', status: 200, mimeType: 'application/json' } });
    responses.set('r', { body: JSON.stringify({ errors: [{ message: 'Cart not found' }] }), base64Encoded: false });
    await send('Network.loadingFinished', { requestId: 'r' });
    const found = events();
    expect(found.find((e) => e.kind === 'request')!.data).toMatchObject({ graphqlOperation: 'GetCart' });
    expect(found.find((e) => e.kind === 'responseBody')!.data).toMatchObject({ graphqlError: true });
    expect(found.find((e) => e.kind === 'networkFailure')!.data).toMatchObject({ graphqlError: true, errorText: 'GraphQL error: Cart not found' });
  });

  it('records WebSocket frames redacted, and only the page own socket text', async () => {
    const { send, events } = await collector();
    await send('Network.webSocketCreated', { requestId: 'w', url: 'wss://app.test/live?token=s3cret' });
    await send('Network.webSocketFrameSent', { requestId: 'w', response: { opcode: 1, payloadData: '{"password":"hunter2","op":"join"}' } });
    await send('Network.webSocketCreated', { requestId: 'x', url: 'wss://chat.other.test/' });
    await send('Network.webSocketFrameReceived', { requestId: 'x', response: { opcode: 1, payloadData: 'private chat' } });
    await send('Network.webSocketClosed', { requestId: 'w' });
    const text = JSON.stringify(events());
    expect(text).not.toMatch(/s3cret|hunter2|private chat/);
    expect(events()[1]!.data).toMatchObject({ payload: expect.stringContaining('"op":"join"') });
    expect(events().map((e) => e.kind)).toEqual(['webSocket', 'webSocketFrame', 'webSocket', 'webSocketFrame', 'webSocketClosed']);
  });

  it('counts the frames of a noisy socket past the limit instead of keeping them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
    const { send, buffer } = await collector();
    for (let i = 0; i < MAX_FRAMES_PER_MINUTE + 5; i++) {
      await send('Network.webSocketFrameReceived', { requestId: 'n', response: { opcode: 1, payloadData: `tick ${i}` } });
    }
    const snapshot = buffer.snapshot(1)!;
    expect(snapshot.events.length).toBeLessThanOrEqual(MAX_FRAMES_PER_MINUTE);
    expect(snapshot.dropped['websocket-frames-over-limit']).toBe(5);
    vi.useRealTimers();
  });

  it('stays detached across all tabs and after detach() once canceled_by_user fires', async () => {
    const buffer = new EvidenceBuffer();
    buffer.start(1, 'deep');
    buffer.start(2, 'deep');
    let canceled = 0;
    const deep = new DeepCollector(buffer, () => 'https://app.test/', () => canceled++);
    await deep.attach(1);
    await deep.attach(2);
    expect(attachCalls).toEqual([1, 2]);

    detachEvent({ tabId: 1 }, 'canceled_by_user');
    expect(deep.isDeclined()).toBe(true);
    expect(canceled).toBe(1);
    expect(deep.isAttached(1)).toBe(false);
    expect(deep.isAttached(2)).toBe(false);
    expect(buffer.mode(1)).toBe('screenshotOnly');
    expect(buffer.mode(2)).toBe('screenshotOnly');

    // Detaching (e.g. off-site navigation) or attaching new tabs must NOT re-attach.
    await deep.detach(1);
    await deep.attach(1);
    await deep.attach(3);
    expect(attachCalls).toEqual([1, 2]);

    // Explicit reconnect clears declined and allows attaching again.
    deep.setDeclined(false);
    await deep.attach(3);
    expect(attachCalls).toEqual([1, 2, 3]);
  });

  it('still records canceled_by_user when woken on a fresh worker with empty attached set', async () => {
    const buffer = new EvidenceBuffer();
    let canceled = 0;
    const deep = new DeepCollector(buffer, () => 'https://app.test/', () => canceled++);
    // Tab 7 was attached before the service worker restarted, so this.attached does not have it.
    detachEvent({ tabId: 7 }, 'canceled_by_user');
    expect(deep.isDeclined()).toBe(true);
    expect(canceled).toBe(1);
    await deep.attach(7);
    expect(attachCalls).toEqual([]);
  });
});


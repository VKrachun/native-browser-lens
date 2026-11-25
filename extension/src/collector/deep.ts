import type { EvidenceBuffer } from './buffer';
import { noiseReason } from './noise';
import { bodyEvidence, requestBody, sanitize, sanitizeText, sanitizeUrl } from './sanitize';

type Params = Record<string, any>;

interface Request {
  url: string;
  resourceType?: string;
  status?: number;
  mimeType?: string;
}

/** A WebSocket frame keeps this much of its text; the rest of a noisy socket is counted, not kept. */
export const MAX_FRAME_CHARS = 2048;
export const MAX_FRAMES_PER_MINUTE = 120;
const MAX_SOCKETS = 64;
/** A GraphQL answer is read for its errors up to this size, past the 16 KiB a body may keep. */
const MAX_GRAPHQL_BODY = 256 * 1024;

/** The GraphQL operation a request body names: its operationName, else the name in its query. */
export function graphqlOperation(body: unknown): string | undefined {
  if (typeof body !== 'string' || !body.includes('query')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  // A batch is an array of operations.
  const names = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((op) => {
    if (!op || typeof op !== 'object' || typeof (op as Params).query !== 'string') return [];
    const { operationName, query } = op as Params;
    if (typeof operationName === 'string' && operationName) return [operationName];
    const named = /\b(query|mutation|subscription)\s+([_A-Za-z]\w{0,99})/.exec(query);
    return [named ? named[2]! : `anonymous ${/^\s*(mutation|subscription)\b/.exec(query)?.[1] ?? 'query'}`];
  });
  return names.length ? names.slice(0, 10).join(', ').slice(0, 200) : undefined;
}

/**
 * The errors of a GraphQL answer, which comes with status 200: at most five, each its message
 * (only when `withText`), path and code. Undefined when the body is no GraphQL answer with errors.
 */
export function graphqlErrors(body: string, withText: boolean): Params[] | undefined {
  if (body.length > MAX_GRAPHQL_BODY || !body.includes('"errors"')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const errors = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((answer) =>
    answer && typeof answer === 'object' && Array.isArray((answer as Params).errors) ? (answer as Params).errors : [],
  );
  if (!errors.length) return undefined;
  return errors.slice(0, 5).map((error: Params) => ({
    message: withText && typeof error?.message === 'string' ? sanitizeText(error.message.slice(0, 300)) : undefined,
    path: Array.isArray(error?.path) ? error.path.slice(0, 10).join('.') : undefined,
    code: typeof error?.extensions?.code === 'string' ? error.extensions.code.slice(0, 80) : undefined,
  }));
}

/** A frame's text without secrets: JSON by field name and content, other text by content. */
export function framePayload(text: string): string {
  let clean: string;
  try {
    clean = JSON.stringify(sanitize(JSON.parse(text)));
  } catch {
    clean = sanitizeText(text);
  }
  return clean.length > MAX_FRAME_CHARS ? `${clean.slice(0, MAX_FRAME_CHARS)}… (${text.length} characters)` : clean;
}

/** Two URLs share an origin, or a host (a page's own WebSocket has a ws: origin). */
const same = (a: string, b: string, part: 'origin' | 'host') => {
  try {
    return new URL(a)[part] === new URL(b)[part];
  } catch {
    return false;
  }
};

/**
 * Chromium's debugger channel: network with failed same-origin response bodies, console,
 * exceptions and browser log entries. One attachment per collected tab.
 */
export class DeepCollector {
  private readonly attached = new Set<number>();
  /** The person clicked Cancel on Chrome's debugging bar: stay detached across all tabs until they explicitly reconnect or start a recording. */
  private declinedAll = false;
  private readonly requests = new Map<string, Request>();
  /** Requests left out as noise: their answers are left out too. */
  private readonly ignored = new Set<string>();
  /** Open WebSockets: their URL, and the frames kept in the current minute. */
  private readonly sockets = new Map<string, { url?: string; minute: number; frames: number }>();

  constructor(
    private readonly buffer: EvidenceBuffer,
    private readonly pageUrl: (tabId: number) => string | undefined,
    private readonly onCanceled?: () => void,
  ) {
    browser.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId !== undefined && this.attached.has(source.tabId)) {
        void this.event(source.tabId, method, (params ?? {}) as Params);
      }
    });
    browser.debugger.onDetach.addListener((source, reason) => {
      if (reason === 'canceled_by_user') {
        // Handle cancel even when this.attached is empty (a restarted MV3 service worker loses in-memory state).
        const alreadyDeclined = this.declinedAll;
        this.declinedAll = true;
        const tabs = new Set(this.attached);
        if (source.tabId !== undefined) tabs.add(source.tabId);
        this.attached.clear();
        this.requests.clear();
        this.sockets.clear();
        for (const tabId of tabs) {
          this.buffer.gap(tabId, 'debugger', `Debugger detached: ${reason}`);
          this.buffer.start(tabId, 'screenshotOnly');
        }
        if (!alreadyDeclined) this.onCanceled?.();
        return;
      }
      if (source.tabId === undefined || !this.attached.delete(source.tabId)) return;
      this.buffer.gap(source.tabId, 'debugger', `Debugger detached: ${reason}`);
    });
  }

  static available() {
    return typeof browser.debugger?.attach === 'function';
  }

  isAttached(tabId: number) {
    return this.attached.has(tabId);
  }

  /** The person clicked Cancel on Chrome's debugging bar. */
  isDeclined() {
    return this.declinedAll;
  }

  setDeclined(value: boolean) {
    this.declinedAll = value;
  }

  async attach(tabId: number) {
    if (this.declinedAll || this.attached.has(tabId)) return;
    const target = { tabId };
    await browser.debugger.attach(target, '1.3');
    if (this.declinedAll) {
      await browser.debugger.detach(target).catch(() => {});
      return;
    }
    this.attached.add(tabId);
    try {
      for (const domain of ['Network.enable', 'Runtime.enable', 'Log.enable']) {
        await browser.debugger.sendCommand(target, domain);
      }
    } catch (error) {
      // Half attached collects nothing but shows the debugging bar: let go of the tab.
      this.attached.delete(tabId);
      await browser.debugger.detach(target).catch(() => {});
      throw error;
    }
  }

  /**
   * A WebP shot of the tab, about 1280 px wide, for the record's filmstrip. Base64. Never throws:
   * a tab that cannot be shot has no shot.
   */
  async shot(tabId: number): Promise<string | null> {
    if (!this.attached.has(tabId)) return null;
    try {
      const metrics = (await browser.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics')) as {
        cssLayoutViewport: { clientWidth: number; clientHeight: number };
      };
      const { clientWidth: width, clientHeight: height } = metrics.cssLayoutViewport;
      const { data } = (await browser.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
        format: 'webp',
        quality: 70,
        clip: { x: 0, y: 0, width, height, scale: Math.min(1, 1280 / Math.max(1, width)) },
      })) as { data: string };
      return data;
    } catch {
      return null;
    }
  }

  /** PNG (base64) of the tab's viewport, taken through the debugger: no activeTab grant needed. */
  async screenshot(tabId: number): Promise<string> {
    const { data } = (await browser.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'png',
    })) as { data: string };
    return data;
  }

  async detach(tabId: number) {
    if (!this.attached.delete(tabId)) return;
    for (const map of [this.requests, this.sockets]) for (const key of map.keys()) if (key.startsWith(`${tabId}:`)) map.delete(key);
    await browser.debugger.detach({ tabId }).catch(() => {});
  }

  private async event(tabId: number, method: string, p: Params) {
    const key = `${tabId}:${p.requestId}`;
    if (method.startsWith('Network.') && method !== 'Network.requestWillBeSent' && this.ignored.has(key)) {
      if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') this.ignored.delete(key);
      return;
    }
    switch (method) {
      case 'Network.requestWillBeSent':
        const noise = noiseReason(p.request.url, p.type, typeof p.request.postData === 'string' ? p.request.postData : '');
        if (noise) {
          if (this.ignored.size > 2048) this.ignored.clear();
          this.ignored.add(key);
          this.buffer.drop(tabId, noise);
          break;
        }
        if (this.requests.size > 512) this.requests.delete(this.requests.keys().next().value!);
        this.requests.set(key, { url: p.request.url, resourceType: p.type });
        this.buffer.record(tabId, 'request', {
          requestId: p.requestId,
          url: p.request.url,
          method: p.request.method,
          resourceType: p.type,
          initiator: p.initiator?.type,
          // What the page sent to its own origin, for a test that replays the request.
          postData: requestBody(p.request.postData, contentType(p.request.headers) ?? '', p.request.url, this.pageUrl(tabId) ?? ''),
          postDataType: contentType(p.request.headers),
          graphqlOperation: graphqlOperation(p.request.postData),
        });
        break;
      case 'Network.responseReceived': {
        const request = this.requests.get(key);
        if (request) Object.assign(request, { status: p.response.status, mimeType: p.response.mimeType });
        this.buffer.record(tabId, 'response', {
          requestId: p.requestId,
          url: p.response.url,
          status: p.response.status,
          statusText: p.response.statusText,
          mimeType: p.response.mimeType,
          fromCache: p.response.fromDiskCache || p.response.fromServiceWorker || false,
          timing: p.response.timing ? { receiveHeadersEnd: p.response.timing.receiveHeadersEnd } : undefined,
        });
        break;
      }
      case 'Network.loadingFinished': {
        const request = this.requests.get(key);
        this.requests.delete(key);
        // Bodies of failures explain the defect; bodies of the page's own API calls let a test
        // replay the server. Documents, scripts and images would only crowd the buffer.
        if (!request) break;
        const failed = (request.status ?? 0) >= 400;
        if (!failed && !['XHR', 'Fetch'].includes(request.resourceType ?? '')) break;
        const page = this.pageUrl(tabId);
        try {
          const { body, base64Encoded } = (await browser.debugger.sendCommand({ tabId }, 'Network.getResponseBody', {
            requestId: p.requestId,
          })) as { body: string; base64Encoded: boolean };
          const evidence = base64Encoded
            ? { omission: 'Binary body left out' }
            : bodyEvidence(body, request.mimeType ?? '', request.url, page ?? '');
          // GraphQL answers its errors with 200: they count as a failed request. Their text only
          // from the page's own origin, as with bodies.
          const errors = !failed && !base64Encoded && /json/i.test(request.mimeType ?? '')
            ? graphqlErrors(body, same(request.url, page ?? '', 'origin'))
            : undefined;
          this.buffer.record(tabId, 'responseBody', { requestId: p.requestId, url: request.url, ...evidence, ...(errors ? { graphqlError: true } : {}) });
          if (errors) {
            this.buffer.record(tabId, 'networkFailure', {
              requestId: p.requestId,
              errorText: `GraphQL error: ${errors.map((e) => e.message ?? e.code ?? 'error').join('; ')}`.slice(0, 600),
              canceled: false,
              graphqlError: true,
              graphqlErrors: errors,
            });
          }
        } catch (error) {
          this.buffer.gap(tabId, 'responseBody', `Body unavailable: ${(error as Error).message}`);
        }
        break;
      }
      case 'Network.loadingFailed':
        this.requests.delete(key);
        this.buffer.record(tabId, 'networkFailure', {
          requestId: p.requestId,
          errorText: p.errorText,
          canceled: p.canceled ?? false,
          blockedReason: p.blockedReason,
        });
        break;
      case 'Network.webSocketCreated':
        if (this.sockets.size >= MAX_SOCKETS) this.sockets.delete(this.sockets.keys().next().value!);
        this.sockets.set(key, { url: p.url, minute: 0, frames: 0 });
        this.buffer.record(tabId, 'webSocket', { requestId: p.requestId, url: sanitizeUrl(p.url ?? ''), initiator: p.initiator?.type });
        break;
      case 'Network.webSocketFrameSent':
      case 'Network.webSocketFrameReceived': {
        // A socket opened before Lens attached has no URL here: its frames count, their text does not.
        const socket = this.sockets.get(key) ?? { minute: 0, frames: 0 };
        if (!this.sockets.has(key) && this.sockets.size < MAX_SOCKETS) this.sockets.set(key, socket);
        const minute = Math.floor(Date.now() / 60_000);
        if (socket.minute !== minute) Object.assign(socket, { minute, frames: 0 });
        if (++socket.frames > MAX_FRAMES_PER_MINUTE) {
          this.buffer.drop(tabId, 'websocket-frames-over-limit');
          break;
        }
        const { opcode, payloadData } = (p.response ?? {}) as { opcode?: number; payloadData?: string };
        const text = opcode === 1 && typeof payloadData === 'string';
        // Only what the page's own server sent and got, as with request bodies.
        const own = socket.url !== undefined && same(socket.url, this.pageUrl(tabId) ?? '', 'host');
        this.buffer.record(tabId, 'webSocketFrame', {
          requestId: p.requestId,
          direction: method === 'Network.webSocketFrameSent' ? 'sent' : 'received',
          opcode,
          length: payloadData?.length ?? 0,
          ...(text && own ? { payload: framePayload(payloadData!) } : { omission: text ? 'Frame of another site left out' : 'Binary or control frame left out' }),
        });
        break;
      }
      case 'Network.webSocketFrameError':
        this.buffer.record(tabId, 'webSocketError', { requestId: p.requestId, errorText: p.errorMessage });
        break;
      case 'Network.webSocketClosed':
        this.sockets.delete(key);
        this.buffer.record(tabId, 'webSocketClosed', { requestId: p.requestId });
        break;
      case 'Runtime.consoleAPICalled':
        this.buffer.record(tabId, 'console', {
          level: p.type,
          text: (p.args ?? []).map(describe).join(' '),
          location: topFrame(p.stackTrace),
        });
        break;
      case 'Runtime.exceptionThrown': {
        const details = p.exceptionDetails ?? {};
        this.buffer.record(tabId, 'exception', {
          text: details.exception?.description ?? details.text,
          url: details.url,
          line: details.lineNumber,
          column: details.columnNumber,
          stack: (details.stackTrace?.callFrames ?? []).slice(0, 12).map(frame),
        });
        break;
      }
      case 'Log.entryAdded':
        this.buffer.record(tabId, 'log', {
          level: p.entry.level,
          source: p.entry.source,
          text: p.entry.text,
          url: p.entry.url,
        });
        break;
    }
  }
}

function contentType(headers: Params | undefined): string | undefined {
  const found = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type');
  return typeof found?.[1] === 'string' ? found[1] : undefined;
}

function describe(arg: Params): string {
  if ('value' in arg) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  return arg.description ?? arg.unserializableValue ?? arg.type ?? '';
}

function frame(f: Params) {
  return { function: f.functionName || '(anonymous)', url: f.url, line: f.lineNumber, column: f.columnNumber };
}

function topFrame(stack: Params | undefined) {
  const first = stack?.callFrames?.[0];
  return first ? frame(first) : undefined;
}

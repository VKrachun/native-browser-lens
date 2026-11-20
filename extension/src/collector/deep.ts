import type { EvidenceBuffer } from './buffer';
import { noiseReason } from './noise';
import { bodyEvidence, requestBody } from './sanitize';

type Params = Record<string, any>;

interface Request {
  url: string;
  resourceType?: string;
  status?: number;
  mimeType?: string;
}

/**
 * Chromium's debugger channel: network with failed same-origin response bodies, console,
 * exceptions and browser log entries. One attachment per collected tab.
 */
export class DeepCollector {
  private readonly attached = new Set<number>();
  private readonly declined = new Set<number>();
  private readonly requests = new Map<string, Request>();
  /** Requests left out as noise: their answers are left out too. */
  private readonly ignored = new Set<string>();

  constructor(
    private readonly buffer: EvidenceBuffer,
    private readonly pageUrl: (tabId: number) => string | undefined,
  ) {
    browser.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId !== undefined && this.attached.has(source.tabId)) {
        void this.event(source.tabId, method, (params ?? {}) as Params);
      }
    });
    browser.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId === undefined || !this.attached.delete(source.tabId)) return;
      this.buffer.gap(source.tabId, 'debugger', `Debugger detached: ${reason}`);
      // The person closed the browser's debugging bar: never attach again in this tab until it
      // leaves the project, and collect without the debugger meanwhile.
      if (reason === 'canceled_by_user') {
        this.declined.add(source.tabId);
        this.buffer.start(source.tabId, 'screenshotOnly');
      }
    });
  }

  static available() {
    return typeof browser.debugger?.attach === 'function';
  }

  isAttached(tabId: number) {
    return this.attached.has(tabId);
  }

  /** The person refused the debugger in this tab. */
  isDeclined(tabId: number) {
    return this.declined.has(tabId);
  }

  async attach(tabId: number) {
    if (this.attached.has(tabId)) return;
    const target = { tabId };
    await browser.debugger.attach(target, '1.3');
    this.attached.add(tabId);
    for (const domain of ['Network.enable', 'Runtime.enable', 'Log.enable']) {
      await browser.debugger.sendCommand(target, domain);
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
    this.declined.delete(tabId);
    if (!this.attached.delete(tabId)) return;
    for (const key of this.requests.keys()) if (key.startsWith(`${tabId}:`)) this.requests.delete(key);
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
          this.buffer.record(tabId, 'responseBody', { requestId: p.requestId, url: request.url, ...evidence });
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

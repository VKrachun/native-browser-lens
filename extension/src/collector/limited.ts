import type { EvidenceBuffer } from './buffer';
import { noiseReason } from './noise';
import { originOf } from '@/messages';

/**
 * Network metadata from webRequest, for browsers without the debugger API (Firefox). It observes
 * only; it never blocks or changes a request.
 */
export class LimitedCollector {
  constructor(
    private readonly buffer: EvidenceBuffer,
    private readonly collected: (tabId: number) => boolean,
  ) {}

  listen() {
    const filter = { urls: ['http://*/*', 'https://*/*'] };
    const web = browser.webRequest;
    web.onBeforeRequest.addListener((d) => {
      this.record(d.tabId, 'request', { requestId: d.requestId, url: d.url, method: d.method, resourceType: d.type });
      return undefined;
    }, filter);
    web.onCompleted.addListener(
      (d) =>
        this.record(d.tabId, 'response', {
          requestId: d.requestId,
          url: d.url,
          status: d.statusCode,
          fromCache: d.fromCache,
        }),
      filter,
    );
    web.onErrorOccurred.addListener(
      (d) => this.record(d.tabId, 'networkFailure', { requestId: d.requestId, url: d.url, errorText: d.error }),
      filter,
    );
  }

  private record(tabId: number, kind: string, data: Record<string, unknown>) {
    const noise = noiseReason(String(data.url ?? ''), String(data.resourceType ?? ''));
    if (noise) {
      // Each request reports here up to three times; count it once.
      if (kind === 'request' && tabId >= 0 && this.collected(tabId)) this.buffer.drop(tabId, noise);
      return;
    }
    if (tabId >= 0 && this.collected(tabId)) this.buffer.record(tabId, kind, { ...data, source: 'webRequest' });
  }
}

export type View = { windowId: number; active: boolean; url?: string; document: string | null };

/**
 * Whether the window still showed the same tab and page after a shot as before it. A tab moved to
 * another window, or another tab in front, fails. A hash or pushState change keeps the document,
 * so it passes; without a document mark (a page that refuses scripts), the origin decides.
 */
export function sameView(before: View, after: View): boolean {
  if (!before.active || !after.active || after.windowId !== before.windowId) return false;
  if (before.document && after.document) return before.document === after.document;
  return originOf(before.url) !== null && originOf(before.url) === originOf(after.url);
}

/** A mark of the tab's current document: the same until the tab loads another page. */
async function documentOf(tabId: number): Promise<string | null> {
  return browser.scripting
    .executeScript({
      target: { tabId },
      func: () => ((globalThis as { lensDocument?: string }).lensDocument ??= crypto.randomUUID()),
    })
    .then((results) => (typeof results[0]?.result === 'string' ? results[0].result : null), () => null);
}

async function viewOf(tabId: number): Promise<View> {
  const [tab, document] = await Promise.all([browser.tabs.get(tabId), documentOf(tabId)]);
  return { windowId: tab.windowId, active: tab.active, url: tab.url, document };
}

/**
 * The visible part of the window, as a PNG data URL, when it shows `tabId`; null when another tab
 * or page came to the front during the shot. captureVisibleTab shoots the window, not the tab: a
 * switch at that moment would put another tab's pixels in this tab's record.
 */
export async function captureTab(tabId: number): Promise<string | null> {
  const before = await viewOf(tabId);
  if (!before.active) return null;
  const png = await browser.tabs.captureVisibleTab(before.windowId, { format: 'png' });
  return sameView(before, await viewOf(tabId)) ? png : null;
}

/**
 * Firefox has no debugger: a WebP shot of the visible tab, about 1280 px wide, base64. Only when
 * the tab is in front (the visible tab is what can be shot) and the grant allows it; else none.
 */
export async function visibleShot(tabId: number): Promise<string | null> {
  try {
    const png = await captureTab(tabId);
    if (!png) return null;
    const bitmap = await createImageBitmap(await (await fetch(png)).blob());
    const scale = Math.min(1, 1280 / Math.max(1, bitmap.width));
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const webp = await canvas.convertToBlob({ type: 'image/webp', quality: 0.7 });
    // A browser without a WebP encoder gives PNG: the daemon keeps WebP shots only.
    if (webp.type !== 'image/webp') return null;
    const bytes = new Uint8Array(await webp.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  } catch {
    return null;
  }
}

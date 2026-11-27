import type { Action } from '@/protocol/Action';
import type { Annotation } from '@/protocol/Annotation';
import type { Evidence } from '@/protocol/Evidence';
import type { EvidenceEvent } from '@/protocol/EvidenceEvent';
import type { Locator } from '@/protocol/Locator';
import type { MarkTarget } from '@/protocol/MarkTarget';
import type { PageElement } from '@/protocol/PageElement';
import type { Pointing } from '@/protocol/Pointing';
import type { Review } from '@/protocol/Review';
import type { ReviewItem } from '@/protocol/ReviewItem';
import type { ReviewVoice } from '@/protocol/ReviewVoice';
import type { ScreenNote } from '@/protocol/ScreenNote';
import type { Shape } from '@/protocol/Shape';
import type { TimeRange } from '@/protocol/TimeRange';
import { NAMESPACE_OID, insideKept, isHidingShape, splitFindingsBlock, uuidv5 } from './helpers';

const STATIC_RESOURCES = new Set(['script', 'stylesheet', 'font', 'image', 'media', 'manifest']);
const STEP_WINDOW_MS = 2000;
const SHOT_WINDOW_MS = 2500;
const CAUSED_NAVIGATION_MS = 5000;
const HARD_CAPTURE_LIMIT = 400 * 1024;
const TARGET_CAPTURE_SIZE = 64 * 1024;
const MAX_BODY_KEEP = 8 * 1024;

export interface TimelineContext {
  kept: TimeRange[];
  voice: ReviewVoice[];
  screen: ScreenNote[];
  pointing: Pointing[];
  annotations: Annotation[];
}

/** Filters evidence to kept ranges, strips elements, and applies typedValues redaction rules. */
export function evidenceForReview(
  evidence: Evidence,
  typedValues: boolean,
  kept: TimeRange[],
  stripVideo: boolean,
): { evidence: Evidence; cut: number } {
  let cut = 0;
  const actions: Action[] = [];
  for (const act of evidence.actions) {
    if (!insideKept(kept, act.timestamp)) {
      cut += 1;
      continue;
    }
    if (!typedValues && (act.kind === 'fill' || act.kind === 'select')) {
      actions.push({ ...act, value: null, masked: true });
    } else {
      actions.push(act);
    }
  }

  const statusByReq = new Map<string, number>();
  for (const ev of evidence.events) {
    if (ev.kind === 'response' && ev.data && typeof ev.data === 'object') {
      const d = ev.data as Record<string, unknown>;
      if (typeof d.requestId === 'string' && typeof d.status === 'number') {
        statusByReq.set(d.requestId, d.status);
      }
    }
  }

  const events: EvidenceEvent[] = [];
  for (const ev of evidence.events) {
    if (stripVideo && ev.kind === 'video') continue;
    if (!insideKept(kept, ev.timestamp)) {
      cut += 1;
      continue;
    }
    if (!typedValues && ev.data && typeof ev.data === 'object') {
      const d = ev.data as Record<string, unknown>;
      if (ev.kind === 'request') {
        const { postData: _p, postDataType: _pt, ...rest } = d;
        events.push({ ...ev, data: rest as EvidenceEvent['data'] });
        continue;
      }
      if (ev.kind === 'responseBody') {
        const reqId = typeof d.requestId === 'string' ? d.requestId : '';
        const st = statusByReq.get(reqId) ?? 0;
        if (st < 400) continue;
      }
    }
    events.push(ev);
  }

  return {
    evidence: {
      ...evidence,
      actions,
      events,
      elements: [],
    },
    cut,
  };
}

function overlapArea(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

/** Maps non-hiding screenshot shapes to the visible DOM elements they point at. */
export function markTargets(shapes: Shape[], elements: PageElement[], scale: number): MarkTarget[] {
  const s = scale > 0 ? scale : 1;
  const masks = shapes
    .filter(isHidingShape)
    .map((m) => ({ x: m.x / s, y: m.y / s, width: m.width / s, height: m.height / s }));

  const safeElements = elements.filter((el) => {
    const area = el.width * el.height;
    if (area <= 0) return false;
    return !masks.some((m) => overlapArea(m, el) > 0);
  });

  const smallestAt = (px: number, py: number): PageElement | null => {
    let best: PageElement | null = null;
    let bestArea = Infinity;
    for (const el of safeElements) {
      if (px >= el.x && px <= el.x + el.width && py >= el.y && py <= el.y + el.height) {
        const area = el.width * el.height;
        if (area < bestArea) {
          bestArea = area;
          best = el;
        }
      }
    }
    return best;
  };

  const out: MarkTarget[] = [];
  let markIdx = 0;
  for (const shape of shapes) {
    if (isHidingShape(shape)) continue;
    markIdx += 1;
    let matched: PageElement[] = [];
    if (shape.kind === 'rectangle') {
      const box = { x: shape.x / s, y: shape.y / s, width: shape.width / s, height: shape.height / s };
      matched = safeElements
        .filter((el) => overlapArea(box, el) / Math.max(1, el.width * el.height) >= 0.6)
        .sort((a, b) => b.width * b.height - a.width * a.height)
        .slice(0, 5);
      if (matched.length === 0) {
        const center = smallestAt(box.x + box.width / 2, box.y + box.height / 2);
        if (center) matched = [center];
      }
    } else if (shape.kind === 'pen' && shape.points.length > 0) {
      const xs = shape.points.map((p) => p.x / s);
      const ys = shape.points.map((p) => p.y / s);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const box = { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
      matched = safeElements
        .filter((el) => overlapArea(box, el) / Math.max(1, el.width * el.height) >= 0.6)
        .sort((a, b) => b.width * b.height - a.width * a.height)
        .slice(0, 5);
      if (matched.length === 0) {
        const center = smallestAt(minX + box.width / 2, minY + box.height / 2);
        if (center) matched = [center];
      }
    } else if (shape.kind === 'arrow') {
      const hit = smallestAt(shape.to.x / s, shape.to.y / s);
      if (hit) matched = [hit];
    } else if (shape.kind === 'text' || shape.kind === 'badge') {
      const hit = smallestAt(shape.x / s, shape.y / s);
      if (hit) matched = [hit];
    }

    out.push({
      mark: markIdx,
      kind: shape.kind,
      elements: matched.map((el) => el.locator),
    });
  }
  return out;
}

/** Extracts deterministic browser failure findings (HTTP errors, network failures, console errors, exceptions). */
export function findingsFromEvidence(evidence: Evidence): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (line: string) => {
    const clean = line.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };

  const reqInfo = new Map<string, { method: string; url: string }>();
  for (const ev of evidence.events) {
    const d = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as Record<string, unknown>;
    if (ev.kind === 'request' && typeof d.requestId === 'string') {
      reqInfo.set(d.requestId, {
        method: String(d.method ?? 'GET'),
        url: String(d.url ?? ''),
      });
    } else if (ev.kind === 'response') {
      const status = Number(d.status ?? 0);
      if (status >= 400) {
        const req = typeof d.requestId === 'string' ? reqInfo.get(d.requestId) : undefined;
        const method = req?.method ?? String(d.method ?? 'GET');
        const url = String(d.url ?? req?.url ?? '');
        add(`HTTP ${status} ${method} ${url}`);
      }
    } else if (ev.kind === 'networkFailure') {
      const req = typeof d.requestId === 'string' ? reqInfo.get(d.requestId) : undefined;
      const url = String(d.url ?? req?.url ?? '');
      const err = String(d.errorText ?? d.error ?? 'failed');
      add(`Network failure: ${url} (${err})`);
    } else if (ev.kind === 'exception') {
      add(`Uncaught exception: ${String(d.text ?? d.message ?? 'unknown error')}`);
    } else if (ev.kind === 'console') {
      const level = String(d.type ?? d.level ?? '').toLowerCase();
      if (level === 'error') {
        const text = Array.isArray(d.args) ? d.args.map(String).join(' ') : String(d.text ?? d.message ?? '');
        if (text) add(`Console error: ${text}`);
      }
    }
  }
  return out.slice(0, 24);
}

function fmtOffset(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSec = Math.floor(clamped / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const rem = clamped % 1000;
  return `+${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(rem).padStart(3, '0')}`;
}

export function spokenInKept(kept: TimeRange[], startMs: number, endMs: number): boolean {
  if (kept.length === 0) return true;
  const mid = Math.round((startMs + endMs) / 2);
  return kept.some((r) => mid >= r.from && mid <= r.to);
}

function pointedAt(pointing: Pointing[], at: number): string[] {
  const labels: string[] = [];
  for (const p of pointing) {
    if (p.to >= at - 500 && p.from <= at + 300) {
      if (!labels.includes(p.label)) labels.push(p.label);
      if (labels.length >= 2) break;
    }
  }
  return labels;
}

function describeLocator(loc: Locator | null): string {
  if (!loc) return 'element';
  if (loc.testId) return `[data-testid="${loc.testId}"]`;
  if (loc.role && loc.name) return `${loc.role} "${loc.name}"`;
  if (loc.text) return `"${loc.text.slice(0, 60)}"`;
  return loc.css || 'element';
}

/** Merges actions, notable network/console events, voice segments, screen notes, and annotations into a timeline. */
export function buildTimeline(evidence: Evidence, ctx: TimelineContext): string {
  const entries: Array<{ at: number; line: string }> = [];
  const reqMap = new Map<string, { method: string; url: string; resourceType: string }>();

  for (const act of evidence.actions) {
    let line: string;
    if (act.kind === 'navigate') line = `Navigated to ${act.url}`;
    else if (act.kind === 'click') line = `Clicked ${describeLocator(act.target)}`;
    else if (act.kind === 'fill') {
      line = act.masked
        ? `Typed [redacted] in ${describeLocator(act.target)}`
        : `Typed ${JSON.stringify(act.value ?? '')} in ${describeLocator(act.target)}`;
    } else if (act.kind === 'select') {
      line = act.masked
        ? `Selected [redacted] in ${describeLocator(act.target)}`
        : `Selected ${JSON.stringify(act.value ?? '')} in ${describeLocator(act.target)}`;
    } else if (act.kind === 'press') {
      line = `Pressed ${act.value ?? 'key'} on ${describeLocator(act.target)}`;
    } else {
      line = `${act.kind} ${describeLocator(act.target)}`;
    }
    entries.push({ at: act.timestamp, line });
  }

  for (const ev of evidence.events) {
    const d = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as Record<string, unknown>;
    if (ev.kind === 'request' && typeof d.requestId === 'string') {
      reqMap.set(d.requestId, {
        method: String(d.method ?? 'GET'),
        url: String(d.url ?? ''),
        resourceType: String(d.resourceType ?? ''),
      });
    } else if (ev.kind === 'response') {
      const req = typeof d.requestId === 'string' ? reqMap.get(d.requestId) : undefined;
      const status = Number(d.status ?? 0);
      const rt = (req?.resourceType ?? String(d.resourceType ?? '')).toLowerCase();
      if (status >= 400 || ['xhr', 'fetch', 'document', 'xmlhttprequest', 'main_frame'].includes(rt)) {
        entries.push({ at: ev.timestamp, line: `HTTP ${status} ${req?.method ?? 'GET'} ${String(d.url ?? req?.url ?? '')}` });
      }
    } else if (ev.kind === 'networkFailure') {
      const req = typeof d.requestId === 'string' ? reqMap.get(d.requestId) : undefined;
      entries.push({
        at: ev.timestamp,
        line: `Network failure: ${String(d.url ?? req?.url ?? '')} (${String(d.errorText ?? 'failed')})`,
      });
    } else if (ev.kind === 'console') {
      const level = String(d.type ?? d.level ?? 'log');
      const text = Array.isArray(d.args) ? d.args.map(String).join(' ') : String(d.text ?? d.message ?? '');
      entries.push({ at: ev.timestamp, line: `Console ${level}: ${text}` });
    } else if (ev.kind === 'exception') {
      entries.push({ at: ev.timestamp, line: `Exception: ${String(d.text ?? d.message ?? '')}` });
    } else if (ev.kind === 'log') {
      const level = String(d.level ?? '').toLowerCase();
      if (level === 'error' || level === 'warning') {
        entries.push({ at: ev.timestamp, line: `Browser ${level}: ${String(d.text ?? '')}` });
      }
    } else if (ev.kind === 'marker') {
      entries.push({ at: ev.timestamp, line: `Marker: ${String(d.label ?? 'marked moment')}` });
    } else if (ev.kind.startsWith('webSocket')) {
      entries.push({ at: ev.timestamp, line: `${ev.kind}: ${String(d.url ?? d.payload ?? '')}` });
    } else if (ev.kind === 'video') {
      entries.push({ at: ev.timestamp, line: 'Tab video recorded' });
    }
  }

  for (const s of ctx.screen) {
    entries.push({ at: s.at, line: `Screen: ${s.text}` });
  }
  for (const ann of ctx.annotations) {
    if (ann.text?.trim()) entries.push({ at: ann.at, line: `Note: ${ann.text.trim()}` });
  }

  const times = entries.map((e) => e.at);
  const first = times.length ? Math.min(...times) : 0;
  const last = times.length ? Math.max(...times) : first;

  for (const vn of ctx.voice) {
    for (const seg of vn.segments) {
      const segStart = vn.startedAt + seg.startMs;
      const segEnd = vn.startedAt + seg.endMs;
      if (times.length > 0 && (segEnd < first - 60_000 || segStart > last + 300_000)) continue;
      if (!spokenInKept(ctx.kept, segStart, segEnd)) continue;
      const ptr = pointedAt(ctx.pointing, Math.round((segStart + segEnd) / 2));
      const suffix = ptr.length ? ` (pointing at ${ptr.join(', ')})` : '';
      entries.push({ at: segStart, line: `Said: "${seg.text.trim()}"${suffix}` });
    }
  }

  entries.sort((a, b) => a.at - b.at);
  const origin = entries[0]?.at ?? 0;
  return entries
    .map((e) => `${fmtOffset(e.at - origin)}  ${e.line.replace(/[\r\n]+/g, ' ').slice(0, 400)}`)
    .join('\n');
}

function jsString(val: string): string {
  return JSON.stringify(val).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function jsComment(val: string): string {
  return val.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

function locatorExpr(loc: Locator | null): string {
  if (!loc) return `page.locator('body')`;
  if (loc.testId) return `page.getByTestId(${jsString(loc.testId)})`;
  if (loc.role && loc.name) {
    const base = `page.getByRole(${jsString(loc.role)}, { name: ${jsString(loc.name)}, exact: true })`;
    return loc.nth && loc.nth > 0 ? `${base}.nth(${loc.nth})` : base;
  }
  if (loc.text) return `page.getByText(${jsString(loc.text)}, { exact: true }).first()`;
  if (loc.css) return `page.locator(${jsString(loc.css)})`;
  return `page.locator('body')`;
}

/** Generates a @playwright/test reproduction spec from recorded actions and page context. */
export function buildPlaywrightSpec(
  evidence: Evidence,
  captureNum: number,
  title: string,
  pageUrl: string,
  opts?: { baseUrl?: string | null; name?: string; hasHar?: boolean },
): string {
  const pageMeta = (evidence.page && typeof evidence.page === 'object' ? evidence.page : {}) as Record<string, unknown>;
  const viewport = (pageMeta.viewport && typeof pageMeta.viewport === 'object'
    ? pageMeta.viewport
    : { width: 1280, height: 800 }) as { width?: number; height?: number };
  const useOpts: Record<string, unknown> = {
    viewport: { width: viewport.width ?? 1280, height: viewport.height ?? 800 },
  };
  if (typeof pageMeta.deviceScaleFactor === 'number') useOpts.deviceScaleFactor = pageMeta.deviceScaleFactor;
  if (typeof pageMeta.locale === 'string') useOpts.locale = pageMeta.locale;
  if (typeof pageMeta.timeZone === 'string') useOpts.timezoneId = pageMeta.timeZone;
  if (pageMeta.colorScheme === 'dark' || pageMeta.colorScheme === 'light') useOpts.colorScheme = pageMeta.colorScheme;

  const firstOrigin = (() => {
    try {
      return new URL(pageUrl).origin;
    } catch {
      return null;
    }
  })();

  const rewriteUrl = (raw: string): string => {
    if (!opts?.baseUrl || !firstOrigin) return raw;
    try {
      const u = new URL(raw);
      if (u.origin === firstOrigin) {
        return `${opts.baseUrl.replace(/\/+$/, '')}${u.pathname}${u.search}${u.hash}`;
      }
    } catch {
      // keep raw
    }
    return raw;
  };

  const prefix = opts?.name ?? `capture-${captureNum}`;
  const lines: string[] = [
    `import { test } from '@playwright/test';`,
    ``,
    `test.use(${JSON.stringify(useOpts, null, 2)});`,
    ``,
    `test(${jsString(title || `Capture ${captureNum}`)}, async ({ page }) => {`,
  ];

  if (opts?.hasHar) {
    lines.push(`  // Recorded API responses are saved beside this test:`);
    lines.push(`  // await page.routeFromHAR(${jsString(`${prefix}.har`)}, { update: false });`);
  }

  if (opts?.baseUrl) {
    lines.push(`  const baseOrigin = new URL(${jsString(opts.baseUrl)}).origin;`);
    lines.push(`  await page.context().route('**/*', (route) => {`);
    lines.push(`    const req = route.request();`);
    lines.push(`    if (req.isNavigationRequest() && new URL(req.url()).origin !== baseOrigin) {`);
    lines.push(`      return route.abort('blockedbyclient'); // lensBlocked`);
    lines.push(`    }`);
    lines.push(`    return route.continue();`);
    lines.push(`  });`);
  }

  const startUrl = rewriteUrl(pageUrl || evidence.actions[0]?.url || 'about:blank');
  lines.push(`  await page.goto(${jsString(startUrl)});`);

  let privateIdx = 0;
  let lastClickOrPressAt = -Infinity;
  for (const act of evidence.actions) {
    if (act.kind === 'navigate') {
      const targetUrl = rewriteUrl(act.url);
      if (act.timestamp - lastClickOrPressAt <= CAUSED_NAVIGATION_MS) {
        lines.push(`  await page.waitForURL(${jsString(targetUrl)}).catch(() => page.goto(${jsString(targetUrl)})); // lensMissed`);
      } else {
        lines.push(`  await page.goto(${jsString(targetUrl)});`);
      }
    } else if (act.kind === 'click') {
      lastClickOrPressAt = act.timestamp;
      lines.push(`  await ${locatorExpr(act.target)}.click();`);
    } else if (act.kind === 'fill') {
      if (act.masked) {
        privateIdx += 1;
        if (opts?.baseUrl) {
          lines.push(`  await ${locatorExpr(act.target)}.fill(process.env.LENS_PRIVATE_${privateIdx} ?? '');`);
        } else {
          lines.push(`  await ${locatorExpr(act.target)}.fill(''); // The person typed a private value here: type a valid one.`);
        }
      } else {
        lines.push(`  await ${locatorExpr(act.target)}.fill(${jsString(act.value ?? '')});`);
      }
    } else if (act.kind === 'select') {
      if (act.masked) {
        lines.push(`  // Private selection on ${jsComment(describeLocator(act.target))}`);
      } else {
        lines.push(`  await ${locatorExpr(act.target)}.selectOption(${jsString(act.value ?? '')});`);
      }
    } else if (act.kind === 'press') {
      lastClickOrPressAt = act.timestamp;
      lines.push(`  await ${locatorExpr(act.target)}.press(${jsString(act.value ?? 'Enter')});`);
    }
  }

  lines.push(`  await page.screenshot({ path: ${jsString(`${prefix}-reproduced.png`)} });`);
  lines.push(`});`);
  lines.push(``);
  return lines.join('\n');
}

/** Builds a HAR 1.2 JSON object for all requests that have both request, response, and responseBody. */
export function buildHar(
  evidence: Evidence,
  rewriteOrigin?: { from: string; to: string },
): { log: { version: string; creator: { name: string; version: string }; entries: unknown[] } } {
  const requests = new Map<string, { at: number; data: Record<string, unknown> }>();
  const responses = new Map<string, { at: number; data: Record<string, unknown> }>();
  const bodies = new Map<string, Record<string, unknown>>();

  for (const ev of evidence.events) {
    const d = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as Record<string, unknown>;
    const id = typeof d.requestId === 'string' ? d.requestId : null;
    if (!id) continue;
    if (ev.kind === 'request') requests.set(id, { at: ev.timestamp, data: d });
    else if (ev.kind === 'response') responses.set(id, { at: ev.timestamp, data: d });
    else if (ev.kind === 'responseBody') bodies.set(id, d);
  }

  const mapHeaders = (raw: unknown): Array<{ name: string; value: string }> => {
    if (!raw || typeof raw !== 'object') return [];
    return Object.entries(raw as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value ?? '') }));
  };

  const entries: unknown[] = [];
  for (const [id, req] of requests) {
    const res = responses.get(id);
    const body = bodies.get(id);
    if (!res || !body) continue;
    const format = String(body.format ?? 'text');
    if (format !== 'json' && format !== 'text') continue;

    let url = String(req.data.url ?? res.data.url ?? '');
    if (rewriteOrigin) {
      try {
        const u = new URL(url);
        if (u.origin === rewriteOrigin.from) {
          url = `${rewriteOrigin.to.replace(/\/+$/, '')}${u.pathname}${u.search}${u.hash}`;
        }
      } catch {
        // leave url
      }
    }

    const bodyText = typeof body.body === 'string' ? body.body : JSON.stringify(body.body ?? '');
    const mimeType = String(res.data.mimeType ?? (format === 'json' ? 'application/json' : 'text/plain'));
    const postData = typeof req.data.postData === 'string' ? req.data.postData : undefined;
    entries.push({
      startedDateTime: new Date(req.at).toISOString(),
      time: Math.max(0, res.at - req.at),
      request: {
        method: String(req.data.method ?? 'GET'),
        url,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: mapHeaders(req.data.headers),
        queryString: [],
        ...(postData !== undefined
          ? { postData: { mimeType: String(req.data.postDataType ?? 'application/json'), text: postData } }
          : {}),
        headersSize: -1,
        bodySize: postData ? postData.length : 0,
      },
      response: {
        status: Number(res.data.status ?? 200),
        statusText: String(res.data.statusText ?? ''),
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: mapHeaders(res.data.headers),
        content: {
          size: bodyText.length,
          mimeType,
          text: bodyText,
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: bodyText.length,
      },
      cache: {},
      timings: { send: 0, wait: Math.max(0, res.at - req.at), receive: 0 },
    });
  }

  return {
    log: {
      version: '1.2',
      creator: { name: 'Sirv Lens', version: '1.0' },
      entries,
    },
  };
}

/** Proportionally downsamples shots across review items to fit within a file budget. */
export function shareShots(items: ReviewItem[], budget: number): void {
  const totalShots = items.reduce((sum, it) => sum + it.shots.length, 0);
  if (totalShots <= budget) return;
  const target = Math.max(0, budget);
  let remaining = target;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i]!;
    const share = i === items.length - 1 ? remaining : Math.floor((it.shots.length / totalShots) * target);
    const keepCount = Math.min(it.shots.length, Math.max(0, share));
    remaining -= keepCount;
    if (keepCount < it.shots.length) {
      const dropped = it.shots.length - keepCount;
      if (keepCount === 0) {
        it.shots = [];
      } else {
        const picked: typeof it.shots = [];
        for (let k = 0; k < keepCount; k += 1) {
          const idx = keepCount === 1 ? it.shots.length - 1 : Math.round((k * (it.shots.length - 1)) / (keepCount - 1));
          picked.push(it.shots[idx]!);
        }
        it.shots = picked;
      }
      it.shotsDropped += dropped;
    }
  }
}

export function filesEndScreenshot(item: ReviewItem): boolean {
  return item.kind !== 'session';
}

/** Builds the `lens-capture.v1` structured JSON record (bounded to 400 KiB), matching Rust `src/record.rs` & VibeQ. */
export async function buildLensCapture(
  review: Review,
  item: ReviewItem,
  evidence: Evidence,
  version: string,
  captureIndex = 1,
): Promise<string> {
  const captureUuid = await uuidv5(NAMESPACE_OID, `lens-capture:${item.capture}:${item.capturedAt}`);
  const pageMeta = (evidence.page && typeof evidence.page === 'object' ? evidence.page : {}) as Record<string, unknown>;
  const start = item.startedAt;
  const end = Math.max(start, item.capturedAt);
  const atMs = (t: number) => Math.round(t - start);

  // Network entries (matching src/record.rs)
  interface RawNet {
    requestId: string;
    at: number;
    ended: number | null;
    method: string;
    url: string;
    kind: string;
    status: number | null;
    failure: string | null;
    requestBody?: string;
    responseBody?: string;
  }
  const netList: RawNet[] = [];
  const netIdx = new Map<string, number>();

  for (const ev of evidence.events) {
    const d = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as Record<string, unknown>;
    const rid = typeof d.requestId === 'string' ? d.requestId : '';
    if (!rid) continue;
    if (ev.kind === 'request') {
      netIdx.set(rid, netList.length);
      netList.push({
        requestId: rid,
        at: ev.timestamp,
        ended: null,
        method: String(d.method ?? 'GET'),
        url: String(d.url ?? ''),
        kind: String(d.resourceType ?? ''),
        status: null,
        failure: null,
        requestBody: typeof d.postData === 'string' ? d.postData.slice(0, MAX_BODY_KEEP) : undefined,
      });
    } else if (ev.kind === 'response') {
      const idx = netIdx.get(rid);
      if (idx !== undefined) {
        netList[idx]!.status = Number(d.status ?? 0);
        netList[idx]!.ended = ev.timestamp;
      }
    } else if (ev.kind === 'requestFailed') {
      const idx = netIdx.get(rid);
      if (idx !== undefined) {
        netList[idx]!.failure = String(d.errorText ?? d.error ?? 'failed');
        netList[idx]!.ended = ev.timestamp;
      }
    } else if (ev.kind === 'responseBody') {
      const idx = netIdx.get(rid);
      if (idx !== undefined) {
        const txt = typeof d.body === 'string' ? d.body : JSON.stringify(d.body ?? '');
        netList[idx]!.responseBody = txt.slice(0, MAX_BODY_KEEP);
      }
    }
  }

  const isFailedNet = (e: RawNet) => Boolean(e.failure) || (e.status !== null && e.status >= 400);
  const droppedRequests: Record<string, number> = {};
  const filteredNet = netList.filter((e) => {
    if (e.method.toUpperCase() === 'OPTIONS' && !isFailedNet(e)) {
      droppedRequests.preflight = (droppedRequests.preflight ?? 0) + 1;
      return false;
    }
    if (STATIC_RESOURCES.has(e.kind.toLowerCase()) && !isFailedNet(e)) {
      droppedRequests['static-asset'] = (droppedRequests['static-asset'] ?? 0) + 1;
      return false;
    }
    return true;
  });

  // Console entries (errors & warnings, repeats merged)
  const consoleEntries: Array<{ atMs: number; level: string; text: string; count: number; source?: string }> = [];
  const consoleAt: number[] = [];
  const seenConsole = new Map<string, number>();
  let consoleRepeats = 0;

  for (const ev of evidence.events) {
    const d = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as Record<string, unknown>;
    let level: string | null = null;
    let text = '';
    let source = '';
    if (ev.kind === 'console') {
      const rawLevel = String(d.level ?? d.type ?? '');
      if (rawLevel === 'error' || rawLevel === 'assert') level = 'error';
      else if (rawLevel === 'warning' || rawLevel === 'warn') level = 'warning';
      else continue;
      text = Array.isArray(d.args) ? d.args.map(String).join(' ') : String(d.text ?? d.message ?? '');
      const loc = d.location && typeof d.location === 'object' ? (d.location as Record<string, unknown>) : null;
      source = typeof loc?.url === 'string' ? loc.url : '';
    } else if (ev.kind === 'exception') {
      level = 'error';
      text = String(d.text ?? d.message ?? '');
      source = typeof d.url === 'string' ? d.url : '';
    } else if (ev.kind === 'log') {
      const rawLevel = String(d.level ?? '');
      if (rawLevel === 'error' || rawLevel === 'warning') level = rawLevel;
      else continue;
      text = String(d.text ?? '');
      source = typeof d.url === 'string' ? d.url : '';
    } else {
      continue;
    }
    const cleanText = text.slice(0, 1000);
    const key = `${cleanText}\0${source}`;
    const prevIdx = seenConsole.get(key);
    if (prevIdx !== undefined) {
      consoleEntries[prevIdx]!.count += 1;
      consoleRepeats += 1;
      continue;
    }
    seenConsole.set(key, consoleEntries.length);
    consoleAt.push(ev.timestamp);
    consoleEntries.push({
      atMs: atMs(ev.timestamp),
      level,
      text: cleanText,
      count: 1,
      ...(source ? { source } : {}),
    });
  }

  // Shots (exact lens-capture.v1 shape: id, atMs, file, sha256, contentType, reason)
  const shots: Array<{ id: string; atMs: number; file: string; sha256: string; contentType: string; reason: string }> =
    item.shots.map((s, idx) => ({
      id: `shot-${idx + 1}`,
      atMs: atMs(s.at),
      file: `capture-${captureIndex}-shot-${idx + 1}.webp`,
      sha256: s.image.sha256,
      contentType: 'image/webp',
      reason: s.reason,
    }));
  if (filesEndScreenshot(item)) {
    shots.push({
      id: 'end',
      atMs: atMs(end),
      file: `capture-${captureIndex}.png`,
      sha256: item.screenshot.sha256,
      contentType: 'image/png',
      reason: 'end',
    });
  }

  // Draft steps: user actions + spoken voice segments + page loads
  interface DraftStep {
    at: number;
    acts: boolean;
    value: Record<string, unknown>;
  }
  const drafts: DraftStep[] = [];
  for (const a of evidence.actions) {
    if (a.kind === 'scroll') continue;
    const step: Record<string, unknown> = { kind: a.kind };
    if (a.kind === 'navigate' && a.url) step.url = a.url;
    if (a.target) step.target = a.target;
    if (a.masked) step.masked = true;
    else if (a.value !== null && a.value !== undefined) step.value = a.value;
    drafts.push({ at: a.timestamp, acts: true, value: step });
  }
  for (const note of review.voice) {
    for (const seg of note.segments) {
      const t = note.startedAt + seg.startMs;
      const mid = note.startedAt + Math.floor((seg.startMs + seg.endMs) / 2);
      if (t < start - 60_000 || t > end + 5_000) continue;
      if (item.kept.length > 0 && !item.kept.some((r) => mid >= r.from && mid <= r.to)) continue;
      const step: Record<string, unknown> = { kind: 'say', value: seg.text.trim() };
      if (seg.corrected) step.corrected = true;
      drafts.push({ at: t, acts: false, value: step });
    }
  }
  drafts.sort((a, b) => a.at - b.at);

  const reqIdMap = new Map<string, string>();
  const linkedReqs = new Set<string>();
  const steps: Array<Record<string, unknown>> = drafts.map((draft, i) => {
    const seq = i + 1;
    const step: Record<string, unknown> = { seq, atMs: atMs(draft.at), ...draft.value };
    if (draft.acts) {
      const until = Math.min(drafts[i + 1]?.at ?? Number.MAX_SAFE_INTEGER, draft.at + STEP_WINDOW_MS);
      const inWin = (t: number) => t >= draft.at && t < until;
      let reqCounter = 0;
      const stepReqs: string[] = [];
      for (const e of filteredNet) {
        if (inWin(e.at) && !reqIdMap.has(e.requestId)) {
          reqCounter += 1;
          const sid = `s${seq}r${reqCounter}`;
          reqIdMap.set(e.requestId, sid);
          linkedReqs.add(e.requestId);
          stepReqs.push(sid);
        }
      }
      if (stepReqs.length) step.requests = stepReqs;

      const stepLogs: number[] = [];
      consoleAt.forEach((t, idx) => {
        if (inWin(t)) stepLogs.push(idx);
      });
      if (stepLogs.length) step.console = stepLogs;

      const caused = ['click', 'press', 'select', 'check', 'uncheck'].includes(String(step.kind));
      const screenNote = item.screen.find((s) => s.afterClick && caused && inWin(s.at));
      if (screenNote) {
        step.screen = { appeared: screenNote.appeared, gone: screenNote.gone };
      }

      const shot = shots.find((s) => {
        const shotAbs = s.atMs + start;
        return s.reason === 'step' && shotAbs > draft.at && shotAbs - draft.at <= SHOT_WINDOW_MS;
      });
      if (shot) step.shot = shot.id;
    }
    return step;
  });

  let beforeCounter = 0;
  interface NetRow {
    id: string;
    atMs: number;
    method: string;
    url: string;
    status: number | null;
    durationMs: number | null;
    failure?: string;
    requestBody?: string;
    responseBody?: string;
  }
  const network: NetRow[] = filteredNet.map((e) => {
    const id = reqIdMap.get(e.requestId) ?? `s0r${++beforeCounter}`;
    const keepBody = isFailedNet(e) || linkedReqs.has(e.requestId);
    const jsonLike = (b?: string) => Boolean(b && b.length <= MAX_BODY_KEEP && /^[\s]*[{\[]/.test(b));
    return {
      id,
      atMs: atMs(e.at),
      method: e.method,
      url: e.url,
      status: e.status,
      durationMs: e.ended !== null ? Math.max(0, e.ended - e.at) : null,
      ...(e.failure ? { failure: e.failure } : {}),
      ...(keepBody && jsonLike(e.requestBody) ? { requestBody: e.requestBody } : {}),
      ...(keepBody && jsonLike(e.responseBody) ? { responseBody: e.responseBody } : {}),
    };
  });

  // Annotations (matching src/record.rs)
  const annotations = item.annotations.map((a) => {
    const aAtMs = atMs(a.at);
    const isHighlight =
      a.drawing.length === 1 &&
      a.drawing[0]!.length === 5 &&
      a.drawing[0]![0]!.x === a.drawing[0]![4]!.x &&
      a.drawing[0]![0]!.y === a.drawing[0]![4]!.y;
    const kind = a.drawing.length === 0 ? 'note' : isHighlight ? 'highlight' : 'drawing';
    let nearestShot: string | undefined;
    let bestDist = 5001;
    for (const s of shots) {
      const dist = Math.abs(s.atMs - aAtMs);
      if (dist < bestDist) {
        bestDist = dist;
        nearestShot = s.id;
      }
    }
    return {
      id: a.id,
      atMs: aAtMs,
      text: a.text,
      kind,
      elements: a.elements,
      ...(nearestShot ? { shot: nearestShot } : {}),
    };
  });

  // Findings block from review notes (falling back to item.findings)
  const parsedBlock = splitFindingsBlock(review.notes);
  const findingTexts = parsedBlock.findings.length > 0 ? parsedBlock.findings : item.findings;
  const findingItems = findingTexts.map((raw) => {
    if (raw.startsWith('Works well:')) return { text: raw.slice('Works well:'.length).trim(), kind: 'praise', atMs: null };
    if (raw.startsWith('Question:')) return { text: raw.slice('Question:'.length).trim(), kind: 'question', atMs: null };
    return { text: raw, kind: 'defect', atMs: null };
  });

  const viewportObj = pageMeta.viewport && typeof pageMeta.viewport === 'object' ? (pageMeta.viewport as Record<string, unknown>) : null;
  const truncated = { bodies: 0, screenItems: 0, steps: 0, shots: item.shotsDropped };
  const record = {
    version: 1 as const,
    producer: { name: 'sirv-lens', version },
    capture: {
      id: captureUuid,
      kind: item.kind,
      startedAt: new Date(start).toISOString(),
      durationMs: Math.max(0, end - start),
      page: {
        url: item.pageUrl,
        title: item.pageTitle,
        ...(typeof pageMeta.buildId === 'string' ? { buildSha: pageMeta.buildId } : {}),
      },
      viewport: viewportObj
        ? {
            width: viewportObj.width ?? null,
            height: viewportObj.height ?? null,
            devicePixelRatio: viewportObj.devicePixelRatio ?? null,
          }
        : null,
      colorScheme: typeof pageMeta.colorScheme === 'string' ? pageMeta.colorScheme : null,
      locale: typeof pageMeta.language === 'string' ? pageMeta.language : typeof pageMeta.locale === 'string' ? pageMeta.locale : null,
      timeZone: typeof pageMeta.timeZone === 'string' ? pageMeta.timeZone : null,
      userAgent: typeof pageMeta.userAgent === 'string' ? pageMeta.userAgent : null,
      collection: item.mode,
    },
    findings: {
      title: review.title,
      items: findingItems,
      writtenBy: parsedBlock.header ? 'model' : 'person',
      shownToPerson: true,
    },
    notes: parsedBlock.header ? parsedBlock.own : review.notes.trim(),
    steps,
    annotations,
    network,
    console: consoleEntries,
    shots,
    recording: item.recording
      ? {
          file: `capture-${captureIndex}.rrweb.json`,
          sha256: item.recording.sha256,
          size: item.recording.size,
          rrweb: '2.2.2',
          recordCanvas: false,
          maskAllInputs: true,
        }
      : null,
    dropped: {
      requests: droppedRequests,
      consoleRepeats,
      cut: item.cut,
      truncated,
    },
  };

  let serialized = JSON.stringify(record);
  if (serialized.length > TARGET_CAPTURE_SIZE) {
    for (const row of record.network) {
      const failed = Boolean(row.failure) || (row.status !== null && row.status >= 400);
      if (!failed && (row.requestBody || row.responseBody)) {
        delete row.requestBody;
        delete row.responseBody;
        truncated.bodies += 1;
      }
    }
    serialized = JSON.stringify(record);
  }
  while (serialized.length > HARD_CAPTURE_LIMIT && record.steps.length > 5) {
    const drop = Math.max(1, Math.floor(record.steps.length * 0.1));
    record.steps.splice(0, drop);
    truncated.steps += drop;
    serialized = JSON.stringify(record);
  }
  while (serialized.length > HARD_CAPTURE_LIMIT && record.network.length > 5) {
    record.network.splice(0, Math.max(1, Math.floor(record.network.length * 0.2)));
    serialized = JSON.stringify(record);
  }
  return serialized;
}

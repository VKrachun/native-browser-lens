import type { Action } from './protocol/Action';
import type { Locator } from './protocol/Locator';

type EvidenceEvent = { timestamp: number; kind: string; data: Record<string, unknown> };
export type Step = { at: number; text: string; error: boolean };

const LONG = 40;

/** A name short enough to read in a list: a long one (a whole toolbar's text) keeps its start. */
function short(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= LONG) return flat;
  return `${flat.slice(0, LONG).replace(/\s+\S*$/, '')}…`;
}

/** The element as a person names it: its role and name, its text, or its test ID. */
export function describeElement(l: Locator | null): string {
  if (!l) return 'the page';
  if (l.role && l.name) return `${l.role} “${short(l.name)}”`;
  if (l.testId) return `[data-testid=${l.testId}]`;
  if (l.text) return `“${short(l.text)}”`;
  return l.css.split(/\s*>\s*/).at(-1) ?? l.css;
}

/** The path of an address on the recorded site, or the address when it is elsewhere. */
function where(url: string, page: string): string {
  try {
    const target = new URL(url);
    const home = page ? new URL(page) : null;
    const path = `${target.pathname}${target.search}`;
    return short(home && home.origin === target.origin ? path : `${target.host}${path}`);
  } catch {
    return short(url);
  }
}

export function describeAction(a: Action, page: string): string {
  const target = describeElement(a.target);
  switch (a.kind) {
    case 'click':
      return `Click ${target}`;
    case 'fill':
      return a.masked ? `Type a private value into ${target}` : `Type “${short(a.value ?? '')}” into ${target}`;
    case 'press':
      return `Press ${a.value ?? 'a key'}`;
    case 'select':
      return a.masked ? `Choose a private option in ${target}` : `Choose “${short(a.value ?? '')}” in ${target}`;
    case 'check':
      return `Check ${target}`;
    case 'uncheck':
      return `Uncheck ${target}`;
    case 'upload':
      return `Choose files in ${target}`;
    case 'navigate':
      return `Go to ${where(a.url, page)}`;
    default:
      return `${a.kind} ${target}`;
  }
}

/** A request the browser stopped itself (the page moved on): not a defect. */
function cancelled(e: EvidenceEvent): boolean {
  const text = String(e.data.errorText ?? '');
  return e.data.canceled === true || /NS_BINDING_ABORTED|ERR_ABORTED|NS_ERROR_ABORT/.test(text);
}

/**
 * What the person did and what failed, in order, in words: failed requests name their method
 * and path, and requests the browser cancelled itself leave the list.
 */
export function stepsOf(actions: Action[], events: EvidenceEvent[], page: string): Step[] {
  const requests = new Map<string, { url: string; method: string }>();
  for (const e of events) {
    if (e.kind === 'request') requests.set(String(e.data.requestId), { url: String(e.data.url ?? ''), method: String(e.data.method ?? 'GET') });
  }
  const failures: Step[] = [];
  for (const e of events) {
    const request = requests.get(String(e.data.requestId));
    const url = String(e.data.url ?? request?.url ?? '');
    const call = `${request?.method ?? ''} ${where(url, page)}`.trim();
    if (e.kind === 'response' && Number(e.data.status) >= 400) {
      failures.push({ at: e.timestamp, text: `HTTP ${e.data.status} · ${call}`, error: true });
    } else if (e.kind === 'networkFailure' && !cancelled(e)) {
      failures.push({ at: e.timestamp, text: `Request failed · ${call || String(e.data.errorText ?? '')}`, error: true });
    } else if (e.kind === 'exception') {
      failures.push({ at: e.timestamp, text: `Error: ${short(String(e.data.text ?? ''))}`, error: true });
    } else if (e.kind === 'console' && e.data.level === 'error') {
      failures.push({ at: e.timestamp, text: `Console: ${short(String(e.data.text ?? ''))}`, error: true });
    }
  }
  return [
    ...actions.filter((a) => a.kind !== 'scroll').map((a) => ({ at: a.timestamp, text: describeAction(a, page), error: false })),
    ...failures,
  ].sort((a, b) => a.at - b.at);
}

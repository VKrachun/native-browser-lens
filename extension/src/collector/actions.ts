// The person's steps in a collected tab, with locators a test runner can find again. Runs in the
// page's isolated world. Typed values stay on this computer when the field looks private.
import type { Action } from '@/protocol/Action';
import type { ActionKind } from '@/protocol/ActionKind';
import type { Locator } from '@/protocol/Locator';
import type { PageElement } from '@/protocol/PageElement';
import { PRIVATE_WORDS, SENSITIVE, redactContent, sanitizeUrl } from './sanitize';

const TEST_IDS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
const PRIVATE_AUTOCOMPLETE = /^(cc-|one-time-code|current-password|new-password)/;
const MAX_NAME = 80;
/** Most candidates Lens compares to number a locator among equal ones. */
const MAX_CANDIDATES = 400;

/** Elements a person acts on; a click inside one of them is a click on it. */
const INTERACTIVE = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  ...['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio', 'switch', 'treeitem', 'combobox'].map(
    (role) => `[role=${role}]`,
  ),
  ...TEST_IDS.map((a) => `[${a}]`),
].join(',');

/** The implicit ARIA roles Playwright's getByRole knows, for the elements Lens names. */
const IMPLICIT_ROLES: [string, string][] = [
  ['a[href]', 'link'],
  ['button, input[type=button], input[type=submit], input[type=reset], input[type=image]', 'button'],
  ['input[type=checkbox]', 'checkbox'],
  ['input[type=radio]', 'radio'],
  ['input[type=range]', 'slider'],
  ['input[type=number]', 'spinbutton'],
  ['input[type=search]', 'searchbox'],
  ['input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=url], textarea', 'textbox'],
  ['select:not([multiple]):not([size]), select[size="1"]', 'combobox'],
  ['select', 'listbox'],
  ['h1, h2, h3, h4, h5, h6', 'heading'],
  ['img[alt]:not([alt=""])', 'img'],
];
/** Roles whose accessible name comes from their text. */
const NAMED_BY_TEXT = new Set(['button', 'link', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio', 'switch', 'treeitem']);

export interface FieldFacts {
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
}

/** Whether a typed value must stay on this computer. Pure, so it is tested without a page. */
export function privateValue(field: FieldFacts, value: string): boolean {
  if (field.type === 'password' || field.type === 'hidden') return true;
  // Any token counts: "section-pay billing cc-csc" is a card code.
  if (field.autocomplete.toLowerCase().split(/\s+/).some((token) => PRIVATE_AUTOCOMPLETE.test(token))) return true;
  const words = [field.name, field.id, field.label, field.placeholder].join(' ');
  if (SENSITIVE.test(words) || PRIVATE_WORDS.test(words)) return true;
  // Twelve or more digits look like a card or account number, whatever the field is called.
  if (value.replace(/\D/g, '').length >= 12 && /^[\d\s-]+$/.test(value.trim())) return true;
  return redactContent(value) !== value;
}

/** Whitespace collapsed; null when empty, too long to match exactly, or changed by redaction. */
export function cleanName(text: string | null | undefined): string | null {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat || flat.length > MAX_NAME || redactContent(flat) !== flat) return null;
  return flat;
}

function editable(el: Element) {
  return Boolean(el.closest('[contenteditable]:not([contenteditable=false])'));
}

export function roleOf(el: Element): string | null {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  return IMPLICIT_ROLES.find(([selector]) => el.matches(selector))?.[1] ?? null;
}

/** Text of a label without the controls inside it (a select's options, a textarea's text). */
function labelText(label: Element): string {
  let text = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).matches('select, textarea, input, [contenteditable]')) return;
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    node.childNodes.forEach(walk);
  };
  walk(label);
  return text;
}

/** A simplified accessible name: what getByRole's `name` matches for common markup. */
export function nameOf(el: Element, role: string | null): string | null {
  const aria = cleanName(el.getAttribute('aria-label'));
  if (aria) return aria;
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (cleanName(text)) return cleanName(text);
  }
  // Tag names, not instanceof: the review names elements inside a replay, which is another realm.
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const control = el as HTMLInputElement;
    const label = [...(control.labels ?? [])].map(labelText).join(' ');
    if (cleanName(label)) return cleanName(label);
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(control.type)) return cleanName(control.value);
    return cleanName(el.getAttribute('placeholder')) ?? cleanName(el.getAttribute('title'));
  }
  if (tag === 'IMG') return cleanName(el.getAttribute('alt'));
  if (role && NAMED_BY_TEXT.has(role) && !editable(el)) {
    return cleanName((el as HTMLElement).innerText ?? el.textContent) ?? cleanName(el.getAttribute('title'));
  }
  return cleanName(el.getAttribute('title'));
}

function rendered(el: Element) {
  return el.getClientRects().length > 0;
}

function roleSelector(role: string) {
  const implicit = IMPLICIT_ROLES.filter(([, r]) => r === role).map(([s]) => s);
  return [`[role=${CSS.escape(role)}]`, ...implicit].join(',');
}

/** A CSS path that matches only this element: from the nearest stable ID, else from the body. */
export function cssPath(el: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = el; node && node !== el.ownerDocument.documentElement && parts.length < 8; node = node.parentElement) {
    const id = node.id;
    if (id && /^[A-Za-z][\w-]*$/.test(id) && !/\d{3,}/.test(id) && el.ownerDocument.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(id)}`);
      return parts.join(' > ');
    }
    const tag = node.tagName.toLowerCase();
    const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node!.tagName) : [];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
  }
  return parts.join(' > ');
}

let blockSelector = '[data-lens-block]';

/**
 * The person's own selectors join [data-lens-block] for this page. Returns the valid ones: an
 * invalid selector would make every closest() throw.
 */
export function setMaskSelectors(selectors: string[], probe: Pick<ParentNode, 'querySelector'> = document.createDocumentFragment()): string[] {
  const valid = selectors.filter((selector) => {
    try {
      probe.querySelector(selector);
      return true;
    } catch {
      return false;
    }
  });
  blockSelector = ['[data-lens-block]', ...valid].join(', ');
  return valid;
}

/** A part of the page marked private for the recording: its text stays out of steps and marks. */
export const blocked = (el: Pick<Element, 'closest'>) => el.closest(blockSelector) !== null;

export function locatorOf(el: Element): Locator {
  const testIdAttribute = TEST_IDS.find((a) => el.hasAttribute(a));
  const testId = testIdAttribute ? cleanName(el.getAttribute(testIdAttribute)) : null;
  const role = roleOf(el);
  const name = role && !blocked(el) ? nameOf(el, role) : null;
  let nth: number | null = null;
  if (role && name && !testId) {
    const equal = [...el.ownerDocument.querySelectorAll(roleSelector(role))]
      .slice(0, MAX_CANDIDATES)
      .filter((c) => rendered(c) && roleOf(c) === role && nameOf(c, role) === name);
    if (equal.length > 1 && equal.includes(el)) nth = equal.indexOf(el);
  }
  const text = !role && !editable(el) && !blocked(el) ? cleanName((el as HTMLElement).innerText) : null;
  return {
    testId: testIdAttribute === 'data-testid' ? testId : null,
    role: name ? role : null,
    name,
    nth,
    text: text && text.length <= 60 ? text : null,
    // Playwright's getByTestId reads data-testid only; other test attributes go through CSS.
    css: testId && testIdAttribute !== 'data-testid' ? `[${testIdAttribute}=${JSON.stringify(testId)}]` : cssPath(el),
  };
}

/** The visible elements worth naming, for marks drawn later on the screenshot. */
export function elementMap(doc: Document, limit: number): PageElement[] {
  const selector = `${INTERACTIVE},h1,h2,h3,h4,h5,h6,img,[role],p,li,td,th,dt,dd,figcaption,legend,caption`;
  const found: PageElement[] = [];
  for (const el of doc.querySelectorAll(selector)) {
    if (found.length >= limit) break;
    if (editable(el) || blocked(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const locator = locatorOf(el);
    if (!locator.testId && !locator.name && !locator.text) continue;
    found.push({ locator, x: r.x, y: r.y, width: r.width, height: r.height });
  }
  return found;
}

type Emit = (action: Action) => void;

/** Listens to the person's input in a page and reports each step once it is complete. */
export class ActionRecorder {
  private readonly pending = new Set<HTMLInputElement | HTMLTextAreaElement | HTMLElement>();
  private lastScroll = 0;
  private scrollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listening = new AbortController();

  constructor(
    private readonly doc: Document,
    private readonly emit: Emit,
  ) {}

  start() {
    const on = <K extends keyof DocumentEventMap>(type: K, handler: (event: DocumentEventMap[K]) => void) =>
      this.doc.addEventListener(type, (event) => event.isTrusted && handler(event), {
        capture: true,
        passive: true,
        signal: this.listening.signal,
      });
    on('click', (e) => this.click(e));
    on('input', (e) => this.typed(e));
    on('change', (e) => this.changed(e));
    on('keydown', (e) => this.key(e));
    on('focusout', (e) => this.flush(e.target));
    this.lastScroll = scrollY;
    addEventListener('scroll', () => this.scrolled(), { passive: true, signal: this.listening.signal });
  }

  /** Stops listening for good. */
  stop() {
    this.listening.abort();
    clearTimeout(this.scrollTimer);
    this.pending.clear();
  }

  /** Reports typing that has not ended yet; Lens calls this before a capture. */
  flushAll() {
    for (const el of [...this.pending]) this.flush(el);
  }

  private record(kind: ActionKind, el: Element | null, value: string | null = null, masked = false) {
    this.emit({
      timestamp: Date.now(),
      kind,
      url: sanitizeUrl(location.href),
      target: el ? locatorOf(el) : null,
      value,
      masked,
    });
  }

  private click(event: MouseEvent) {
    const start = event.composedPath()[0];
    if (!(start instanceof Element)) return;
    const el = start.closest(INTERACTIVE) ?? start;
    this.flushAll();
    // Focus clicks on text fields become the typing; checkboxes and radios report their change.
    if (editable(el) || el.matches('textarea, select, input:not([type=button],[type=submit],[type=reset],[type=image])')) return;
    if (el instanceof HTMLLabelElement && el.control) return;
    this.record('click', el);
  }

  private typed(event: Event) {
    const el = event.target;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (!['checkbox', 'radio', 'file', 'range', 'color'].includes((el as HTMLInputElement).type)) this.pending.add(el);
    } else if (el instanceof HTMLElement && editable(el)) {
      this.pending.add(el.closest<HTMLElement>('[contenteditable]') ?? el);
    }
  }

  private flush(target: EventTarget | null) {
    if (!(target instanceof HTMLElement) || !this.pending.delete(target)) return;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const value = target.value;
      // A part of the page marked private for the recording keeps its typed values out too.
      const masked = blocked(target) || privateValue(facts(target), value);
      this.record('fill', target, masked ? null : value, masked);
    } else {
      // Editable text is never recorded, as in the DOM recording.
      this.record('fill', target, null, true);
    }
  }

  private changed(event: Event) {
    const el = event.target;
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      this.flushAll();
      this.record(el.checked ? 'check' : 'uncheck', el);
    } else if (el instanceof HTMLInputElement && el.type === 'file') {
      const kinds = [...new Set([...(el.files ?? [])].map((f) => fileType(f.name)))];
      this.record('upload', el, `${el.files?.length ?? 0} file(s): .${kinds.join(', .')}`);
    } else if (el instanceof HTMLSelectElement) {
      this.flushAll();
      const label = [...el.selectedOptions].map((o) => o.label).join(', ');
      const masked = blocked(el) || privateValue(facts(el), label);
      this.record('select', el, masked ? null : label, masked);
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      this.flush(el);
    }
  }

  private key(event: KeyboardEvent) {
    const modifier = event.ctrlKey || event.metaKey || event.altKey;
    const bare = ['Enter', 'Escape'].includes(event.key);
    if (!bare && !(modifier && !['Control', 'Meta', 'Alt', 'Shift'].includes(event.key))) return;
    const el = event.target instanceof Element ? event.target : null;
    if (event.key === 'Enter' && !modifier && el?.matches('textarea, [contenteditable], [contenteditable] *')) return;
    this.flushAll();
    const combo = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && modifier && 'Shift', event.metaKey && 'Meta', event.key.length === 1 ? event.key.toLowerCase() : event.key]
      .filter(Boolean)
      .join('+');
    const focused = el && el !== this.doc.body && el !== this.doc.documentElement ? el : null;
    this.record('press', focused, combo);
  }

  private scrolled() {
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      if (Math.abs(scrollY - this.lastScroll) < 200) return;
      this.lastScroll = scrollY;
      this.record('scroll', null, String(Math.round(scrollY)));
    }, 600);
  }
}

/** A file's extension, lower case; '?' for a name without one (id_rsa, .bashrc), which is no type. */
export function fileType(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '?';
}

/** The text of the elements aria-labelledby names, as a screen reader hears the field. */
function ariaLabelledBy(el: Element): string {
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  return ids.map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ');
}

function facts(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): FieldFacts {
  return {
    type: el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase(),
    autocomplete: el.getAttribute('autocomplete') ?? '',
    name: el.getAttribute('name') ?? '',
    id: el.id,
    label: [...[...(el.labels ?? [])].map(labelText), el.getAttribute('aria-label') ?? '', ariaLabelledBy(el)].join(' '),
    placeholder: el.getAttribute('placeholder') ?? '',
  };
}

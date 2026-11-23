// Step shots are pixels of the page: a typed card number or password shows in them even when the
// steps mask it. Before each shot, Lens finds the private fields on the page and blacks them out.

import { redactContent } from './sanitize';

type Rect = [number, number, number, number];
/** `values`: the other filled fields; the redaction rules, which cannot run in the page, check them. */
export type PrivateRects = { rects: Rect[]; width: number; values?: [Rect, string][] };

/**
 * The private fields in view, in CSS pixels of the viewport. Runs in the page through
 * scripting.executeScript, so it must not use anything from outside its own body. `masked`: the
 * person's own selectors (Settings), blacked out like [data-lens-block].
 */
export function privateRects(masked: string[] = []): PrivateRects {
  const words =
    /password|passwd|secret|token|card|cc-?num|cvv|cvc|csc|iban|ssn|social.?security|passport|\bpin\b|account.?num|routing|one.?time|otp|2fa|mfa/i;
  const rects: [number, number, number, number][] = [];
  const values: [[number, number, number, number], string][] = [];
  const add = (el: Element, value?: string) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) {
      if (value === undefined) rects.push([r.left, r.top, r.width, r.height]);
      else values.push([[r.left, r.top, r.width, r.height], value]);
    }
  };
  // Open shadow roots too: design systems put their inputs there.
  const all = (selector: string, root: Document | ShadowRoot = document): Element[] => {
    const found = [...root.querySelectorAll(selector)];
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) found.push(...all(selector, host.shadowRoot));
    return found;
  };
  for (const el of all('[data-lens-block]')) add(el);
  for (const selector of masked) {
    try {
      for (const el of all(selector)) add(el);
    } catch {
      // Not a valid selector: the others still apply.
    }
  }
  // A frame's fields cannot be read from here (a hosted card form is on another site): it goes black.
  for (const el of all('iframe, frame, embed, object')) add(el);
  // Editable text is never recorded, in the steps or the DOM recording: nor in the shots.
  for (const el of all('[contenteditable]:not([contenteditable=false])')) add(el);
  for (const el of all('input, textarea, select') as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[]) {
    if (el.type === 'hidden' || !el.value) continue;
    const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
    const labels = [...(el.labels ?? [])].map((label) => label.textContent ?? '');
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => (id && el.ownerDocument.getElementById(id)?.textContent) || '');
    const named = [el.name, el.id, el.getAttribute('aria-label') ?? '', el.getAttribute('placeholder') ?? '', ...labels, ...labelledBy].join(' ');
    const digits = el.value.replace(/\D/g, '').length >= 12 && /^[\d\s-]+$/.test(el.value.trim());
    if (
      el.type === 'password' ||
      autocomplete.some((token) => /^(cc-|one-time-code|current-password|new-password)/.test(token)) ||
      words.test(named) ||
      digits
    ) {
      add(el);
    } else {
      add(el, el instanceof HTMLSelectElement ? [...el.selectedOptions].map((o) => o.label).join(', ') : el.value);
    }
  }
  return { rects, width: innerWidth, values };
}

/** The shot (base64, WebP or PNG as `type` says) with the rectangles filled black; null when that fails. */
export async function maskShot(data: string, found: PrivateRects, type: 'image/webp' | 'image/png' = 'image/webp'): Promise<string | null> {
  const rects = [...found.rects, ...(found.values ?? []).filter(([, value]) => redactContent(value) !== value).map(([rect]) => rect)];
  if (rects.length === 0) return data;
  try {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const scale = canvas.width / Math.max(1, found.width);
    context.fillStyle = '#000';
    // A few pixels more on each side: the field's border and focus ring can show the value's edge.
    for (const [x, y, w, h] of rects) context.fillRect(x * scale - 2, y * scale - 2, w * scale + 4, h * scale + 4);
    const webp = await canvas.convertToBlob({ type, quality: 0.7 });
    if (webp.type !== type) return null;
    const bytes = new Uint8Array(await webp.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  } catch {
    return null;
  }
}

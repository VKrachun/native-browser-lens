import { PRIVATE_WORDS, REDACTED, SENSITIVE, redactContent, sanitizeUrl } from './sanitize';

const META_TERMS = ['csrf', 'xsrf', 'token', 'secret', 'nonce', 'session', 'auth', 'password', 'credential', 'api-key', 'apikey'];
const META_SENSITIVE = new RegExp(`${SENSITIVE.source}|nonce|auth|session`, 'i');

/** Elements the recorder leaves out entirely: marked ones, hidden inputs, credential-like meta tags. */
export const BLOCK_SELECTOR = [
  '[data-lens-block]',
  'input[type=hidden]',
  ...['name', 'property', 'http-equiv'].flatMap((attribute) => META_TERMS.map((term) => `meta[${attribute}*=${term} i]`)),
].join(', ');

/**
 * The evidence's redaction rules over one rrweb event, in place. Strings are not cut, so DOM
 * snapshots stay whole and replayable.
 */
export function scrubRecording(value: unknown): unknown {
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? sanitizeUrl(value) : redactContent(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubRecording(value[i]);
    return value;
  }
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    // A meta element that escaped the block list still loses its content when its name is sensitive.
    const attributes = node.attributes as Record<string, unknown> | undefined;
    if (typeof node.tagName === 'string' && node.tagName.toLowerCase() === 'meta' && attributes) {
      const label = ['name', 'property', 'http-equiv', 'itemprop'].map((k) => String(attributes[k] ?? '')).join(' ');
      if (META_SENSITIVE.test(label) && 'content' in attributes) attributes.content = REDACTED;
    }
    // A password field's value attribute (its HTML default) never leaves, empty or not.
    if (typeof node.tagName === 'string' && node.tagName.toLowerCase() === 'input' && attributes &&
        String(attributes.type ?? '').toLowerCase() === 'password' && 'value' in attributes) {
      attributes.value = REDACTED;
    }
    // Attribute names count as field names: data-cvv, data-card-number.
    for (const key of Object.keys(node)) node[key] = SENSITIVE.test(key) || PRIVATE_WORDS.test(key) ? REDACTED : scrubRecording(node[key]);
  }
  return value;
}

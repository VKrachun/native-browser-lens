// Evidence leaves the page only after this pass. Credentials in URLs, headers, bodies, storage and
// console text are replaced; nothing is uploaded until a person reviews it, but the local notebook
// should not hold secrets either.
export const SENSITIVE = /authorization|cookie|password|passwd|secret|token|api.?key|session.?id|credential|csrf|xsrf/i;
/** Names of fields that hold payment, identity or one-time codes. Their values never leave. */
export const PRIVATE_WORDS =
  /card|cc-?num|cvv|cvc|csc|iban|ssn|social.?security|passport|\bpin\b|account.?num|routing|one.?time|otp|2fa|mfa/i;
const privateKey = (key: string) => SENSITIVE.test(key) || PRIVATE_WORDS.test(key) || custom.names.has(key.toLowerCase());

/** The person's own rules, on top of the built-in ones (Settings, `PrivacySettings`). */
export interface PrivacySettings {
  maskSelectors: string[];
  sensitiveHeaders: string[];
  sensitivePatterns: string[];
}
/** Where the background keeps the rules (from the app) for the recorder in each page. */
export const PRIVACY_KEY = 'lens_privacy_settings';
const MAX_RULES = 50;
const MAX_PATTERN = 200;
let custom = { names: new Set<string>(), patterns: [] as RegExp[] };

/** Strings only, trimmed, without empties, at most MAX_RULES. Anything else reads as no rules. */
export function privacySettings(raw: unknown): PrivacySettings {
  const list = (value: unknown) =>
    (Array.isArray(value) ? value : [])
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, MAX_RULES);
  const found = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { maskSelectors: list(found.maskSelectors), sensitiveHeaders: list(found.sensitiveHeaders), sensitivePatterns: list(found.sensitivePatterns) };
}

/**
 * Sets the person's rules for this page or worker: header (and field) names whose values go, and
 * patterns whose matches go. Returns the patterns that did not compile or were too long.
 */
export function setCustomRedaction(settings: Partial<Pick<PrivacySettings, 'sensitiveHeaders' | 'sensitivePatterns'>>): string[] {
  const { sensitiveHeaders, sensitivePatterns } = privacySettings(settings);
  const rejected: string[] = [];
  const patterns: RegExp[] = [];
  for (const source of sensitivePatterns) {
    try {
      // ponytail: the length cap limits but cannot rule out a backtracking pattern; a worker with a timeout would.
      if (source.length > MAX_PATTERN) throw new Error('too long');
      const pattern = new RegExp(source, 'gi');
      // A pattern that matches the empty string would put the marker between every character.
      if (pattern.test('')) throw new Error('matches nothing');
      patterns.push(pattern);
    } catch {
      rejected.push(source);
    }
  }
  custom = { names: new Set(sensitiveHeaders.map((name) => name.toLowerCase())), patterns };
  return rejected;
}

/** How many values a pass replaced in this evidence: for a summary of what was left out. */
export function countRedactions(value: unknown): number {
  return (typeof value === 'string' ? value : JSON.stringify(value) ?? '').split(REDACTED).length - 1;
}
/** Query keys that carry credentials in signed or OAuth URLs, beyond the general list. */
const SENSITIVE_QUERY = /^(code|code_verifier|state|sig|signature|key|auth|jwt|otp|refresh_token|client_secret)$|^x-(amz|goog)-/i;
export const REDACTED = '[REDACTED]';
const MAX_TEXT = 16 * 1024;

export function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const [key, value] of [...url.searchParams.entries()]) {
      const clean = privateKey(key) || SENSITIVE_QUERY.test(key) ? REDACTED : sanitizeText(value);
      if (clean !== value) url.searchParams.set(key, clean);
    }
    // Content rules over the whole URL too: tokens also travel in paths.
    return sanitizeText(url.toString());
  } catch {
    return sanitizeText(input);
  }
}

export function sanitizeText(text: string): string {
  return redactContent(text.slice(0, MAX_TEXT));
}

/**
 * The content rules without the length cap, for text that must stay whole (DOM recordings). Every
 * pattern is linear: the one open-ended prefix starts at a word boundary and is bounded, so a long
 * run of word characters cannot make it backtrack quadratically.
 */
export function redactContent(text: string): string {
  return custom.patterns.reduce((out, pattern) => out.replace(pattern, REDACTED), builtIn(text));
}

function builtIn(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`)
    // A cookie header holds every cookie to the end of its line, not only the first pair.
    .replace(/\b((?:set-)?cookie\s{0,8}:\s{0,8})[^\r\n]+/gi, `$1${REDACTED}`)
    // A quoted secret may hold spaces: the whole quoted value goes.
    .replace(/((?:password|passwd|secret|token|api[_-]?key)["']?\s{0,8}[:=]\s{0,8})"[^"\r\n]{0,512}"/gi, `$1"${REDACTED}"`)
    .replace(/((?:password|passwd|secret|token|api[_-]?key)["']?\s{0,8}[:=]\s{0,8})'[^'\r\n]{0,512}'/gi, `$1'${REDACTED}'`)
    .replace(
      /((?:authorization|cookie|password|passwd|secret|\b[\w-]{0,64}?token|api[_-]?key|session[_-]?id|csrf|xsrf)\s{0,8}["']?\s{0,8}[:=]\s{0,8}["']?)[^\s"'&,;}]+/gi,
      `$1${REDACTED}`,
    )
    // Signed-URL and OAuth query keys wherever a URL sits inside text: CSS url(), srcset, scripts.
    .replace(/([?&;](?:code|state|sig|signature|key|auth|jwt|otp|x-(?:amz|goog)-[\w-]{1,40})=)[^&\s"'#)]+/gi, `$1${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    // Card numbers: 13 to 19 digits, spaces or dashes allowed, that pass the Luhn check.
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (digits) => (luhn(digits.replace(/\D/g, '')) ? REDACTED : digits));
}

export function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 7) return '[OMITTED: depth limit]';
  if (typeof value === 'string') return /^https?:\/\//.test(value) ? sanitizeUrl(value) : sanitizeText(value);
  if (typeof value === 'number' && Number.isInteger(value) && luhn(String(Math.abs(value)))) return REDACTED;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Header and cookie lists: { name, value } pairs whose name is sensitive.
    if (typeof record.name === 'string' && privateKey(record.name) && 'value' in record) {
      return { name: sanitizeText(record.name), value: REDACTED };
    }
    return Object.fromEntries(
      Object.entries(record)
        .slice(0, 80)
        .map(([key, v]) => [key, privateKey(key) ? REDACTED : sanitize(v, depth + 1)]),
    );
  }
  return value;
}

/**
 * What a page sent in a request body: same origin only, at most 16 KiB, with JSON and form fields
 * redacted by name and by content. Undefined when it is left out.
 */
export function requestBody(body: unknown, contentType: string, url: string, pageUrl: string): string | undefined {
  if (typeof body !== 'string' || !body || body.length > MAX_TEXT) return undefined;
  try {
    if (new URL(url).origin !== new URL(pageUrl).origin) return undefined;
  } catch {
    return undefined;
  }
  if (/json/i.test(contentType)) {
    try {
      return JSON.stringify(sanitize(JSON.parse(body)));
    } catch {
      return sanitizeText(body);
    }
  }
  if (/x-www-form-urlencoded/i.test(contentType)) {
    const form = new URLSearchParams(body);
    // OAuth exchanges (code, code_verifier, refresh_token) are form bodies too.
    for (const [key, value] of [...form.entries()]) form.set(key, privateKey(key) || SENSITIVE_QUERY.test(key) ? REDACTED : sanitizeText(value));
    return form.toString();
  }
  return /^text\//i.test(contentType) ? sanitizeText(body) : undefined;
}

/** A response body, or the reason it was left out. */
export function bodyEvidence(body: string, mimeType: string, url: string, pageUrl: string): Record<string, unknown> {
  try {
    if (new URL(url).origin !== new URL(pageUrl).origin) return { omission: 'Response body outside the page origin' };
  } catch {
    return { omission: 'Response URL unavailable' };
  }
  if (new TextEncoder().encode(body).length > MAX_TEXT) return { omission: 'Response body exceeds 16 KiB' };
  if (!/json|text\/plain|javascript|text\/css/.test(mimeType)) return { omission: 'Binary or document body left out' };
  try {
    return { format: 'json', body: sanitize(JSON.parse(body)) };
  } catch {
    return { format: 'text', body: sanitizeText(body) };
  }
}

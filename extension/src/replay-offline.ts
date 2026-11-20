// A replay rebuilds the recorded page inside a Lens page, and a rebuilt <img>, stylesheet, font or
// frame loads from the recorded site again. That tells the site that someone opens the replay, and
// what it serves then (not what the person saw) is what the reviewer sees. So, unless the person
// asks for the site's images, every address the replay would fetch is taken out of the events.

/**
 * Whether an address fetches nothing: data:, blob:, about: or a fragment. The URL parser drops
 * tabs and line breaks and reads a backslash as a slash, so the test does too; anything else, a
 * relative path included, counts as remote. A content security policy backs this up (below).
 */
function harmless(value: string): boolean {
  const url = value.replace(/[\t\n\r]/g, '').replace(/\\/g, '/').trim();
  return url === '' || url.startsWith('#') || /^(?:data|blob|about):/i.test(url);
}
const REMOTE = { test: (value: string) => !harmless(value) };
/** A transparent pixel: an image keeps its box, so the layout does not move. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
/** Elements whose src or href only shows a picture: they get the blank one. */
const PICTURES = new Set(['img', 'input', 'image']);
/** Links are not fetched (and the replay takes no clicks); everything else with an href is. */
const LINKS = new Set(['a', 'area']);
const FETCHED = new Set(['src', 'href', 'xlink:href', 'poster', 'data', 'background', 'rr_src']);

/**
 * CSS without the addresses it would fetch: url(...) becomes none, every @import goes, and a quoted
 * address (image-set() takes plain strings) becomes empty. A regular expression cannot read every
 * CSS escape: the policy the replay's page gets (offlineEvents) is what makes this safe.
 */
export function offlineCss(text: string): string {
  if (!/url\(|@import|image-set/i.test(text)) return text;
  // Each pattern has one way to match (a backslash is only ever an escape), so page text cannot
  // make it run for long.
  return text
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)((?:\\[\s\S]|(?!\1\s*\))[^\\])*?)\1\s*\)/gi, (whole, _q, inner: string) => (harmless(inner) ? whole : 'none'))
    .replace(/image-set\(([^()]*)\)/gi, (_whole, inside: string) =>
      `image-set(${inside.replace(/(['"])((?:\\[\s\S]|(?!\1)[^\\\n])*)\1/g, (quoted, _q, inner: string) => (harmless(inner) ? quoted : '""'))})`,
    );
}

type Attributes = Record<string, unknown>;

/**
 * One element's attributes; `snapshot` is true for a node of a snapshot (an attribute is left
 * out), false for an attribute change (it is removed with null, as rrweb does).
 */
function offlineAttributes(tag: string | undefined, attributes: Attributes, snapshot: boolean): Attributes {
  const out: Attributes = {};
  const drop = (name: string) => {
    if (!snapshot) out[name] = null;
  };
  for (const [key, value] of Object.entries(attributes)) {
    const name = key.toLowerCase();
    if (typeof value !== 'string') {
      // A style change can be a map of properties: its values are CSS.
      out[key] = value && typeof value === 'object' ? walkStrings(value, offlineCss) : value;
    } else if (name === 'style' || name === '_csstext') {
      out[key] = offlineCss(value);
    } else if (name === 'srcset' || name === 'imagesrcset') {
      if (/(?:^|,)\s*(?:https?:)?\/\//i.test(value)) drop(key);
      else out[key] = value;
    } else if (FETCHED.has(name) && REMOTE.test(value) && !(name === 'href' && tag && LINKS.has(tag))) {
      if (tag && PICTURES.has(tag)) out[key] = BLANK;
      else if (tag === 'iframe' || tag === 'frame') out[key] = 'about:blank';
      else drop(key);
    } else if (name === 'srcdoc') {
      // A frame's own page as text: whatever it holds would load unchecked.
      drop(key);
    } else if (tag === 'meta' && name === 'content' && /url\s*=/i.test(value)) {
      // <meta http-equiv=refresh content="0;url=...">: the replay frame would go to the site.
      drop(key);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function walkStrings(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === 'string') return change(value);
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, change));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walkStrings(v, change)]));
}

/**
 * The events with nothing left to fetch from the web: snapshot nodes, added nodes, attribute
 * changes, style text, style rules and declarations, adopted style sheets and fonts.
 */
export function offlineEvents<T>(events: T[]): T[] {
  // Attribute changes name their element by id only: the tag comes from where it was added.
  const tags = new Map<number, string>();
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return offlineCss(value);
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    const snapshot = typeof node.tagName === 'string';
    if (snapshot && typeof node.id === 'number') tags.set(node.id, (node.tagName as string).toLowerCase());
    const tag = snapshot ? (node.tagName as string).toLowerCase() : typeof node.id === 'number' ? tags.get(node.id) : undefined;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(node)) {
      if (key === 'attributes' && inner && typeof inner === 'object' && !Array.isArray(inner)) {
        out[key] = offlineAttributes(tag, inner as Attributes, snapshot);
      } else if (key === 'fontSource' && typeof inner === 'string' && REMOTE.test(inner)) {
        out[key] = 'local("none")';
      } else {
        out[key] = walk(inner);
      }
    }
    return out;
  };
  return events.map((event) => withPolicy(walk(event)) as T);
}

/**
 * What the replayed page may load: nothing from the web. A policy in its head holds for whatever
 * the rewrite above misses, as the page's own policy would. Pictures and fonts in data: and blob:
 * addresses stay; style attributes and style elements work (the replay frame runs no scripts).
 */
export const OFFLINE_POLICY =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline' data: blob:; frame-src about: data:";
let policyId = 2 ** 30;

/**
 * A full snapshot (rrweb type 2) with the policy as the first element of the head of its root
 * <html>; a head is made when there is none. A snapshot without a root <html> is not replayed:
 * the policy would have no place, and its page would load freely.
 */
function withPolicy(event: unknown): unknown {
  const record = event as { type?: number; data?: { node?: unknown } };
  if (record?.type !== 2 || !record.data?.node) return event;
  type Node = { type?: number; tagName?: string; childNodes?: Node[]; attributes?: Record<string, unknown>; id?: number };
  const root = record.data.node as Node;
  const html = (root.childNodes ?? []).find((n) => n.tagName?.toLowerCase() === 'html');
  const meta: Node = { type: 2, tagName: 'meta', attributes: { 'http-equiv': 'Content-Security-Policy', content: OFFLINE_POLICY }, childNodes: [], id: policyId++ };
  if (!html) {
    root.childNodes = [{ type: 2, tagName: 'html', attributes: {}, id: policyId++, childNodes: [{ type: 2, tagName: 'head', attributes: {}, id: policyId++, childNodes: [meta] }] }];
    return event;
  }
  let head = (html.childNodes ?? []).find((n) => n.tagName?.toLowerCase() === 'head');
  if (!head) {
    head = { type: 2, tagName: 'head', attributes: {}, childNodes: [], id: policyId++ };
    html.childNodes = [head, ...(html.childNodes ?? [])];
  }
  head.childNodes = [meta, ...(head.childNodes ?? [])];
  return event;
}

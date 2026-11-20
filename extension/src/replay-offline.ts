// A replay rebuilds the recorded page inside a Lens page, and a rebuilt <img>, stylesheet, font or
// frame loads from the recorded site again. That tells the site that someone opens the replay, and
// what it serves then (not what the person saw) is what the reviewer sees. So, unless the person
// asks for the site's images, every address the replay would fetch is taken out of the events.

/** Absolute and protocol-relative web addresses; data: and blob: stay, they fetch nothing. */
const REMOTE = /^\s*(?:https?:)?\/\//i;
/** A transparent pixel: an image keeps its box, so the layout does not move. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
/** Elements whose src or href only shows a picture: they get the blank one. */
const PICTURES = new Set(['img', 'input', 'image']);
/** Links are not fetched (and the replay takes no clicks); everything else with an href is. */
const LINKS = new Set(['a', 'area']);
const FETCHED = new Set(['src', 'href', 'xlink:href', 'poster', 'data', 'background', 'rr_src']);

/** CSS without the remote addresses it would fetch: url(...) becomes none, @import goes. */
export function offlineCss(text: string): string {
  if (!/url\(|@import/i.test(text)) return text;
  return text
    .replace(/url\(\s*(['"]?)\s*(?:https?:)?\/\/(?:\\.|(?!\1\s*\)).)*?\1\s*\)/gi, 'none')
    .replace(/@import\s+(['"])\s*(?:https?:)?\/\/[^'"]*\1[^;]*;?/gi, '');
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
  return events.map((event) => walk(event) as T);
}

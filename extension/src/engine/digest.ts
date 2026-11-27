import type { Pointing } from '@/protocol/Pointing';
import type { ScreenNote } from '@/protocol/ScreenNote';
import type { TimeRange } from '@/protocol/TimeRange';

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head']);
const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'img', 'h1', 'h2', 'h3', 'h4', 'label', 'li']);
const MAX_DEPTH = 400;
const MAX_NOTES = 300;
const MAX_ITEMS = 25;
const MAX_ITEM_CHARS = 120;
const SETTLE_MS = 1500;
const MAX_POINTING = 3000;
const MAX_POINTING_WORK = 200_000;

interface RrNode {
  id: number;
  type: number; // 0=Document, 1=DocumentType, 2=Element, 3=Text, 4=CDATA, 5=Comment
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
  childNodes?: RrNode[];
  [key: string]: unknown;
}

export interface RrEvent {
  type: number;
  timestamp: number;
  data?: Record<string, unknown>;
}

interface StoredNode {
  raw: RrNode;
  parent: number | null;
  children: number[];
}

class VirtualDom {
  nodes = new Map<number, StoredNode>();
  rootId: number | null = null;
  href = '';
  width = 1280;
  height = 800;

  loadSnapshot(node: RrNode): void {
    this.nodes.clear();
    this.rootId = node.id;
    const visit = (n: RrNode, parent: number | null, depth: number) => {
      if (depth > MAX_DEPTH || typeof n.id !== 'number') return;
      const children: number[] = [];
      const copy: RrNode = { ...n, attributes: n.attributes ? { ...n.attributes } : undefined };
      delete copy.childNodes;
      this.nodes.set(n.id, { raw: copy, parent, children });
      for (const child of n.childNodes ?? []) {
        if (typeof child?.id === 'number') {
          children.push(child.id);
          visit(child, n.id, depth + 1);
        }
      }
    };
    visit(node, null, 0);
  }

  applyMutation(data: Record<string, unknown>): void {
    const removes = Array.isArray(data.removes) ? (data.removes as Array<{ parentId?: number; id?: number }>) : [];
    for (const r of removes) {
      if (typeof r.parentId === 'number' && typeof r.id === 'number') {
        const parent = this.nodes.get(r.parentId);
        if (parent) parent.children = parent.children.filter((c) => c !== r.id);
      }
      if (typeof r.id === 'number') this.removeSubtree(r.id, 0);
    }

    const adds = Array.isArray(data.adds)
      ? (data.adds as Array<{ parentId?: number; nextId?: number | null; node?: RrNode }>)
      : [];
    for (const a of adds) {
      if (typeof a.parentId !== 'number' || !a.node || typeof a.node.id !== 'number') continue;
      const parent = this.nodes.get(a.parentId);
      if (!parent) continue;
      const copy: RrNode = {
        ...a.node,
        attributes: a.node.attributes ? { ...a.node.attributes } : undefined,
      };
      delete copy.childNodes;
      const existing = this.nodes.get(a.node.id);
      if (existing) {
        existing.raw = copy;
        existing.parent = a.parentId;
      } else {
        this.nodes.set(a.node.id, { raw: copy, parent: a.parentId, children: [] });
      }
      parent.children = parent.children.filter((c) => c !== a.node!.id);
      if (typeof a.nextId === 'number') {
        const idx = parent.children.indexOf(a.nextId);
        if (idx >= 0) parent.children.splice(idx, 0, a.node.id);
        else parent.children.push(a.node.id);
      } else {
        parent.children.push(a.node.id);
      }
    }

    const texts = Array.isArray(data.texts) ? (data.texts as Array<{ id?: number; value?: string }>) : [];
    for (const t of texts) {
      if (typeof t.id !== 'number') continue;
      const node = this.nodes.get(t.id);
      if (node) node.raw.textContent = typeof t.value === 'string' ? t.value : '';
    }

    const attributes = Array.isArray(data.attributes)
      ? (data.attributes as Array<{ id?: number; attributes?: Record<string, unknown> }>)
      : [];
    for (const attr of attributes) {
      if (typeof attr.id !== 'number' || !attr.attributes) continue;
      const node = this.nodes.get(attr.id);
      if (!node) continue;
      node.raw.attributes = { ...(node.raw.attributes ?? {}) };
      for (const [k, v] of Object.entries(attr.attributes)) {
        if (v === null) delete node.raw.attributes[k];
        else node.raw.attributes[k] = v;
      }
    }
  }

  private removeSubtree(id: number, depth: number): void {
    if (depth > MAX_DEPTH) return;
    const node = this.nodes.get(id);
    if (!node) return;
    this.nodes.delete(id);
    for (const c of node.children) this.removeSubtree(c, depth + 1);
  }

  toSnapshot(): RrNode | null {
    if (this.rootId === null || !this.nodes.has(this.rootId)) return null;
    const seen = new Set<number>();
    const build = (id: number, depth: number): RrNode | null => {
      if (depth > MAX_DEPTH || seen.has(id)) return null;
      seen.add(id);
      const entry = this.nodes.get(id);
      if (!entry) return null;
      const out: RrNode = {
        ...entry.raw,
        attributes: entry.raw.attributes ? { ...entry.raw.attributes } : undefined,
      };
      if (entry.children.length > 0) {
        out.childNodes = entry.children
          .map((cid) => build(cid, depth + 1))
          .filter((c): c is RrNode => c !== null);
      }
      return out;
    };
    return build(this.rootId, 0);
  }

  private isHidden(entry: StoredNode): boolean {
    const tag = (entry.raw.tagName ?? '').toLowerCase();
    if (SKIP_TAGS.has(tag)) return true;
    const attrs = entry.raw.attributes ?? {};
    if ('hidden' in attrs && attrs.hidden !== false && attrs.hidden !== 'false') return true;
    if (attrs['aria-hidden'] === 'true') return true;
    const style = typeof attrs.style === 'string' ? attrs.style.toLowerCase() : '';
    if (style.includes('display:none') || style.includes('display: none')) return true;
    return false;
  }

  visibleItems(): Set<string> {
    const items = new Set<string>();
    if (this.rootId === null) return items;
    const seen = new Set<number>();
    const walk = (id: number, depth: number) => {
      if (depth > MAX_DEPTH || seen.has(id) || items.size >= MAX_ITEMS * 4) return;
      seen.add(id);
      const entry = this.nodes.get(id);
      if (!entry || this.isHidden(entry)) return;
      const tag = (entry.raw.tagName ?? '').toLowerCase();
      const attrs = entry.raw.attributes ?? {};
      if (entry.raw.type === 3 && typeof entry.raw.textContent === 'string') {
        const text = entry.raw.textContent.replace(/\s+/g, ' ').trim();
        if (text.length >= 2) items.add(text.slice(0, MAX_ITEM_CHARS));
      } else if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const label = String(attrs['aria-label'] ?? attrs.placeholder ?? attrs.name ?? '').trim();
        if (label) {
          const disabled = 'disabled' in attrs ? ' (disabled)' : '';
          items.add(`[field: ${label.slice(0, 80)}${disabled}]`);
        }
      } else if (tag === 'button') {
        const label = String(attrs['aria-label'] ?? '').trim();
        if (label) {
          const disabled = 'disabled' in attrs ? ' (disabled)' : '';
          items.add(`[button: ${label.slice(0, 80)}${disabled}]`);
        }
      } else if (tag === 'img') {
        const alt = String(attrs.alt ?? '').trim();
        if (alt) items.add(`[image: ${alt.slice(0, 80)}]`);
      }
      for (const cid of entry.children) walk(cid, depth + 1);
    };
    walk(this.rootId, 0);
    return items;
  }

  private textOf(id: number, depth = 0): string {
    if (depth > 8) return '';
    const entry = this.nodes.get(id);
    if (!entry || this.isHidden(entry)) return '';
    if (entry.raw.type === 3) return (entry.raw.textContent ?? '').replace(/\s+/g, ' ').trim();
    let out = '';
    for (const cid of entry.children) {
      const part = this.textOf(cid, depth + 1);
      if (part) out = out ? `${out} ${part}` : part;
      if (out.length >= 80) break;
    }
    return out.slice(0, 80).trim();
  }

  labelFor(nodeId: number): string | null {
    let cur: number | null = nodeId;
    for (let steps = 0; steps < 10 && cur !== null; steps += 1) {
      const entry = this.nodes.get(cur);
      if (!entry) break;
      const tag = (entry.raw.tagName ?? '').toLowerCase();
      const attrs = entry.raw.attributes ?? {};
      const role = typeof attrs.role === 'string' ? attrs.role : '';
      if (entry.raw.type === 2 && (INTERACTIVE_TAGS.has(tag) || role)) {
        const aria = String(attrs['aria-label'] ?? attrs.title ?? attrs.placeholder ?? attrs.alt ?? '').trim();
        const text = aria || this.textOf(cur);
        if (text) {
          const kind =
            role ||
            (tag === 'a'
              ? 'link'
              : tag === 'img'
                ? 'image'
                : tag.startsWith('h')
                  ? 'heading'
                  : tag === 'input' || tag === 'textarea' || tag === 'select'
                    ? 'field'
                    : tag);
          return `${kind} "${text.slice(0, 60)}"`;
        }
      }
      cur = entry.parent;
    }
    return null;
  }
}

/** Extracts screen notes (page loads and post-click visible DOM diffs) from rrweb events. */
export function digestRecording(events: RrEvent[], kept: TimeRange[] = []): ScreenNote[] {
  const dom = new VirtualDom();
  const notes: ScreenNote[] = [];
  const inKept = (t: number) => kept.length === 0 || kept.some((r) => t >= r.from && t <= r.to);

  let pendingClick: { at: number; before: Set<string> } | null = null;
  const flushClick = (now: number) => {
    if (!pendingClick) return;
    const after = dom.visibleItems();
    const appeared: string[] = [];
    const gone: string[] = [];
    for (const item of after) {
      if (!pendingClick.before.has(item)) appeared.push(item);
      if (appeared.length >= MAX_ITEMS) break;
    }
    for (const item of pendingClick.before) {
      if (!after.has(item)) gone.push(item);
      if (gone.length >= MAX_ITEMS) break;
    }
    if ((appeared.length > 0 || gone.length > 0) && inKept(pendingClick.at) && notes.length < MAX_NOTES) {
      const parts: string[] = [];
      if (appeared.length) parts.push(`appeared: ${appeared.slice(0, 12).join('; ')}`);
      if (gone.length) parts.push(`gone: ${gone.slice(0, 8).join('; ')}`);
      notes.push({ at: now, text: parts.join(' | '), appeared, gone, afterClick: true });
    }
    pendingClick = null;
  };

  for (const ev of events) {
    if (pendingClick && ev.timestamp - pendingClick.at >= SETTLE_MS) {
      flushClick(ev.timestamp);
    }
    if (ev.type === 4 && ev.data) {
      if (typeof ev.data.href === 'string') dom.href = ev.data.href;
      if (typeof ev.data.width === 'number') dom.width = ev.data.width;
      if (typeof ev.data.height === 'number') dom.height = ev.data.height;
    } else if (ev.type === 2 && ev.data?.node) {
      if (pendingClick) flushClick(ev.timestamp);
      dom.loadSnapshot(ev.data.node as RrNode);
      if (inKept(ev.timestamp) && notes.length < MAX_NOTES) {
        const items = [...dom.visibleItems()].slice(0, MAX_ITEMS);
        if (items.length > 0) {
          notes.push({ at: ev.timestamp, text: `the page showed: ${items.join('; ')}`, appeared: items, gone: [], afterClick: false });
        }
      }
    } else if (ev.type === 3 && ev.data) {
      const source = ev.data.source;
      if (source === 0) {
        dom.applyMutation(ev.data);
      } else if (source === 2 && ev.data.type === 2) {
        if (pendingClick) flushClick(ev.timestamp);
        pendingClick = { at: ev.timestamp, before: dom.visibleItems() };
      }
    }
  }
  if (pendingClick && events.length > 0) {
    flushClick(events[events.length - 1]!.timestamp);
  }
  return notes;
}

/** Extracts pointer resting intervals over labeled DOM elements from rrweb events. */
export function pointingFromRecording(events: RrEvent[], kept: TimeRange[] = []): Pointing[] {
  const dom = new VirtualDom();
  const out: Pointing[] = [];
  const inKept = (t: number) => kept.length === 0 || kept.some((r) => t >= r.from && t <= r.to);
  let work = 0;

  const pushPoint = (at: number, nodeId: number) => {
    if (!inKept(at) || out.length >= MAX_POINTING) return;
    const label = dom.labelFor(nodeId);
    if (!label) return;
    const last = out.at(-1);
    if (last && last.label === label && at - last.to <= 1500) {
      last.to = Math.max(last.to, at);
    } else {
      out.push({ from: at, to: at, label });
    }
  };

  for (const ev of events) {
    if (++work > MAX_POINTING_WORK) break;
    if (ev.type === 2 && ev.data?.node) {
      dom.loadSnapshot(ev.data.node as RrNode);
    } else if (ev.type === 3 && ev.data) {
      const source = ev.data.source;
      if (source === 0) {
        dom.applyMutation(ev.data);
      } else if ((source === 1 || source === 6) && Array.isArray(ev.data.positions)) {
        for (const pos of ev.data.positions as Array<{ id?: number; timeOffset?: number }>) {
          if (++work > MAX_POINTING_WORK) break;
          if (typeof pos.id === 'number') {
            pushPoint(ev.timestamp + (pos.timeOffset ?? 0), pos.id);
          }
        }
      } else if (source === 2 && typeof ev.data.id === 'number') {
        pushPoint(ev.timestamp, ev.data.id);
      }
    }
  }
  return out;
}

/** Trims an rrweb event stream to `kept` intervals, synthesizing Meta + FullSnapshot on entry. */
export function trimRecording(events: RrEvent[], kept: TimeRange[]): RrEvent[] {
  if (kept.length === 0 || events.length === 0) return events;
  const sorted = [...kept].sort((a, b) => a.from - b.from);
  const dom = new VirtualDom();
  const out: RrEvent[] = [];
  let rangeIdx = 0;
  let entered = false;

  for (const ev of events) {
    // Advance past finished ranges
    while (rangeIdx < sorted.length && ev.timestamp > sorted[rangeIdx]!.to) {
      rangeIdx += 1;
      entered = false;
    }

    const active = rangeIdx < sorted.length ? sorted[rangeIdx]! : null;
    const inside = active !== null && ev.timestamp >= active.from && ev.timestamp <= active.to;

    if (inside && !entered) {
      entered = true;
      if (ev.type !== 4 && ev.type !== 2) {
        const snap = dom.toSnapshot();
        if (snap) {
          out.push({
            type: 4,
            timestamp: active!.from,
            data: { href: dom.href, width: dom.width, height: dom.height },
          });
          out.push({
            type: 2,
            timestamp: active!.from,
            data: { node: snap, initialOffset: { left: 0, top: 0 } },
          });
        }
      }
    }

    // Always advance virtual DOM state before or during kept ranges
    if (ev.type === 4 && ev.data) {
      if (typeof ev.data.href === 'string') dom.href = ev.data.href;
      if (typeof ev.data.width === 'number') dom.width = ev.data.width;
      if (typeof ev.data.height === 'number') dom.height = ev.data.height;
    } else if (ev.type === 2 && ev.data?.node) {
      dom.loadSnapshot(ev.data.node as RrNode);
    } else if (ev.type === 3 && ev.data?.source === 0) {
      dom.applyMutation(ev.data);
    } else if (ev.type === 3 && ev.data?.source === 4) {
      if (typeof ev.data.width === 'number') dom.width = ev.data.width;
      if (typeof ev.data.height === 'number') dom.height = ev.data.height;
    }

    if (inside) out.push(ev);
  }

  const lastEnd = sorted.at(-1)!.to;
  out.push({ type: 5, timestamp: lastEnd, data: { tag: 'lens-end', payload: {} } });
  return out;
}

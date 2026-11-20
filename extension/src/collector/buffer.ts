import type { Action } from '@/protocol/Action';
import type { CaptureMode } from '@/protocol/CaptureMode';
import type { CoverageGap } from '@/protocol/CoverageGap';
import type { EvidenceEvent } from '@/protocol/EvidenceEvent';
import { sanitize } from './sanitize';

/** Capture reaches this far back; a session holds everything from Record to Stop. */
export const WINDOW_MS = 10 * 60_000;
export const MAX_EVENTS = 4000;
export const MAX_EVENT_BYTES = 24 * 1024;
export const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_GAPS = 40;

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

interface Entry {
  mode: CaptureMode;
  events: { event: EvidenceEvent; size: number }[];
  size: number;
  gaps: CoverageGap[];
  /** A session in this tab keeps everything from this time on. */
  hold?: number;
  /** Requests left out as noise, by reason. */
  dropped: Record<string, number>;
}

/** The last ten minutes of evidence for each collected tab, within count and byte budgets. */
export class EvidenceBuffer {
  private readonly tabs = new Map<number, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  start(tabId: number, mode: CaptureMode) {
    const entry = this.tabs.get(tabId);
    if (entry) entry.mode = mode;
    else this.tabs.set(tabId, { mode, events: [], size: 0, gaps: [], dropped: {} });
  }

  stop(tabId: number) {
    this.tabs.delete(tabId);
  }

  mode(tabId: number): CaptureMode | undefined {
    return this.tabs.get(tabId)?.mode;
  }

  /** A new document in the tab: the old page's evidence no longer describes what is on screen. */
  reset(tabId: number) {
    const entry = this.tabs.get(tabId);
    if (entry) Object.assign(entry, { events: [], size: 0, gaps: [], dropped: {} });
  }

  record(tabId: number, kind: string, data: Record<string, unknown>) {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    let event: EvidenceEvent = { timestamp: this.now(), kind, data: sanitize(data) as EvidenceEvent['data'] };
    let size = bytes(event);
    if (size > MAX_EVENT_BYTES) {
      event = { timestamp: event.timestamp, kind, data: { omission: `Event of ${size} bytes exceeds 24 KiB` } };
      size = bytes(event);
    }
    entry.events.push({ event, size });
    entry.size += size;
    this.prune(tabId, entry);
  }

  gap(tabId: number, channel: string, reason: string) {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    const open = entry.gaps.find((g) => g.channel === channel && g.reason === reason);
    if (open) open.endedAt = this.now();
    else entry.gaps.push({ channel, reason, startedAt: this.now(), endedAt: null });
    if (entry.gaps.length > MAX_GAPS) entry.gaps.shift();
  }

  /** Counts a request left out on purpose. */
  drop(tabId: number, reason: string) {
    const entry = this.tabs.get(tabId);
    if (entry) entry.dropped[reason] = (entry.dropped[reason] ?? 0) + 1;
  }

  /** Keeps everything from `from` on, past the window, until released with null. */
  hold(tabId: number, from: number | null) {
    const entry = this.tabs.get(tabId);
    if (entry) entry.hold = from ?? undefined;
  }

  /** The evidence from `from` on (default: the whole window). */
  snapshot(tabId: number, from = 0) {
    const entry = this.tabs.get(tabId);
    if (!entry) return undefined;
    this.prune(tabId, entry);
    return {
      mode: entry.mode,
      events: entry.events.map((e) => e.event).filter((e) => e.timestamp >= from),
      gaps: [...entry.gaps],
      dropped: { ...entry.dropped },
    };
  }

  private prune(tabId: number, entry: Entry) {
    const cutoff = Math.min(this.now() - WINDOW_MS, entry.hold ?? Infinity);
    while (entry.events.length && entry.events[0]!.event.timestamp < cutoff) entry.size -= entry.events.shift()!.size;
    let evicted = false;
    while (entry.events.length > MAX_EVENTS || entry.size > MAX_BUFFER_BYTES) {
      entry.size -= entry.events.shift()!.size;
      evicted = true;
    }
    if (evicted) this.gap(tabId, 'buffer', 'Oldest evidence evicted by the count or byte budget');
  }
}

/** Steps live longer than the evidence window: the flow that led to a defect often starts earlier. */
export const ACTION_WINDOW_MS = 10 * 60_000;
export const MAX_ACTIONS = 300;

/** The person's recent steps in each collected tab. */
export class ActionLog {
  private readonly tabs = new Map<number, Action[]>();
  private readonly holds = new Map<number, number>();

  constructor(private readonly now: () => number = Date.now) {}

  private cutoff(tabId: number) {
    return Math.min(this.now() - ACTION_WINDOW_MS, this.holds.get(tabId) ?? Infinity);
  }

  add(tabId: number, action: Action) {
    const list = this.tabs.get(tabId) ?? [];
    list.push(action);
    const cutoff = this.cutoff(tabId);
    while (list.length && (list.length > MAX_ACTIONS || list[0]!.timestamp < cutoff)) list.shift();
    this.tabs.set(tabId, list);
  }

  hold(tabId: number, from: number | null) {
    if (from === null) this.holds.delete(tabId);
    else this.holds.set(tabId, from);
  }

  snapshot(tabId: number, from = 0): Action[] {
    const cutoff = Math.max(this.cutoff(tabId), from);
    return (this.tabs.get(tabId) ?? []).filter((a) => a.timestamp >= cutoff);
  }

  clear(tabId: number) {
    this.tabs.delete(tabId);
    this.holds.delete(tabId);
  }
}

/** rrweb's event types that start a replay: the page's size and URL, then the whole DOM. */
const META = 4;
const FULL_SNAPSHOT = 2;
/** One tab's replay may hold this much; beyond it the oldest stretch goes, with a gap. */
export const MAX_REPLAY_BYTES = 64 * 1024 * 1024;

interface ReplayEvent {
  type: number;
  timestamp: number;
}

/**
 * The DOM recording of each collected tab, across page loads. A replay can only start at a full
 * snapshot, so the buffer keeps the last one before the window and cuts there.
 */
export class ReplayBuffer {
  private readonly tabs = new Map<number, { events: { event: ReplayEvent; size: number }[]; size: number; hold?: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  add(tabId: number, events: ReplayEvent[]) {
    const entry = this.tabs.get(tabId) ?? { events: [], size: 0 };
    for (const event of events) {
      const size = JSON.stringify(event).length;
      entry.events.push({ event, size });
      entry.size += size;
    }
    this.tabs.set(tabId, entry);
    this.prune(entry);
  }

  hold(tabId: number, from: number | null) {
    const entry = this.tabs.get(tabId);
    if (entry) entry.hold = from ?? undefined;
  }

  /** The events from the last full snapshot at or before `from`, or the first one after it. */
  slice(tabId: number, from: number): ReplayEvent[] {
    const entry = this.tabs.get(tabId);
    if (!entry) return [];
    const start = startBefore(entry.events.map((e) => e.event), from);
    return entry.events.slice(start).map((e) => e.event);
  }

  clear(tabId: number) {
    this.tabs.delete(tabId);
  }

  private prune(entry: { events: { event: ReplayEvent; size: number }[]; size: number; hold?: number }) {
    const cutoff = Math.min(this.now() - WINDOW_MS, entry.hold ?? Infinity);
    let start = startBefore(
      entry.events.map((e) => e.event),
      cutoff,
    );
    // Over budget: drop whole stretches up to the next full snapshot, so the rest still replays.
    let size = entry.events.slice(start).reduce((sum, e) => sum + e.size, 0);
    while (size > MAX_REPLAY_BYTES) {
      // The next start must lie past this one: a meta event in front of the current snapshot would
      // otherwise give the same start again, and the loop would never end.
      let next = start;
      let from = start;
      while (from <= start) {
        next = entry.events.findIndex((e, i) => i > next && e.event.type === FULL_SNAPSHOT);
        if (next < 0) break;
        from = entry.events[next - 1]?.event.type === META ? next - 1 : next;
      }
      if (next < 0) break;
      size -= entry.events.slice(start, from).reduce((sum, e) => sum + e.size, 0);
      start = from;
    }
    if (start > 0) {
      entry.events.splice(0, start);
      entry.size = size;
    }
  }
}

/** A snapshot this soon after `from` is the one taken for it, when a session started. */
const FRESH_MS = 5000;

/**
 * Index of the replay start for `from`: a full snapshot taken just after it, else the last one at
 * or before it (with the meta event in front of it).
 */
export function startBefore(events: ReplayEvent[], from: number): number {
  let found = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.type !== FULL_SNAPSHOT) continue;
    const at = events[i]!.timestamp;
    if (at <= from || found < 0 || at - from <= FRESH_MS) found = i;
    if (at > from) break;
  }
  if (found < 0) return 0;
  return events[found - 1]?.type === META ? found - 1 : found;
}

/** Shots of each tab after the person's steps, for the record's filmstrip. */
export const MAX_SHOTS = 60;

export class ShotBuffer {
  private readonly tabs = new Map<number, { shots: { at: number; data: string }[]; hold?: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Adds a shot unless it equals the previous one. Returns whether it was kept. */
  add(tabId: number, at: number, data: string): boolean {
    const entry = this.tabs.get(tabId) ?? { shots: [] };
    this.tabs.set(tabId, entry);
    if (entry.shots.at(-1)?.data === data) return false;
    entry.shots.push({ at, data });
    const cutoff = Math.min(this.now() - WINDOW_MS, entry.hold ?? Infinity);
    while (entry.shots.length && (entry.shots[0]!.at < cutoff || entry.shots.length > MAX_SHOTS)) entry.shots.shift();
    return true;
  }

  hold(tabId: number, from: number | null) {
    const entry = this.tabs.get(tabId);
    if (entry) entry.hold = from ?? undefined;
  }

  since(tabId: number, from: number) {
    return (this.tabs.get(tabId)?.shots ?? []).filter((s) => s.at >= from);
  }

  clear(tabId: number) {
    this.tabs.delete(tabId);
  }
}

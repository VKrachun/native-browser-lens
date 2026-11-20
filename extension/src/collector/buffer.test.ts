import { describe, expect, it } from 'vitest';
import { EvidenceBuffer, MAX_EVENTS, ReplayBuffer, ShotBuffer, startBefore, WINDOW_MS } from './buffer';

describe('EvidenceBuffer', () => {
  it('keeps two minutes, then evicts by count and records the gap', () => {
    let now = 0;
    const buffer = new EvidenceBuffer(() => now);
    buffer.start(1, 'deep');
    buffer.record(1, 'console', { text: 'old' });
    now = WINDOW_MS + 1;
    for (let i = 0; i < MAX_EVENTS + 5; i++) buffer.record(1, 'console', { text: `n${i}` });
    const snapshot = buffer.snapshot(1)!;
    expect(snapshot.events).toHaveLength(MAX_EVENTS);
    expect(JSON.stringify(snapshot.events)).not.toContain('"old"');
    expect(snapshot.gaps.map((g) => g.channel)).toContain('buffer');
  });

  it('replaces an oversized event with an omission and ignores tabs it does not collect', () => {
    const buffer = new EvidenceBuffer(() => 1);
    buffer.start(1, 'limited');
    buffer.record(1, 'responseBody', { body: Array.from({ length: 60 }, () => 'x'.repeat(1000)) });
    buffer.record(2, 'console', { text: 'not collected' });
    expect(buffer.snapshot(1)!.events[0]!.data).toHaveProperty('omission');
    expect(buffer.snapshot(2)).toBeUndefined();
  });

  it('keeps everything a session holds, past the window', () => {
    let now = 0;
    const buffer = new EvidenceBuffer(() => now);
    buffer.start(1, 'deep');
    buffer.hold(1, 0);
    buffer.record(1, 'console', { text: 'at the start' });
    now = WINDOW_MS * 3;
    buffer.record(1, 'console', { text: 'later' });
    expect(buffer.snapshot(1)!.events.map((e) => (e.data as { text: string }).text)).toEqual(['at the start', 'later']);
    buffer.hold(1, null);
    now += WINDOW_MS + 1;
    buffer.record(1, 'console', { text: 'now' });
    expect(buffer.snapshot(1)!.events).toHaveLength(1);
  });
});

describe('ReplayBuffer', () => {
  const meta = (t: number) => ({ type: 4, timestamp: t });
  const full = (t: number) => ({ type: 2, timestamp: t });
  const step = (t: number) => ({ type: 3, timestamp: t });

  it('starts every replay at a full snapshot', () => {
    const s = 1000;
    const events = [meta(0), full(0), step(5 * s), meta(60 * s), full(60 * s), step(70 * s)];
    expect(startBefore(events, 65 * s)).toBe(3);
    // A session's own snapshot, taken just after it started, wins over the older one.
    expect(startBefore(events, 58 * s)).toBe(3);
    expect(startBefore(events, 30 * s)).toBe(0);
    expect(startBefore(events, -5 * s)).toBe(0);
  });

  it('drops what lies before the window, from the last snapshot before it', () => {
    let now = 0;
    const buffer = new ReplayBuffer(() => now);
    buffer.add(1, [meta(0), full(0), step(1)]);
    now = WINDOW_MS + 100;
    buffer.add(1, [meta(60_000), full(60_000), step(WINDOW_MS + 50)]);
    expect(buffer.slice(1, 0).map((e) => e.timestamp)).toEqual([0, 0, 1, 60_000, 60_000, WINDOW_MS + 50]);
    now = WINDOW_MS + 70_000;
    buffer.add(1, [step(now)]);
    expect(buffer.slice(1, 0)[0]).toEqual(meta(60_000));
  });

  it('over budget, drops the oldest stretch even when it starts with a meta event', () => {
    const buffer = new ReplayBuffer(() => 10);
    const big = (t: number) => ({ type: 3, timestamp: t, data: 'x'.repeat(40 * 1024 * 1024) });
    buffer.add(1, [meta(0), full(0), big(1), meta(5), full(5), big(6)]);
    expect(buffer.slice(1, 0).map((e) => e.timestamp)).toEqual([5, 5, 6]);
  });
});


describe('ShotBuffer', () => {
  it('keeps the shots of a session that started before its first shot, past the window', () => {
    let now = 0;
    const shots = new ShotBuffer(() => now);
    shots.hold(1, 0);
    shots.add(1, 1, 'a');
    now = WINDOW_MS * 3;
    shots.add(1, now, 'b');
    expect(shots.since(1, 0).map((s) => s.data)).toEqual(['a', 'b']);
  });

  it('moves a recording to the tab that replaced it', () => {
    const shots = new ShotBuffer(() => 10);
    shots.add(1, 10, 'a');
    shots.move(1, 2);
    expect([shots.since(1, 0).length, shots.since(2, 0).length]).toEqual([0, 1]);
  });
});

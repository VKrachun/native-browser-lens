import { expect, it } from 'vitest';
import { ActionLog, EvidenceBuffer, MAX_ACTIONS, ReplayBuffer, ShotBuffer } from './buffer';
import { chunk, emptyBatch, gather, KINDS, STALE_MS, stale, type Batch } from './evidence-spool';
import type { Action } from '@/protocol/Action';

const step = (timestamp: number): Action => ({ timestamp, kind: 'click', url: '', target: null, value: null, masked: false });

it('brings a recording back from its spool, older before newer, within the caps', () => {
  // The worker before the restart: what it collected reaches the spool through the buffers' taps.
  const now = 1000;
  const spooled: Batch = emptyBatch();
  const first = { events: new EvidenceBuffer(() => now), actions: new ActionLog(() => now), replay: new ReplayBuffer(() => now), shots: new ShotBuffer(() => now) };
  first.events.onAdd = (_, items) => spooled.events.push(...items);
  first.actions.onAdd = (_, items) => spooled.actions.push(...items);
  first.replay.onAdd = (_, items) => spooled.replay.push(...(items as never[]));
  first.shots.onAdd = (_, items) => spooled.shots.push(...items);
  first.events.start(1, 'deep');
  first.events.record(1, 'console', { text: 'before the restart' });
  for (let i = 0; i < MAX_ACTIONS + 10; i++) first.actions.add(1, step(500 + i));
  first.replay.add(1, [{ type: 4, timestamp: 600 }, { type: 2, timestamp: 600 }, { type: 3, timestamp: 700 }]);
  first.shots.add(1, 650, 'shot-a');
  // Written in two batches, as the spool does.
  const chunks = KINDS.flatMap((kind) => {
    const items = spooled[kind] as unknown[];
    const half = Math.ceil(items.length / 2);
    return [chunk(100, kind, items.slice(0, half)), chunk(100, kind, items.slice(half))];
  });
  const back = gather(chunks, { session: 100, tab: 1, savedAt: 900, gaps: [{ channel: 'buffer', reason: 'x', startedAt: 1, endedAt: null }], dropped: { noise: 2 } });

  // The new worker collected a little before the spool was read back.
  const events = new EvidenceBuffer(() => now);
  const actions = new ActionLog(() => now);
  const replay = new ReplayBuffer(() => now);
  const shots = new ShotBuffer(() => now);
  events.start(1, 'deep');
  for (const b of [events, actions, replay, shots]) b.hold(1, 100);
  events.record(1, 'console', { text: 'after the restart' });
  actions.add(1, step(950));
  replay.add(1, [{ type: 4, timestamp: 960 }, { type: 2, timestamp: 960 }]);
  shots.add(1, 970, 'shot-b');

  events.restore(1, back.events, back.gaps, back.dropped);
  actions.restore(1, back.actions);
  replay.restore(1, back.replay);
  shots.restore(1, back.shots);

  const snapshot = events.snapshot(1)!;
  expect(snapshot.events.map((e) => (e.data as { text: string }).text)).toEqual(['before the restart', 'after the restart']);
  expect(snapshot.gaps.map((g) => g.channel)).toEqual(['buffer']);
  expect(snapshot.dropped).toEqual({ noise: 2 });
  const steps = actions.snapshot(1);
  expect(steps).toHaveLength(MAX_ACTIONS);
  expect(steps.at(-1)!.timestamp).toBe(950);
  expect(steps[0]!.timestamp).toBeLessThan(steps[1]!.timestamp);
  expect(replay.slice(1, 100).map((e) => e.timestamp)).toEqual([600, 600, 700, 960, 960]);
  expect(shots.since(1, 0).map((s) => s.data)).toEqual(['shot-a', 'shot-b']);
  expect(back.bytes).toBeGreaterThan(0);
});

it('a restore without spooled data changes nothing', () => {
  const events = new EvidenceBuffer(() => 1);
  events.restore(1, [], [], {});
  expect(events.snapshot(1)).toBeUndefined();
  const actions = new ActionLog(() => 1);
  actions.restore(1, []);
  expect(actions.snapshot(1)).toEqual([]);
});

it('deletes spools no running recording owns, and old ones', () => {
  const now = 10 * STALE_MS;
  const states = [
    { session: 1, savedAt: now - 1000 },
    { session: 2, savedAt: now - 1000 },
    { session: 3, savedAt: now - STALE_MS - 1 },
  ];
  expect(stale(states, new Set([1, 3]), now)).toEqual([2, 3]);
  expect(stale(states, new Set([1, 2, 3]), now)).toEqual([3]);
});

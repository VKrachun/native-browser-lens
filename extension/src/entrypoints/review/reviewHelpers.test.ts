import { describe, expect, it } from 'vitest';
import type { Capture } from '@/protocol/Capture';
import { autoTrimBounds, correctSegment, jumpTarget, markersOf, privacyCounts, videoOf } from './reviewHelpers';

const blob = (sha256: string) => ({ sha256, size: 1, mediaType: 'application/octet-stream' });

function capture(extra: Partial<Capture>): Capture {
  return {
    id: 1,
    observation: 1,
    createdAt: 0,
    pageUrl: 'https://shop.test/',
    pageTitle: 'Shop',
    mode: 'limited',
    screenshot: blob('s'),
    evidence: blob('e'),
    eventCount: 0,
    gapCount: 0,
    annotations: [],
    recording: null,
    kind: 'screenshot',
    startedAt: 0,
    edits: { trimStart: null, trimEnd: null, cuts: [], annotations: [], hiddenShots: [], shotMasks: [] },
    shots: [],
    ...extra,
  } as Capture;
}

describe('autoTrimBounds', () => {
  const range = { start: 0, end: 60_000 };
  it('pads one second before the first activity and 1.5 s after the last', () => {
    expect(autoTrimBounds([20_000, 5_000, 30_000], range)).toEqual({ trimStart: 4_000, trimEnd: 31_500 });
  });
  it('stays inside the recording', () => {
    expect(autoTrimBounds([500, 59_500], range)).toEqual({ trimStart: 0, trimEnd: 60_000 });
  });
  it('ignores activity outside the recording and gives null when nothing happened', () => {
    expect(autoTrimBounds([-5, 70_000], range)).toBeNull();
    expect(autoTrimBounds([], range)).toBeNull();
  });
  it('keeps at least one second', () => {
    const bounds = autoTrimBounds([59_900], { start: 59_000, end: 60_000 })!;
    expect(bounds.trimEnd - bounds.trimStart).toBe(1000);
  });
});

describe('jumpTarget', () => {
  const times = [3000, 1000, 2000];
  it('finds the next and the previous moment, never the one under the playhead', () => {
    expect(jumpTarget(times, 1000, 1)).toBe(2000);
    expect(jumpTarget(times, 2100, -1)).toBe(1000);
    expect(jumpTarget(times, 0, 1)).toBe(1000);
  });
  it('gives null past the ends', () => {
    expect(jumpTarget(times, 3000, 1)).toBeNull();
    expect(jumpTarget(times, 1000, -1)).toBeNull();
    expect(jumpTarget([], 0, 1)).toBeNull();
  });
});

describe('markersOf', () => {
  it('reads evidence and rrweb markers, once per marker', () => {
    const events = [{ timestamp: 1000, kind: 'marker', data: { label: 'Checkout breaks' } }];
    const recorded = [
      { type: 5, timestamp: 1010, data: { tag: 'lens-marker', payload: { label: 'Checkout breaks' } } },
      { type: 5, timestamp: 5000, data: { tag: 'lens-marker', payload: {} } },
      { type: 5, timestamp: 6000, data: { tag: 'other' } },
    ];
    expect(markersOf(events, recorded)).toEqual([
      { at: 1000, label: 'Checkout breaks' },
      { at: 5000, label: 'Marker' },
    ]);
  });
});

describe('videoOf', () => {
  it('finds the video event', () => {
    const video = { timestamp: 9, kind: 'video', data: { blob: blob('v'), startedAt: 5, truncated: true } };
    expect(videoOf([{ timestamp: 1, kind: 'console', data: {} }, video])).toEqual({ blob: blob('v'), startedAt: 5, truncated: true });
    expect(videoOf([])).toBeNull();
  });
});

describe('correctSegment', () => {
  const segments = [
    { startMs: 0, endMs: 1000, text: 'fellow americans', corrected: false },
    { startMs: 1000, endMs: 2000, text: 'the total', corrected: false },
  ];
  it('marks the changed line as corrected', () => {
    expect(correctSegment(segments, 0, ' fellow testers ')).toEqual([{ ...segments[0], text: 'fellow testers', corrected: true }, segments[1]]);
  });
  it('gives null for no change or a missing line', () => {
    expect(correctSegment(segments, 1, 'the total ')).toBeNull();
    expect(correctSegment(segments, 5, 'x')).toBeNull();
  });
});

describe('privacyCounts', () => {
  const masked = capture({ annotations: [{ kind: 'mask', x: 0, y: 0, width: 1, height: 1 }, { kind: 'blur', x: 0, y: 0, width: 1, height: 1 }] });
  const session = capture({
    kind: 'session',
    shots: [
      { at: 10, image: blob('a'), reason: 'step' },
      { at: 20, image: blob('b'), reason: 'step' },
      { at: 30, image: blob('c'), reason: 'end' },
    ],
    edits: {
      trimStart: null,
      trimEnd: null,
      cuts: [],
      annotations: [],
      hiddenShots: [30],
      shotMasks: [{ at: 10, areas: [{ x: 0, y: 0, width: 0.5, height: 0.5 }] }],
    },
  } as Partial<Capture>);
  const settings = { maskSelectors: ['.secret'], sensitiveHeaders: ['x-api-key', 'x-org'], sensitivePatterns: [] };

  it('counts redactions, masks, rules and screenshots without a mask', () => {
    const counts = privacyCounts([masked, capture({}), session], ['{"a":"[REDACTED]","b":"[REDACTED]"}', '', '[REDACTED]'], settings);
    // The unmasked screenshot, and the session shot at 20 (10 is masked, 30 is removed).
    expect(counts).toEqual({ redacted: 3, masks: 3, rules: 3, unmasked: 2 });
  });
  it('leaves out the shots when they stay on this computer', () => {
    expect(privacyCounts([session], [''], null, false)).toEqual({ redacted: 0, masks: 1, rules: 0, unmasked: 0 });
  });
});

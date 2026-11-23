import { describe, expect, it } from 'vitest';
import type { Shape } from '@/protocol/Shape';
import { badgeRadius, bounds, ink, label, moved, nextBadge, shapeAt, textScale, wrap } from './shapes';

describe('annotate shapes', () => {
  it('sizes labels and badges as render.rs does', () => {
    expect(textScale(400)).toBe(2);
    expect(textScale(5000)).toBe(6);
    expect(wrap('aaa bbb', 5)).toEqual(['aaa', 'bbb']);
    expect(wrap('abcdefgh', 5)).toEqual(['abcde', 'fgh']);
    expect(label('hi', 2)).toMatchObject({ width: 2 * 12 - 2 + 12, height: 16 - 2 + 12 });
    expect(badgeRadius(7, 2)).toBe(12);
    expect(ink('#ffb000')).toBe('#000000');
    expect(ink('#2f7bff')).toBe('#ffffff');
  });

  it('numbers the next badge with the smallest free number', () => {
    const badge = (number: number): Shape => ({ kind: 'badge', x: 0, y: 0, number, color: '#ff3355' });
    expect(nextBadge([])).toBe(1);
    expect(nextBadge([badge(1), badge(3)])).toBe(2);
    expect(nextBadge(Array.from({ length: 999 }, (_, i) => badge(i + 1)))).toBeNull();
  });

  it('finds the topmost shape and moves every kind', () => {
    const shapes: Shape[] = [
      { kind: 'rectangle', x: 0, y: 0, width: 100, height: 100, color: '#ff3355' },
      { kind: 'arrow', from: { x: 10, y: 10 }, to: { x: 90, y: 10 }, color: '#ff3355' },
      { kind: 'pen', points: [{ x: 200, y: 200 }, { x: 300, y: 200 }], color: '#ff3355' },
    ];
    expect(shapeAt(shapes, { x: 50, y: 12 }, 2, 4)).toBe(1);
    expect(shapeAt(shapes, { x: 50, y: 50 }, 2, 4)).toBe(0);
    expect(shapeAt(shapes, { x: 250, y: 203 }, 2, 4)).toBe(2);
    expect(shapeAt(shapes, { x: 250, y: 250 }, 2, 4)).toBeNull();
    expect(bounds(moved(shapes[2]!, 5, -5), 2)).toEqual({ x: 205, y: 195, width: 100, height: 0 });
    expect(moved(shapes[1]!, 1, 1)).toMatchObject({ from: { x: 11, y: 11 }, to: { x: 91, y: 11 } });
    expect(moved(shapes[0]!, 1, 2)).toMatchObject({ x: 1, y: 2, width: 100 });
  });
});

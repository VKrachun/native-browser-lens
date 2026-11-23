import type { Point } from '@/protocol/Point';
import type { Shape } from '@/protocol/Shape';

/** Geometry that must agree with `src/render.rs`, which draws the exported marks. */
export const MAX_LABEL = 500;
export const MAX_BADGE = 999;
const CELL = { width: 6, height: 8 };

type Box = { x: number; y: number; width: number; height: number };

/** Pixels per font dot: render.rs `text_scale`. */
export function textScale(imageWidth: number): number {
  return Math.min(6, Math.max(2, Math.floor(imageWidth / 500)));
}

/** Black or white text, whichever reads on `color`: render.rs `ink`. */
export function ink(color: string): '#000000' | '#ffffff' {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) as [number, number, number];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#000000' : '#ffffff';
}

/** Lines of at most `width` characters, broken between words where it can: render.rs `wrap`. */
export function wrap(text: string, width = 48): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const whole of paragraph.split(/\s+/).filter(Boolean)) {
      const word = [...whole];
      while (word.length) {
        const used = [...line].length;
        const room = Math.max(0, width - (used + (used > 0 ? 1 : 0)));
        if (word.length <= room) {
          line += (used > 0 ? ' ' : '') + word.splice(0).join('');
        } else if (used > 0) {
          lines.push(line);
          line = '';
        } else {
          lines.push(word.splice(0, width).join(''));
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The pill of a text callout, its top left corner at the shape's `x`, `y`. */
export function label(text: string, s: number) {
  const lines = wrap(text);
  const longest = Math.max(0, ...lines.map((l) => [...l].length));
  const pad = 3 * s;
  return {
    lines,
    pad,
    width: longest * CELL.width * s - s + 2 * pad,
    height: lines.length * CELL.height * s - s + 2 * pad,
  };
}

/** The colored circle of a step badge; the white ring adds `s`. */
export function badgeRadius(number: number, s: number): number {
  const textWidth = String(number).length * CELL.width * s - s;
  return Math.max(6 * s, textWidth / 2 + 2 * s);
}

/** The smallest step number no badge uses yet, or null when 1 to 999 are all taken. */
export function nextBadge(shapes: Shape[]): number | null {
  const used = new Set(shapes.flatMap((shape) => (shape.kind === 'badge' ? [shape.number] : [])));
  for (let n = 1; n <= MAX_BADGE; n++) if (!used.has(n)) return n;
  return null;
}

/** A box with positive sizes. */
export function box(shape: Box): Box {
  return {
    x: Math.min(shape.x, shape.x + shape.width),
    y: Math.min(shape.y, shape.y + shape.height),
    width: Math.abs(shape.width),
    height: Math.abs(shape.height),
  };
}

function around(points: Point[]): Box {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The area a shape covers on the screenshot. */
export function bounds(shape: Shape, s: number): Box {
  switch (shape.kind) {
    case 'rectangle':
    case 'mask':
    case 'blur':
      return box(shape);
    case 'arrow':
      return around([shape.from, shape.to]);
    case 'pen':
      return around(shape.points);
    case 'text': {
      const { width, height } = label(shape.text, s);
      return { x: shape.x, y: shape.y, width, height };
    }
    case 'badge': {
      const r = badgeRadius(shape.number, s) + s;
      return { x: shape.x - r, y: shape.y - r, width: 2 * r, height: 2 * r };
    }
  }
}

function toSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The index of the topmost shape at `at`, within `slack` pixels of a line, or null. */
export function shapeAt(shapes: Shape[], at: Point, s: number, slack: number): number | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i]!;
    if (shape.kind === 'arrow' && toSegment(at, shape.from, shape.to) <= slack) return i;
    if (shape.kind === 'pen') {
      const { points } = shape;
      for (let j = 0; j < points.length; j++) {
        if (toSegment(at, points[j]!, points[j + 1] ?? points[j]!) <= slack) return i;
      }
    }
    if (shape.kind !== 'arrow' && shape.kind !== 'pen') {
      const b = bounds(shape, s);
      if (at.x >= b.x - slack && at.x <= b.x + b.width + slack && at.y >= b.y - slack && at.y <= b.y + b.height + slack) {
        return i;
      }
    }
  }
  return null;
}

/** The shape moved by `dx`, `dy`. */
export function moved(shape: Shape, dx: number, dy: number): Shape {
  const step = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
  switch (shape.kind) {
    case 'arrow':
      return { ...shape, from: step(shape.from), to: step(shape.to) };
    case 'pen':
      return { ...shape, points: shape.points.map(step) };
    default:
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
  }
}

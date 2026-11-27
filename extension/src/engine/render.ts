import type { Area } from '@/protocol/Area';
import type { Shape } from '@/protocol/Shape';

const LINE_WIDTH = 3;
const ARROW_HEAD = 14;

/**
 * Burns annotations, blur pixelation, and opaque black masks into a PNG screenshot
 * using OffscreenCanvas (with passthrough fallback in headless/Node test environments).
 */
export async function renderAnnotatedPng(
  pngBytes: Uint8Array<ArrayBuffer>,
  shapes: Shape[],
): Promise<{ bytes: Uint8Array<ArrayBuffer>; width: number; height: number }> {
  const dims = readPngDimensions(pngBytes);
  if (shapes.length === 0 || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return { bytes: pngBytes, width: dims.width, height: dims.height };
  }

  const bitmap = await createImageBitmap(new Blob([pngBytes], { type: 'image/png' }));
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { bytes: pngBytes, width, height };
    ctx.drawImage(bitmap, 0, 0);

    // Pass 1: Non-hiding marks (rectangle, arrow, pen, text, badge)
    for (const shape of shapes) {
      if (shape.kind === 'mask' || shape.kind === 'blur') continue;
      drawMark(ctx, shape, width);
    }

    // Pass 2: Blur (block pixelation matching Rust render.rs)
    const block = Math.max(12, Math.min(48, Math.round(width / 120)));
    for (const shape of shapes) {
      if (shape.kind !== 'blur') continue;
      pixelateRect(ctx, shape.x, shape.y, shape.width, shape.height, width, height, block);
    }

    // Pass 3: Opaque black masks last so nothing can leak through
    ctx.fillStyle = '#000000';
    for (const shape of shapes) {
      if (shape.kind !== 'mask') continue;
      const x = Math.max(0, Math.floor(shape.x));
      const y = Math.max(0, Math.floor(shape.y));
      const w = Math.max(0, Math.ceil(shape.width));
      const h = Math.max(0, Math.ceil(shape.height));
      ctx.fillRect(x, y, w, h);
    }

    const outBlob = await canvas.convertToBlob({ type: 'image/png' });
    return { bytes: new Uint8Array(await outBlob.arrayBuffer()), width, height };
  } finally {
    bitmap.close();
  }
}

/** Burns normalized [0..1] opaque black rectangles into a WebP step shot. */
export async function maskWebpShot(
  webpBytes: Uint8Array<ArrayBuffer>,
  masks: Area[],
): Promise<Uint8Array<ArrayBuffer>> {
  if (masks.length === 0 || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return webpBytes;
  }
  const bitmap = await createImageBitmap(new Blob([webpBytes], { type: 'image/webp' }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return webpBytes;
    ctx.drawImage(bitmap, 0, 0);
    ctx.fillStyle = '#000000';
    for (const m of masks) {
      const x = Math.floor(Math.max(0, m.x) * bitmap.width);
      const y = Math.floor(Math.max(0, m.y) * bitmap.height);
      const w = Math.ceil(Math.max(0, m.width) * bitmap.width);
      const h = Math.ceil(Math.max(0, m.height) * bitmap.height);
      ctx.fillRect(x, y, w, h);
    }
    const outBlob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 });
    return new Uint8Array(await outBlob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function drawMark(ctx: OffscreenCanvasRenderingContext2D, shape: Shape, width: number): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (shape.kind === 'rectangle') {
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = LINE_WIDTH;
    ctx.strokeRect(shape.x, shape.y, shape.width, shape.height);
  } else if (shape.kind === 'arrow') {
    ctx.strokeStyle = shape.color;
    ctx.fillStyle = shape.color;
    ctx.lineWidth = LINE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(shape.from.x, shape.from.y);
    ctx.lineTo(shape.to.x, shape.to.y);
    ctx.stroke();
    const angle = Math.atan2(shape.to.y - shape.from.y, shape.to.x - shape.from.x);
    ctx.beginPath();
    ctx.moveTo(shape.to.x, shape.to.y);
    ctx.lineTo(
      shape.to.x - ARROW_HEAD * Math.cos(angle - Math.PI / 6),
      shape.to.y - ARROW_HEAD * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      shape.to.x - ARROW_HEAD * Math.cos(angle + Math.PI / 6),
      shape.to.y - ARROW_HEAD * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();
  } else if (shape.kind === 'pen' && shape.points.length > 0) {
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = LINE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(shape.points[0]!.x, shape.points[0]!.y);
    for (let i = 1; i < shape.points.length; i += 1) {
      ctx.lineTo(shape.points[i]!.x, shape.points[i]!.y);
    }
    ctx.stroke();
  } else if (shape.kind === 'text') {
    const fontSize = Math.max(14, Math.min(36, Math.round(width / 60)));
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
    const padX = Math.round(fontSize * 0.5);
    const padY = Math.round(fontSize * 0.35);
    const metrics = ctx.measureText(shape.text);
    const boxW = metrics.width + padX * 2;
    const boxH = fontSize + padY * 2;
    ctx.fillStyle = shape.color;
    ctx.beginPath();
    ctx.roundRect(shape.x, shape.y, boxW, boxH, 6);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    ctx.fillText(shape.text, shape.x + padX, shape.y + padY);
  } else if (shape.kind === 'badge') {
    const r = Math.max(14, Math.min(28, Math.round(width / 70)));
    ctx.fillStyle = shape.color;
    ctx.beginPath();
    ctx.arc(shape.x, shape.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.round(r * 1.1)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(shape.number), shape.x, shape.y + 1);
  }
  ctx.restore();
}

function pixelateRect(
  ctx: OffscreenCanvasRenderingContext2D,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  canvasW: number,
  canvasH: number,
  block: number,
): void {
  const x0 = Math.max(0, Math.floor(rx));
  const y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(canvasW, Math.ceil(rx + rw));
  const y1 = Math.min(canvasH, Math.ceil(ry + rh));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;

  const img = ctx.getImageData(x0, y0, w, h);
  const d = img.data;
  for (let by = 0; by < h; by += block) {
    for (let bx = 0; bx < w; bx += block) {
      const bw = Math.min(block, w - bx);
      const bh = Math.min(block, h - by);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const count = bw * bh;
      for (let py = by; py < by + bh; py += 1) {
        for (let px = bx; px < bx + bw; px += 1) {
          const i = (py * w + px) * 4;
          r += d[i]!;
          g += d[i + 1]!;
          b += d[i + 2]!;
          a += d[i + 3]!;
        }
      }
      const ar = Math.round(r / count);
      const ag = Math.round(g / count);
      const ab = Math.round(b / count);
      const aa = Math.round(a / count);
      for (let py = by; py < by + bh; py += 1) {
        for (let px = bx; px < bx + bw; px += 1) {
          const i = (py * w + px) * 4;
          d[i] = ar;
          d[i + 1] = ag;
          d[i + 2] = ab;
          d[i + 3] = aa;
        }
      }
    }
  }
  ctx.putImageData(img, x0, y0);
}

/** Reads PNG IHDR width/height directly from the header bytes (works in Node too). */
export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }
  return { width: 1280, height: 800 };
}

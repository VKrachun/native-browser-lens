import type { Capture } from '@/protocol/Capture';
import type { Edits } from '@/protocol/Edits';
import type { Shape } from '@/protocol/Shape';
import type { TimeRange } from '@/protocol/TimeRange';
import { badRequest } from './errors';

export const MAX_NOTES_BYTES = 256 * 1024;
export const MAX_SHAPES = 500;
export const MAX_PEN_POINTS = 5000;
export const MAX_TEXT_CHARS = 500;
export const MAX_EDITS_ITEMS = 200;
export const MAX_STROKE_POINTS = 2000;
export const MAX_SHOTS = 60;
export const NAMESPACE_OID = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

export function defaultEdits(): Edits {
  return {
    trimStart: null,
    trimEnd: null,
    cuts: [],
    annotations: [],
    hiddenShots: [],
    shotMasks: [],
  };
}

export function isEditsDefault(edits: Edits): boolean {
  return (
    edits.trimStart === null &&
    edits.trimEnd === null &&
    edits.cuts.length === 0 &&
    edits.annotations.length === 0 &&
    edits.hiddenShots.length === 0 &&
    edits.shotMasks.length === 0
  );
}

/** Lowercase, slugged, deduplicated tags, at most 8 (matching Rust `clean_tags`). */
export function cleanTags(raw: string[], limit = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const cleaned = item
      .toLowerCase()
      .replace(/[^a-z0-9:]+/g, '-')
      .slice(0, 32)
      .replace(/^-+|-+$/g, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

/** Strict origin normalization (`http|https`, no path/query/hash/credentials). */
export function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest(`Invalid site origin: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest(`Unsupported scheme: ${url.protocol}`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw badRequest(`Origin must not include path, query, fragment or credentials: ${raw}`);
  }
  return url.origin;
}

export function isHidingShape(shape: Shape): shape is Extract<Shape, { kind: 'mask' | 'blur' }> {
  return shape.kind === 'mask' || shape.kind === 'blur';
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function validateShapes(shapes: Shape[]): void {
  if (shapes.length > MAX_SHAPES) throw badRequest(`Too many annotations (max ${MAX_SHAPES})`);
  for (const s of shapes) {
    if ('color' in s && !HEX_COLOR.test(s.color)) {
      throw badRequest(`Invalid annotation color: ${s.color}`);
    }
    if (s.kind === 'pen' && s.points.length > MAX_PEN_POINTS) {
      throw badRequest(`Pen stroke too long (max ${MAX_PEN_POINTS} points)`);
    }
    if (s.kind === 'text' && s.text.length > MAX_TEXT_CHARS) {
      throw badRequest(`Text annotation too long (max ${MAX_TEXT_CHARS} chars)`);
    }
    if (s.kind === 'badge' && (!Number.isInteger(s.number) || s.number < 1 || s.number > 999)) {
      throw badRequest(`Badge number must be 1..999`);
    }
  }
}

/** Sorted non-empty `[from, to]` intervals inside `[trimStart ?? start, trimEnd ?? end]` minus cuts. */
export function keptRanges(edits: Edits, start: number, end: number): TimeRange[] {
  const from = edits.trimStart !== null ? Math.max(start, edits.trimStart) : start;
  const to = edits.trimEnd !== null ? Math.min(end, edits.trimEnd) : end;
  if (to <= from) return [];
  const cuts = edits.cuts
    .filter((c) => c.to > c.from)
    .map((c) => ({ from: Math.max(from, c.from), to: Math.min(to, c.to) }))
    .filter((c) => c.to > c.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);

  let ranges: TimeRange[] = [{ from, to }];
  for (const cut of cuts) {
    const next: TimeRange[] = [];
    for (const r of ranges) {
      if (cut.to <= r.from || cut.from >= r.to) {
        next.push(r);
      } else {
        if (cut.from > r.from) next.push({ from: r.from, to: cut.from });
        if (cut.to < r.to) next.push({ from: cut.to, to: r.to });
      }
    }
    ranges = next;
  }
  return ranges.filter((r) => r.to > r.from);
}

export function insideKept(kept: TimeRange[], time: number): boolean {
  if (kept.length === 0) return true;
  return kept.some((r) => time >= r.from && time <= r.to);
}

export function validateEdits(edits: Edits, capture: Pick<Capture, 'startedAt' | 'createdAt' | 'shots'>): void {
  if (edits.cuts.length > MAX_EDITS_ITEMS) throw badRequest(`Too many cuts (max ${MAX_EDITS_ITEMS})`);
  if (edits.annotations.length > MAX_EDITS_ITEMS) throw badRequest(`Too many timeline annotations (max ${MAX_EDITS_ITEMS})`);
  for (const ann of edits.annotations) {
    for (const stroke of ann.drawing ?? []) {
      if (stroke.length > MAX_STROKE_POINTS) {
        throw badRequest(`Timeline stroke too long (max ${MAX_STROKE_POINTS} points)`);
      }
    }
  }
  const shotTimes = new Set(capture.shots.map((s) => s.at));
  for (const sm of edits.shotMasks) {
    if (!shotTimes.has(sm.at)) {
      throw badRequest(`Shot mask references missing shot at ${sm.at}`);
    }
  }
  if (!isEditsDefault(edits)) {
    const kept = keptRanges(edits, capture.startedAt, capture.createdAt);
    if (kept.length === 0) {
      throw badRequest('Trim and cuts leave nothing of the recording.');
    }
  }
}

/** First meaningful line of notes, stripped of leading bullets, max 140 chars. */
export function headlineOf(notes: string): string | null {
  for (const raw of notes.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('Findings')) continue;
    const stripped = line.replace(/^[-*]\s+/, '').trim();
    if (!stripped) continue;
    return stripped.length > 140 ? `${stripped.slice(0, 139)}…` : stripped;
  }
  return null;
}

/** Splits the top `Findings...:` bullet block from the rest of the observation notes. */
export function splitFindingsBlock(notes: string): { header: string | null; findings: string[]; own: string } {
  const lines = notes.split('\n');
  if (!lines[0] || !/^Findings[^:\n]*:\s*$/.test(lines[0])) {
    return { header: null, findings: [], own: notes.trim() };
  }
  const header = lines[0];
  const findings: string[] = [];
  let i = 1;
  while (i < lines.length && lines[i]!.startsWith('- ')) {
    findings.push(lines[i]!.slice(2));
    i += 1;
  }
  while (i < lines.length && lines[i]!.trim() === '') i += 1;
  return { header, findings, own: lines.slice(i).join('\n').trim() };
}

export function plainTitle(raw: string, maxLen = 200): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[[\]()<>!`*_#|\\]/g, '')
    .trim()
    .slice(0, maxLen)
    .trim();
}

const HEX_TABLE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  let buf: ArrayBuffer;
  if (data instanceof ArrayBuffer) {
    buf = data;
  } else if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer instanceof ArrayBuffer) {
    buf = data.buffer;
  } else {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    buf = copy.buffer;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let hex = '';
  for (let i = 0; i < digest.length; i += 1) hex += HEX_TABLE[digest[i]!]!;
  return hex;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`Invalid UUID: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** RFC 4122 UUIDv5 (SHA-1) using Web Crypto. */
export async function uuidv5(namespaceUuid: string, name: string): Promise<string> {
  const nsBytes = uuidToBytes(namespaceUuid);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(nsBytes.length + nameBytes.length);
  input.set(nsBytes, 0);
  input.set(nameBytes, nsBytes.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', input.buffer));
  const bytes = hash.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

export function slugify(text: string, maxLen = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return slug || 'review';
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Parses WAV duration in milliseconds from RIFF/WAVE header (supports LIST chunks before data). */
export function wavDurationMs(bytes: Uint8Array): number {
  if (bytes.length < 44) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let byteRate = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 8 + 16 <= bytes.length) {
      byteRate = view.getUint32(offset + 8 + 8, true);
    } else if (id === 'data') {
      dataSize = Math.min(size, bytes.length - (offset + 8));
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || !dataSize) return 0;
  return Math.round((dataSize / byteRate) * 1000);
}

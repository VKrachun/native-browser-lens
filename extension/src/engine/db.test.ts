import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addVoiceNote,
  createCapture,
  createObservation,
  deleteObservation,
  getBlob,
  getObservation,
  getStorageUsage,
  listCaptures,
  listObservations,
  listProjects,
  pruneStorage,
  putBlob,
  resetDbForTests,
  saveAnnotations,
  saveEdits,
  saveProject,
  splitIntoTasks,
  splitObservation,
  updateObservation,
} from './db';
import { LensError } from './errors';
import { cleanTags, defaultEdits, keptRanges, uuidv5 } from './helpers';

beforeEach(async () => {
  resetDbForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('sirv-lens-v1');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
});

describe('engine/db', () => {
  it('stores content-addressed blobs and deduplicates by SHA-256', async () => {
    const bytes = new TextEncoder().encode('hello lens');
    const ref1 = await putBlob(bytes, 'application/json');
    const ref2 = await putBlob(bytes, 'application/json');
    expect(ref1.sha256).toBe(ref2.sha256);
    expect(ref1.sha256).toHaveLength(64);
    expect(ref1.size).toBe(bytes.byteLength);

    const loaded = await getBlob(ref1.sha256);
    expect(loaded).not.toBeNull();
    expect(new TextDecoder().decode(loaded!.bytes)).toBe('hello lens');
  });

  it('enforces monotonic IDs and revision conflict checks on observations', async () => {
    const a = await createObservation('First', 'https://example.com');
    expect(a.id).toBe(1);
    expect(a.revision).toBe(1);

    const updated = await updateObservation({
      id: a.id,
      revision: 1,
      title: 'Updated',
      notes: 'Findings:\n- Button does not work\n\nExtra note',
      tags: ['AI Tools', 'bug', 'BUG'],
    });
    expect(updated.revision).toBe(2);
    expect(updated.tags).toEqual(['ai-tools', 'bug']);

    await expect(
      updateObservation({ id: a.id, revision: 1, title: 'Stale', notes: '' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    await deleteObservation(a.id);
    const b = await createObservation('Second', 'https://example.com');
    expect(b.id).toBe(2);
  });

  it('creates captures, validates shapes/edits, and lists observation summaries', async () => {
    const cap = await createCapture({
      observation: null,
      pageUrl: 'https://app.example.com/cart',
      pageTitle: 'Cart',
      screenshot: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      evidence: {
        mode: 'deep',
        events: [],
        gaps: [],
        page: null,
        actions: [],
        elements: [],
        dropped: {},
      },
      recording: null,
      kind: 'session',
      startedAt: 1_000_000,
      shots: [],
    });

    const annotated = await saveAnnotations(cap.id, [
      { kind: 'rectangle', x: 10, y: 20, width: 100, height: 50, color: '#ff0000' },
    ]);
    expect(annotated.annotations).toHaveLength(1);

    const edited = await saveEdits(cap.id, {
      ...defaultEdits(),
      trimStart: 1_000_000,
      trimEnd: cap.createdAt,
    });
    expect(edited.edits.trimStart).toBe(1_000_000);

    await expect(
      saveEdits(cap.id, { ...defaultEdits(), trimStart: cap.createdAt + 10_000 }),
    ).rejects.toBeInstanceOf(LensError);

    const list = await listObservations();
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe('session');
    expect(list[0]!.captureCount).toBe(1);
  });

  it('splits observations by findings and splits into tasks with trimmed edits', async () => {
    const cap = await createCapture({
      observation: null,
      pageUrl: 'https://app.example.com',
      pageTitle: 'Home',
      screenshot: '',
      evidence: { mode: 'deep', events: [], gaps: [], page: null, actions: [], elements: [], dropped: {} },
      recording: null,
      kind: 'session',
      startedAt: 10_000,
      shots: [],
    });
    const obs = await getObservation(cap.observation);
    const updated = await updateObservation({
      id: obs.id,
      revision: obs.revision,
      title: 'Two bugs',
      notes: 'Findings (written by Claude):\n- First bug\n- Second bug\n\nMy own note',
    });

    const copy = await splitObservation(updated.id, updated.revision, [1], 'Second bug');
    expect(copy.notes).toContain('- Second bug');
    expect(copy.notes).not.toContain('- First bug');
    expect(copy.notes).toContain('My own note');
    expect((await listCaptures(copy.id))).toHaveLength(1);

    const origAfter = await getObservation(updated.id);
    expect(origAfter.notes).toContain('- First bug');
    expect(origAfter.notes).not.toContain('- Second bug');

    const split = await splitIntoTasks(origAfter.id, origAfter.revision, [
      { title: 'Task A', findings: ['A'], tags: ['ui'], fromSeconds: null, toSeconds: null },
      { title: 'Task B', findings: ['B'], tags: ['api'], fromSeconds: null, toSeconds: null },
    ]);
    expect(split).toHaveLength(2);
    await expect(getObservation(origAfter.id)).rejects.toMatchObject({ code: 'notFound' });
  });

  it('manages projects, voice notes, storage usage, and pruning', async () => {
    const p = await saveProject({ id: null, name: 'App', origins: ['https://app.example.com/'], enabled: true });
    expect(p.origins).toEqual(['https://app.example.com']);
    expect(await listProjects()).toHaveLength(1);

    const obs = await createObservation('Voice test', 'https://app.example.com');
    const wavHeader = new Uint8Array(44);
    wavHeader.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    wavHeader.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    wavHeader.set([0x66, 0x6d, 0x74, 0x20], 12); // fmt
    new DataView(wavHeader.buffer).setUint32(16, 16, true);
    new DataView(wavHeader.buffer).setUint32(28, 32000, true); // byteRate
    wavHeader.set([0x64, 0x61, 0x74, 0x61], 36); // data
    new DataView(wavHeader.buffer).setUint32(40, 64000, true); // 2s
    const wav = new Uint8Array(44 + 64000);
    wav.set(wavHeader, 0);
    const audioRef = await putBlob(wav, 'audio/wav');
    const vn = await addVoiceNote({ observation: obs.id, startedAt: Date.now(), audio: audioRef });
    expect(vn.durationMs).toBe(2000);

    const usage = await getStorageUsage();
    expect(usage.audioBytes).toBe(wav.byteLength);
    expect(usage.observationCount).toBe(1);

    const pruned = await pruneStorage(1, false);
    expect(pruned.deletedObservations).toBe(0);
  });

  it('computes keptRanges, cleanTags, and deterministic UUIDv5', async () => {
    expect(keptRanges({ ...defaultEdits(), trimStart: 10, trimEnd: 100, cuts: [{ from: 30, to: 50 }] }, 0, 200)).toEqual([
      { from: 10, to: 30 },
      { from: 50, to: 100 },
    ]);
    expect(cleanTags(['  AI Tools! ', 'bug', 'BUG', 'a:b'])).toEqual(['ai-tools', 'bug', 'a:b']);
    const id1 = await uuidv5('6ba7b812-9dad-11d1-80b4-00c04fd430c8', 'lens-capture:1:1000');
    const id2 = await uuidv5('6ba7b812-9dad-11d1-80b4-00c04fd430c8', 'lens-capture:1:1000');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

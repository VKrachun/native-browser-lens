const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeVoice, wavData } = require('../src/review-video.cjs');

test('voice follows kept frames, microphone offsets, overlapping notes and silent gaps', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-voice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  function track(name, start, duration, sample) {
    const file = path.join(dir, name);
    const data = Buffer.alloc(44 + duration * 32);
    data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
    data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
    data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28);
    data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
    data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
    for (let i = 0; i < duration * 16; i++) data.writeInt16LE(sample(Math.floor(i / 16)), 44 + 2 * i);
    fs.writeFileSync(file, data);
    return { path: file, start, duration };
  }
  const voice = track('voice.wav', 1030, 400, ms => ms);
  const overlapping = track('second.wav', 1310, 12, () => 500);
  const spans = [{ from: 1000, to: 1155 }, { from: 1300, to: 1450 }];
  const output = path.join(dir, 'sound');
  assert.equal(writeVoice(spans, [{ ...voice, start: 1155, duration: 145 }], output), false);
  assert.equal(fs.existsSync(output), false);
  assert.equal(writeVoice(spans, [voice, overlapping], output), true);
  const pcm = fs.readFileSync(output);
  assert.equal(pcm.length, 400 * 32);
  for (let ms = 0; ms < 400; ms++) {
    const source = ms < 155 ? 1000 + ms : ms >= 200 && ms < 350 ? 1300 + ms - 200 : 0;
    const sample = (source >= 1030 && source < 1430 ? source - 1030 : 0) +
      (source >= 1310 && source < 1322 ? 500 : 0);
    for (let i = 0; i < 16; i++) assert.equal(pcm.readInt16LE(ms * 32 + i * 2), sample);
  }
});

test('a WAV with a LIST chunk before its samples is read at its data chunk', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-wav-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const list = Buffer.from('LIST\x05\0\0\0INFOx\0', 'latin1');
  const fmt = Buffer.alloc(24);
  fmt.write('fmt '); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(16000, 12); fmt.writeUInt32LE(32000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const data = Buffer.from('data\0\0\0\0', 'latin1');
  const file = path.join(dir, 'listed.wav');
  fs.writeFileSync(file, Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), fmt, list, data, Buffer.alloc(64)]));
  const fd = fs.openSync(file, 'r');
  t.after(() => fs.closeSync(fd));
  assert.equal(wavData(fd), 12 + 24 + 14 + 8);
});

test('stills render the end of a replay as PNG and each step time as WebP', async t => {
  const tools = process.env.LENS_E2E_VIDEO_TOOLS ||
    path.join(os.homedir(), '.local', 'share', 'sirv-lens', 'video-tools');
  if (!fs.existsSync(path.join(tools, 'node_modules', 'playwright-core'))) return t.skip('no video tools');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-stills-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = 1_700_000_000_000;
  const events = [
    { type: 4, data: { href: 'https://shop.test/', width: 800, height: 600 }, timestamp: at },
    { type: 2, timestamp: at + 1, data: { initialOffset: { left: 0, top: 0 }, node: { type: 0, id: 1, childNodes: [
      { type: 1, id: 2, name: 'html', publicId: '', systemId: '' },
      { type: 2, id: 3, tagName: 'html', attributes: {}, childNodes: [
        { type: 2, id: 4, tagName: 'head', attributes: {}, childNodes: [] },
        { type: 2, id: 5, tagName: 'body', attributes: { style: 'background:#c00' }, childNodes: [
          { type: 3, id: 6, textContent: 'Checkout' },
          // A recorded page asks for a remote image: the renderer must not fetch it.
          { type: 2, id: 7, tagName: 'img', attributes: { src: 'https://tracker.test/seen.png' }, childNodes: [] }] }] }] } } },
    { type: 5, data: { tag: 'lens-end', payload: {} }, timestamp: at + 2000 },
  ];
  const recording = path.join(dir, 'recording.json');
  const times = path.join(dir, 'times.json');
  fs.writeFileSync(recording, JSON.stringify(events));
  fs.writeFileSync(times, JSON.stringify([at + 500, at + 1500]));
  const { stills } = require('../src/review-video.cjs');
  await stills(tools, recording, times, dir);
  const png = fs.readFileSync(path.join(dir, 'screenshot.png'));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 800);
  for (const n of [0, 1]) {
    const webp = fs.readFileSync(path.join(dir, `shot-${n}.webp`));
    assert.equal(webp.toString('ascii', 0, 4) + webp.toString('ascii', 8, 12), 'RIFFWEBP');
  }
});

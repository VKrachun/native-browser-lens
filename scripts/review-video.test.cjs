const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeVoice } = require('../src/review-video.cjs');

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

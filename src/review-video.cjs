// Runs locally against one frozen rrweb recording. The browser has a fresh, offline context.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { pipeline } = require('node:stream/promises');

const FRAME_MS = 100;
// The daemon passes the FFmpeg it found: a service on macOS has no Homebrew folder on its PATH.
const FFMPEG = process.env.LENS_FFMPEG || 'ffmpeg';
const SAMPLES_PER_MS = 16; // Lens microphone WAVs are mono 16 kHz signed 16-bit PCM.

// Where a 16 kHz mono 16-bit WAV's samples start. Chunks such as LIST may come before them, so the
// chunks are walked, as speech.rs does.
function wavData(fd) {
  const header = Buffer.alloc(4096);
  const read = fs.readSync(fd, header, 0, header.length, 0);
  const fail = () => { throw new Error('Cannot read the recorded microphone WAV.'); };
  if (read < 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') fail();
  let format = false;
  for (let at = 12; at + 8 <= read;) {
    const id = header.toString('ascii', at, at + 4);
    const length = header.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      format = body + 16 <= read && header.readUInt16LE(body) === 1 && header.readUInt16LE(body + 2) === 1 &&
        header.readUInt32LE(body + 4) === 16000 && header.readUInt16LE(body + 14) === 16;
      if (!format) fail();
    } else if (id === 'data' && format) {
      return body;
    }
    at = body + length + (length & 1);
  }
  fail();
}

// Compose the soundtrack on the same clock as frames(). Pad the last frame of each
// interval with silence so many short cuts cannot make the narration drift.
function writeVoice(spans, tracks, output) {
  const inputs = tracks.filter(track => spans.some(({ from, to }) =>
    Math.max(from, track.start) < Math.min(to, track.start + track.duration)));
  if (!inputs.length) return false;

  const destination = fs.openSync(output, 'wx', 0o600);
  const sources = [];
  try {
    for (const track of inputs) {
      const fd = fs.openSync(track.path, 'r');
      sources.push({ ...track, fd, data: wavData(fd) });
    }
    for (const { from, to } of spans) {
      const renderedMs = FRAME_MS * Math.max(1, Math.ceil((to - from) / FRAME_MS));
      for (let at = from; at < from + renderedMs; at += 1000) {
        const length = Math.min(1000, from + renderedMs - at) * SAMPLES_PER_MS;
        const mix = new Int32Array(length);
        for (const track of sources) {
          const first = Math.max(at, track.start);
          const last = Math.min(at + 1000, to, track.start + track.duration);
          if (first >= last) continue;
          const pcm = Buffer.alloc((last - first) * SAMPLES_PER_MS * 2);
          const position = track.data + (first - track.start) * SAMPLES_PER_MS * 2;
          if (fs.readSync(track.fd, pcm, 0, pcm.length, position) !== pcm.length)
            throw new Error('The microphone WAV ended before the reviewed interval.');
          const offset = (first - at) * SAMPLES_PER_MS;
          for (let i = 0; i < pcm.length / 2; i++) mix[offset + i] += pcm.readInt16LE(i * 2);
        }
        const pcm = Buffer.alloc(length * 2);
        for (let i = 0; i < length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, mix[i])), i * 2);
        fs.writeFileSync(destination, pcm);
      }
    }
    return true;
  } finally {
    fs.closeSync(destination);
    for (const track of sources) fs.closeSync(track.fd);
  }
}

// The bundled player and its browser, for one recording: offline, every request aborted, and a
// deny-by-default CSP, so recorded pages (untrusted) reach neither the network nor the disk.
async function open(tools, events) {
  const load = createRequire(path.join(tools, 'package.json'));
  let chromium, playerDir;
  try {
    ({ chromium } = load('playwright-core'));
    playerDir = path.dirname(load.resolve('rrweb-player'));
  } catch {
    throw new Error('Install the optional video tools: npm install --prefix "' + tools + '" playwright-core@1.65.0 rrweb-player@2.2.2');
  }
  if (!events.some(e => e.type === 2) || events.length < 2) throw new Error('The reviewed recording has no replayable snapshot.');
  const view = events.find(e => e.type === 4 && e.data.width > 0 && e.data.height > 0)?.data;
  const scale = view ? Math.min(1, 1600 / view.width, 1000 / view.height) : 1;
  const even = n => Math.max(2, 2 * Math.round(n / 2));
  const viewport = { width: even((view?.width || 1280) * scale), height: even((view?.height || 720) * scale) };
  // Recorded pages are untrusted: the renderer keeps Chromium's process sandbox on every system.
  const browser = await chromium.launch({ chromiumSandbox: true }).catch(error => {
    throw new Error(`Chromium did not start with its sandbox, so Lens did not render the replay: ${error.message}`);
  });
  try {
    const context = await browser.newContext({ viewport, offline: true, serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; frame-src about:"><style>body{margin:0;background:#fff;overflow:hidden}</style>');
    await page.addStyleTag({ path: path.join(playerDir, 'style.css') });
    // evaluate the bundled library separately from the untrusted event data.
    await page.evaluate(fs.readFileSync(path.join(playerDir, 'rrweb-player.umd.cjs'), 'utf8'));
    const epoch = new Date('2020-01-01T00:00:00Z');
    await page.clock.install({ time: epoch });
    await page.clock.pauseAt(new Date(+epoch + 1000));
    await page.evaluate(({ events, viewport }) => {
      window.player = new rrwebPlayer({ target: document.body, props: {
        ...viewport, events, autoPlay: false, showController: false, skipInactive: false,
        loadTimeout: 0, UNSAFE_replayCanvas: false,
      } });
    }, { events, viewport });
    return { browser, context, page, start: events[0].timestamp, end: events.at(-1).timestamp };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function render(tools, recording, ranges, output) {
  if (spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status !== 0) throw new Error('Install FFmpeg to save an MP4.');
  const events = JSON.parse(fs.readFileSync(recording, 'utf8'));
  const { browser, page, start, end } = await open(tools, events);
  try {
    const { kept, voice } = JSON.parse(fs.readFileSync(ranges, 'utf8'));
    const spans = (kept.length ? kept : [{ from: start, to: end }])
      .map(({ from, to }) => ({ from: Math.max(start, from), to: Math.min(end, to) }))
      .filter(({ from, to }) => from <= to);
    if (!spans.length) throw new Error('No kept frames in this recording.');
    const pcm = path.join(path.dirname(ranges), 'voice.s16le');
    const hasVoice = writeVoice(spans, voice, pcm);
    // Each kept interval starts with a seek. The recorder clock cannot advance while encoding a frame.
    async function* frames() {
      for (const { from, to } of spans) {
        await page.evaluate(offset => window.player.goto(offset, true), from - start);
        for (let at = from; at < Math.max(to, from + 1); at += FRAME_MS) {
          yield await page.screenshot({ type: 'jpeg', quality: 87, timeout: 15000 });
          if (at + FRAME_MS < to) await page.clock.runFor(FRAME_MS);
        }
      }
    }
    // FFmpeg 9 no longer guesses the codec of a piped image stream.
    const encoder = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg',
      '-framerate', String(1000 / FRAME_MS), '-i', 'pipe:0',
      ...(hasVoice ? ['-f', 's16le', '-ar', '16000', '-ac', '1', '-i', pcm, '-map', '0:v:0', '-map', '1:a:0',
        '-c:a', 'aac', '-b:a', '64k'] : ['-an']), '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-f', 'mp4', output], { stdio: ['pipe', 'ignore', 'inherit'] });
    try {
      const [[code]] = await Promise.all([once(encoder, 'close'), pipeline(frames(), encoder.stdin)]);
      if (code !== 0) throw new Error('FFmpeg could not encode the replay.');
    } finally {
      encoder.kill();
    }
  } finally {
    await browser.close();
  }
}

// Still pictures from the replay, for a browser that could not take screenshots (Firefox without
// access to all sites): `screenshot.png` at the end of the recording, and `shot-N.webp` at each time
// in `times` (Unix ms), as the extension's own step shots are.
async function stills(tools, recording, times, output) {
  const events = JSON.parse(fs.readFileSync(recording, 'utf8'));
  const at = JSON.parse(fs.readFileSync(times, 'utf8'));
  const { browser, context, page, start, end } = await open(tools, events);
  try {
    // A screenshot shows the page, not the replay's drawn pointer.
    await page.addStyleTag({ content: '.replayer-mouse,.replayer-mouse-tail{display:none!important}' });
    const still = async time => {
      await page.evaluate(offset => window.player.goto(offset, false), Math.min(end, Math.max(start, time)) - start);
      return page.screenshot({ type: 'png', timeout: 15000 });
    };
    fs.writeFileSync(path.join(output, 'screenshot.png'), await still(end));
    // WebP like the browser's step shots; a blank page of its own encodes it, apart from the replay.
    const encoder = await context.newPage();
    for (const [n, time] of at.entries()) {
      const png = (await still(time)).toString('base64');
      const webp = await encoder.evaluate(async png => {
        const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + png)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.7 });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
      }, png);
      fs.writeFileSync(path.join(output, `shot-${n}.webp`), Buffer.from(webp, 'base64'));
    }
  } finally {
    await browser.close();
  }
}

module.exports = { writeVoice, wavData, stills };
if (require.main === module) (process.argv[2] === '--stills' ? stills(...process.argv.slice(3)) : render(...process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });

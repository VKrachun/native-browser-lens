// Runs locally against one frozen rrweb recording. The browser has a fresh, offline context.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { pipeline } = require('node:stream/promises');

async function render(tools, recording, ranges, output) {
  const load = createRequire(path.join(tools, 'package.json'));
  let chromium, playerDir;
  try {
    ({ chromium } = load('playwright-core'));
    playerDir = path.dirname(load.resolve('rrweb-player'));
  } catch {
    throw new Error('Install the optional video tools: npm install --prefix "' + tools + '" playwright-core@1.65.0 rrweb-player@2.2.2');
  }
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) throw new Error('Install FFmpeg to save an MP4.');
  const events = JSON.parse(fs.readFileSync(recording, 'utf8'));
  if (!events.some(e => e.type === 2) || events.length < 2) throw new Error('The reviewed recording has no replayable snapshot.');
  const view = events.find(e => e.type === 4 && e.data.width > 0 && e.data.height > 0)?.data;
  const scale = view ? Math.min(1, 1600 / view.width, 1000 / view.height) : 1;
  const even = n => Math.max(2, 2 * Math.round(n / 2));
  const viewport = { width: even((view?.width || 1280) * scale), height: even((view?.height || 720) * scale) };
  const start = events[0].timestamp;
  const end = events.at(-1).timestamp;
  const kept = JSON.parse(fs.readFileSync(ranges, 'utf8'));
  const spans = (kept.length ? kept : [{ from: start, to: end }])
    .map(({ from, to }) => ({ from: Math.max(start, from), to: Math.min(end, to) }))
    .filter(({ from, to }) => from <= to);
  if (!spans.length) throw new Error('No kept frames in this recording.');
  const browser = await chromium.launch({ chromiumSandbox: process.platform === 'linux' });
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
    // Each kept interval starts with a seek. The recorder clock cannot advance while encoding a frame.
    async function* frames() {
      for (const { from, to } of spans) {
        await page.evaluate(offset => window.player.goto(offset, true), from - start);
        for (let at = from; at < Math.max(to, from + 1); at += 100) {
          yield await page.screenshot({ type: 'jpeg', quality: 87, timeout: 15000 });
          if (at + 100 < to) await page.clock.runFor(100);
        }
      }
    }
    const encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe',
      '-framerate', '10', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p',
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
render(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

// The product screenshots on lens.sirv.studio: a demo store whose coupon breaks the total, recorded
// with a spoken description, then the panel, the replay editor, the annotate editor and the review
// page with its filing. Fictional content in a temporary LENS_HOME; Claude is a stand-in, Whisper
// is real when the speech program and model are there, and the voice is espeak-ng.
//   (cd extension && LENS_E2E=1 pnpm build) && cargo build
//   LENS_SPEECH_DIR=~/.local/bin LENS_SPEECH_MODELS=~/.local/share/sirv-lens/models node site/screenshots.mjs
// Writes site/public/assets/shot-*.webp (2x, cwebp -q 90); the raw PNGs stay in the temp folder.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const { chromium } = createRequire(join(root, 'extension', 'package.json'))('playwright-core');
const assets = join(root, 'site', 'public', 'assets');
const target = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: root })).target_directory;
const bin = join(target, 'debug', 'lens');
const extension = join(root, 'extension', '.output', 'chrome-mv3');
const id = 'cggibhoaigdeemmdlfcncfkmoknndbfd';
const work = mkdtempSync(join(tmpdir(), 'lens-site-shots-'));
const raw = join(work, 'raw');
mkdirSync(raw);

// The voice: what a tester says while the bug happens.
const voice = join(work, 'voice.wav');
try {
  execFileSync('espeak-ng', ['-v', 'en-us', '-s', '140', '-w', join(work, 'say.wav'),
    'Okay. I apply the coupon, SAVE twenty. And now the total is broken. It should be one hundred and eight dollars. The price request fails, too.']);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(work, 'say.wav'), '-af', 'adelay=1500,apad=pad_dur=2', '-ar', '48000', '-ac', '1', voice]);
} catch {
  throw new Error('espeak-ng and ffmpeg make the voice: install them');
}

// Claude stand-in: the title and findings a model would write for this recording.
const fakeClaude = join(work, 'claude');
writeFileSync(fakeClaude, `#!/usr/bin/env node
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
let input = ''; process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const structured_output = input.includes('Existing open tasks') ? { duplicates: [] }
    : { title: 'Checkout: total shows NaN after the SAVE20 coupon',
        findings: ['After the coupon SAVE20, the total shows $NaN instead of $108.00', 'POST /api/price returns 500: "price is NaN"'],
        tags: ['checkout', 'bug'], issues: [] };
  console.log(JSON.stringify({ type: 'result', is_error: false, structured_output }));
});
`, { mode: 0o755 });

// The demo store: a checkout whose coupon request fails and leaves NaN in the total.
const items = [
  ['Trail Runner X', 'Size 42 · Slate', 96, '#ff8a5b', '#d9481f'],
  ['Merino Hiking Socks', '2 pairs · Charcoal', 24, '#7aa7ff', '#2f5fd6'],
  ['Canyon Bottle 750 ml', 'Sage', 15, '#86d6a8', '#1f9a63'],
];
const store = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Checkout · Juniper Outfitters</title><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2a24;background:#f6f5f1}
header{display:flex;align-items:center;gap:28px;padding:0 36px;height:62px;background:#fff;border-bottom:1px solid #e7e4dc}
.logo{font-weight:800;font-size:17px;letter-spacing:-.01em;display:flex;gap:9px;align-items:center}.logo i{width:22px;height:22px;border-radius:50% 50% 50% 4px;background:#2e5e46;display:inline-block}
nav a{color:#5d665f;text-decoration:none;margin-right:20px;font-size:14px}
.cart{margin-left:auto;font-size:14px;color:#5d665f}
main{display:grid;grid-template-columns:1.25fr 1fr;gap:28px;padding:30px 36px;max-width:1080px}
h1{font-size:24px;margin:0 0 18px;letter-spacing:-.01em}h2{font-size:16px;margin:0 0 14px}
.box{background:#fff;border:1px solid #e7e4dc;border-radius:14px;padding:20px}
.item{display:grid;grid-template-columns:64px 1fr auto;gap:14px;align-items:center;padding:12px 0;border-top:1px solid #efece5}.item:first-of-type{border-top:0}
.thumb{width:64px;height:64px;border-radius:10px}.item b{display:block}.item span{color:#6b746d;font-size:13px}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
input{width:100%;padding:10px 12px;border:1px solid #d9d5cb;border-radius:9px;font:inherit;background:#fff}
.row{display:flex;gap:8px}.row input{flex:1}
button{font:600 14px system-ui;border-radius:9px;padding:10px 16px;border:1px solid #d9d5cb;background:#fff;cursor:pointer}
button.pay{width:100%;margin-top:18px;padding:13px;background:#2e5e46;color:#fff;border-color:#2e5e46;font-size:15px}
.sum{display:flex;justify-content:space-between;padding:6px 0;color:#4d564f}.sum.total{border-top:1px solid #efece5;margin-top:8px;padding-top:12px;font-weight:800;font-size:19px;color:#1f2a24}
.applied{color:#2e5e46;font-size:13px;margin-top:6px;min-height:20px}
.demo{position:fixed;right:14px;bottom:10px;font-size:11px;color:#a29d90}
</style></head><body>
<header><span class="logo"><i></i>Juniper Outfitters</span><nav><a href="#">Shoes</a><a href="#">Clothing</a><a href="#">Camp</a></nav><span class="cart">Cart · 3</span></header>
<main><section><h1>Checkout</h1><div class="box"><h2>Your order</h2>${items
  .map(([name, sub, price, a, b]) => `<div class="item"><div class="thumb" style="background:linear-gradient(135deg,${a},${b})"></div><div><b>${name}</b><span>${sub}</span></div><strong>$${price}.00</strong></div>`)
  .join('')}</div></section>
<section><div class="box"><h2>Payment</h2>
<div class="sum"><span>Subtotal</span><span>$135.00</span></div><div class="sum"><span>Shipping</span><span>Free</span></div>
<div class="sum total"><span>Total</span><span data-testid="total">$135.00</span></div>
<label for="coupon">Coupon</label><div class="row"><input id="coupon" name="coupon" autocomplete="off"><button id="apply">Apply</button></div><div class="applied" id="applied"></div>
<label for="card">Card number</label><input id="card" name="card" autocomplete="off">
<button class="pay">Pay</button></div></section></main><span class="demo">Demo store</span>
<script>
document.getElementById('apply').onclick = async () => {
  const coupon = document.getElementById('coupon').value;
  document.getElementById('applied').textContent = coupon + ' applied: 20% off';
  const r = await fetch('/api/price', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ coupon }) });
  const price = (await r.json()).total;
  if (!r.ok) console.error('price request failed', r.status);
  document.querySelector('[data-testid=total]').textContent = '$' + Number(price).toFixed(2);
};
</script></body></html>`;
// Chromium sends shop.juniper.test through this server as a proxy: the shots show a real-looking
// address instead of 127.0.0.1 and a port.
const site = createServer((req, res) => {
  const path = req.url.startsWith('http') ? new URL(req.url).pathname : req.url;
  if (path === '/api/price') {
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'price is NaN' }));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(store);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const origin = 'http://shop.juniper.test';

const env = {
  ...process.env,
  LENS_HOME: join(work, 'lens'),
  HOME: join(work, 'home'),
  XDG_CONFIG_HOME: join(work, 'config'),
  LENS_CLAUDE_BINARY: fakeClaude,
  LENS_CODEX_BINARY: join(work, 'no'),
};
const profile = join(env.XDG_CONFIG_HOME, 'chromium');
mkdirSync(profile, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  ...(existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : { channel: 'chromium' }),
  headless: true,
  env,
  deviceScaleFactor: 2,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${voice}%noloop`,
    `--proxy-server=http://127.0.0.1:${site.address().port}`,
    '--proxy-bypass-list=127.0.0.1;localhost',
  ],
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name, options = {}) => page.screenshot({ path: join(raw, `${name}.png`), ...options });
try {
  execFileSync(bin, ['register'], { env, stdio: 'ignore' });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const shop = await context.newPage();
  await shop.setViewportSize({ width: 1000, height: 760 });
  await shop.goto(`${origin}/checkout`);
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0]?.id, origin);

  const panel = await context.newPage();
  await panel.setViewportSize({ width: 380, height: 760 });
  await panel.goto(`chrome-extension://${id}/sidepanel.html?tab=${tabId}`);
  await panel.getByRole('status', { name: 'Connection' }).filter({ hasText: /^Connected/ }).waitFor({ timeout: 20_000 });
  const onboarding = panel.getByRole('region', { name: 'Default destination' });
  await onboarding.getByLabel('Destination', { exact: true }).selectOption('linear');
  await onboarding.getByRole('button', { name: 'Save default' }).click();
  await onboarding.waitFor({ state: 'detached' });
  await panel.getByRole('button', { name: 'Collect evidence on this site' }).click();
  await panel.getByText('Collecting network, console and errors').waitFor({ timeout: 15_000 });
  // The setup card is for first runs; a product shot shows the panel in use.
  await panel.addStyleTag({ content: '[aria-label="Setup"]{display:none !important}' });
  // The bug once, before any recording: a capture keeps it, and the annotate editor marks it.
  await shop.getByLabel('Coupon').fill('SAVE20');
  await Promise.all([shop.waitForResponse(`${origin}/api/price`), shop.getByRole('button', { name: 'Apply' }).click()]);
  await shop.getByLabel('Card number').fill('4242424242424242');
  await wait(800);
  // The annotate editor: a capture of the store, a box around the total and a mask on the card.
  await panel.getByRole('tab', { name: 'Capture' }).click();
  await panel.getByRole('button', { name: 'Capture to a new observation' }).click();
  const capture = panel.getByRole('region', { name: 'Observation' });
  await capture.getByRole('button', { name: /^Open the recording, Capture/ }).waitFor({ timeout: 20_000 });
  const [editor] = await Promise.all([context.waitForEvent('page'), capture.getByRole('button', { name: /Annotate capture/ }).click()]);
  await editor.setViewportSize({ width: 1280, height: 820 });
  const canvas = editor.locator('canvas').first();
  await canvas.waitFor({ timeout: 15_000 });
  await wait(800);
  const box = await canvas.boundingBox();
  // The canvas shows the 1000x760 store page scaled to its box.
  const at = (x, y) => [box.x + (x / 1000) * box.width, box.y + (y / 760) * box.height];
  const drag = async ([x1, y1], [x2, y2]) => {
    await editor.mouse.move(x1, y1);
    await editor.mouse.down();
    await editor.mouse.move(x2, y2, { steps: 6 });
    await editor.mouse.up();
  };
  const totalBox = await shop.getByTestId('total').boundingBox();
  const cardBox = await shop.getByLabel('Card number').boundingBox();
  await drag(at(totalBox.x - 140, totalBox.y - 10), at(totalBox.x + totalBox.width + 12, totalBox.y + totalBox.height + 10));
  await editor.getByRole('button', { name: 'Mask' }).click();
  await drag(at(cardBox.x, cardBox.y), at(cardBox.x + cardBox.width, cardBox.y + cardBox.height));
  await wait(500);
  await shot(editor, 'annotate');
  await editor.getByRole('button', { name: 'Save' }).click();
  await editor.getByRole('status').filter({ hasText: /Saved/ }).waitFor({ timeout: 15_000 });
  await editor.close();
  await panel.goto(`chrome-extension://${id}/sidepanel.html?tab=${tabId}`);
  await panel.getByRole('status', { name: 'Connection' }).filter({ hasText: /^Connected/ }).waitFor({ timeout: 20_000 });
  await panel.addStyleTag({ content: '[aria-label="Setup"]{display:none !important}' });

  // A fresh page for the recorded session.
  await shop.reload();
  await panel.getByRole('tab', { name: 'Record' }).click();
  await panel.getByLabel('Record my voice').check();
  await panel.getByRole('button', { name: 'Record', exact: true }).click();
  await panel.getByRole('status', { name: 'Recording' }).waitFor({ timeout: 15_000 });

  // The session, in step with the voice.
  await wait(1500);
  await shop.getByLabel('Coupon').pressSequentially('SAVE20', { delay: 120 });
  await wait(800);
  await shop.getByRole('button', { name: 'Apply' }).click();
  await wait(4000);
  await shop.getByTestId('total').hover();
  await wait(4000);
  await shop.getByLabel('Card number').pressSequentially('4242424242424242', { delay: 40 });
  await wait(1500);
  await shop.screenshot({ path: join(raw, 'store.png') });
  await shot(panel, 'panel-recording');
  await wait(6000);

  const [review] = await Promise.all([context.waitForEvent('page'), panel.getByRole('button', { name: /^Stop/ }).click()]);
  await review.setViewportSize({ width: 1280, height: 900 });
  const form = review.getByRole('region', { name: 'Title and findings' });
  await form.getByLabel('Title', { exact: true }).waitFor({ timeout: 30_000 });
  await review.getByRole('status', { name: 'Summary' }).filter({ hasText: /wrote the title/ }).waitFor({ timeout: 60_000 });

  // The replay editor: captions from the voice, a drawing on the total with a note.
  const [studio] = await Promise.all([context.waitForEvent('page'), review.getByRole('link', { name: /^Open replay and transcript/ }).click()]);
  await studio.setViewportSize({ width: 1440, height: 1000 });
  await studio.getByRole('region', { name: 'Recording editor' }).waitFor({ timeout: 30_000 });
  if (process.env.LENS_SPEECH_MODELS && process.env.LENS_SPEECH_DIR) {
    await studio.getByRole('region', { name: 'What happened' }).getByText(/coupon/i).first().waitFor({ timeout: 180_000 });
  }
  await studio.getByRole('button', { name: 'Draw' }).click();
  await studio.evaluate(() => scrollTo(0, 0));
  const total = await studio.frameLocator('.stage iframe').getByTestId('total').boundingBox();
  if (total) {
    const [cx, cy, rx, ry] = [total.x + total.width / 2, total.y + total.height / 2, total.width / 2 + 16, total.height / 2 + 10];
    await studio.mouse.move(cx + rx, cy);
    await studio.mouse.down();
    for (let a = 0; a <= 2 * Math.PI + 0.3; a += 0.25) await studio.mouse.move(cx + rx * Math.cos(a), cy + ry * Math.sin(a), { steps: 2 });
    await studio.mouse.up();
    await studio.getByRole('button', { name: 'Done drawing' }).click();
    const draft = studio.getByRole('dialog', { name: 'New note' });
    await draft.getByLabel('Note').fill('Total turns into $NaN after the coupon');
    await draft.getByRole('button', { name: 'Add note' }).click();
  }
  // A frame after the coupon: the total is broken and the caption says so.
  const line = await studio.getByLabel('Timeline').boundingBox();
  await studio.mouse.click(line.x + line.width * 0.42, line.y + line.height / 2);
  await wait(1500);
  await studio.getByRole('status', { name: 'Edits' }).filter({ hasText: /Saved/ }).waitFor({ timeout: 15_000 }).catch(() => {});
  await studio.evaluate(() => scrollTo(0, 0));
  await studio.getByRole('region', { name: 'Recording editor' }).screenshot({ path: join(raw, 'editor.png') });

  // The review page: title, findings, notes, the steps.
  await review.bringToFront();
  await review.reload();
  await form.getByLabel('Title', { exact: true }).waitFor({ timeout: 30_000 });
  await wait(1500);
  await review.evaluate(() => scrollTo(0, 0));
  await shot(review, 'review');

  // Filing: freeze the review, then the tracker and the agent hand-off.
  await review.getByRole('button', { name: 'Create review' }).click();
  const handoff = review.getByRole('region', { name: 'Hand off' });
  if (await handoff.waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
    await handoff.getByLabel('Project folder').fill('~/projects/juniper-store');
    const then = review.getByLabel(/^Then hand off to /);
    if (await then.count()) await then.check();
  }
  await wait(1200);
  await shot(review, 'file-full', { fullPage: true });

  // Crop to the UI that matters and write WebP at 2x.
  const magick = (...args) => execFileSync('magick', args);
  const png = (name) => join(raw, `${name}.png`);
  magick(png('store'), '(', '-size', '2x1520', 'xc:#d4d4d8', ')', png('panel-recording'), '+append', png('record'));
  magick(png('editor'), '-crop', '2784x1880+0+0', '+repage', png('editor'));
  magick(png('annotate'), '-crop', '2560x1720+0+0', '+repage', png('annotate'));
  for (const name of ['review', 'file-full']) {
    magick(png(name), '-fuzz', '2%', '-trim', '+repage', '-bordercolor', 'white', '-border', '40', png(name));
  }
  for (const [from, to] of [['record', 'record'], ['review', 'review'], ['editor', 'replay'], ['annotate', 'annotate'], ['file-full', 'file']]) {
    execFileSync('cwebp', ['-quiet', '-q', '90', '-m', '6', png(from), '-o', join(assets, `shot-${to}.webp`)]);
  }
  console.log(`shot-*.webp in ${assets}; raw shots in ${raw}`);
} finally {
  await context.close();
  site.close();
  try {
    execFileSync(bin, ['stop'], { env, stdio: 'ignore' });
  } catch {}
}

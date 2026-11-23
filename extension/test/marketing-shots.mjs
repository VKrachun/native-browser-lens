// Product screenshots for the website and the store listings: a styled demo asset library with a
// real defect, recorded with a spoken description, then the editor and the review page. Fictional
// content; Claude and VibeQ are stand-ins, Whisper is real when the speech environment is set.
//   LENS_E2E=1 pnpm build && LENS_SPEECH_MODELS=… LENS_SPEECH_DIR=… node test/marketing-shots.mjs <folder> <voice.wav>
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'marketing-shots');
const voice = resolve(process.argv[3] ?? join(import.meta.dirname, 'fixtures', 'speech.wav'));
mkdirSync(out, { recursive: true });
const root = resolve(import.meta.dirname, '../..');
const target = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: root })).target_directory;
const bin = join(target, 'debug', 'lens');
const extension = resolve(import.meta.dirname, '../.output/chrome-mv3');
const id = 'cggibhoaigdeemmdlfcncfkmoknndbfd';
const work = mkdtempSync(join(tmpdir(), 'lens-shots-'));

// Claude stand-in: a summary of the demo defect, and one duplicate for the duplicate check.
const fakeClaude = join(work, 'claude');
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
let input = ''; process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const structured_output = input.includes('Existing open tasks')
    ? { duplicates: [{ id: 'task-41', reason: 'Same Export failure on the asset page (POST /api/export returns 500)' }] }
    : { title: 'Assets: Export does nothing (HTTP 500); NEW badge on an archived asset',
        findings: ['Export does nothing on the Trail Runner X asset: POST /api/export returns 500', 'The NEW badge shows on an archived asset'],
        tags: ['assets', 'bug'], issues: [] };
  console.log(JSON.stringify({ type: 'result', is_error: false, structured_output }));
});
`,
  { mode: 0o755 },
);

// VibeQ stand-in: sign-in, the member, and a similar open task.
const vibeq = createServer((req, res) => {
  const json = (status, value) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(value)));
  if (req.url.startsWith('/auth/mcp-token')) {
    return /session=demo/.test(req.headers.cookie ?? '') ? json(200, { token: 'demo-token', kind: 'mcp' }) : json(401, {});
  }
  if (req.headers.authorization !== 'Bearer demo-token') return json(403, {});
  if (req.url === '/auth/me') return json(200, { id: 'member-1', name: 'Alex Kim' });
  if (req.url === '/api/members') return json(200, [{ id: 'member-2', name: 'Sam Rivera' }]);
  if (req.url.startsWith('/api/tasks/similar?')) {
    return json(200, { results: [{ id: 'task-41', title: 'Export button fails on asset page', status: 'todo', description: 'Export returns 500', similarity: 0.5 }] });
  }
  json(404, {});
});
await new Promise((r) => vibeq.listen(0, '127.0.0.1', r));
const vibeqOrigin = `http://127.0.0.1:${vibeq.address().port}`;

// The demo site: an asset library whose Export fails and whose archived asset says NEW.
const thumb = (a, b) => `background:linear-gradient(135deg,${a},${b})`;
const assets = [
  ['Trail Runner X', 'Footwear · 24 images', thumb('#ff8a5b', '#e8431f'), 'NEW', 'Archived'],
  ['Summit Jacket', 'Outerwear · 18 images', thumb('#6aa8ff', '#2f5fd6'), '', 'Published'],
  ['Canyon Pack 30L', 'Bags · 31 images', thumb('#7ed6a5', '#1f9a63'), '', 'Published'],
  ['Ridge Cap', 'Accessories · 9 images', thumb('#f7c96b', '#d9922b'), '', 'Draft'],
  ['Basecamp Tent', 'Camping · 42 images', thumb('#b49cff', '#6d4fd8'), '', 'Published'],
  ['Alpine Bottle', 'Accessories · 12 images', thumb('#7fe0e6', '#1e9fb0'), '', 'Published'],
];
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Assets · Northwind</title><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d2433;background:#f5f6fa}
header{display:flex;align-items:center;gap:28px;padding:0 32px;height:60px;background:#fff;border-bottom:1px solid #e6e8ef}
.logo{font-weight:700;font-size:17px;display:flex;gap:9px;align-items:center}.logo i{width:22px;height:22px;border-radius:6px;background:#1d2433;display:inline-block}
nav a{color:#5b6475;text-decoration:none;margin-right:20px;font-size:14px}nav a.on{color:#1d2433;font-weight:600}
main{padding:28px 32px}h1{font-size:24px;margin:0 0 4px}.sub{color:#6b7385;margin:0 0 22px}
.bar{display:flex;gap:10px;margin-bottom:20px}.bar input{flex:1;max-width:340px;padding:9px 12px;border:1px solid #dcdfe7;border-radius:9px;font:inherit}
button{font:600 14px system-ui;border-radius:9px;padding:9px 16px;border:1px solid #dcdfe7;background:#fff;cursor:pointer}
button.primary{background:#1d2433;color:#fff;border-color:#1d2433}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.card{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.05),0 6px 18px -10px rgba(20,30,60,.25)}
.thumb{height:130px;position:relative}.badge{position:absolute;top:10px;left:10px;background:#fff;color:#e8431f;font:700 11px system-ui;padding:3px 8px;border-radius:99px}
.meta{padding:12px 14px;display:flex;justify-content:space-between;align-items:center}.meta b{display:block;font-size:15px}.meta span{color:#6b7385;font-size:13px}
.state{font-size:12px;padding:3px 9px;border-radius:99px;background:#eef0f5;color:#5b6475}
.detail{display:none;margin-top:22px;background:#fff;border-radius:14px;padding:20px;gap:18px;align-items:center;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.detail.open{display:flex}.detail .thumb{width:160px;height:110px;border-radius:10px}.detail h2{margin:0 0 4px;font-size:19px}.detail p{margin:0 0 12px;color:#6b7385}
.demo{position:fixed;right:14px;bottom:10px;font-size:11px;color:#9aa1b0}
</style></head><body>
<header><span class="logo"><i></i>Northwind</span><nav><a href="#">Home</a><a class="on" href="#">Assets</a><a href="#">Collections</a><a href="#">Reports</a></nav></header>
<main><h1>Assets</h1><p class="sub">6 products · updated today</p>
<div class="bar"><input aria-label="Search assets" placeholder="Search assets"><button>Filter</button><button class="primary">Upload</button></div>
<div class="grid">${assets
  .map(
    ([name, sub, bg, badge, state], i) =>
      `<div class="card" data-testid="asset-${i}"><div class="thumb" style="${bg}">${badge ? `<span class="badge">${badge}</span>` : ''}</div><div class="meta"><div><b>${name}</b><span>${sub}</span></div><span class="state">${state}</span></div></div>`,
  )
  .join('')}</div>
<section class="detail" aria-label="Asset"><div class="thumb" style="${assets[0][2]}"></div><div><h2>Trail Runner X</h2><p>Footwear · 24 images · Archived</p>
<button class="primary" onclick="fetch('/api/export',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({asset:'trail-runner-x'})}).then(r=>r.json()).then(j=>console.error('export failed',j.error))">Export</button> <button>Share</button></div></section>
</main><span class="demo">Demo site</span>
<script>document.querySelector('[data-testid=asset-0]').addEventListener('click',()=>document.querySelector('.detail').classList.add('open'))</script>
</body></html>`;
// Chromium sends app.northwind.test through this server as a proxy: the screenshots show a real
// looking address instead of 127.0.0.1 and a port. Paths arrive as absolute URLs.
const site = createServer((req, res) => {
  const path = req.url.startsWith('http') ? new URL(req.url).pathname : req.url;
  if (path === '/api/export') {
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'export worker unavailable' }));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const origin = 'http://app.northwind.test';

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
    // VibeQ's stand-in and the app stay direct.
    '--proxy-bypass-list=127.0.0.1;localhost',
  ],
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  execFileSync(bin, ['register'], { env, stdio: 'ignore' });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const shop = await context.newPage();
  await shop.setViewportSize({ width: 1040, height: 820 });
  await shop.goto(`${origin}/assets`);
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0]?.id, origin);

  // Sign in to the VibeQ stand-in, so the review page can look for duplicates.
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${id}/options.html`);
  await settings.getByLabel('VibeQ address').fill(vibeqOrigin);
  await settings.getByRole('button', { name: 'Sign in with VibeQ' }).click();
  await context.addCookies([{ name: 'session', value: 'demo', url: vibeqOrigin }]);
  await settings.getByRole('status', { name: 'VibeQ account' }).filter({ hasText: 'Alex Kim' }).waitFor({ timeout: 20_000 });
  await settings.close();

  const panel = await context.newPage();
  await panel.setViewportSize({ width: 380, height: 820 });
  await panel.goto(`chrome-extension://${id}/sidepanel.html?tab=${tabId}`);
  await panel.getByRole('status', { name: 'Connection' }).filter({ hasText: /^Connected/ }).waitFor({ timeout: 20_000 });
  await panel.getByRole('button', { name: 'Collect evidence on this site' }).click();
  await panel.getByText('Collecting network, console and errors').waitFor({ timeout: 15_000 });
  // The setup card is for first runs; a product shot shows the panel in use.
  await panel.addStyleTag({ content: '[aria-label="Setup"]{display:none !important}' });
  await panel.getByRole('button', { name: 'Record', exact: true }).click();
  await panel.getByRole('status', { name: 'Recording' }).waitFor({ timeout: 15_000 });

  // The session: open the asset, press Export, point at the badge, while the voice plays.
  await shop.mouse.move(200, 300, { steps: 8 });
  await wait(1200);
  await shop.getByTestId('asset-0').click();
  await wait(1500);
  await shop.getByRole('button', { name: 'Export' }).hover();
  await wait(800);
  await shop.getByRole('button', { name: 'Export' }).click();
  await wait(3500);
  await shop.locator('.badge').hover();
  await wait(3000);
  await shop.evaluate(() => scrollTo(0, 0));
  await wait(300);
  await shop.screenshot({ path: join(out, 'site-recording.png') });
  await panel.screenshot({ path: join(out, 'panel-recording.png') });
  await wait(2500);

  const [studio] = await Promise.all([context.waitForEvent('page'), panel.getByRole('button', { name: /^Stop/ }).click()]);
  await studio.setViewportSize({ width: 1440, height: 1000 });
  await studio.getByRole('region', { name: 'Recording editor' }).waitFor({ timeout: 30_000 });
  if (process.env.LENS_SPEECH_MODELS) {
    await studio.getByRole('region', { name: 'Transcript' }).getByText(/export/i).first().waitFor({ timeout: 180_000 });
  }
  await studio.getByRole('status', { name: 'Summary' }).filter({ hasText: /wrote the title/ }).waitFor({ timeout: 60_000 });
  await wait(1500);
  await studio.getByRole('region', { name: 'Recording editor' }).scrollIntoViewIfNeeded();
  // A frame from the middle: the asset open, the caption of the second sentence.
  const line = await studio.getByLabel('Timeline').boundingBox();
  await studio.mouse.click(line.x + line.width * 0.4, line.y + line.height / 2);
  await wait(1500);
  await studio.getByRole('region', { name: 'Recording editor' }).screenshot({ path: join(out, 'editor.png') });
  await studio.evaluate(() => scrollTo(0, 0));
  await studio.screenshot({ path: join(out, 'review-top.png') });

  await studio.getByRole('button', { name: 'Create review' }).click();
  await studio.getByRole('region', { name: 'Duplicates' }).getByText('Same problem').waitFor({ timeout: 60_000 });
  // The hand-off, set up as a person would before filing: the project folder and "Then hand off".
  const handoff = studio.getByRole('region', { name: 'Hand off' });
  if (await handoff.count()) {
    await handoff.getByLabel('Project folder').fill('/home/ana/projects/northwind');
    await studio.getByLabel(/^Then hand off to /).check();
  }
  await wait(800);
  await studio.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await studio.screenshot({ path: join(out, 'review-file.png') });
  await studio.evaluate(() => scrollTo(0, 0));
  await studio.screenshot({ path: join(out, 'review-filed-top.png') });
  console.log(`shots in ${out}`);
} finally {
  await context.close();
  site.close();
  vibeq.close();
  try {
    execFileSync(bin, ['stop'], { env, stdio: 'ignore' });
  } catch {}
}

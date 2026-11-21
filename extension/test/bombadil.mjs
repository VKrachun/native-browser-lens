// Property-based exploration of the extension pages with Bombadil (github.com/antithesishq/bombadil).
// The demo of marketing-shots.mjs makes a real recording; then Bombadil attaches to the same
// browser and clicks, types and reloads at random on each page, against the specs in ./bombadil.
//   LENS_E2E=1 pnpm build && cargo build && BOMBADIL=/path/to/bombadil node test/bombadil.mjs <out> [minutes per page] [page...]
// Pages: review, replay, panel, options. The daemon gets a PATH without real agents and URL handlers: a
// random click on Hand off must not start Codex, Claude Code or Zeron on this computer. Set
// LENS_SPEECH_MODELS, LENS_SPEECH_DIR and LENS_E2E_VIDEO_TOOLS as for check.sh to transcribe the
// voice and render MP4s.
//
// Bombadil 0.8.0 explores http, https and file pages only, and loses a new tab that changes
// process. bombadil/bombadil.patch adds chrome-extension:// pages and attaching to the tab that
// shows the page. Build it once (the terminal driver needs zig; this needs the browser only):
//   git clone https://github.com/antithesishq/bombadil && cd bombadil && git checkout c7bd61f3ec83
//   git apply <this folder>/bombadil/bombadil.patch
//   cargo build --release -p bombadil-cli --no-default-features   (a `trunk` on PATH, or a stub)
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'bombadil-runs');
const minutes = Number(process.argv[3] ?? 3);
const wanted = process.argv.slice(4).length ? process.argv.slice(4) : ['review', 'replay', 'panel', 'options'];
const bombadil = process.env.BOMBADIL ?? 'bombadil';
mkdirSync(out, { recursive: true });
const root = resolve(import.meta.dirname, '../..');
const target = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: root })).target_directory;
const bin = join(target, 'debug', 'lens');
const extension = resolve(import.meta.dirname, '../.output/chrome-mv3');
const specs = join(import.meta.dirname, 'bombadil');
const id = 'cggibhoaigdeemmdlfcncfkmoknndbfd';
const work = mkdtempSync(join(tmpdir(), 'lens-bombadil-'));

// Programs the daemon may find: system tools, node, and stand-ins that only log.
const fakeBin = join(work, 'bin');
mkdirSync(fakeBin);
const tool = (name, body) => writeFileSync(join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const node = execFileSync('sh', ['-c', 'command -v node']).toString().trim();
symlinkSync(node, join(fakeBin, 'node'));
tool('xdg-mime', 'exit 1');
// The service manager is the person's: a test must never reach their sirv-lens.service.
tool('systemctl', `echo "systemctl $*" >> "${work}/launched.log"; exit 1`);
tool('xdg-open', `echo "xdg-open $*" >> "${work}/launched.log"`);
tool('t3', `echo "t3 $*" >> "${work}/launched.log"; [ "$1 $2" = "thread start" ] && echo thread-1; exit 0`);
// Claude Code stand-in, signed in: a duplicate check, a draft (its schema names "markdown") or a
// summary with two problems, so Split has something to split. It never calls a model.
writeFileSync(
  join(fakeBin, 'claude'),
  `#!/usr/bin/env node
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const asked = input + process.argv.join(' ');
  const structured_output = asked.includes('Existing open tasks')
    ? { duplicates: [{ id: 'task-41', reason: 'Same Export failure' }] }
    : asked.includes('"markdown"')
      ? { markdown: '## What happened\\n\\nExport returns HTTP 500.', findings: [{ kind: 'hypothesis', text: 'The export worker is down', source: null }] }
      : { title: 'Assets: Export does nothing (HTTP 500)', findings: ['POST /api/export returns 500', 'The NEW badge shows on an archived asset'], tags: ['assets', 'bug'],
          issues: [
            { title: 'Export does nothing (HTTP 500)', findings: ['POST /api/export returns 500'], tags: ['export'], fromSeconds: null, toSeconds: null },
            { title: 'NEW badge on an archived asset', findings: ['The NEW badge shows on an archived asset'], tags: ['badge'], fromSeconds: null, toSeconds: null },
          ] };
  console.log(JSON.stringify({ type: 'result', is_error: false, structured_output }));
});
`,
  { mode: 0o755 },
);

// VibeQ stand-in, as in e2e.mjs: sign-in, members, a similar task, uploads, submissions with
// receipts, and Sirvant. Each submission gets its own task.
let filed = 0;
let sirvant = 0;
const submissions = new Map();
const vibeq = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const json = (status, value) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(value)));
    const url = req.url;
    if (url.startsWith('/auth/mcp-token')) {
      return /session=demo/.test(req.headers.cookie ?? '') ? json(200, { token: 'demo-token', kind: 'mcp' }) : json(401, {});
    }
    if (req.headers.authorization !== 'Bearer demo-token') return json(403, {});
    if (url === '/auth/me') return json(200, { id: 'member-1', name: 'Alex Kim' });
    if (url === '/api/members') return json(200, [{ id: 'member-2', name: 'Sam Rivera' }]);
    if (url.startsWith('/api/tasks/similar?')) {
      return json(200, { results: [{ id: 'task-41', title: 'Export button fails', status: 'todo', description: 'Export returns 500', similarity: 0.5 }] });
    }
    if (/^\/api\/agent\/tasks\/[^/]+\/river-work$/.test(url) && req.method === 'POST') {
      return json(++sirvant === 1 ? 201 : 409, { session: { id: `session-${sirvant}` } });
    }
    if (url === '/api/attachments/stage') return json(201, { stagedKey: `staged/member-1/${Math.random()}` });
    const found = url.match(/^\/api\/capture\/v1\/submissions\/(.+)$/);
    if (found) return submissions.has(found[1]) ? json(200, submissions.get(found[1])) : json(404, {});
    if (url === '/api/capture/v1/submissions' && req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const staged = new Set(body.stagedAttachments.map((s) => s.id));
      const missing = body.evidenceManifest.map((a) => a.id).filter((id) => !staged.has(id));
      const task = `task-${++filed}`;
      const receipt = {
        submissionId: body.submissionId, observationId: body.observationId, revision: body.revision,
        taskId: task, taskUrl: `http://vibeq.test/?task=${task}`, createdAt: Date.now(),
        attachmentStatus: missing.length ? 'partial' : 'complete', missingAttachments: missing,
      };
      submissions.set(body.submissionId, receipt);
      return json(201, receipt);
    }
    json(404, {});
  });
});
await new Promise((r) => vibeq.listen(0, '127.0.0.1', r));
const vibeqOrigin = `http://127.0.0.1:${vibeq.address().port}`;

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Assets · Northwind</title></head><body>
<h1>Assets</h1><label>Search <input name="q"></label><label>Card <input name="card"></label>
<div data-testid="asset-0" style="padding:20px;background:#eee">Trail Runner X <span class="badge">NEW</span></div>
<button onclick="fetch('/api/export',{method:'POST'}).then(r=>r.json()).then(j=>console.error('export failed',j.error))">Export</button>
</body></html>`;
const site = createServer((req, res) => {
  const path = req.url.startsWith('http') ? new URL(req.url).pathname : req.url;
  if (path === '/api/export') return (res.writeHead(500, { 'content-type': 'application/json' }), res.end('{"error":"export worker unavailable"}'));
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const origin = 'http://app.northwind.test';

const env = {
  ...process.env,
  PATH: `${fakeBin}:/usr/bin:/bin`,
  LENS_HOME: join(work, 'lens'),
  HOME: join(work, 'home'),
  XDG_CONFIG_HOME: join(work, 'config'),
  XDG_DATA_HOME: join(work, 'data'),
  LENS_CLAUDE_BINARY: join(fakeBin, 'claude'),
  LENS_CODEX_BINARY: join(work, 'no'),
  // HOME moves into the work folder: the MP4 renderer still needs the real Playwright browsers.
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright'),
};
const profile = join(env.XDG_CONFIG_HOME, 'chromium');
mkdirSync(profile, { recursive: true });
// The MP4 renderer's tools, as in e2e.mjs; without them Save replay as MP4 explains how to install them.
if (process.env.LENS_E2E_VIDEO_TOOLS) {
  mkdirSync(env.LENS_HOME, { recursive: true });
  symlinkSync(resolve(process.env.LENS_E2E_VIDEO_TOOLS), join(env.LENS_HOME, 'video-tools'));
}
const port = 9400 + Math.floor(Math.random() * 400);
const context = await chromium.launchPersistentContext(profile, {
  ...(existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : { channel: 'chromium' }),
  headless: true,
  env,
  args: [
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${join(import.meta.dirname, 'fixtures', 'speech.wav')}%noloop`,
    `--proxy-server=http://127.0.0.1:${site.address().port}`,
    '--proxy-bypass-list=127.0.0.1;localhost',
  ],
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
try {
  execFileSync(bin, ['register'], { env, stdio: 'ignore' });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const shop = await context.newPage();
  await shop.goto(`${origin}/assets`);
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0]?.id, origin);

  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${id}/options.html`);
  await settings.getByText('Other integrations', { exact: true }).click();
  await settings.getByLabel('VibeQ address').fill(vibeqOrigin);
  await settings.getByRole('button', { name: 'Sign in with VibeQ' }).click();
  await context.addCookies([{ name: 'session', value: 'demo', url: vibeqOrigin }]);
  await settings.getByRole('status', { name: 'VibeQ account' }).filter({ hasText: 'Alex Kim' }).waitFor({ timeout: 20_000 });
  // VibeQ as the default destination: the review page then offers File to VibeQ.
  await settings.getByLabel('Destination', { exact: true }).selectOption('vibeq');
  await settings.getByRole('button', { name: 'Save default' }).click();
  await settings.getByText('Default saved.').waitFor();
  await settings.close();

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html?tab=${tabId}`);
  await panel.getByRole('status', { name: 'Connection' }).filter({ hasText: /^Connected/ }).waitFor({ timeout: 20_000 });
  await panel.getByRole('button', { name: 'Collect evidence on this site' }).click();
  await panel.getByText('Collecting network, console and errors').waitFor({ timeout: 15_000 });
  await panel.getByRole('button', { name: 'Record', exact: true }).click();
  await panel.getByRole('status', { name: 'Recording' }).waitFor({ timeout: 15_000 });
  await shop.getByTestId('asset-0').click();
  await shop.getByLabel('Card').fill('4111 1111 1111 1111');
  await shop.getByRole('button', { name: 'Export' }).click();
  await wait(3000);
  const [studio] = await Promise.all([
    context.waitForEvent('page', { predicate: (p) => p.url().includes('/review.html'), timeout: 30_000 }),
    panel.getByRole('button', { name: /^Stop/ }).click(),
  ]);
  await studio.getByRole('status', { name: 'Summary' }).filter({ hasText: /wrote the title/ }).waitFor({ timeout: 60_000 }).catch(async (error) => {
    await studio.screenshot({ path: join(out, 'setup-failed.png') });
    throw new Error(`${studio.url()}: ${error.message}`);
  });
  const replay = await studio.getByRole('link', { name: /Open replay and transcript/ }).getAttribute('href');
  const urls = {
    review: studio.url(),
    replay: new URL(replay, studio.url()).href,
    panel: `chrome-extension://${id}/sidepanel.html?tab=${tabId}`,
    options: `chrome-extension://${id}/options.html`,
  };
  await studio.close();
  await panel.close();

  for (const name of wanted) {
    const trace = join(out, `${name}.trace`);
    const spec = process.env.LENS_BOMBADIL_SPEC ?? join(specs, 'common.ts');
    console.log(`\n== ${name}: ${minutes} min on ${urls[name]}`);
    // Bombadil drives a tab that already shows the page: a new tab that navigates to an extension
    // page changes process, and Bombadil then never sees the navigation end.
    const tab = await context.newPage();
    await tab.goto(urls[name]);
    // Async, so Playwright keeps reading the browser's events while Bombadil runs.
    const run = await new Promise((done) => {
      const child = spawn(
        bombadil,
        ['browser', 'test-external', '--remote-debugger', `http://127.0.0.1:${port}`,
          '--instrument-javascript', '', '--time-limit', `${minutes}m`,
          '--output-path', trace, '--output-path-overwrite', urls[name], spec],
        { stdio: 'inherit', env: process.env },
      );
      child.on('error', (error) => done({ status: null, error }));
      child.on('exit', (status) => done({ status }));
    });
    results.push(`${name}: exit ${run.status}${run.error ? ` (${run.error.message})` : ''}, trace ${trace}`);
    if (run.status !== 0) process.exitCode = 1;
    await tab.close().catch(() => {});
  }
} finally {
  await context.close().catch(() => {});
  site.close();
  vibeq.close();
  try {
    execFileSync(bin, ['stop'], { env, stdio: 'ignore' });
  } catch {}
  console.log(`\n${results.join('\n')}`);
  const launched = join(work, 'launched.log');
  console.log(existsSync(launched) ? `programs the daemon tried to start:\n${readFileSync(launched, 'utf8')}` : 'the daemon started no outside program');
  console.log(`tasks filed to the VibeQ stand-in: ${filed}; Sirvant calls: ${sirvant}; work folder ${work}`);
}

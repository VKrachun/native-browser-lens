// End to end: real Chromium + the built extension + `lens register` + the shim + lensd, against a
// local fixture site that fails the way real sites do.
//   LENS_E2E=1 pnpm build && pnpm test:e2e
// LENS_BIN and CHROMIUM_PATH override the binaries.
//
// macOS and Linux run in a temporary home: Chromium reads user-level hosts from
// <user-data-dir>/NativeMessagingHosts, and the profile is the folder `lens register` writes into.
// Windows reads hosts from HKCU, so there the test registers for the current user and unregisters
// at the end; run it on CI or a disposable account.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const targetDir = () =>
  JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: root })).target_directory;
const bin = process.env.LENS_BIN ?? join(targetDir(), 'debug', process.platform === 'win32' ? 'lens.exe' : 'lens');
const extension = resolve(import.meta.dirname, '../.output/chrome-mv3');
const extensionId = 'cggibhoaigdeemmdlfcncfkmoknndbfd';
const isolated = process.platform !== 'win32';

// A VibeQ that commits the first submission and then loses its reply, as a dropped connection does.
const vibeq = { submissions: new Map(), staged: 0, submits: 0, dropFirstReply: true, sirvant: [] };
const fakeVibeq = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const json = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const url = request.url;
    // VibeQ mints a personal token for whoever its session cookie names.
    if (url.startsWith('/auth/mcp-token')) {
      const signedIn = /(^|;\s*)session=e2e-session(;|$)/.test(request.headers.cookie ?? '');
      return signedIn ? json(200, { token: 'e2e-token', kind: 'mcp' }) : json(401, { error: 'Invalid session' });
    }
    if (request.headers.authorization !== 'Bearer e2e-token') return json(403, { error: 'personal_token_required' });
    if (url === '/auth/me') return json(200, { id: 'member-1', name: 'Tess Tester' });
    // VibeQ's title search for duplicates: one open task matches whatever is asked.
    if (url.startsWith('/api/tasks/similar?')) {
      return json(200, { results: [{ id: 'task-9', title: 'Checkout total is NaN', status: 'todo', description: 'NaN after Pay', similarity: 0.6 }] });
    }
    if (url === '/api/members') return json(200, [{ id: 'member-2', name: 'Ana' }]);
    // Sirvant, VibeQ's agent: the task page's "put to work" call. A second call finds the live run.
    if (url === '/api/agent/tasks/task-1/river-work' && request.method === 'POST') {
      vibeq.sirvant.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return json(vibeq.sirvant.length === 1 ? 201 : 409, { session: { id: 'session-1' } });
    }
    if (url === '/api/attachments/stage') return (vibeq.staged++, json(201, { stagedKey: `staged/member-1/${vibeq.staged}` }));
    const found = url.match(/^\/api\/capture\/v1\/submissions\/(.+)$/);
    if (found) return vibeq.submissions.has(found[1]) ? json(200, vibeq.submissions.get(found[1]).receipt) : json(404, {});
    if (url === '/api/capture/v1/submissions' && request.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      vibeq.submits++;
      const staged = new Set(body.stagedAttachments.map((s) => s.id));
      const missing = body.evidenceManifest.map((a) => a.id).filter((id) => !staged.has(id));
      const receipt = {
        submissionId: body.submissionId, observationId: body.observationId, revision: body.revision,
        taskId: 'task-1', taskUrl: 'http://vibeq.test/?task=task-1', createdAt: 1,
        attachmentStatus: missing.length ? 'partial' : 'complete', missingAttachments: missing,
      };
      vibeq.submissions.set(body.submissionId, { body, receipt });
      if (vibeq.dropFirstReply) return (vibeq.dropFirstReply = false), request.socket.destroy();
      return json(201, receipt);
    }
    json(404, {});
  });
});
await new Promise((ready) => fakeVibeq.listen(0, '127.0.0.1', ready));

const work = mkdtempSync(join(tmpdir(), 'lens-e2e-'));
// A stand-in for Claude Code: signed in, and it answers every summary with the same title. The
// test must never spend a real model call. Windows would need a .cmd; there no agent is found.
const fakeClaude = join(work, 'claude');
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  // A duplicate check names one existing task; every other call is a summary with two problems.
  const asked = input + process.argv.join(' ');
  const structured_output = asked.includes('Existing open tasks')
    ? { duplicates: [{ id: 'task-9', reason: 'The same NaN total after Pay' }] }
    : { title: 'Checkout: total shows NaN after Pay', findings: ['The total shows NaN after Pay', 'The coupon field accepts expired codes'], tags: ['Checkout', 'bug'],
        issues: [
          { title: 'Checkout total shows NaN after Pay', findings: ['The total shows NaN after Pay'], tags: ['checkout'], fromSeconds: null, toSeconds: null },
          { title: 'Coupon accepts expired codes', findings: ['The coupon field accepts expired codes'], tags: ['coupon'], fromSeconds: null, toSeconds: null },
        ] };
  console.log(JSON.stringify({ type: 'result', is_error: false, structured_output }));
});
`,
  { mode: 0o755 },
);
const summaries = process.platform !== 'win32';
// T3 Code's CLI, faked on PATH: it logs what Lens asks and knows the project only once it is added.
const fakeBin = join(work, 'bin');
const handoffProject = join(work, 'project');
if (summaries) {
  mkdirSync(handoffProject, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, 't3'),
    `#!/bin/sh
dir=$(dirname "$0")
echo "ARGS $*" >> "$dir/t3.log"
case "$1 $2" in
  "thread start")
    if [ -f "$dir/added" ]; then cat >> "$dir/t3.log"; echo thread-1
    else echo "No T3 Code project matches '$3'. Pass a project id or a path inside a project."; fi ;;
  "project add") touch "$dir/added" ;;
esac
`,
    { mode: 0o755 },
  );
}
const env = {
  ...process.env,
  LENS_HOME: join(work, 'lens'),
  LENS_VIBEQ_TOKEN: 'e2e-token',
  LENS_CLAUDE_BINARY: summaries ? fakeClaude : join(work, 'no-claude'),
  LENS_CODEX_BINARY: join(work, 'no-codex'),
  ...(isolated ? { HOME: join(work, 'home'), XDG_CONFIG_HOME: join(work, 'config') } : {}),
  ...(summaries ? { PATH: `${fakeBin}:${process.env.PATH}` } : {}),
};
const profile = {
  linux: () => join(env.XDG_CONFIG_HOME, 'chromium'),
  darwin: () => join(env.HOME, 'Library', 'Application Support', 'Chromium'),
  win32: () => join(work, 'profile'),
}[process.platform]();
mkdirSync(profile, { recursive: true });

// The fixture: a checkout whose price request fails with a body that holds a secret.
const priceRequests = [];
const fixture = createServer((request, response) => {
  if (request.url === '/api/price') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      priceRequests.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'price is NaN', token: 'fixture-secret-123' }));
    });
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><title>Checkout</title>
    <meta name="csrf-token" content="meta-csrf-555">
    <h1>Checkout</h1>
    <input type="hidden" name="csrf" value="hidden-csrf-777">
    <a href="/next?access_token=link-token-888">Next</a>
    <div contenteditable>draft-secret-999</div>
    <label>Coupon <input name="coupon"></label>
    <label>Card number <input name="card"></label>
    <p data-testid="total">Total: NaN</p>
    <button onclick="console.error('total is NaN'); fetch('/api/price', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ coupon: document.querySelector('[name=coupon]').value }) })">Pay</button>`);
});
await new Promise((ready) => fixture.listen(0, '127.0.0.1', ready));
const site = `http://127.0.0.1:${fixture.address().port}`;

const systemChromium = '/usr/bin/chromium';
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(systemChromium) ? systemChromium : undefined);
const context = await chromium.launchPersistentContext(profile, {
  // The `chromium` channel is the full browser in new headless mode; the headless shell cannot load extensions.
  ...(executablePath ? { executablePath } : { channel: 'chromium' }),
  headless: true,
  env,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    // A WAV file stands in for the microphone, and its prompt answers itself.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${join(import.meta.dirname, 'fixtures', 'speech.wav')}%noloop`,
  ],
});
const consoleErrors = [];
context.on('page', (page) => {
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${page.url().slice(0, 60)}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${page.url().slice(0, 60)}: ${e.message}`));
});
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  if (!worker.url().startsWith(`chrome-extension://${extensionId}/`)) {
    throw new Error(`the extension loaded with an unexpected ID: ${worker.url()}`);
  }

  const shop = await context.newPage();
  await shop.goto(`${site}/checkout`);
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({ url: `${url}/*` }))[0]?.id,
    site,
  );

  // Extension first: before the app is registered, the panel explains how to install it, and
  // continues by itself once the app is there.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${tabId}`);
  await panel.getByRole('heading', { name: 'Install the Lens app' }).waitFor({ timeout: 15_000 });
  await panel.getByRole('status', { name: 'Connection' }).filter({ hasText: 'App not installed' }).waitFor();
  execFileSync(bin, ['register'], { env, stdio: 'inherit' });
  const status = panel.getByRole('status', { name: 'Connection' });
  const connected = await status
    .filter({ hasText: /^Connected/ })
    .waitFor({ timeout: 20_000 })
    .then(() => true, () => false);
  if (!connected) {
    const log = (name) => join(env.LENS_HOME, 'logs', name);
    const read = (name) => (existsSync(log(name)) ? readFileSync(log(name), 'utf8') : '(none)');
    throw new Error(`side panel: ${await status.textContent()}\nlensd.log: ${read('lensd.log')}\nhost.log: ${read('host.log')}`);
  }

  // The setup card lists only the open steps; the background script announced the extension, so its step leaves.
  const setup = panel.getByRole('region', { name: 'Setup' });
  await setup.waitFor({ timeout: 15_000 });
  // Setup shows only what the panel cannot: starting at login (a button), and VibeQ (optional).
  await setup.getByRole('button', { name: 'Turn on' }).waitFor({ timeout: 15_000 });
  if (await setup.getByText(/Browser extension|A site to collect on/).count()) throw new Error('setup repeats what the panel shows');

  // Track the site: a project for its origin, and the debugger attaches to the tab.
  await panel.getByRole('button', { name: 'Collect evidence on this site' }).click();
  await panel.getByText('Collecting network, console and errors').waitFor({ timeout: 15_000 });

  // The defect happens, then the person captures it.
  await shop.getByLabel('Coupon').fill('SAVE10');
  await shop.getByLabel('Card number').fill('4111111111111111');
  await Promise.all([
    shop.waitForResponse(`${site}/api/price`),
    shop.getByRole('button', { name: 'Pay' }).click(),
  ]);
  await panel.waitForTimeout(500);
  // Record is the default mode; this part uses Capture, which saves the last ten minutes.
  await panel.getByRole('tab', { name: 'Capture' }).click();
  await panel.getByRole('button', { name: 'Capture to a new observation' }).click();

  // A capture opens its observation: its picture leads the detail view.
  const capture = panel.getByRole('region', { name: 'Observation' });
  const hero = capture.getByRole('button', { name: /^Open the recording, Capture/ });
  await hero.or(panel.getByRole('alert')).first().waitFor({ timeout: 15_000 });
  if (await panel.getByRole('alert').isVisible()) throw new Error(await panel.getByRole('alert').textContent());
  await hero.getByRole('img').waitFor();
  const imageWidth = await hero.getByRole('img').evaluate((img) => img.naturalWidth);
  if (!(imageWidth > 0)) throw new Error('the screenshot did not render');

  // The stored evidence holds the defect, and not the secret.
  const evidence = findEvidence(join(env.LENS_HOME, 'blobs'));
  const kinds = new Set(evidence.events.map((e) => e.kind));
  for (const kind of ['console', 'request', 'response', 'responseBody']) {
    if (!kinds.has(kind)) throw new Error(`the evidence has no ${kind} event: ${[...kinds]}`);
  }
  const text = JSON.stringify(evidence);
  if (!text.includes('total is NaN') || !text.includes('price is NaN')) throw new Error('the defect is missing');
  if (text.includes('fixture-secret-123')) throw new Error('the secret reached the notebook');
  const everything = allBlobs(join(env.LENS_HOME, 'blobs'));
  for (const secret of ['4111111111111111', 'meta-csrf-555', 'hidden-csrf-777', 'link-token-888', 'draft-secret-999']) {
    if (everything.includes(secret)) throw new Error(`${secret} reached the notebook`);
  }
  if (!evidence.events.some((e) => e.kind === 'response' && e.data.status === 500)) throw new Error('no 500 response');
  // The steps, with locators; the card number stays private.
  const steps = evidence.actions.map((a) => `${a.kind} ${a.target?.role ?? ''} ${a.target?.name ?? ''} ${a.masked ? '(masked)' : a.value ?? ''}`.trim());
  for (const expected of ['fill textbox Coupon SAVE10', 'fill textbox Card number (masked)', 'click button Pay']) {
    if (!steps.includes(expected)) throw new Error(`the steps lack "${expected}": ${JSON.stringify(steps)}`);
  }
  if (!evidence.elements.some((e) => e.locator.testId === 'total')) throw new Error('the element map lacks the total');

  // Annotate: a rectangle, a mask drawn twice with an undo between, then save.
  const [editor] = await Promise.all([
    context.waitForEvent('page'),
    capture.getByRole('button', { name: /Annotate capture/ }).click(),
  ]);
  const canvas = editor.locator('canvas').first();
  await canvas.waitFor({ timeout: 15_000 });
  const area = await canvas.boundingBox();
  const drag = async (x1, y1, x2, y2) => {
    await editor.mouse.move(area.x + x1, area.y + y1);
    await editor.mouse.down();
    await editor.mouse.move(area.x + x2, area.y + y2, { steps: 5 });
    await editor.mouse.up();
  };
  await drag(20, 20, 160, 90);
  await editor.getByRole('button', { name: 'Mask' }).click();
  await drag(200, 20, 300, 60);
  await editor.getByRole('button', { name: 'Undo' }).click();
  await drag(200, 20, 320, 70);
  await editor.getByRole('button', { name: 'Save' }).click();
  await editor.getByRole('status').filter({ hasText: 'Saved · 2 marks' }).waitFor({ timeout: 15_000 });
  await capture.getByText('Mark up · 2').waitFor({ timeout: 15_000 });

  // The capture's recording opens in the editor, the same one Record mode uses.
  const [replay] = await Promise.all([
    context.waitForEvent('page'),
    capture.getByRole('button', { name: 'Open in editor' }).click(),
  ]);
  await replay.getByRole('region', { name: 'Recording editor' }).waitFor({ timeout: 15_000 });
  const replayed = replay.frameLocator('.stage iframe').getByRole('heading', { name: 'Checkout' });
  await replayed.waitFor({ state: 'attached', timeout: 15_000 });

  // Notes: autosave, then still there after the panel reloads (a new shim, the same daemon).
  const notes = 'Coupon SAVE10 applied, then Pay: total shows NaN.';
  await panel.getByLabel('Notes', { exact: true }).fill(notes);
  await panel.getByRole('status', { name: 'Notes status' }).filter({ hasText: /^Saved$/ }).waitFor({ timeout: 15_000 });
  await panel.reload();
  await panel.getByRole('list', { name: 'Observations' }).getByRole('button', { name: /^Checkout/ }).first().click();
  await panel.getByRole('button', { name: 'Review and file' }).waitFor({ timeout: 15_000 });
  const reloaded = panel.getByLabel('Notes', { exact: true });
  await reloaded.waitFor({ timeout: 15_000 });
  // Lens may have put its findings in front meanwhile: the person's text follows them, whole.
  if (!(await reloaded.inputValue()).endsWith(notes)) throw new Error(`notes after reload: ${await reloaded.inputValue()}`);

  // Voice: a spoken note becomes a transcript when the speech model and program are present
  // (LENS_SPEECH_MODELS, LENS_SPEECH_DIR); without them it waits and the panel offers the model.
  const speech = Boolean(process.env.LENS_SPEECH_MODELS && process.env.LENS_SPEECH_DIR);
  await panel.getByRole('button', { name: 'Record', exact: true }).click();
  await panel.getByRole('status', { name: 'Recording' }).waitFor({ timeout: 15_000 });
  await panel.waitForTimeout(11_500);
  await panel.getByRole('button', { name: /^Stop/ }).click();
  const transcript = panel.getByRole('list', { name: 'Voice note list' }).getByLabel('Transcript').first();
  if (speech) {
    await transcript.filter({ hasText: /fellow Americans/i }).waitFor({ timeout: 180_000 });
  } else {
    await transcript.filter({ hasText: /Waiting for the speech model/ }).waitFor({ timeout: 30_000 });
    await panel.getByRole('button', { name: 'Download the speech model' }).waitFor();
  }

  // Review and export: only after the person confirms the screenshots; the export holds the
  // daemon-rendered images and a report of what failed.
  const [review] = await Promise.all([
    context.waitForEvent('page'),
    panel.getByRole('button', { name: 'Review and file' }).click(),
  ]);
  const freeze = review.getByRole('button', { name: 'Create review' });
  await freeze.waitFor({ timeout: 15_000 });
  // The page title is not a title: a small model writes one, and the findings, before the review.
  await review
    .getByRole('status', { name: 'Summary' })
    .filter({ hasText: summaries ? /wrote the title/ : /No title was written/ })
    .waitFor({ timeout: 30_000 });
  if (summaries) {
    if ((await review.getByLabel('Title', { exact: true }).inputValue()) !== 'Checkout: total shows NaN after Pay') throw new Error('the title was not written');
    // The model's tags, cleaned, ready for the VibeQ task; the person can edit them.
    if ((await review.getByLabel('Tags', { exact: true }).inputValue()) !== 'checkout, bug') throw new Error('the tags were not written');
    if (!(await review.getByLabel('Notes', { exact: true }).inputValue()).startsWith('Findings (written by Claude Haiku from the recording; check them):\n- The total shows NaN after Pay\n- The coupon field')) {
      throw new Error(`the findings are not first: ${await review.getByLabel('Notes', { exact: true }).inputValue()}`);
    }
    // Two unrelated defects: the coupon one moves to a task of its own, with a copy of the capture.
    // The model found two unrelated problems: Lens offers one task each; here the person keeps one.
    const problems = review.getByRole('region', { name: 'Separate problems' });
    await problems.getByRole('heading', { name: 'This recording shows 2 separate problems' }).waitFor({ timeout: 20_000 });
    await problems.getByRole('button', { name: 'Keep as one task' }).click();
    await problems.waitFor({ state: 'detached' });
    await review.getByRole('button', { name: 'Split into two tasks' }).click();
    await review.getByRole('checkbox', { name: 'The coupon field accepts expired codes' }).check();
    if ((await review.getByLabel('Title of the new task').inputValue()) !== 'The coupon field accepts expired codes') throw new Error('the new task has no title');
    const [split] = await Promise.all([context.waitForEvent('page'), review.getByRole('button', { name: 'Move 1 to a new task' }).click()]);
    const splitNotes = split.getByLabel('Notes', { exact: true });
    await splitNotes.waitFor({ timeout: 15_000 });
    const moved = await splitNotes.inputValue();
    if (!moved.includes('- The coupon field accepts expired codes') || moved.includes('- The total shows NaN')) throw new Error(`the new task's notes: ${moved}`);
    await split.getByRole('img', { name: /before review/ }).first().waitFor({ timeout: 15_000 });
    await split.close();
    await review.getByRole('status', { name: 'Split' }).waitFor();
    const left = await review.getByLabel('Notes', { exact: true }).inputValue();
    if (left.includes('coupon field accepts') || !left.includes('NaN after Pay')) throw new Error(`the split left: ${left}`);
  }
  await freeze.click();
  await review.getByRole('list', { name: 'Reviewed captures' }).getByRole('img').first().waitFor({ timeout: 15_000 });
  await review.getByRole('button', { name: 'Export to Downloads' }).click();
  const exportStatus = review.getByRole('status', { name: 'Export' });
  await exportStatus.waitFor({ timeout: 15_000 });
  await review.getByRole('list', { name: /Findings of capture/ }).getByText(/HTTP 500 from/).waitFor();
  const folder = (await exportStatus.textContent()).replace(/^Exported to /, '');
  const report = readFileSync(join(folder, 'report.md'), 'utf8');
  for (const expected of ['HTTP 500 from', '` Console error: total is NaN `', notes, '![Capture 1](capture-1.png)']) {
    if (!report.includes(expected)) throw new Error(`report.md lacks ${expected}:\n${report}`);
  }
  for (const file of ['capture-1.lens.json', 'capture-1.png', 'capture-1-evidence.json', 'capture-1.rrweb.json', 'review.json', 'capture-1-timeline.txt', 'capture-1.spec.ts', 'capture-1.har']) {
    if (!existsSync(join(folder, file))) throw new Error(`the export lacks ${file}`);
  }
  if (speech) {
    const said = readFileSync(join(folder, 'voice-1.txt'), 'utf8');
    if (!/fellow Americans/i.test(said) || !/^\[00:0\d\] /.test(said)) throw new Error(`voice-1.txt: ${said}`);
    if (!readFileSync(join(folder, 'capture-1-timeline.txt'), 'utf8').includes('the person said:')) {
      throw new Error('the timeline lacks the voice note');
    }
  }
  // Voice recordings never leave this computer: only their transcripts do.
  if (readdirSync(folder).some((f) => /\.(wav|webm|ogg)$/.test(f))) throw new Error(`audio in the export: ${readdirSync(folder)}`);
  const spec = readFileSync(join(folder, 'capture-1.spec.ts'), 'utf8');
  for (const expected of ['.fill("SAVE10")', 'getByRole("button", { name: "Pay", exact: true }).click()', '// Lens recorded: HTTP 500 from POST']) {
    if (!spec.includes(expected)) throw new Error(`capture-1.spec.ts lacks ${expected}:\n${spec}`);
  }
  const har = JSON.parse(readFileSync(join(folder, 'capture-1.har'), 'utf8'));
  if (!har.log.entries.some((e) => e.response.status === 500 && e.request.postData?.text.includes('SAVE10'))) {
    throw new Error(`capture-1.har lacks the failed price request: ${JSON.stringify(har).slice(0, 300)}`);
  }

  // An agent repeats the steps: the generated test runs unchanged against the site and sends the
  // same request again.
  const repro = mkdtempSync(join(import.meta.dirname, '.repro-'));
  try {
    copyFileSync(join(folder, 'capture-1.spec.ts'), join(repro, 'capture-1.spec.ts'));
    const browserOptions = executablePath ? { launchOptions: { executablePath } } : { channel: 'chromium' };
    writeFileSync(join(repro, 'playwright.config.mjs'), `export default { testDir: '.', outputDir: 'results', reporter: 'line', use: ${JSON.stringify(browserOptions)} };\n`);
    const before = priceRequests.length;
    // Not execFileSync: the fixture site runs in this process and must keep answering.
    const runner = spawn(process.execPath, [join(import.meta.dirname, '../node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.config.mjs'], {
      cwd: repro,
      stdio: 'inherit',
    });
    const code = await new Promise((done) => runner.on('exit', done));
    if (code !== 0) throw new Error(`the generated test failed (exit ${code})`);
    if (priceRequests.length !== before + 1 || !priceRequests.at(-1).includes('SAVE10')) {
      throw new Error(`the replay sent ${JSON.stringify(priceRequests.slice(before))}`);
    }
    if (!existsSync(join(repro, 'capture-1-reproduced.png'))) throw new Error('the replay took no screenshot');
  } finally {
    rmSync(repro, { recursive: true, force: true });
  }
  if (!isolated) rmSync(folder, { recursive: true, force: true });

  // File to VibeQ: the first reply is lost; filing again finishes without a second task.
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  // Sign in through VibeQ: nobody is signed in yet, so Lens opens VibeQ and waits for the session.
  const vibeqOrigin = `http://127.0.0.1:${fakeVibeq.address().port}`;
  await settings.getByLabel('VibeQ address').fill(vibeqOrigin);
  if (process.env.E2E_GALLERY) {
    mkdirSync(process.env.E2E_GALLERY, { recursive: true });
    await settings.screenshot({ path: join(process.env.E2E_GALLERY, 'settings-signed-out.png') });
  }
  await settings.getByRole('button', { name: 'Sign in with VibeQ' }).click();
  await settings.getByRole('status', { name: 'Sign-in' }).or(settings.getByRole('alert')).waitFor({ timeout: 15_000 });
  if (await settings.getByRole('alert').isVisible()) throw new Error(`settings: ${await settings.getByRole('alert').textContent()}`);
  await context.addCookies([{ name: 'session', value: 'e2e-session', url: vibeqOrigin }]);
  await settings.getByRole('status', { name: 'VibeQ account' }).filter({ hasText: 'Tess Tester' }).or(settings.getByRole('alert')).waitFor({ timeout: 15_000 });
  if (await settings.getByRole('alert').isVisible()) throw new Error(`settings: ${await settings.getByRole('alert').textContent()}`);
  // The AI model: Automatic by default; Codex is missing here, so choosing it says what stops.
  const models = settings.getByRole('region', { name: 'AI model' });
  if (!(await models.getByLabel(/^Automatic/).isChecked())) throw new Error('the AI model is not Automatic by default');
  await models.getByLabel(/^Codex/).check();
  await models.getByRole('alert').filter({ hasText: 'Codex is not installed' }).waitFor({ timeout: 10_000 });
  await models.getByLabel(/^Automatic/).check();
  await models.getByRole('alert').waitFor({ state: 'detached', timeout: 10_000 });
  await review.reload();
  await review.getByRole('button', { name: 'Create review' }).click();
  await review.getByRole('list', { name: 'Reviewed captures' }).getByRole('img').first().waitFor({ timeout: 15_000 });
  // Before filing, Lens looks for the same problem in VibeQ; the model judged task-9 the same.
  if (summaries) {
    const duplicates = review.getByRole('region', { name: 'Duplicates' });
    await duplicates.getByText('Same problem').waitFor({ timeout: 30_000 });
    if ((await duplicates.getByRole('link', { name: 'Checkout total is NaN' }).getAttribute('href')) !== `${vibeqOrigin}/?task=task-9`) {
      throw new Error('the duplicate does not link to its task');
    }
  }
  await review.getByLabel('Assign to').selectOption({ label: 'Ana' });
  await review.getByLabel('Then put Sirvant to work').check();
  const handoff = review.getByRole('region', { name: 'Hand off' });
  if (summaries) {
    // File, then hand off to T3 Code at once: the agent's prompt links the new VibeQ task.
    await handoff.getByLabel('App').selectOption({ label: 'T3 Code' });
    await handoff.getByLabel('Project folder').fill(handoffProject);
    await review.getByLabel('Then hand off to T3 Code').check();
  }
  await review.getByRole('button', { name: 'File to VibeQ' }).click();
  await review.getByRole('alert').filter({ hasText: /Filing again is safe/ }).waitFor({ timeout: 30_000 });
  await review.getByRole('button', { name: 'File to VibeQ' }).click();
  await review.getByRole('status', { name: 'Filing' }).getByRole('link', { name: 'http://vibeq.test/?task=task-1' }).waitFor({ timeout: 30_000 });
  // Filed, then Sirvant was put to work on the task, once, as the VibeQ task page does it.
  await review.getByRole('status', { name: 'Filing' }).filter({ hasText: 'Sirvant works on it now.' }).waitFor({ timeout: 15_000 });
  if (vibeq.sirvant.length !== 1 || vibeq.sirvant[0].mode !== 'work' || vibeq.sirvant[0].invoked_from !== 'lens') {
    throw new Error(`Sirvant was asked: ${JSON.stringify(vibeq.sirvant)}`);
  }
  if (summaries) {
    // Handed off after filing: an unknown folder becomes a project, then a thread starts with the task.
    await handoff.getByRole('status', { name: 'Hand-off' }).filter({ hasText: 'T3 Code works on it now.' }).waitFor({ timeout: 30_000 });
    const t3Log = join(fakeBin, 't3.log');
    for (let i = 0; i < 50 && !readFileSync(t3Log, 'utf8').includes(`ARGS app ${handoffProject}`); i++) await new Promise((done) => setTimeout(done, 100));
    const asked = readFileSync(t3Log, 'utf8');
    for (const expected of [
      `ARGS project add ${handoffProject}`,
      `ARGS thread start ${handoffProject} - --title`,
      'Work on VibeQ task task-1: http://vibeq.test/?task=task-1',
      'get_task in the VibeQ MCP',
      '/report.md',
      'record what you did on the VibeQ task',
      `ARGS app ${handoffProject}`,
    ]) {
      if (!asked.includes(expected)) throw new Error(`T3 Code was not asked ${expected}:\n${asked}`);
    }
  }
  const [submitted] = [...vibeq.submissions.values()];
  if (vibeq.submits !== 1 || vibeq.submissions.size !== 1) throw new Error(`VibeQ got ${vibeq.submits} submits`);
  // The task is tagged: `lens` for the source, then the observation's tags.
  if (summaries && submitted.body.tags?.join(',') !== 'lens,checkout,bug') throw new Error(`the task's tags: ${submitted.body.tags}`);
  if (vibeq.staged !== submitted.body.evidenceManifest.length) {
    throw new Error(`${vibeq.staged} uploads for ${submitted.body.evidenceManifest.length} files`);
  }
  // VibeQ gets lens-capture.v1: the record, the shots, the end screenshot and the recording.
  const filed = submitted.body.evidenceManifest.map((a) => `${a.filename} ${a.contentType}`);
  if (
    !filed.includes('capture-1.lens.json application/vnd.sirv.lens-capture+json') ||
    !filed.includes('capture-1.rrweb.json application/vnd.rrweb+json') ||
    filed.some((f) => !/^capture-1(\.lens\.json|\.rrweb\.json|\.png|-shot-\d+\.webp) /.test(f))
  ) {
    throw new Error(`filed files: ${filed.join(', ')}`);
  }
  if (submitted.body.assigneeId !== 'member-2' || !submitted.body.markdown.includes('HTTP 500 from')) {
    throw new Error(`unexpected submission: ${JSON.stringify(submitted.body).slice(0, 400)}`);
  }

  // MCP: an agent sees the reviewed defect and its rendered screenshot, nothing else.
  const mcp = spawn(bin, ['mcp'], {
    // verify_fix runs the extension's Playwright with the same Chromium as this test.
    env: { ...env, LENS_VERIFY_BROWSER: executablePath ?? chromium.executablePath() },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: mcp.stdout });
  const pending = new Map();
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  let nextId = 1;
  const rpc = (method, params, wait = 15_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), wait);
      pending.set(id, (message) => (clearTimeout(timer), message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)));
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = (await rpc('tools/list', {})).tools.map((t) => t.name).sort().join(',');
    if (tools !== 'get_review,list_reviews,playwright_test,read_review_file,recent_evidence,search_reviews,verify_fix') {
      throw new Error(`MCP tools: ${tools}`);
    }
    const listing = (await rpc('tools/call', { name: 'list_reviews', arguments: {} })).content;
    if (!listing[0].text.includes('UNTRUSTED DATA')) throw new Error('MCP: review titles are not marked untrusted');
    const listed = JSON.parse(listing[1].text);
    const latest = listed[0];
    // An agent working on the VibeQ task finds the review by the task.
    if (latest.vibeqTaskId !== 'task-1' || latest.vibeqTaskUrl !== 'http://vibeq.test/?task=task-1' || !latest.pageUrl?.startsWith('http')) {
      throw new Error(`MCP list_reviews: ${JSON.stringify(latest)}`);
    }
    const reviewed = (await rpc('tools/call', { name: 'get_review', arguments: { review: latest.id } })).content;
    if (!reviewed[0].text.includes('UNTRUSTED DATA')) throw new Error('MCP: page content is not marked untrusted');
    const detail = JSON.parse(reviewed[1].text);
    if (!detail.notesByThePerson.includes(notes) || !detail.captures[0].untrustedPageContent.findings.some((f) => f.startsWith('HTTP 500'))) {
      throw new Error(`MCP review: ${JSON.stringify(detail).slice(0, 300)}`);
    }
    if (speech && !/fellow Americans/i.test(detail.voiceNotesByThePerson[0]?.transcript ?? '')) {
      throw new Error(`MCP voice: ${JSON.stringify(detail.voiceNotesByThePerson)}`);
    }
    if (detail.captures[0].untrustedPageContent.marks[0]?.kind !== 'rectangle') throw new Error(`MCP marks: ${JSON.stringify(detail.captures[0].untrustedPageContent.marks)}`);
    const served = (await rpc('tools/call', { name: 'read_review_file', arguments: { review: latest.id, file: 'capture-1.spec.ts' } })).content;
    if (!served[1].text.includes('getByRole("button", { name: "Pay", exact: true }).click()')) throw new Error(`MCP spec: ${served[1].text.slice(0, 300)}`);
    const record = JSON.parse((await rpc('tools/call', { name: 'read_review_file', arguments: { review: latest.id, file: 'capture-1.lens.json' } })).content[1].text);
    if (record.version !== 1 || !record.steps.some((s) => s.kind === 'click' && s.target?.name === 'Pay')) {
      throw new Error(`MCP record: ${JSON.stringify(record).slice(0, 300)}`);
    }
    // The fix prompt, named by the VibeQ task the review was filed as.
    const prompt = await rpc('prompts/get', { name: 'fix', arguments: { review: 'task-1' } });
    if (!prompt.messages[0].content.text.startsWith(`Fix the defect in Sirv Lens review ${latest.id}.`)) {
      throw new Error(`MCP fix prompt: ${prompt.messages[0].content.text.slice(0, 200)}`);
    }
    const resource = await rpc('resources/read', { uri: `lens://review/${latest.id}` });
    if (JSON.parse(resource.contents[0].text).review !== latest.id) throw new Error('MCP resource: wrong review');
    const searched = JSON.parse((await rpc('tools/call', { name: 'search_reviews', arguments: { text: 'task-1', site: '127.0.0.1' } })).content[1].text);
    if (searched.length !== 1 || searched[0].id !== latest.id) throw new Error(`MCP search: ${JSON.stringify(searched)}`);
    const test = (await rpc('tools/call', { name: 'playwright_test', arguments: { review: latest.id, base_url: 'http://localhost:4321' } })).content[1].text;
    if (!test.includes('page.goto("http://localhost:4321/')) throw new Error(`MCP playwright_test: ${test.slice(0, 400)}`);
    // Live evidence, once the person allows it: the last ten minutes of the shop, without a recording.
    await panel.evaluate(() => chrome.storage.local.set({ 'lens.agentsLive': true }));
    let live = [];
    for (let i = 0; i < 3 && !live.length; i++) {
      const answer = (await rpc('tools/call', { name: 'recent_evidence', arguments: { site: site } }, 20_000)).content[1].text;
      live = answer.startsWith('[') ? JSON.parse(answer) : [];
    }
    if (!live[0]?.findings.some((f) => f.startsWith('HTTP 500'))) throw new Error(`MCP recent_evidence: ${JSON.stringify(live).slice(0, 300)}`);
    await panel.evaluate(() => chrome.storage.local.set({ 'lens.agentsLive': false }));
    // Proof of a fix: the shop still answers 500, so verify_fix finds the recorded failure again.
    const verified = JSON.parse(
      (await rpc('tools/call', { name: 'verify_fix', arguments: { review: latest.id, base_url: site, project: resolve(import.meta.dirname, '..') } }, 180_000)).content[1].text,
    );
    if (!verified.stepsRan || !verified.stillFailing.some((f) => f.startsWith('HTTP 500'))) {
      throw new Error(`MCP verify_fix: ${JSON.stringify(verified).slice(0, 600)}`);
    }
    for (const left of ['.lens', 'test-results', `lens-verify-${latest.id}-capture-1-reproduced.png`]) {
      if (existsSync(resolve(import.meta.dirname, '..', left))) throw new Error(`verify_fix left ${left} in the project`);
    }
    const image = (await rpc('tools/call', { name: 'read_review_file', arguments: { review: latest.id, file: 'capture-1.png' } })).content[0];
    if (image.type !== 'image' || image.mimeType !== 'image/png' || !image.data.startsWith('iVBORw0KGgo')) {
      throw new Error(`MCP image: ${JSON.stringify(image).slice(0, 200)}`);
    }
  } finally {
    mcp.kill();
  }

  // Record mode: a session with the voice, then the editor: a drawing on Pay with a note, a cut,
  // and a review whose timeline and test carry the note and leave out the cut part.
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${tabId}`);
  await status.filter({ hasText: /^Connected/ }).waitFor({ timeout: 15_000 });
  await panel.getByRole('tab', { name: 'Record' }).click();
  await panel.getByLabel('Record my voice').check();
  await panel.getByRole('button', { name: 'Record', exact: true }).click();
  await panel.getByRole('status', { name: 'Recording' }).waitFor({ timeout: 15_000 });
  await shop.getByLabel('Coupon').fill('SAVE20');
  await shop.getByRole('button', { name: 'Pay' }).click();
  // The person closes the panel while talking: the voice keeps recording in the background.
  await panel.goto('about:blank');
  await panel.waitForTimeout(11_500);
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${tabId}`);
  await panel.getByRole('status', { name: 'Recording' }).filter({ hasText: 'Screen, steps and your voice' }).waitFor({ timeout: 15_000 });
  const [studio] = await Promise.all([context.waitForEvent('page'), panel.getByRole('button', { name: /^Stop/ }).click()]);
  const editorRegion = studio.getByRole('region', { name: 'Recording editor' });
  await editorRegion.waitFor({ timeout: 30_000 });
  await studio.getByRole('status', { name: 'Edits' }).filter({ hasText: /kept/ }).waitFor({ timeout: 15_000 });
  if (speech) {
    const transcriptPanel = studio.getByRole('region', { name: 'Transcript' });
    await transcriptPanel.getByText(/fellow Americans/i).first().waitFor({ timeout: 180_000 });
    // The person corrects what Whisper heard before it leaves.
    await transcriptPanel.getByRole('listitem').first().hover();
    await transcriptPanel.getByRole('button', { name: 'Correct this line' }).first().click();
    await transcriptPanel.getByLabel('Correct the transcript').fill('And so, my fellow testers, the total is wrong.');
    await transcriptPanel.getByLabel('Correct the transcript').press('Enter');
    await transcriptPanel.getByText('And so, my fellow testers, the total is wrong.').waitFor({ timeout: 10_000 });
  }
  // Draw a circle around Pay in the replay.
  // Measure after Draw: the click may scroll the page.
  await studio.getByRole('button', { name: 'Draw' }).click();
  await studio.evaluate(() => scrollTo(0, 0));
  const pay = await studio.frameLocator('.stage iframe').getByRole('button', { name: 'Pay' }).boundingBox();
  if (!pay) throw new Error('the replay does not show the Pay button');
  const cx = pay.x + pay.width / 2;
  const cy = pay.y + pay.height / 2;
  await studio.mouse.move(cx - 3, cy - 3);
  await studio.mouse.down();
  for (const [dx, dy] of [[3, -3], [3, 3], [-3, 3], [-3, -3], [0, 0]]) await studio.mouse.move(cx + dx, cy + dy, { steps: 3 });
  await studio.mouse.up();
  if (process.env.E2E_GALLERY) await studio.screenshot({ path: join(process.env.E2E_GALLERY, 'editor-drawing.png') });
  await studio.getByRole('button', { name: 'Done drawing' }).click();
  const draft = studio.getByRole('dialog', { name: 'New note' });
  await draft.getByText(/marks button “Pay”/).waitFor({ timeout: 10_000 });
  await draft.getByLabel('Note').fill('Total turns into NaN after Pay');
  await draft.getByRole('button', { name: 'Add note' }).click();
  // Highlight: the element under the pointer is outlined and named; a click notes it.
  await studio.getByRole('button', { name: 'Highlight' }).click();
  await studio.evaluate(() => scrollTo(0, 0));
  const coupon = await studio.frameLocator('.stage iframe').getByRole('textbox', { name: 'Coupon' }).boundingBox();
  await studio.mouse.move(coupon.x + coupon.width / 2, coupon.y + coupon.height / 2, { steps: 3 });
  if (process.env.E2E_GALLERY) await studio.screenshot({ path: join(process.env.E2E_GALLERY, 'editor-highlight.png') });
  await studio.mouse.down();
  await studio.mouse.up();
  const highlighted = studio.getByRole('dialog', { name: 'New note' });
  await highlighted.getByText(/marks textbox “Coupon”/).waitFor({ timeout: 10_000 });
  await highlighted.getByLabel('Note').fill('The coupon is applied twice');
  await highlighted.getByRole('button', { name: 'Add note' }).click();
  // Space plays and pauses.
  await studio.keyboard.press(' ');
  await studio.getByRole('button', { name: 'Pause' }).waitFor({ timeout: 5_000 });
  await studio.keyboard.press(' ');
  await studio.getByRole('button', { name: 'Play' }).waitFor({ timeout: 5_000 });
  // Dragging scrubs: the clock follows the pointer.
  const bar = await studio.getByLabel('Timeline').boundingBox();
  await studio.mouse.move(bar.x + bar.width * 0.1, bar.y + bar.height / 2);
  await studio.mouse.down();
  await studio.mouse.move(bar.x + bar.width * 0.6, bar.y + bar.height / 2, { steps: 4 });
  await studio.mouse.up();
  const clockText = await studio.getByLabel('Time', { exact: true }).textContent();
  if (clockText.startsWith('0:00')) throw new Error(`scrubbing did not move the replay: ${clockText}`);
  // Cut the last fifth of the timeline, with the Cut tool.
  await studio.getByRole('button', { name: 'Cut', exact: true }).click();
  const line = await studio.getByLabel('Timeline').boundingBox();
  await studio.mouse.move(line.x + line.width * 0.8, line.y + line.height / 2);
  await studio.mouse.down();
  await studio.mouse.move(line.x + line.width * 0.99, line.y + line.height / 2, { steps: 5 });
  await studio.mouse.up();
  await studio.getByRole('button', { name: /^Cut .* out$/ }).click();
  // Shots: Lens took one after the steps; the person removes the first before it leaves.
  const strip = studio.getByRole('region', { name: 'Shots' });
  await strip.waitFor({ timeout: 10_000 });
  const shotCount = await strip.getByRole('listitem').count();
  // The person blacks out the top-left of the last shot, and removes the first when there are two.
  await strip.getByRole('button', { name: /^Mask parts of the shot/ }).last().click();
  const masker = studio.getByRole('dialog', { name: /^Mask the shot/ });
  const shotBox = await masker.getByLabel('Shot to mask').boundingBox();
  await studio.mouse.move(shotBox.x + 1, shotBox.y + 1);
  await studio.mouse.down();
  await studio.mouse.move(shotBox.x + shotBox.width * 0.4, shotBox.y + shotBox.height * 0.4, { steps: 4 });
  await studio.mouse.up();
  await masker.getByRole('button', { name: 'Save masks' }).click();
  if ((await strip.locator('.mask-box').count()) !== 1) throw new Error('the masked shot does not show its mask');
  const removedOne = shotCount > 1;
  if (removedOne) await strip.getByRole('button', { name: /^Remove the shot/ }).first().click();
  await studio.getByRole('status', { name: 'Edits' }).filter({ hasText: /2 notes · Saved/ }).waitFor({ timeout: 15_000 });
  await studio.getByRole('status', { name: 'Summary' }).filter({ hasText: summaries ? /wrote the title/ : /No title was written/ }).waitFor({ timeout: 30_000 });
  await studio.getByRole('button', { name: 'Create review' }).click();
  await studio.getByRole('button', { name: 'Export to Downloads' }).click();
  const recorded = studio.getByRole('status', { name: 'Export' });
  await recorded.waitFor({ timeout: 15_000 });
  const sessionFolder = (await recorded.textContent()).replace(/^Exported to /, '');
  if (!existsSync(join(sessionFolder, 'capture-1.png'))) throw new Error('the recording lacks its screenshot');
  if (speech && !readFileSync(join(sessionFolder, 'voice-1.txt'), 'utf8').includes('my fellow testers, the total is wrong')) {
    throw new Error('the corrected transcript did not leave');
  }
  const sessionReport = readFileSync(join(sessionFolder, 'report.md'), 'utf8');
  // Findings first, the raw timeline last.
  if (!(sessionReport.indexOf('Findings') < sessionReport.indexOf('## Timeline'))) throw new Error(`the report order:\n${sessionReport}`);
  const sessionTimeline = readFileSync(join(sessionFolder, 'capture-1-timeline.txt'), 'utf8');
  const sessionSpec = readFileSync(join(sessionFolder, 'capture-1.spec.ts'), 'utf8');
  for (const [file, text] of [['timeline', sessionTimeline], ['spec', sessionSpec]]) {
    if (!/noted: Total turns into NaN after Pay \(marked button "Pay"\)/.test(text)) throw new Error(`the ${file} lacks the note:\n${text}`);
  }
  if (!sessionSpec.includes('.fill("SAVE20")')) throw new Error(`the recording's test lacks its steps:\n${sessionSpec}`);
  // The record: the person's steps with full locators, notes with their elements, model findings.
  const lens = JSON.parse(readFileSync(join(sessionFolder, 'capture-1.lens.json'), 'utf8'));
  const fill = lens.steps.find((step) => step.kind === 'fill' && step.value === 'SAVE20');
  if (lens.version !== 1 || lens.capture.kind !== 'session' || fill?.target?.role !== 'textbox' || fill.target.name !== 'Coupon') {
    throw new Error(`the record's steps: ${JSON.stringify(lens.steps).slice(0, 500)}`);
  }
  const noteKinds = lens.annotations.map((a) => `${a.kind}:${a.elements.map((e) => e.name).join(',')}`).sort();
  if (noteKinds.join(' ') !== 'drawing:Pay highlight:Coupon') throw new Error(`the record's notes: ${noteKinds}`);
  if (summaries && lens.findings.writtenBy !== 'model') throw new Error(`the record's findings: ${JSON.stringify(lens.findings)}`);
  const stepShots = lens.shots.filter((shot) => shot.reason === 'step');
  if (stepShots.length !== shotCount - (removedOne ? 1 : 0)) {
    throw new Error(`the record kept ${lens.shots.length} shots of ${shotCount} (one removed: ${removedOne})`);
  }
  // The mask is burned into the shot that leaves: its top-left pixel is black.
  const maskedFile = readFileSync(join(sessionFolder, stepShots.at(-1).file)).toString('base64');
  const pixel = await studio.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/webp;base64,${data}`;
    await image.decode();
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return [...context.getImageData(5, 5, 1, 1).data];
  }, maskedFile);
  if (pixel.slice(0, 3).some((v) => v !== 0)) throw new Error(`the shared shot is not masked: ${pixel}`);
  if (!lens.shots.some((shot) => shot.reason === 'end') || typeof lens.dropped.cut !== 'number') throw new Error('the record lacks its end shot or its cut count');
  // The cut recording leaves now, rebuilt from the kept part only (before, it stayed here).
  const trimmed = JSON.parse(readFileSync(join(sessionFolder, 'capture-1.rrweb.json'), 'utf8'));
  const last = trimmed.at(-1);
  if (!lens.recording || last?.data?.tag !== 'lens-end') {
    throw new Error(`the cut recording: ${JSON.stringify(lens.recording)} ends with ${JSON.stringify(last)}`);
  }

  // Design review: every page with real content, light and dark, at the widths people use.
  if (process.env.E2E_GALLERY) {
    const gallery = process.env.E2E_GALLERY;
    mkdirSync(gallery, { recursive: true });
    const shots = [
      ['panel-list', panel, 400],
      ['review', review, 1280],
      ['annotate', editor, 1280],
      ['replay', replay, 1280],
      ['settings', settings, 1280],
      ['editor', studio, 1280],
    ];
    await panel.reload();
    await status.filter({ hasText: /^Connected/ }).waitFor();
    for (const scheme of ['light', 'dark']) {
      for (const [name, page, width] of shots) {
        // Chrome pauses transitions in a background tab; a page in front shows its settled colors.
        await page.bringToFront();
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: name === 'panel-list' ? 820 : 900 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(gallery, `${name}-${scheme}.png`) });
      }
      await panel.getByRole('list', { name: 'Observations' }).getByRole('button').first().click();
      await panel.getByRole('button', { name: 'Review and file' }).waitFor();
      await panel.waitForTimeout(500);
      await panel.screenshot({ path: join(gallery, `panel-detail-${scheme}.png`) });
      await panel.getByRole('button', { name: 'All recordings' }).click();
    }
  }

  console.log(`e2e: ok (${evidence.events.length} events, screenshot ${imageWidth}px wide, 2 marks, replay, notes kept, reviewed, exported and filed once despite a lost reply, served over MCP)`);
} catch (error) {
  // Every open page as it was at the failure: the first thing to look at, locally and in CI.
  const shots = process.env.E2E_SHOTS ?? join(tmpdir(), 'lens-e2e-shots');
  mkdirSync(shots, { recursive: true });
  for (const [index, page] of context.pages().entries()) {
    await page.screenshot({ path: join(shots, `page-${index}.png`), fullPage: true }).catch(() => {});
    const focused = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160)).catch(() => null);
    console.error(`e2e: page ${index} ${page.url().slice(0, 80)} has focus on ${focused}`);
  }
  console.error(`e2e: screenshots of every page are in ${shots}`);
  if (consoleErrors.length) console.error(`e2e: browser console errors:\n${consoleErrors.join('\n')}`);
  throw error;
} finally {
  // Cleanup must not hide the failure above, and must not hang the job.
  await Promise.race([context.close(), new Promise((done) => setTimeout(done, 20_000))]).catch(() => {});
  fixture.close();
  fakeVibeq.close();
  for (const command of [['stop'], ...(isolated ? [] : [['unregister']])]) {
    try {
      execFileSync(bin, command, { env, timeout: 10_000 });
    } catch (error) {
      console.error(`cleanup: lens ${command[0]}: ${error.message}`);
    }
  }
  try {
    if (process.env.E2E_KEEP) console.log(`e2e: kept ${work}`);
    else rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (error) {
    console.error(`cleanup: ${error.message}`);
  }
}

function allBlobs(blobs) {
  return readdirSync(blobs)
    .flatMap((folder) => readdirSync(join(blobs, folder)).map((name) => readFileSync(join(blobs, folder, name), 'latin1')))
    .join('\n');
}

/** The one JSON object blob in the store: the capture's evidence. */
function findEvidence(blobs) {
  for (const folder of readdirSync(blobs)) {
    for (const name of readdirSync(join(blobs, folder))) {
      const bytes = readFileSync(join(blobs, folder, name));
      if (bytes[0] === 0x7b) return JSON.parse(bytes.toString('utf8'));
    }
  }
  throw new Error('no evidence blob was stored');
}

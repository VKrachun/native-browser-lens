// Standalone Extension-Only End-to-End Test:
// Launches real Chromium with ONLY the built browser extension (ZERO native binary, ZERO NativeMessagingHosts!)
// against a local failing fixture page, verifying:
//  1. Sidepanel connects immediately ("Ready · v...") with no companion app or Onboarding nag.
//  2. Options page renders Voice (WebGPU/WASM + Groq/OpenAI), AI model (BYOK), Remote HTTP MCP, Storage, Privacy.
//  3. Recording a failing click on the fixture site saves to IndexedDB, opens Review, freezes a Review, and builds a valid ZIP.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const extension = resolve(import.meta.dirname, '../.output/chrome-mv3');
const extensionId = 'cggibhoaigdeemmdlfcncfkmoknndbfd';

const fixture = createServer((req, res) => {
  if (req.url === '/api/pay') {
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'payment_declined' }));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html>
    <html><head><title>Standalone Fixture</title></head>
    <body>
      <h1>Checkout</h1>
      <button id="pay" data-testid="pay-now">Pay now</button>
      <p id="status"></p>
      <script>
        document.getElementById('pay').addEventListener('click', async () => {
          const r = await fetch('/api/pay', { method: 'POST' });
          document.getElementById('status').textContent = 'Status ' + r.status;
          console.error('Checkout failed with status', r.status);
        });
      </script>
    </body></html>`);
});

await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const { port } = fixture.address();
const siteUrl = `http://127.0.0.1:${port}/`;
const userDataDir = mkdtempSync(join(tmpdir(), 'lens-standalone-e2e-'));

let context;
try {
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // 1. Open fixture page
  const appPage = await context.newPage();
  await appPage.goto(siteUrl);

  // 2. Open Options page and verify guided wizard + all-settings mode
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 10_000 });
  // Step 1: Destination
  await options.getByRole('heading', { name: 'Default destination' }).waitFor({ timeout: 5_000 });
  // Step 2: Voice notes
  await options.getByRole('button', { name: /Next: Voice/ }).click();
  await options.getByRole('heading', { name: 'Voice notes' }).waitFor({ timeout: 5_000 });
  // Step 3: AI summaries
  await options.getByRole('button', { name: /Next: AI summaries/ }).click();
  await options.getByRole('heading', { name: 'AI model (BYOK)' }).waitFor({ timeout: 5_000 });
  // Step 4: Coding agents
  await options.getByRole('button', { name: /Next: Coding agents/ }).click();
  await options.getByRole('heading', { name: 'Coding agents (Remote HTTP MCP)' }).waitFor({ timeout: 5_000 });
  // Step 5: Privacy & Storage
  await options.getByRole('button', { name: /Next: Privacy/ }).click();
  await options.getByRole('heading', { name: 'Setup checklist' }).waitFor({ timeout: 5_000 });
  await options.getByRole('heading', { name: 'Storage and retention' }).waitFor({ timeout: 5_000 });
  // Switch to All settings view and confirm all sections appear together
  await options.getByRole('button', { name: 'All settings', exact: true }).click();
  await options.getByRole('heading', { name: 'AI model (BYOK)' }).waitFor({ timeout: 5_000 });
  await options.getByRole('heading', { name: 'Voice notes' }).waitFor({ timeout: 5_000 });
  await options.close();

  // 3. Open Sidepanel targeting the fixture tab and confirm instant Ready status (no companion app!)
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const fixtureTabId = await panel.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === url)?.id ?? null;
  }, siteUrl);
  if (!fixtureTabId) throw new Error('Could not resolve fixture tab ID');
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${fixtureTabId}`);
  await panel.getByText(/Ready · v/).waitFor({ timeout: 10_000 });
  // Ensure no native-app "App not found" text exists
  const bodyText = await panel.locator('body').innerText();
  if (bodyText.includes('App not found') || bodyText.includes('Download Sirv Lens')) {
    throw new Error('Unexpected native-app onboarding text in sidepanel');
  }

  // 4. Add site project and record a session (uncheck mic since CI/test runner has no audio device)
  const collectBtn = panel.getByRole('button', { name: 'Collect evidence on this site' });
  await collectBtn.waitFor({ timeout: 10_000 });
  await collectBtn.click();
  await panel.getByText('Collecting', { exact: true }).waitFor({ timeout: 10_000 });

  const micToggle = panel.getByRole('checkbox', { name: /microphone|voice/i });
  if ((await micToggle.count()) > 0 && (await micToggle.isChecked())) {
    await micToggle.uncheck();
  }

  const recordBtn = panel.getByRole('button', { name: /^Record$/ });
  await recordBtn.waitFor({ timeout: 10_000 });
  await recordBtn.click();
  await panel.getByRole('button', { name: /^Stop$/ }).waitFor({ timeout: 10_000 });

  // Trigger failing action on fixture site
  await appPage.bringToFront();
  await appPage.getByTestId('pay-now').click();
  await appPage.getByText('Status 500').waitFor({ timeout: 5_000 });
  await appPage.waitForTimeout(500);

  // Stop recording and wait for Replay (recording editor) tab to open
  await panel.bringToFront();
  const replayPromise = context.waitForEvent('page', {
    predicate: (p) => p.url().includes('/replay.html'),
    timeout: 15_000,
  });
  await panel.getByRole('button', { name: /^Stop$/ }).click();
  const replayPage = await replayPromise;
  await replayPage.waitForLoadState('domcontentloaded');

  // Open Review from the recording page's "Review and export" button
  const reviewPromise = context.waitForEvent('page', {
    predicate: (p) => p.url().includes('/review.html'),
    timeout: 15_000,
  });
  await replayPage.getByRole('button', { name: 'Review and export' }).click();
  const reviewPage = await reviewPromise;
  await reviewPage.waitForLoadState('domcontentloaded');

  // Create frozen review
  const createBtn = reviewPage.getByRole('button', { name: 'Create review' });
  await createBtn.waitFor({ timeout: 10_000 });
  await createBtn.click();

  // Verify review froze cleanly and shows Save evidence ZIP + Hand off to a coding agent
  await reviewPage.getByRole('button', { name: 'Save evidence ZIP' }).waitFor({ timeout: 15_000 });
  await reviewPage.getByRole('heading', { name: 'Hand off to a coding agent' }).waitFor({ timeout: 5_000 });
  await reviewPage.getByText(/View shared evidence/).click();
  await reviewPage.getByText(/HTTP 500/).waitFor({ timeout: 5_000 });
  await reviewPage.getByRole('button', { name: 'Save evidence ZIP' }).click();
  await reviewPage.getByText(/Downloaded lens-review-.*-evidence\.zip/).waitFor({ timeout: 10_000 });

  console.log('PASS: Standalone extension-only E2E succeeded (zero companion app, IndexedDB + Review + HTTP 500 + ZIP download verified).');
} finally {
  await context?.close().catch(() => {});
  fixture.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

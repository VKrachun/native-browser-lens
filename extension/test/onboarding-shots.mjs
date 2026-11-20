// Screenshots of the first-run path, for design review: the app missing, a first connection on a
// site Lens does not collect on yet, the same site collected, and Settings. Light and dark.
//   LENS_E2E=1 pnpm build && node test/onboarding-shots.mjs <folder>
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'onboarding-shots');
mkdirSync(out, { recursive: true });
const root = resolve(import.meta.dirname, '../..');
const target = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: root })).target_directory;
const bin = join(target, 'debug', 'lens');
const extension = resolve(import.meta.dirname, '../.output/chrome-mv3');
const id = 'cggibhoaigdeemmdlfcncfkmoknndbfd';
const work = mkdtempSync(join(tmpdir(), 'lens-shots-'));
const env = { ...process.env, LENS_HOME: join(work, 'lens'), HOME: join(work, 'home'), XDG_CONFIG_HOME: join(work, 'config'),
  LENS_CLAUDE_BINARY: join(work, 'no'), LENS_CODEX_BINARY: join(work, 'no') };
const profile = join(env.XDG_CONFIG_HOME, 'chromium');
mkdirSync(profile, { recursive: true });
const site = createServer((_, res) => (res.writeHead(200, { 'content-type': 'text/html' }), res.end('<title>Shop</title><h1>Shop</h1>')));
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${site.address().port}`;
const chromiumPath = existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined;
const context = await chromium.launchPersistentContext(profile, {
  ...(chromiumPath ? { executablePath: chromiumPath } : { channel: 'chromium' }), headless: true, env,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const shot = async (page, name, width, height = 900) => {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${name}-${scheme}.png`), fullPage: true });
  }
};
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const shop = await context.newPage();
  await shop.goto(`${origin}/`);
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0]?.id, origin);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html?tab=${tabId}`);
  await panel.getByRole('heading', { name: 'The browser could not find the Lens app' }).waitFor({ timeout: 15_000 });
  await shot(panel, '1-app-missing', 400);
  execFileSync(bin, ['register'], { env, stdio: 'ignore' });
  await panel.getByRole('status', { name: 'Connection' }).filter({ hasText: /^Connected/ }).waitFor({ timeout: 20_000 });
  await panel.waitForTimeout(1500);
  await shot(panel, '2-connected', 400);
  await panel.getByRole('button', { name: 'Collect evidence on this site' }).click();
  await panel.getByText('Collecting network, console and errors').waitFor({ timeout: 15_000 });
  await panel.waitForTimeout(1500);
  await shot(panel, '3-collecting', 400);
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${id}/options.html`);
  await settings.waitForTimeout(1500);
  await shot(settings, '4-settings', 1280);
  console.log(`shots in ${out}`);
} finally {
  await context.close();
  site.close();
  try { execFileSync(bin, ['stop'], { env, stdio: 'ignore' }); } catch {}
}

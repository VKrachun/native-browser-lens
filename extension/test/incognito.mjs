// Split-incognito end-to-end check: verifies manifest split mode, isolation of shared Chrome
// APIs (storage.session, badge, content scripts), full recording inside an Incognito window, and
// that Review and Settings open inside the Incognito window rather than jumping to a normal window.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function makeTargetRpc(cdp) {
  let nextId = 1;
  const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    const msg = JSON.parse(message);
    const key = `${sessionId}:${msg.id}`;
    if (msg.id && pending.has(key)) {
      const { resolve, reject } = pending.get(key);
      pending.delete(key);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  return (sessionId, method, params = {}) => {
    const id = nextId++;
    const key = `${sessionId}:${id}`;
    return new Promise((resolve, reject) => {
      pending.set(key, { resolve, reject });
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch((error) => {
        pending.delete(key);
        reject(error);
      });
    });
  };
}

async function evalIn(rpc, sessionId, body) {
  const res = await rpc(sessionId, 'Runtime.evaluate', {
    expression: `(async () => { ${body} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'Runtime.evaluate failed');
  }
  return res.result?.value;
}

async function waitUntil(fn, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`incognito: timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

export async function verifyIncognito({ context, settings, extension, extensionId, site, relaunch }) {
  // 1. Manifest checks: Chromium uses split mode; Firefox leaves incognito unset.
  const chromeManifest = JSON.parse(readFileSync(resolve(extension, 'manifest.json'), 'utf8'));
  if (chromeManifest.incognito !== 'split') {
    throw new Error(`incognito: chrome manifest has incognito=${JSON.stringify(chromeManifest.incognito)}, expected "split"`);
  }
  const firefoxManifestPath = resolve(extension, '../firefox-mv3/manifest.json');
  if (existsSync(firefoxManifestPath)) {
    const firefoxManifest = JSON.parse(readFileSync(firefoxManifestPath, 'utf8'));
    if (firefoxManifest.incognito !== undefined) {
      throw new Error(`incognito: firefox manifest must not set incognito, got ${JSON.stringify(firefoxManifest.incognito)}`);
    }
  }

  // 2. Before Incognito access is granted, Settings shows the Allow in Incognito guidance.
  const privacy = settings.getByRole('region', { name: 'Privacy' });
  await privacy.getByText(/Allow in Incognito/).waitFor({ timeout: 10_000 });
  await privacy.getByRole('button', { name: 'Extension details' }).waitFor({ timeout: 5_000 });

  // 3. Turn on Allow in Incognito in Chrome's extension settings and relaunch the same profile.
  const extPage = await context.newPage();
  await extPage.goto(`chrome://extensions/?id=${extensionId}`);
  await extPage.evaluate(
    (id) =>
      new Promise((ok, fail) =>
        chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, incognitoAccess: true }, () =>
          chrome.runtime.lastError ? fail(new Error(chrome.runtime.lastError.message)) : ok(),
        ),
      ),
    extensionId,
  );
  await context.close();
  const nextContext = await relaunch();

  const normSw = nextContext.serviceWorkers()[0] ?? (await nextContext.waitForEvent('serviceworker', { timeout: 15_000 }));
  const allowed = await normSw.evaluate(() => chrome.extension.isAllowedIncognitoAccess());
  if (!allowed) throw new Error('incognito: isAllowedIncognitoAccess() is still false after enabling');

  // Seed normal SW's checkpoint and toolbar badge so we catch any clobbering when the incognito worker starts.
  await normSw.evaluate(async () => {
    await chrome.storage.session.set({
      'lens.sessions': { sessions: [[999_999, 12_345]], offProject: [], voiced: [], filmed: [] },
    });
    await chrome.action.setBadgeText({ text: '0:07' });
  });

  // Open an Incognito window on the tracked fixture site. In split mode, windows.create returns null
  // to the normal worker because split processes cannot hold handles to each other's windows.
  await normSw.evaluate((url) => chrome.windows.create({ incognito: true, url }), `${site}/checkout`);

  const cdp = await nextContext.browser().newBrowserCDPSession();
  const rpc = makeTargetRpc(cdp);

  const attachTarget = async (predicate, label) =>
    waitUntil(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      for (const target of targetInfos) {
        if (!predicate(target)) continue;
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
        return { target, sessionId };
      }
      return null;
    }, label);

  // 4. Find the split Incognito service worker (inIncognitoContext === true).
  const incogSw = await waitUntil(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sws = targetInfos.filter((t) => t.type === 'service_worker' && t.url.includes(extensionId));
    for (const target of sws) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
      const isIncog = await evalIn(rpc, sessionId, 'return chrome.extension.inIncognitoContext;').catch(() => false);
      if (isIncog === true) return { target, sessionId };
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
    return null;
  }, 'split incognito service worker');

  // Wait for the Incognito checkout tab to be found and collecting.
  const incogTab = await waitUntil(async () => {
    const found = await evalIn(
      rpc,
      incogSw.sessionId,
      `const tabs = await chrome.tabs.query({ url: ${JSON.stringify(`${site}/*`)} });
       const tab = tabs[0];
       if (!tab?.id) return null;
       return { id: tab.id, incognito: tab.incognito, url: tab.url };`,
    );
    return found;
  }, 'incognito checkout tab');
  if (!incogTab.incognito) throw new Error(`incognito: checkout tab is not incognito: ${JSON.stringify(incogTab)}`);

  // 5. Open the side panel inside the Incognito window and verify it connects and collects.
  await evalIn(
    rpc,
    incogSw.sessionId,
    `await chrome.tabs.create({ url: chrome.runtime.getURL('/sidepanel.html?tab=' + ${incogTab.id}) });`,
  );
  const incogPanel = await attachTarget(
    (t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${extensionId}/sidepanel.html?tab=${incogTab.id}`),
    'incognito side panel tab',
  );

  await waitUntil(async () => {
    const state = await evalIn(
      rpc,
      incogPanel.sessionId,
      `const status = document.querySelector('[role="status"][aria-label="Connection"]')?.textContent ?? '';
       const record = document.querySelector('button.record-go:not(:disabled)');
       return /^Connected/.test(status) && Boolean(record);`,
    );
    return state;
  }, 'incognito side panel ready to Record');

  // Verify the Incognito SW did NOT wipe the normal SW's badge or lens.sessions checkpoint.
  const normalAfterBoot = await normSw.evaluate(async () => ({
    badge: await chrome.action.getBadgeText({}),
    sessions: await chrome.storage.session.get(['lens.sessions', 'lens.sessions.incognito']),
  }));
  if (normalAfterBoot.badge !== '0:07') {
    throw new Error(`incognito: idle incognito SW clobbered normal badge (got ${JSON.stringify(normalAfterBoot.badge)})`);
  }
  if (normalAfterBoot.sessions['lens.sessions']?.sessions?.[0]?.[0] !== 999_999) {
    throw new Error(`incognito: incognito SW clobbered normal lens.sessions: ${JSON.stringify(normalAfterBoot.sessions)}`);
  }
  // Clear our seeded normal state before recording in Incognito.
  await normSw.evaluate(async () => {
    await chrome.storage.session.set({ 'lens.sessions': { sessions: [], offProject: [], voiced: [], filmed: [] } });
    await chrome.action.setBadgeText({ text: '' });
  });

  // 6. Start a recording in Incognito, trigger an error in the Incognito checkout tab, then Stop.
  await evalIn(
    rpc,
    incogPanel.sessionId,
    `const btn = document.querySelector('button.record-go');
     if (!btn) throw new Error('Record button missing');
     btn.click();`,
  );
  await waitUntil(
    () =>
      evalIn(
        rpc,
        incogPanel.sessionId,
        `return Boolean([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Stop'));`,
      ),
    'incognito recording started (Stop button visible)',
  );

  // Confirm the running session is stored under lens.sessions.incognito, not lens.sessions.
  const midSession = await normSw.evaluate(() => chrome.storage.session.get(['lens.sessions', 'lens.sessions.incognito']));
  if (midSession['lens.sessions.incognito']?.sessions?.[0]?.[0] !== incogTab.id) {
    throw new Error(`incognito: expected tab ${incogTab.id} in lens.sessions.incognito, got ${JSON.stringify(midSession)}`);
  }
  if (midSession['lens.sessions']?.sessions?.length) {
    throw new Error(`incognito: recording leaked into normal lens.sessions: ${JSON.stringify(midSession)}`);
  }

  // Trigger a failure in the Incognito checkout tab.
  const incogShop = await attachTarget(
    (t) => t.type === 'page' && t.url.startsWith(`${site}/checkout`),
    'incognito checkout page target',
  );
  await evalIn(
    rpc,
    incogShop.sessionId,
    `const input = document.querySelector('input[name="coupon"]');
     input.value = 'INCOG20';
     input.dispatchEvent(new Event('input', { bubbles: true }));
     document.querySelector('button').click();`,
  );
  await new Promise((r) => setTimeout(r, 400));

  // Stop the recording from the Incognito side panel.
  await evalIn(
    rpc,
    incogPanel.sessionId,
    `const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Stop');
     if (!btn) throw new Error('Stop button missing');
     btn.click();`,
  );

  // 7. Review tab MUST open inside the Incognito window (incognito: true), never in the normal window.
  const reviewTab = await waitUntil(async () => {
    const tabs = await evalIn(
      rpc,
      incogSw.sessionId,
      `return (await chrome.tabs.query({})).map((t) => ({ url: t.url || t.pendingUrl || '', incognito: t.incognito }));`,
    );
    return tabs.find((t) => t.url.startsWith(`chrome-extension://${extensionId}/review.html?observation=`)) ?? null;
  }, 'review.html tab inside incognito window', 20_000);
  if (!reviewTab.incognito) {
    throw new Error(`incognito: review tab did not open in Incognito: ${JSON.stringify(reviewTab)}`);
  }
  const normalReviewTabs = await normSw.evaluate(
    async (extId) => (await chrome.tabs.query({})).filter((t) => (t.url || t.pendingUrl || '').includes(`${extId}/review.html`)),
    extensionId,
  );
  if (normalReviewTabs.length) {
    throw new Error(`incognito: review.html leaked into normal window: ${JSON.stringify(normalReviewTabs)}`);
  }

  // Verify the Review page inside Incognito loads the saved observation and its captured 500 error.
  const incogReview = await attachTarget(
    (t) => t.type === 'page' && t.url === reviewTab.url,
    'incognito review page target',
  );
  await waitUntil(
    () =>
      evalIn(
        rpc,
        incogReview.sessionId,
        `const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Create review' && !b.disabled);
         if (!btn) return false;
         btn.click();
         return true;`,
      ),
    'incognito review Create review button',
    20_000,
  );
  await waitUntil(
    () =>
      evalIn(
        rpc,
        incogReview.sessionId,
        `const el = [...document.querySelectorAll('summary, button')].find((n) => /^View shared evidence/.test(n.textContent?.trim() ?? ''));
         if (!el) return false;
         el.click();
         return true;`,
      ),
    'incognito review View shared evidence toggle',
    20_000,
  );
  await waitUntil(
    () =>
      evalIn(
        rpc,
        incogReview.sessionId,
        `return (document.body?.innerText ?? '').includes('HTTP 500 from');`,
      ),
    'incognito review showing captured HTTP 500 evidence',
    20_000,
  );

  // Confirm the incognito session checkpoint and badge cleared once the recording stopped.
  const afterStop = await normSw.evaluate(async () => ({
    badge: await chrome.action.getBadgeText({}),
    sessions: await chrome.storage.session.get(['lens.sessions', 'lens.sessions.incognito']),
  }));
  if (afterStop.sessions['lens.sessions.incognito']?.sessions?.length) {
    throw new Error(`incognito: lens.sessions.incognito still has sessions after Stop: ${JSON.stringify(afterStop.sessions)}`);
  }
  if (afterStop.badge !== '') {
    throw new Error(`incognito: badge was not cleared after Stop (got ${JSON.stringify(afterStop.badge)})`);
  }

  // 8. openOptionsPage() from Incognito opens Settings inside Incognito, and hides Allow in Incognito now.
  await evalIn(rpc, incogPanel.sessionId, 'await chrome.runtime.openOptionsPage();');
  const optionsTab = await waitUntil(async () => {
    const tabs = await evalIn(
      rpc,
      incogSw.sessionId,
      `return (await chrome.tabs.query({})).map((t) => ({ url: t.url || t.pendingUrl || '', incognito: t.incognito }));`,
    );
    return tabs.find((t) => t.url.startsWith(`chrome-extension://${extensionId}/options.html`)) ?? null;
  }, 'options.html tab inside incognito window');
  if (!optionsTab.incognito) {
    throw new Error(`incognito: options tab did not open in Incognito: ${JSON.stringify(optionsTab)}`);
  }
  const incogOptions = await attachTarget(
    (t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${extensionId}/options.html`),
    'incognito options page target',
  );
  await waitUntil(
    () => evalIn(rpc, incogOptions.sessionId, 'return Boolean(document.querySelector("section[aria-label=Privacy]"));'),
    'incognito options Privacy section',
  );
  // Give the async isAllowedIncognitoAccess() check a tick to settle, then verify the note stays hidden.
  await new Promise((r) => setTimeout(r, 300));
  const noteVisible = await evalIn(
    rpc,
    incogOptions.sessionId,
    `return (document.querySelector('section[aria-label="Privacy"]')?.textContent ?? '').includes('Allow in Incognito');`,
  );
  if (noteVisible) {
    throw new Error('incognito: Settings still showed "Allow in Incognito" after access was granted');
  }

  return nextContext;
}

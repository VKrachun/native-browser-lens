import { ActionLog, EvidenceBuffer, ReplayBuffer, ShotBuffer, WINDOW_MS } from '@/collector/buffer';
import { DeepCollector } from '@/collector/deep';
import { LimitedCollector, visibleShot } from '@/collector/limited';
import { sanitize, sanitizeText, sanitizeUrl } from '@/collector/sanitize';
import { LensClient } from '@/lens-client';
import { clientInfo } from '@/identity';
import {
  originOf,
  type BackgroundRequest,
  type Broadcast,
  type CaptureResult,
  type OffscreenReply,
  type OffscreenRequest,
  type SessionStart,
  type TabStatus,
} from '@/messages';
import type { Project } from '@/protocol/Project';
import type { JsonValue } from '@/protocol/serde_json/JsonValue';
import type { CoverageGap } from '@/protocol/CoverageGap';
import type { Action } from '@/protocol/Action';
import type { PageElement } from '@/protocol/PageElement';
import type { Prepared, RecorderMessage } from './recorder.content';

/** A recording uploads in chunks; past this it is left out with a gap. */
const MAX_RECORDING_BYTES = 256 * 1024 * 1024;

export default defineBackground(() => {
  const buffer = new EvidenceBuffer();
  const actions = new ActionLog();
  const replay = new ReplayBuffer();
  const shots = new ShotBuffer();
  const shotTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** A shot shows a step's result: taken this long after the last of a quick series of steps. */
  const SHOT_DELAY_MS = 700;
  const SHOT_STEPS = new Set(['click', 'press', 'select', 'check', 'uncheck']);
  function scheduleShot(tabId: number) {
    if (deep && !deep.isAttached(tabId)) return;
    clearTimeout(shotTimers.get(tabId));
    shotTimers.set(
      tabId,
      setTimeout(() => {
        shotTimers.delete(tabId);
        const at = Date.now();
        void (deep ? deep.shot(tabId) : visibleShot(tabId)).then(
          (data) => data && buffer.mode(tabId) !== undefined && shots.add(tabId, at, data),
        );
      }, SHOT_DELAY_MS),
    );
  }
  /** Record mode: the tabs with a running session, and when each started. */
  const sessions = new Map<number, number>();
  const urls = new Map<number, string>();
  const deep = DeepCollector.available() ? new DeepCollector(buffer, (tabId) => urls.get(tabId)) : undefined;
  if (!deep) new LimitedCollector(buffer, (tabId) => buffer.mode(tabId) !== undefined).listen();

  let projects: Project[] = [];
  let paused = false;
  let lens: LensClient | null = null;
  const client = () => (lens ??= new LensClient(() => (lens = null)));

  const projectFor = (origin: string | null) =>
    origin ? projects.find((p) => p.enabled && p.origins.includes(origin)) : undefined;
  const permitted = (origin: string | null) =>
    origin ? browser.permissions.contains({ origins: [`${origin}/*`] }) : Promise.resolve(false);

  const queues = new Map<number, Promise<void>>();

  /**
   * Starts or stops collection on a tab to match the projects and the granted origins. Calls for one
   * tab run in order, and each works on the tab's latest URL, so a navigation during an await can
   * never leave the debugger on a site the person did not grant.
   */
  function sync(tabId: number, url: string | undefined): Promise<void> {
    if (url) urls.set(tabId, url);
    const next = (queues.get(tabId) ?? Promise.resolve()).then(() => syncNow(tabId)).catch(() => {});
    queues.set(tabId, next);
    return next;
  }

  async function allowed(tabId: number) {
    const origin = originOf(urls.get(tabId));
    return !paused && Boolean(projectFor(origin)) && (await permitted(origin));
  }

  async function syncNow(tabId: number) {
    if (!(await allowed(tabId))) {
      // A recording keeps what it has when the tab passes through another site (a sign-in or
      // payment redirect); nothing is collected there, and collection resumes on the way back.
      if (sessions.has(tabId) && !paused) {
        buffer.gap(tabId, 'navigation', 'The tab left the project sites: nothing was recorded there');
        await deep?.detach(tabId);
        return;
      }
      stop(tabId);
      await deep?.detach(tabId);
      return;
    }
    if (buffer.mode(tabId) !== undefined && (!deep || deep.isAttached(tabId) || deep.isDeclined(tabId))) return;
    void injectRecorder(tabId);
    if (!deep) return buffer.start(tabId, 'limited');
    buffer.start(tabId, 'deep');
    try {
      await deep.attach(tabId);
    } catch (error) {
      buffer.start(tabId, 'screenshotOnly');
      buffer.gap(tabId, 'debugger', `The browser refused the debugger: ${(error as Error).message}`);
    }
    if (!(await allowed(tabId))) {
      stop(tabId);
      await deep.detach(tabId);
    }
  }

  function stop(tabId: number) {
    buffer.stop(tabId);
    actions.clear(tabId);
    replay.clear(tabId);
    shots.clear(tabId);
    clearTimeout(shotTimers.get(tabId));
    sessions.delete(tabId);
    keptVoice.delete(tabId);
    void endMicrophone(tabId, 'mic-cancel');
  }

  /** The rrweb recorder, in collected tabs only. Idempotent: the script guards against a second run. */
  async function injectRecorder(tabId: number) {
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/recorder.js'] });
    } catch (error) {
      buffer.gap(tabId, 'recording', `The page refused the recorder: ${(error as Error).message}`);
    }
  }

  /**
   * What the page holds for a capture: its recent DOM recording (or null with a gap that says
   * why), the steps it had not reported yet, and the elements on screen.
   */
  async function preparePage(tabId: number, gaps: CoverageGap[]) {
    const gap = (channel: string, reason: string) => gaps.push({ channel, reason, startedAt: Date.now(), endedAt: null });
    const empty = { recording: null, pending: [] as Action[], elements: [] as PageElement[] };
    if (buffer.mode(tabId) === undefined) return empty;
    try {
      const prepared = (await Promise.race([
        browser.tabs.sendMessage(tabId, { kind: 'lens-prepare' }),
        new Promise((_, fail) => setTimeout(() => fail(new Error('the recorder did not answer')), 3000)),
      ])) as Prepared | undefined;
      if (!prepared) return gap('recording', 'The recorder did not answer'), empty;
      replay.add(tabId, prepared.recording);
      return { recording: null, pending: prepared.pending, elements: prepared.elements };
    } catch (error) {
      return gap('recording', (error as Error).message), empty;
    }
  }

  async function syncAll() {
    for (const tab of await browser.tabs.query({})) if (tab.id !== undefined) await sync(tab.id, tab.url);
  }

  async function loadProjects() {
    try {
      paused = (await client().request({ method: 'hello' })).paused;
      projects = await client().request({ method: 'listProjects' });
      // Setup's checklist learns from this that the extension is installed, connected and current.
      await client().request({ method: 'announce', params: await clientInfo() });
    } catch {
      // The app restarts (an update) or is gone: keep the projects known so far. Emptying them
      // would stop every tab's collection and end a running recording before its Stop.
    }
    await syncAll();
  }

  async function status(tabId: number): Promise<TabStatus> {
    const tab = await browser.tabs.get(tabId);
    const origin = originOf(tab.url);
    const project = origin ? projects.find((p) => p.origins.includes(origin)) : undefined;
    return {
      origin,
      paused,
      session: sessions.get(tabId) ?? null,
      voice: voiced.has(tabId),
      projectId: project?.id ?? null,
      permitted: await permitted(origin),
      mode: buffer.mode(tabId) ?? null,
    };
  }

  /**
   * Saves what the tab recorded from `session` on (Record mode), or the last ten minutes
   * (Capture mode): the replay, the steps, network and console, and a screenshot of now.
   */
  async function capture(tabId: number, observation: number | null, session: number | null = null): Promise<CaptureResult> {
    try {
      const from = session ?? Date.now() - WINDOW_MS;
      const tab = await browser.tabs.get(tabId);
      const screenshot = await takeScreenshot(tab);
      const snapshot = buffer.snapshot(tabId, from) ?? {
        mode: 'screenshotOnly' as const,
        events: [],
        dropped: {},
        gaps: [{ channel: 'collector', reason: 'Lens does not collect evidence on this site', startedAt: Date.now(), endedAt: null }],
      };
      const { pending, elements } = await preparePage(tabId, snapshot.gaps);
      // The replay lasts until now, also when the page did not change at the end.
      const events = [...replay.slice(tabId, from), { type: 5, data: { tag: 'lens-end', payload: {} }, timestamp: Date.now() }];
      let recording = null;
      if (events.length > 1) {
        const body = new Blob([JSON.stringify(events)], { type: 'application/json' });
        if (body.size > MAX_RECORDING_BYTES) {
          snapshot.gaps.push({ channel: 'recording', reason: 'The recording exceeds 256 MiB', startedAt: Date.now(), endedAt: null });
        } else {
          recording = await client().upload(body, 'application/json');
        }
      }
      const taken = [];
      for (const shot of shots.since(tabId, from)) {
        const bytes = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
        const image = await client().upload(new Blob([bytes], { type: 'image/webp' }), 'image/webp');
        taken.push({ at: shot.at, image, reason: 'step' });
      }
      const page = await pageSnapshot(tabId).catch((error: Error) => {
        snapshot.gaps.push({ channel: 'page', reason: error.message, startedAt: Date.now(), endedAt: null });
        return null;
      });
      const saved = await client().request({
        method: 'createCapture',
        params: {
          observation,
          pageUrl: sanitizeUrl(tab.url ?? ''),
          pageTitle: sanitizeText(tab.title ?? ''),
          screenshot,
          evidence: { ...snapshot, page, actions: [...actions.snapshot(tabId, from), ...pending], elements },
          recording,
          kind: session === null ? 'moment' : 'session',
          shots: taken,
          startedAt: session ?? Math.max(from, events[0]?.timestamp ?? from),
        },
      });
      void broadcast({ kind: 'captured', capture: saved });
      return { ok: true, capture: saved };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /** Chrome: tabs whose session records the microphone in the offscreen page. One at a time. */
  const voiced = new Set<number>();
  async function microphone(kind: OffscreenRequest['kind']): Promise<OffscreenReply> {
    if (kind === 'mic-start' && !(await browser.offscreen.hasDocument())) {
      await browser.offscreen.createDocument({
        url: browser.runtime.getURL('/offscreen.html'),
        reasons: ['USER_MEDIA'],
        justification: 'Records the voice of a Record mode session while the side panel is closed.',
      });
    }
    return browser.runtime.sendMessage({ target: 'offscreen', kind } satisfies OffscreenRequest);
  }
  async function endMicrophone(tabId: number, kind: 'mic-stop' | 'mic-cancel'): Promise<OffscreenReply | null> {
    if (!voiced.delete(tabId)) return null;
    const reply = await microphone(kind).catch((error: Error) => ({ ok: false as const, error: error.message }));
    if (voiced.size === 0) await browser.offscreen.closeDocument().catch(() => {});
    return reply;
  }

  async function startSession(tabId: number, voice = false): Promise<SessionStart> {
    if (buffer.mode(tabId) === undefined) return { ok: false, error: 'Lens does not collect on this site yet.' };
    if (voice && !voiced.has(tabId)) {
      if (voiced.size > 0) return { ok: false, error: 'The microphone already records a session in another tab.' };
      const started = await microphone('mic-start').catch((error: Error) => ({ ok: false as const, error: error.message }));
      if (!started.ok) {
        return { ok: false, error: `The microphone did not start: ${started.error}`, microphoneBlocked: 'blocked' in started && started.blocked };
      }
      // The tab stopped collecting while the microphone asked for permission.
      if (buffer.mode(tabId) === undefined) {
        await microphone('mic-cancel').catch(() => {});
        await browser.offscreen.closeDocument().catch(() => {});
        return { ok: false, error: 'Lens stopped collecting on this site while the microphone started.' };
      }
      voiced.add(tabId);
    }
    const startedAt = sessions.get(tabId) ?? Date.now();
    sessions.set(tabId, startedAt);
    buffer.hold(tabId, startedAt);
    actions.hold(tabId, startedAt);
    replay.hold(tabId, startedAt);
    shots.hold(tabId, startedAt);
    await browser.tabs.sendMessage(tabId, { kind: 'lens-snapshot' }).catch(() => {});
    void broadcast({ kind: 'tabChanged', tabId });
    return { ok: true, startedAt };
  }

  /** The voice of a Stop that the app did not take: the next Stop saves it with the recording. */
  const keptVoice = new Map<number, OffscreenReply | null>();
  async function stopSession(tabId: number): Promise<CaptureResult> {
    const startedAt = sessions.get(tabId);
    if (startedAt === undefined) return { ok: false, error: 'No recording runs in this tab.' };
    const voiceSoFar = keptVoice.has(tabId) ? Promise.resolve(keptVoice.get(tabId) ?? null) : endMicrophone(tabId, 'mic-stop');
    const [result, spoken] = await Promise.all([capture(tabId, null, startedAt), voiceSoFar]);
    if (!result.ok) {
      // The app did not take it (not running, say): the session and its voice stay for Stop again.
      keptVoice.set(tabId, spoken);
      return { ok: false, error: `${result.error}. The recording is kept: press Stop again when the Lens app runs` };
    }
    keptVoice.delete(tabId);
    sessions.delete(tabId);
    buffer.hold(tabId, null);
    actions.hold(tabId, null);
    replay.hold(tabId, null);
    shots.hold(tabId, null);
    void broadcast({ kind: 'tabChanged', tabId });
    if (!result.ok || !spoken) return result;
    try {
      if (!spoken.ok || !spoken.wav) throw new Error(spoken.ok ? 'it is empty' : spoken.error);
      const bytes = Uint8Array.from(atob(spoken.wav), (c) => c.charCodeAt(0));
      const audio = await client().upload(new Blob([bytes], { type: 'audio/wav' }), 'audio/wav');
      await client().request({
        method: 'addVoiceNote',
        params: { observation: result.capture.observation, startedAt: spoken.startedAt, audio },
      });
    } catch (error) {
      return { ok: false, error: `The recording was saved, but not the voice: ${(error as Error).message}` };
    }
    return result;
  }

  /** Through the debugger when attached; else the visible tab, which needs activeTab (a toolbar
   * click or the shortcut) and the tab in front. */
  async function takeScreenshot(tab: Browser.tabs.Tab): Promise<string> {
    if (tab.id !== undefined && deep?.isAttached(tab.id)) return deep.screenshot(tab.id);
    if (!tab.active && tab.id !== undefined) await browser.tabs.update(tab.id, { active: true });
    const image = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return image.slice(image.indexOf(',') + 1);
  }

  browser.runtime.onMessage.addListener((message: BackgroundRequest | RecorderMessage, sender, reply) => {
    if (message.kind === 'lens-action' || message.kind === 'lens-replay') {
      const tabId = sender.tab?.id;
      if (tabId === undefined || buffer.mode(tabId) === undefined) return;
      if (message.kind === 'lens-action') {
        actions.add(tabId, message.action);
        if (SHOT_STEPS.has(message.action.kind)) scheduleShot(tabId);
      } else replay.add(tabId, message.events);
      return;
    }
    if (message.kind === 'startSession' || message.kind === 'stopSession') {
      (message.kind === 'startSession' ? startSession(message.tabId, message.voice) : stopSession(message.tabId)).then(reply, (error: Error) =>
        reply({ ok: false, error: error.message }),
      );
      return true;
    }
    const work =
      message.kind === 'capture'
        ? capture(message.tabId, message.observation)
        : message.kind === 'tabStatus'
          ? status(message.tabId)
          : message.kind === 'lensReachable'
            ? client()
                .request({ method: 'hello' })
                .then(() => true, () => false)
            : loadProjects();
    work.then(reply, (error: Error) => reply({ ok: false, error: error.message }));
    return true;
  });

  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url && buffer.mode(tabId) !== undefined) {
      // Leaving the project's origins stops recording at once; sync then detaches. Another
      // project starts its own evidence, so an agent asking about one never gets the other's;
      // a recording keeps going until its Stop.
      const project = projectFor(originOf(change.url));
      const moved = project?.id !== projectFor(originOf(urls.get(tabId)))?.id && !sessions.has(tabId);
      if ((project && !moved) || sessions.has(tabId)) {
        buffer.record(tabId, 'navigation', { url: change.url });
        const url = sanitizeUrl(change.url);
        actions.add(tabId, { timestamp: Date.now(), kind: 'navigate', url, target: null, value: null, masked: false });
      } else stop(tabId);
    }
    if (change.url || change.status === 'complete') {
      void sync(tabId, tab.url).then(async () => {
        // A new document has no recorder yet; sync starts one only when collection begins.
        if (change.status === 'complete' && buffer.mode(tabId) !== undefined) await injectRecorder(tabId);
        await broadcast({ kind: 'tabChanged', tabId });
      });
    }
  });
  browser.tabs.onActivated.addListener(({ tabId }) => void broadcast({ kind: 'tabChanged', tabId }));
  browser.tabs.onRemoved.addListener((tabId) => {
    stop(tabId);
    urls.delete(tabId);
    queues.delete(tabId);
    void deep?.detach(tabId);
  });
  // A prerendered or discarded tab swapped in gets a new id: the old one's state goes.
  browser.tabs.onReplaced.addListener((added, removed) => {
    stop(removed);
    urls.delete(removed);
    queues.delete(removed);
    void deep?.detach(removed);
    void browser.tabs.get(added).then((tab) => sync(added, tab.url), () => {});
  });
  browser.permissions.onAdded.addListener(() => void loadProjects());
  browser.permissions.onRemoved.addListener(() => void loadProjects());

  // The toolbar button opens the notebook beside the page; the shortcut also captures at once.
  if (import.meta.env.FIREFOX) {
    const { sidebarAction } = browser as unknown as { sidebarAction: { toggle(): Promise<void>; open(): Promise<void> } };
    browser.action.onClicked.addListener(() => sidebarAction.toggle());
    browser.commands.onCommand.addListener((command, tab) => {
      if (command !== 'capture' || tab?.id === undefined) return;
      void sidebarAction.open();
      void capture(tab.id, null);
    });
  } else {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    browser.commands.onCommand.addListener((command, tab) => {
      if (command !== 'capture' || tab?.id === undefined) return;
      void browser.sidePanel.open({ tabId: tab.id });
      void capture(tab.id, null);
    });
  }

  /**
   * Live evidence for coding agents, when the person turned it on in Settings: one request waits
   * for an agent's question, on a connection of its own, while Lens collects on a tab. The answer
   * is the same buffer a capture takes, without the screenshot, the shots and the replay.
   */
  let agentsLive = false;
  let serving = false;
  const LIVE_KEY = 'lens.agentsLive';
  async function serveAgents() {
    if (serving) return;
    serving = true;
    const poller = new LensClient();
    let after = 0;
    try {
      while (agentsLive) {
        const collecting = (await browser.tabs.query({})).filter((t) => t.id !== undefined && buffer.mode(t.id) !== undefined);
        if (collecting.length === 0 || paused) {
          await new Promise((done) => setTimeout(done, 5000));
          continue;
        }
        const ask = await poller.request({ method: 'waitForAsk', params: { after } });
        if (!ask) continue;
        after = ask.id;
        // The person may have paused Lens or turned this off while the question waited.
        paused = (await poller.request({ method: 'hello' })).paused;
        if (!agentsLive || paused) {
          await poller.request({ method: 'provideEvidence', params: { ask: ask.id, tabs: [] } });
          continue;
        }
        const from = Date.now() - WINDOW_MS;
        const tabs = [];
        for (const tab of await browser.tabs.query({})) {
          if (tab.id === undefined || buffer.mode(tab.id) === undefined) continue;
          let host = '';
          try {
            host = new URL(tab.url ?? '').hostname;
          } catch {
            continue;
          }
          if (ask.site && host !== ask.site && !host.endsWith(`.${ask.site}`)) continue;
          const snapshot = buffer.snapshot(tab.id, from);
          if (!snapshot) continue;
          tabs.push({
            url: sanitizeUrl(tab.url ?? ''),
            title: sanitizeText(tab.title ?? ''),
            evidence: { ...snapshot, page: null, actions: actions.snapshot(tab.id, from), elements: [] } as unknown as JsonValue,
          });
        }
        await poller.request({ method: 'provideEvidence', params: { ask: ask.id, tabs } });
      }
    } catch {
      // Lens stopped or restarted: try again soon.
      setTimeout(() => void serveAgents(), 10_000);
    } finally {
      poller.disconnect();
      serving = false;
    }
  }
  void browser.storage.local.get(LIVE_KEY).then((found) => {
    agentsLive = found[LIVE_KEY] === true;
    if (agentsLive) void serveAgents();
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(LIVE_KEY in changes)) return;
    agentsLive = changes[LIVE_KEY]?.newValue === true;
    if (agentsLive) void serveAgents();
  });

  void loadProjects();
  // A restarted background has no sessions: a microphone page left from before records nothing
  // anyone can save, and open panels must stop showing a recording.
  if (!import.meta.env.FIREFOX) {
    void browser.offscreen
      .hasDocument()
      .then((open) => {
        if (open && voiced.size === 0) return browser.offscreen.closeDocument();
      })
      .catch(() => {});
  }
  void broadcast({ kind: 'tabChanged', tabId: -1 });
  // Pause and resume come from the Lens menu, outside the browser: check for them regularly.
  setInterval(() => {
    const before = paused;
    void loadProjects().then(() => {
      if (before !== paused) void broadcast({ kind: 'tabChanged', tabId: -1 });
    });
  }, 15_000);
});

function broadcast(message: Broadcast) {
  return browser.runtime.sendMessage(message).catch(() => {});
}

/** Facts about the page that the screenshot cannot show. Runs in the page's isolated world. */
async function pageSnapshot(tabId: number) {
  const [result] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => ({
      title: document.title,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
        scrollX,
        scrollY,
      },
      language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      online: navigator.onLine,
      userAgent: navigator.userAgent,
      // Which build ran: a version meta tag, Next.js's build ID, or a data attribute on <html>.
      buildId: (() => {
        const meta = document.querySelector(
          ['build-sha', 'git-commit', 'git-sha', 'commit', 'commit-sha', 'build-id', 'build', 'version', 'app-version', 'release', 'sentry-release']
            .map((name) => `meta[name="${name}"],meta[property="${name}"]`)
            .join(','),
        );
        const fromMeta = meta?.getAttribute('content');
        if (fromMeta) return fromMeta.slice(0, 120);
        const html = document.documentElement;
        const fromHtml = html.dataset.build ?? html.dataset.version ?? html.dataset.commit;
        if (fromHtml) return fromHtml.slice(0, 120);
        try {
          const next = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent ?? 'null') as { buildId?: string } | null;
          if (next?.buildId) return `next:${next.buildId}`.slice(0, 120);
        } catch {
          // Not a Next.js page.
        }
        // The App Router has no __NEXT_DATA__; its build ID names the manifest's folder.
        const manifest = [...document.scripts].map((x) => x.src).find((src) => /\/_next\/static\/[^/]+\/_(build|ssg)Manifest\.js/.test(src));
        const id = manifest?.match(/\/_next\/static\/([^/]+)\//)?.[1];
        return id ? `next:${id}`.slice(0, 120) : null;
      })(),
      // A site can say what the defect depends on: account role, feature flags, release.
      // <script type="application/json" id="lens-context">{...}</script>
      context: (() => {
        const text = document.querySelector('script#lens-context[type="application/json"]')?.textContent ?? '';
        if (!text || text.length > 8192) return null;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return null;
        }
      })(),
    }),
  });
  // The context comes from the site: the redaction rules apply to it like to any evidence.
  return sanitize(result?.result ?? null) as JsonValue | null;
}

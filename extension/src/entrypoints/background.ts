import { ActionLog, EvidenceBuffer, ReplayBuffer, ShotBuffer, WINDOW_MS, type ReplayEvent } from '@/collector/buffer';
import { DeepCollector } from '@/collector/deep';
import { LimitedCollector, captureTab, visibleShot } from '@/collector/limited';
import { maskShot, privateRects } from '@/collector/shot-mask';
import { PRIVACY_KEY, privacySettings, sanitize, sanitizeText, sanitizeUrl, setCustomRedaction } from '@/collector/sanitize';
import { BackgroundLensClient as LensClient } from '@/engine/bg-client';
import { clientInfo } from '@/identity';
import {
  originOf,
  sitePattern,
  type BackgroundRequest,
  type Broadcast,
  type CaptureResult,
  OFFSCREEN_PART_BYTES,
  type OffscreenReply,
  type OffscreenRequest,
  type RecordedVideoRef,
  type SessionStart,
  type TabStatus,
} from '@/messages';
import type { Project } from '@/protocol/Project';
import type { JsonValue } from '@/protocol/serde_json/JsonValue';
import type { CoverageGap } from '@/protocol/CoverageGap';
import type { Action } from '@/protocol/Action';
import type { PageElement } from '@/protocol/PageElement';
import type { BlobRef } from '@/protocol/BlobRef';
import type { Prepared, RecorderMessage } from './recorder.content';
import { spool, spooled, unspool } from '@/voice-spool';
import * as evidence from '@/collector/evidence-spool';

/** A recording uploads in chunks; past this it is left out with a gap. */
const MAX_RECORDING_BYTES = 256 * 1024 * 1024;
/** An inline screenshot (base64) the app's 16 MiB request limit still takes, with the evidence. */
const MAX_INLINE_SCREENSHOT = 12 * 1024 * 1024;

/** The voice of a Chrome session, as the offscreen page recorded it. */
type Spoken = { ok: true; startedAt: number; wav: Blob | null } | { ok: false; error: string };

export default defineBackground(() => {
  const buffer = new EvidenceBuffer();
  const actions = new ActionLog();
  const replay = new ReplayBuffer();
  const shots = new ShotBuffer();
  const shotTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const cancelShot = (tabId: number) => {
    clearTimeout(shotTimers.get(tabId));
    shotTimers.delete(tabId);
  };
  /** A shot shows a step's result: taken this long after the last of a quick series of steps. */
  const SHOT_DELAY_MS = 700;
  const SHOT_STEPS = new Set(['click', 'press', 'select', 'check', 'uncheck']);
  function scheduleShot(tabId: number) {
    if (deep && !deep.isAttached(tabId)) return;
    if (!collecting(tabId)) return;
    clearTimeout(shotTimers.get(tabId));
    shotTimers.set(
      tabId,
      setTimeout(() => {
        shotTimers.delete(tabId);
        const at = Date.now();
        void (async () => {
          const page = async () => (await browser.tabs.get(tabId).catch(() => null))?.url;
          const before = await page();
          // Where the private fields are, just before the shot: without that, no shot.
          const found = await browser.scripting
            .executeScript({ target: { tabId }, func: privateRects, args: [maskSelectors] })
            .then((results) => results[0]?.result ?? null, () => null);
          if (!found) return;
          const raw = await (deep ? deep.shot(tabId) : visibleShot(tabId));
          // Another page by now: the rectangles describe the old one, so they would mask the wrong places.
          if (!before || (await page()) !== before) return;
          const data = raw && (await maskShot(raw, found));
          if (data && collecting(tabId)) shots.add(tabId, at, data);
        })();
      }, SHOT_DELAY_MS),
    );
  }
  /** Record mode: the tabs with a running session, and when each started. */
  const sessions = new Map<number, number>();

  /**
   * What a running recording collects also goes to the evidence spool, in batches: every few
   * seconds, and at once after each step. A worker the browser stopped then loses at most the
   * last batch (see restore and resume).
   */
  const SPOOL_MS = 3000;
  const batches = new Map<number, evidence.Batch>();
  /** Bytes each recording's spool holds; past MAX_SPOOL_BYTES it is written again from memory. */
  const spoolBytes = new Map<number, number>();
  const tap =
    <K extends evidence.Kind>(kind: K) =>
    (tabId: number, items: evidence.Batch[K]) => {
      // A restored recording spools again only after its earlier spool is read back.
      if (!sessions.has(tabId) || restored.has(tabId)) return;
      const batch = batches.get(tabId) ?? evidence.emptyBatch();
      (batch[kind] as unknown[]).push(...items);
      batches.set(tabId, batch);
      if (kind === 'actions') void flushEvidence();
    };
  buffer.onAdd = tap('events');
  actions.onAdd = tap('actions');
  replay.onAdd = tap('replay');
  shots.onAdd = tap('shots');
  let flushing: Promise<void> = Promise.resolve();
  function flushEvidence(): Promise<void> {
    flushing = flushing.then(async () => {
      if (!batches.size) return;
      const chunks: evidence.Chunk[] = [];
      const states: evidence.State[] = [];
      const fresh: number[] = [];
      for (const [tabId, batch] of batches) {
        const session = sessions.get(tabId);
        if (session === undefined) continue;
        let written = evidence.KINDS.filter((kind) => batch[kind].length).map((kind) => evidence.chunk(session, kind, batch[kind]));
        let bytes = (spoolBytes.get(session) ?? 0) + written.reduce((sum, c) => sum + c.bytes, 0);
        if (bytes > evidence.MAX_SPOOL_BYTES) {
          // Memory keeps to its caps and the spool only grows: then the spool starts again from memory.
          fresh.push(session);
          written = [
            evidence.chunk(session, 'events', buffer.snapshot(tabId, session)?.events ?? []),
            evidence.chunk(session, 'actions', actions.snapshot(tabId, session)),
            evidence.chunk(session, 'replay', replay.slice(tabId, session)),
            evidence.chunk(session, 'shots', shots.since(tabId, session)),
          ];
          bytes = written.reduce((sum, c) => sum + c.bytes, 0);
        }
        spoolBytes.set(session, bytes);
        chunks.push(...written);
        const meta = buffer.snapshot(tabId, Number.MAX_SAFE_INTEGER);
        states.push({ session, tab: tabId, savedAt: Date.now(), gaps: meta?.gaps ?? [], dropped: meta?.dropped ?? {} });
      }
      batches.clear();
      await evidence.write(chunks, states, fresh).catch(() => {});
    });
    return flushing;
  }
  setInterval(() => void flushEvidence(), SPOOL_MS);
  /** The recording ended or went: its spool goes too. */
  function dropEvidence(tabId: number, session: number | undefined) {
    batches.delete(tabId);
    if (session === undefined) return;
    spoolBytes.delete(session);
    // After any write in flight, so a late batch cannot bring the spool back.
    void flushing.then(() => evidence.remove([session])).catch(() => {});
  }
  /** Recording tabs on a site outside the project: the recording waits, nothing is collected. */
  const offProject = new Set<number>();
  const collecting = (tabId: number) => buffer.mode(tabId) !== undefined && !offProject.has(tabId);
  const INCOGNITO = Boolean((browser.extension as { inIncognitoContext?: boolean } | undefined)?.inIncognitoContext);
  const DECLINED_KEY = INCOGNITO ? 'lens.debuggerDeclined.incognito' : 'lens.debuggerDeclined';
  const urls = new Map<number, string>();
  const deep = DeepCollector.available()
    ? new DeepCollector(
        buffer,
        (tabId) => urls.get(tabId),
        () => {
          void browser.storage.session.set({ [DECLINED_KEY]: true }).catch(() => {});
          void broadcast({ kind: 'tabChanged', tabId: -1 });
        },
      )
    : undefined;
  if (!deep) new LimitedCollector(buffer, collecting).listen();

  let projects: Project[] = [];
  let paused = false;
  let lens: LensClient | null = null;
  const client = () => (lens ??= new LensClient(() => (lens = null)));

  const projectFor = (origin: string | null) =>
    origin ? projects.find((p) => p.enabled && p.origins.includes(origin)) : undefined;
  const permitted = (origin: string | null) =>
    origin ? browser.permissions.contains({ origins: [sitePattern(origin)] }) : Promise.resolve(false);

  const queues = new Map<number, Promise<void>>();
  /** Done when the recordings of an earlier worker are restored (set at the end of this script). */
  let restoring: Promise<void> = Promise.resolve();
  /**
   * Done when, after that, the projects are known too: before them every site looks outside the
   * project. Messages and commands wait for this (set at the end of this script).
   */
  let ready: Promise<void> = Promise.resolve();

  /**
   * Starts or stops collection on a tab to match the projects and the granted origins. Calls for one
   * tab run in order, and each works on the tab's latest URL, so a navigation during an await can
   * never leave the debugger on a site the person did not grant.
   */
  function sync(tabId: number, url: string | undefined): Promise<void> {
    if (url) urls.set(tabId, url);
    // The first sync of a tab waits for the recordings of an earlier worker.
    // Not `ready`: the first loadProjects syncs every tab, and it is part of `ready`.
    const next = (queues.get(tabId) ?? restoring)
      .then(() => syncNow(tabId))
      .then(() => resume(tabId))
      .catch(() => {});
    queues.set(tabId, next);
    return next;
  }

  async function allowed(tabId: number) {
    const origin = originOf(urls.get(tabId));
    return !paused && Boolean(projectFor(origin)) && (await permitted(origin));
  }

  async function syncNow(tabId: number) {
    if (!(await allowed(tabId))) {
      // The person took this site away (removed its grant, or turned its project off): that is
      // no redirect, so the recording ends, microphone and all.
      const origin = originOf(urls.get(tabId));
      const known = origin ? projects.find((p) => p.origins.includes(origin)) : undefined;
      const revoked = known !== undefined && (!known.enabled || !(await permitted(origin)));
      // A recording keeps what it has when the tab passes through another site (a sign-in or
      // payment redirect); nothing is collected there, and collection resumes on the way back.
      if (sessions.has(tabId) && !paused && !revoked) {
        offProject.add(tabId);
        cancelShot(tabId);
        buffer.gap(tabId, 'navigation', 'The tab left the project sites: nothing was recorded there');
        await deep?.detach(tabId);
        return;
      }
      const ended = sessions.has(tabId);
      stop(tabId);
      await deep?.detach(tabId);
      if (ended) void broadcast({ kind: 'tabChanged', tabId });
      return;
    }
    offProject.delete(tabId);
    if (deep?.isDeclined()) {
      if (buffer.mode(tabId) !== 'screenshotOnly') {
        void injectRecorder(tabId);
        buffer.start(tabId, 'screenshotOnly');
      }
      return;
    }
    if (buffer.mode(tabId) !== undefined && (!deep || deep.isAttached(tabId))) return;
    void injectRecorder(tabId);
    if (!deep) return buffer.start(tabId, 'limited');
    buffer.start(tabId, 'deep');
    try {
      await deep.attach(tabId);
    } catch (error) {
      buffer.start(tabId, 'screenshotOnly');
      buffer.gap(tabId, 'debugger', `The browser refused the debugger: ${(error as Error).message}`);
    }
    if (deep.isDeclined()) {
      buffer.start(tabId, 'screenshotOnly');
      return;
    }
    // The tab moved on during the attach: the same choice as above, so a recording that went to
    // another site (a redirect) waits there instead of ending.
    if (!(await allowed(tabId))) return syncNow(tabId);
  }

  /**
   * Chrome stops a service worker after 30 s without events, and a browser can restart it any
   * time: the recordings in memory would be gone, and the panel would show Record again. So who
   * records what is kept in storage.session, and a new worker continues those recordings with the
   * evidence spool; it loses only the last batch and the time it was down, and says so in a gap.
   * While a recording runs, an extension call every 20 s keeps the worker (Chrome 110 and later),
   * and an alarm wakes it when it stopped anyway.
   */
  // In Chrome's split incognito mode, normal and incognito workers share storage.session: keep
  // each context's running recordings under its own key so they never overwrite or vanish each other.
  const SESSIONS_KEY = INCOGNITO ? 'lens.sessions.incognito' : 'lens.sessions';
  type Checkpoint = { sessions: [number, number][]; offProject: number[]; voiced: number[] };
  let saved = '';
  let alive: ReturnType<typeof setInterval> | undefined;
  /** A new worker cannot know whether an earlier one left the alarm: it clears it once. */
  let alarmChecked = false;
  function checkpoint() {
    badge();
    const now: Checkpoint = { sessions: [...sessions], offProject: [...offProject], voiced: [...voiced] };
    const text = JSON.stringify(now);
    if (text !== saved) {
      saved = text;
      void browser.storage.session.set({ [SESSIONS_KEY]: now }).catch(() => {});
    }
    if (sessions.size > 0 && alive === undefined) {
      alive = setInterval(() => void browser.runtime.getPlatformInfo().catch(() => {}), 20_000);
      void browser.alarms?.create(SESSIONS_KEY, { periodInMinutes: 0.5 });
    } else if (sessions.size === 0 && (alive !== undefined || !alarmChecked)) {
      clearInterval(alive);
      alive = undefined;
      void browser.alarms?.clear(SESSIONS_KEY);
    }
    alarmChecked = true;
  }
  // The alarm's work is the wake itself: this script then restores the recordings.
  browser.alarms?.onAlarm.addListener(() => {});

  /** Recordings an earlier worker started: they continue once their tab collects again. */
  const restored = new Set<number>();
  /**
   * Recordings of tabs that were gone at restore: a prerendered page swapped in while the worker
   * slept has a new tab id, and its onReplaced comes after the restore. Then the recording moves.
   */
  const vanished = new Map<number, { startedAt: number; off: boolean; voiced: boolean }>();
  async function restore() {
    const found = await browser.storage.session.get([SESSIONS_KEY, DECLINED_KEY]).catch(() => ({}) as Record<string, unknown>);
    // Only set true, never false: onDetach('canceled_by_user') may have fired while this read was in flight.
    if (found[DECLINED_KEY] === true) deep?.setDeclined(true);
    const earlier = found[SESSIONS_KEY] as Checkpoint | undefined;
    if (!earlier) return checkpoint(), void cleanSpool();
    const open = new Set((await browser.tabs.query({})).map((t) => t.id));
    // The microphone page outlives the worker: its voice still belongs to the recording.
    const microphoneOpen = !import.meta.env.FIREFOX && (await browser.offscreen.hasDocument().catch(() => false));
    for (const [tabId, startedAt] of earlier.sessions) {
      const off = earlier.offProject.includes(tabId);
      const voice = microphoneOpen && earlier.voiced.includes(tabId);
      if (!open.has(tabId)) {
        vanished.set(tabId, { startedAt, off, voiced: voice });
        continue;
      }
      sessions.set(tabId, startedAt);
      restored.add(tabId);
      if (off) offProject.add(tabId);
      if (voice) voiced.add(tabId);
    }
    checkpoint();
    void cleanSpool();
  }
  /** Spools of recordings that ended while no worker ran (a crash, a closed tab), or are old. */
  async function cleanSpool() {
    const live = new Set([...sessions.values(), ...[...vanished.values()].map((v) => v.startedAt)]);
    await evidence
      .list()
      .then((states) => evidence.remove(evidence.stale(states, live, Date.now())))
      .catch(() => {});
  }
  /** Holds what a tab's recording needs, from its start on; null releases it. */
  function holdAll(tabId: number, from: number | null) {
    buffer.hold(tabId, from);
    actions.hold(tabId, from);
    replay.hold(tabId, from);
    shots.hold(tabId, from);
  }
  /**
   * After a sync: a restored recording resumes once its tab collects, with what the earlier worker
   * spooled in front of what this one collected since. The state is saved.
   */
  async function resume(tabId: number) {
    const session = sessions.get(tabId);
    if (session !== undefined && restored.has(tabId) && collecting(tabId)) {
      holdAll(tabId, session);
      const found = await evidence.read(session).catch(() => null);
      // The tab may have gone or stopped while the spool was read.
      if (sessions.get(tabId) === session && restored.has(tabId)) {
        if (found) {
          const lost = { channel: 'collector', reason: 'The browser restarted Lens in the background: nothing was recorded for this time', startedAt: found.savedAt, endedAt: Date.now() };
          buffer.restore(tabId, found.events, [...found.gaps, lost], found.dropped);
          actions.restore(tabId, found.actions);
          replay.restore(tabId, found.replay);
          shots.restore(tabId, found.shots);
        } else {
          buffer.gap(tabId, 'collector', 'The browser restarted Lens in the background: what was recorded before is lost');
        }
        restored.delete(tabId);
        // What this worker collected until now went to memory only (see tap): the spool is
        // written again from memory, which now holds it all.
        spoolBytes.set(session, Number.POSITIVE_INFINITY);
        batches.set(tabId, batches.get(tabId) ?? evidence.emptyBatch());
        void flushEvidence();
        // The replay needs a fresh copy of the page to go on from.
        void browser.tabs.sendMessage(tabId, { kind: 'lens-snapshot' }).catch(() => {});
      }
    }
    checkpoint();
  }

  function stop(tabId: number) {
    const session = sessions.get(tabId);
    dropEvidence(tabId, session);
    // Also Firefox's, which the sidebar wrote: a tab that closes without the sidebar leaves it.
    if (session !== undefined) void unspool(tabId, session);
    restored.delete(tabId);
    buffer.stop(tabId);
    actions.clear(tabId);
    replay.clear(tabId);
    shots.clear(tabId);
    cancelShot(tabId);
    sessions.delete(tabId);
    offProject.delete(tabId);
    keptVoice.delete(tabId);
    void endMicrophone(tabId, 'mic-cancel');
    checkpoint();
  }

  /**
   * The recorder also starts with each page of a granted, enabled project, when the page starts
   * to load: steps taken while a slow page loads are recorded too. It records nothing until this
   * script says the tab collects (lens-should-record). Ports are left out of the patterns, as
   * Firefox's match patterns take none: the recorder's question keeps other ports out.
   */
  const RECORDER = 'lens-recorder';
  let registered: string | null = null;
  // One at a time: two at once both find no script, and the second registration fails.
  let registering: Promise<void> = Promise.resolve();
  function registerRecorder() {
    registering = registering.then(registerNow, registerNow);
    return registering;
  }
  async function registerNow() {
    const origins: string[] = [];
    for (const project of paused ? [] : projects.filter((p) => p.enabled)) {
      for (const origin of project.origins) if (await permitted(origin).catch(() => false)) origins.push(origin);
    }
    const matches = [...new Set(origins.map((origin) => `${new URL(origin).protocol}//${new URL(origin).hostname}/*`))].sort();
    const key = JSON.stringify(matches);
    if (key === registered) return;
    try {
      // In Chrome's split incognito mode, normal and incognito workers share the registered script
      // list, so either worker can register or remove it between our check and our write.
      const found = await browser.scripting.getRegisteredContentScripts({ ids: [RECORDER] });
      if (!matches.length) {
        if (found.length) {
          await browser.scripting.unregisterContentScripts({ ids: [RECORDER] }).catch(async (error) => {
            if ((await browser.scripting.getRegisteredContentScripts({ ids: [RECORDER] })).length) throw error;
          });
        }
      } else {
        const script = { id: RECORDER, js: ['content-scripts/recorder.js'], matches, runAt: 'document_start' as const, persistAcrossSessions: false };
        await (found.length
          ? browser.scripting.updateContentScripts([script]).catch(() => browser.scripting.registerContentScripts([script]))
          : browser.scripting.registerContentScripts([script]).catch(() => browser.scripting.updateContentScripts([script])));
      }
      registered = key;
    } catch {
      // The next look at the projects (every 15 s) tries again; executeScript still starts the
      // recorder once a page has loaded.
    }
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

  /**
   * The person's own redaction rules: the app keeps them (Settings); this copy in storage.local
   * serves the recorder in each page and a worker that starts while the app is away.
   */
  let maskSelectors: string[] = [];
  let privacyKnown = '';
  function applyPrivacy(raw: unknown) {
    const settings = privacySettings(raw);
    setCustomRedaction(settings);
    maskSelectors = settings.maskSelectors;
    privacyKnown = JSON.stringify(settings);
  }
  void browser.storage.local.get(PRIVACY_KEY).then((found) => applyPrivacy(found[PRIVACY_KEY]), () => {});
  async function loadPrivacy() {
    // An app older than these settings answers with an error: the stored rules stay.
    const fromApp = await client()
      .request({ method: 'getPrivacySettings' } as never)
      .then((answer: unknown) => answer, () => undefined);
    if (fromApp === undefined || fromApp === null) return;
    const settings = privacySettings(fromApp);
    if (JSON.stringify(settings) === privacyKnown) return;
    applyPrivacy(settings);
    await browser.storage.local.set({ [PRIVACY_KEY]: settings }).catch(() => {});
  }

  // Normal and incognito workers do not receive each other's runtime.sendMessage: mirror
  // projectsChanged through shared storage.local so adding or toggling a site takes effect in both.
  const PROJECTS_SYNC_KEY = 'lens.projectsSync';
  let lastProjectsSync = '';
  async function notifyProjectsChanged() {
    await loadProjects();
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    lastProjectsSync = token;
    void browser.storage.local.set({ [PROJECTS_SYNC_KEY]: token }).catch(() => {});
  }

  async function loadProjects() {
    try {
      paused = (await client().request({ method: 'hello' })).paused;
      projects = await client().request({ method: 'listProjects' });
      await loadPrivacy();
      // Setup's checklist learns from this that the extension is installed, connected and current.
      await client().request({ method: 'announce', params: await clientInfo() });
    } catch {
      // The app restarts (an update) or is gone: keep the projects known so far. Emptying them
      // would stop every tab's collection and end a running recording before its Stop.
    }
    await syncAll();
    await registerRecorder();
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
      debuggerDeclined: deep?.isDeclined() || undefined,
      recorder: buffer.mode(tabId) === undefined ? null : await recorderRuns(tabId),
      hasHeavyMedia: collecting(tabId) ? await detectHeavyMedia(tabId) : undefined,
    };
  }

  /** Whether the tab's recorder answers. A page still loading gets the benefit of the doubt. */
  async function recorderRuns(tabId: number): Promise<boolean> {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (tab?.status === 'loading') return true;
    return Promise.race([
      browser.tabs.sendMessage(tabId, { kind: 'lens-ping' }).then((answer) => answer === true, () => false),
      new Promise<boolean>((done) => setTimeout(() => done(true), 1000)),
    ]);
  }

  /**
   * Saves what the tab recorded during a session: the replay, the steps, network and console,
   * and a screenshot of now.
   */
  async function capture(
    tabId: number,
    observation: number | null,
    session: number | null = null,
    /** Runs just before the capture is saved; when it fails, nothing is saved. */
    beforeSave?: () => Promise<void>,
  ): Promise<CaptureResult> {
    try {
      const from = session ?? Date.now() - WINDOW_MS;
      const tab = await browser.tabs.get(tabId);
      const shotGaps: CoverageGap[] = [];
      // As a blob: a 10 MiB PNG in base64 would pass the app's request limit on its own. A Lens
      // app older than 0.12.18 takes no PNG uploads: then the screenshot goes inline, as it did.
      const shot = await maskedScreenshot(tab, shotGaps);
      const png = shot === null ? null : Uint8Array.from(atob(shot), (c) => c.charCodeAt(0));
      const screenshotBlob = !png
        ? null
        : await client()
            .upload(new Blob([png], { type: 'image/png' }), 'image/png')
            .catch((error: Error) => {
              if (shot!.length > MAX_INLINE_SCREENSHOT) throw error;
              return null;
            });
      const snapshot = buffer.snapshot(tabId, from) ?? {
        mode: 'screenshotOnly' as const,
        events: [],
        dropped: {},
        gaps: [{ channel: 'collector', reason: 'Lens does not collect evidence on this site', startedAt: Date.now(), endedAt: null }],
      };
      snapshot.gaps.push(...shotGaps);
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
      // A missing picture never holds a recording back: the steps, voice and evidence are saved.
      if (shot === null && !recording && !shotGaps.length) {
        snapshot.gaps.push({
          channel: 'screenshot',
          reason: 'No screenshot: Firefox takes one only with access to all sites, and this page had no replay to make one from',
          startedAt: Date.now(),
          endedAt: null,
        });
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
      await beforeSave?.();
      const saved = await client().request({
        method: 'createCapture',
        params: {
          observation,
          pageUrl: sanitizeUrl(tab.url ?? ''),
          pageTitle: sanitizeText(tab.title ?? ''),
          screenshot: screenshotBlob || shot === null ? '' : shot,
          // An older app knows no such field: it goes only with a blob that app took.
          ...(screenshotBlob ? { screenshotBlob } : {}),
          // No picture from the browser: the app renders it, and the step shots, from the replay.
          ...(shot === null ? { renderScreenshot: true } : {}),
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
  /** A microphone start runs: no other may start, and nothing closes the offscreen page meanwhile. */
  let micStarting = false;
  /** The last close of the offscreen page: a start waits for it, or it would close the new microphone. */
  let micClosing: Promise<void> = Promise.resolve();
  const closeMicrophonePage = () => (micClosing = browser.offscreen.closeDocument().catch(() => {}));
  async function offscreen(message: OffscreenRequest): Promise<OffscreenReply> {
    const starts = message.kind === 'mic-start';
    if (starts) await micClosing;
    if (starts && !(await browser.offscreen.hasDocument())) {
      await browser.offscreen.createDocument({
        url: browser.runtime.getURL('/offscreen.html'),
        reasons: ['USER_MEDIA'],
        justification: 'Records the voice of a Record mode session while the side panel is closed.',
      });
    }
    return browser.runtime.sendMessage(message);
  }
  const microphone = (kind: 'mic-start' | 'mic-stop' | 'mic-cancel') => offscreen({ target: 'offscreen', kind });
  /** Nothing records in the offscreen page any more: it may close. */
  const offscreenIdle = () => voiced.size === 0 && !micStarting;
  /** The offscreen page's WAV `id`, read in parts: one message carries at most 64 MiB. */
  async function readWav(id: number, size: number): Promise<Blob> {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let offset = 0; offset < size; offset += OFFSCREEN_PART_BYTES) {
      const part: OffscreenReply = await browser.runtime.sendMessage({ target: 'offscreen', kind: 'mic-part', id, offset } satisfies OffscreenRequest);
      if (!part.ok || !part.wav) throw new Error(part.ok ? 'the recording broke off' : part.error);
      const bytes = Uint8Array.from(atob(part.wav), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
      // A short part would shift every sample after it.
      if (bytes.length !== Math.min(OFFSCREEN_PART_BYTES, size - offset)) throw new Error('a part of the recording is missing');
      parts.push(bytes);
    }
    return new Blob(parts, { type: 'audio/wav' });
  }

  /** Whether the page shows a large canvas (2D or WebGL) or a video: the replay shows them blank. */
  async function detectHeavyMedia(tabId: number): Promise<boolean | undefined> {
    return browser.scripting
      .executeScript({
        target: { tabId },
        // Sizes only: asking a canvas for its context would give it one.
        func: () =>
          [...document.querySelectorAll('canvas, video')].some((el) => {
            const r = el.getBoundingClientRect();
            return el.tagName === 'VIDEO' ? r.width * r.height > 0 : r.width >= 200 && r.height >= 150;
          }),
      })
      .then(([found]) => found?.result ?? undefined, () => undefined);
  }

  /**
   * The toolbar badge: the time of the longest running recording, in red, every second; after a
   * shortcut, a short sign for a moment.
   */
  let badgeTimer: ReturnType<typeof setInterval> | undefined;
  let flash: { text: string; color: string; until: number } | null = null;
  let shownBadge = '';
  // Action badge text is shared across normal and incognito windows in Chrome's split mode: an
  // idle worker clears the badge only if it was the one that set it.
  let badgeOwned = false;
  function badge() {
    const now = Date.now();
    if (flash && flash.until <= now) flash = null;
    const seconds = sessions.size ? Math.max(0, Math.floor((now - Math.min(...sessions.values())) / 1000)) : 0;
    const time =
      seconds < 600 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : seconds < 6000 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
    const text = flash?.text ?? (sessions.size ? time : '');
    const color = flash?.color ?? '#e11d48';
    const next = text ? `${text} ${color}` : '';
    if (next !== shownBadge && (text !== '' || badgeOwned)) {
      shownBadge = next;
      badgeOwned = text !== '';
      if (text) void browser.action.setBadgeBackgroundColor({ color }).catch(() => {});
      void browser.action.setBadgeText({ text }).catch(() => {});
    }
    const live = sessions.size > 0 || flash !== null;
    if (live && badgeTimer === undefined) badgeTimer = setInterval(badge, 1000);
    if (!live && badgeTimer !== undefined) {
      clearInterval(badgeTimer);
      badgeTimer = undefined;
    }
  }
  function flashBadge(text: string, color: string) {
    flash = { text, color, until: Date.now() + 1500 };
    badge();
  }

  /** A marker at this moment of the tab's recording, in its evidence and its replay. */
  function dropMarker(tabId: number, label?: string): { ok: true; at: number } | { ok: false; error: string } {
    if (!sessions.has(tabId) || !collecting(tabId)) return { ok: false, error: 'No recording runs in this tab.' };
    const at = Date.now();
    const text = sanitizeText((label ?? '').trim().slice(0, 200)) || 'Marker';
    buffer.record(tabId, 'marker', { label: text });
    replay.add(tabId, [{ type: 5, timestamp: at, data: { tag: 'lens-marker', payload: { label: text } } } as ReplayEvent]);
    flashBadge('✓', '#16a34a');
    return { ok: true, at };
  }

  /** The recording shortcuts: they work with the panel closed too. A refusal shows "!" on the badge. */
  function shortcut(command: string, tabId: number) {
    const refused = (result: { ok: boolean }) => void (result.ok || flashBadge('!', '#6b7280'));
    if (command === 'toggle-recording') {
      void ready
        .then((): Promise<{ ok: boolean }> => (sessions.has(tabId) ? stopSession(tabId) : startSession(tabId)))
        .then(refused, () => refused({ ok: false }));
    } else if (command === 'drop-marker') {
      void ready.then(() => refused(dropMarker(tabId)));
    }
  }
  /** Tabs whose microphone is ending: it stays theirs until its WAV is read, so no new start takes it. */
  const ending = new Set<number>();
  async function endMicrophone(tabId: number, kind: 'mic-stop' | 'mic-cancel'): Promise<Spoken | null> {
    if (!voiced.has(tabId) || ending.has(tabId)) return null;
    ending.add(tabId);
    let reply: Spoken;
    try {
      const ended = await microphone(kind);
      reply = !ended.ok
        ? ended
        : {
            ok: true,
            startedAt: ended.startedAt,
            wav: kind === 'mic-stop' && ended.size && ended.id !== undefined ? await readWav(ended.id, ended.size) : null,
          };
    } catch (error) {
      reply = { ok: false, error: (error as Error).message };
    } finally {
      ending.delete(tabId);
      voiced.delete(tabId);
      checkpoint();
    }
    if (offscreenIdle()) await closeMicrophonePage();
    return reply;
  }

  // A start in progress per tab: a second start (two panels, a double click) gets the same answer
  // instead of starting the microphone again, which would cancel the first start's voice.
  const starting = new Map<number, Promise<SessionStart>>();
  function startSession(tabId: number, voice = false): Promise<SessionStart> {
    const running = starting.get(tabId);
    if (running) return running;
    const start = beginSession(tabId, voice).finally(() => starting.delete(tabId));
    starting.set(tabId, start);
    return start;
  }

  async function resumeDebugger(tabId?: number) {
    if (!deep) return;
    deep.setDeclined(false);
    await browser.storage.session.remove(DECLINED_KEY).catch(() => {});
    if (tabId !== undefined) {
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (tab) await sync(tabId, tab.url);
    } else {
      await syncAll();
    }
    void broadcast({ kind: 'tabChanged', tabId: tabId ?? -1 });
  }

  async function beginSession(tabId: number, voice: boolean): Promise<SessionStart> {
    if (deep?.isDeclined()) await resumeDebugger(tabId);
    if (buffer.mode(tabId) === undefined) return { ok: false, error: 'Lens does not collect on this site yet.' };
    if (voice && !voiced.has(tabId)) {
      if (voiced.size > 0 || micStarting) return { ok: false, error: 'The microphone already records a session in another tab.' };
      micStarting = true;
      try {
        const started = await microphone('mic-start').catch((error: Error) => ({ ok: false as const, error: error.message }));
        if (!started.ok) {
          return { ok: false, error: `The microphone did not start: ${started.error}`, microphoneBlocked: 'blocked' in started && started.blocked };
        }
        // The tab stopped collecting while the microphone asked for permission.
        if (buffer.mode(tabId) === undefined) {
          await microphone('mic-cancel').catch(() => {});
          await closeMicrophonePage();
          return { ok: false, error: 'Lens stopped collecting on this site while the microphone started.' };
        }
        voiced.add(tabId);
      } finally {
        micStarting = false;
      }
    }
    let startedAt = sessions.get(tabId) ?? Date.now();
    // The start names the recording's spool: two recordings never share one.
    if (!sessions.has(tabId)) while ([...sessions.values()].includes(startedAt)) startedAt++;
    sessions.set(tabId, startedAt);
    holdAll(tabId, startedAt);
    checkpoint();
    await browser.tabs.sendMessage(tabId, { kind: 'lens-snapshot' }).catch(() => {});
    void broadcast({ kind: 'tabChanged', tabId });
    return { ok: true, startedAt };
  }

  /** Ends the tab's recording without saving it; the tab goes on collecting as before Record. */
  async function discardSession(tabId: number): Promise<{ ok: true }> {
    const session = sessions.get(tabId);
    if (session === undefined) return { ok: true };
    const off = offProject.has(tabId);
    dropEvidence(tabId, session);
    if (!import.meta.env.FIREFOX) void unspool(tabId, session);
    sessions.delete(tabId);
    restored.delete(tabId);
    offProject.delete(tabId);
    keptVoice.delete(tabId);
    holdAll(tabId, null);
    // Only the recording kept the tab here, on a site outside the project: it collects nothing there.
    if (off) stop(tabId);
    await endMicrophone(tabId, 'mic-cancel');
    checkpoint();
    void broadcast({ kind: 'tabChanged', tabId });
    return { ok: true };
  }

  /** The voice of a Stop that the app did not take: the next Stop saves it with the recording. */
  const keptVoice = new Map<number, Spoken | null>();
  /** The voice an earlier worker kept for this recording's Stop again (Chrome). */
  async function keptOnDisk(tabId: number, session: number): Promise<Spoken | null> {
    if (import.meta.env.FIREFOX) return null;
    const found = await spooled(tabId, session);
    return found?.parts[0] ? { ok: true, startedAt: found.startedAt, wav: found.parts[0] } : null;
  }
  // A Stop in progress per tab: a second Stop gets the same answer instead of a second capture,
  // which would find the microphone taken and save no voice.
  const stopping = new Map<number, Promise<CaptureResult>>();
  function stopSession(tabId: number, video?: RecordedVideoRef | null): Promise<CaptureResult> {
    const running = stopping.get(tabId);
    if (running) return running;
    const stop = endSession(tabId, video).finally(() => stopping.delete(tabId));
    stopping.set(tabId, stop);
    return stop;
  }

  async function endSession(tabId: number, video?: RecordedVideoRef | null): Promise<CaptureResult> {
    // The tab's latest site and grant first: the worker may have slept through a navigation.
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (tab) await sync(tabId, tab.url);
    const startedAt = sessions.get(tabId);
    if (startedAt === undefined) return { ok: false, error: 'No recording runs in this tab.' };
    // The page now is not the project's: its screenshot, URL and title must not join the recording.
    if (offProject.has(tabId)) {
      return { ok: false, error: 'This tab is on a site outside the project. Go back to the project site, then press Stop' };
    }
    // Restarted, and not collecting again yet: what is on screen is not checked yet.
    if (restored.has(tabId)) {
      return { ok: false, error: 'Lens restarted in the background and is picking this recording up again. Press Stop again in a moment' };
    }
    if (video) {
      if (video.truncated) buffer.gap(tabId, 'video', 'The video reached 200 MiB and ends there');
      buffer.record(tabId, 'video', { blob: video.blob, startedAt: video.startedAt, truncated: video.truncated });
    }
    const voiceSoFar = keptVoice.has(tabId)
      ? Promise.resolve(keptVoice.get(tabId) ?? null)
      : voiced.has(tabId)
        ? endMicrophone(tabId, 'mic-stop')
        : keptOnDisk(tabId, startedAt);
    // The voice goes to the app before the capture is saved: an upload that fails keeps the
    // recording and its voice for Stop again, instead of a saved recording without its voice.
    let audio: BlobRef | null = null;
    const sendVoice = async () => {
      const voice = await voiceSoFar;
      if (voice?.ok && voice.wav) audio = await client().upload(voice.wav, 'audio/wav');
    };
    const [result, spoken] = await Promise.all([capture(tabId, null, startedAt, sendVoice), voiceSoFar]);
    if (!result.ok) {
      // The app did not take it (not running, say): the session and its voice stay for Stop again,
      // also past a restart of this worker.
      keptVoice.set(tabId, spoken);
      const kept =
        spoken?.ok && spoken.wav && !import.meta.env.FIREFOX
          ? await spool({ tab: tabId, session: startedAt, startedAt: spoken.startedAt, type: 'audio/wav', parts: [spoken.wav] }).then(
              () => '',
              () => ' (keep the browser open: the voice is kept in memory only)',
            )
          : '';
      return { ok: false, error: `${result.error}. The recording is kept${kept}: press Stop again when the Lens app runs` };
    }
    keptVoice.delete(tabId);
    dropEvidence(tabId, startedAt);
    sessions.delete(tabId);
    restored.delete(tabId);
    holdAll(tabId, null);
    checkpoint();
    void broadcast({ kind: 'tabChanged', tabId });
    try {
      if (!spoken) return result;
      const sent = audio as BlobRef | null;
      if (!spoken.ok || !sent) throw new Error(spoken.ok ? 'it is empty' : spoken.error);
      await client().request({
        method: 'addVoiceNote',
        params: { observation: result.capture.observation, startedAt: spoken.startedAt, audio: sent },
      });
    } catch (error) {
      return { ok: false, error: `The recording was saved, but not the voice: ${(error as Error).message}` };
    } finally {
      // The kept voice is in the app now, or belongs to no recording any more.
      if (!import.meta.env.FIREFOX) void unspool(tabId, startedAt);
    }
    return result;
  }

  /**
   * The screenshot with the private fields blacked out, as the step shots have them. Null, with a
   * gap, when the page cannot be checked for them or changed during the shot: then the app renders
   * the screenshot from the replay, which masks them itself.
   */
  async function maskedScreenshot(tab: Browser.tabs.Tab, gaps: CoverageGap[]): Promise<string | null> {
    const found =
      tab.id === undefined
        ? null
        : await browser.scripting.executeScript({ target: { tabId: tab.id }, func: privateRects, args: [maskSelectors] }).then((results) => results[0]?.result ?? null, () => null);
    const shot = await takeScreenshot(tab);
    if (shot === null) return null;
    const now = await browser.tabs.get(tab.id!).catch(() => null);
    const masked = found && now?.url === tab.url ? await maskShot(shot, found, 'image/png') : null;
    if (!masked) {
      gaps.push({ channel: 'screenshot', reason: 'No screenshot: Lens could not check the page for private fields', startedAt: Date.now(), endedAt: null });
    }
    return masked;
  }

  /** Through the debugger when attached; else the visible tab, which needs access to all sites or
   * activeTab (a toolbar click or the shortcut) and the tab in front. Null when Firefox has neither:
   * then the Lens app renders the screenshot from the replay. */
  async function takeScreenshot(tab: Browser.tabs.Tab): Promise<string | null> {
    if (tab.id !== undefined && deep?.isAttached(tab.id)) return deep.screenshot(tab.id);
    if (tab.id === undefined) throw new Error('The tab is gone');
    if (!tab.active) await browser.tabs.update(tab.id, { active: true });
    let image: string | null;
    try {
      image = await captureTab(tab.id);
    } catch (error) {
      if (import.meta.env.FIREFOX && !(await browser.permissions.contains({ origins: ['<all_urls>'] }))) return null;
      throw error;
    }
    if (!image) throw new Error('Another tab came to the front during the screenshot; press again');
    return image.slice(image.indexOf(',') + 1);
  }

  browser.runtime.onMessage.addListener((message: BackgroundRequest | RecorderMessage, sender, reply) => {
    // A recorder that started with its page asks first: it records only where Lens collects.
    if (message.kind === 'lens-should-record') {
      const tabId = sender.tab?.id;
      const url = sender.url ?? sender.tab?.url;
      if (tabId === undefined || sender.frameId !== 0) return void reply(false);
      void ready
        .then(() => sync(tabId, url))
        .then(() => reply(collecting(tabId) && Boolean(projectFor(originOf(url)))), () => reply(false));
      return true;
    }
    if (message.kind === 'lens-action' || message.kind === 'lens-replay') {
      // The step that woke this worker counts too: it waits for the recordings and the projects.
      void ready.then(() => {
        const tabId = sender.tab?.id;
        // Only from a page of an enabled project: an old document still sending after the tab left
        // the project sites is ignored.
        if (tabId === undefined || !collecting(tabId) || !projectFor(originOf(sender.url ?? sender.tab?.url))) return;
        if (message.kind === 'lens-action') {
          actions.add(tabId, message.action);
          if (SHOT_STEPS.has(message.action.kind)) scheduleShot(tabId);
        } else replay.add(tabId, message.events);
      });
      return;
    }
    // A message can be what woke this worker: the recordings of the earlier one come first.
    if (message.kind === 'startSession' || message.kind === 'stopSession') {
      ready
        .then((): Promise<SessionStart | CaptureResult> =>
          message.kind === 'startSession' ? startSession(message.tabId, message.voice) : stopSession(message.tabId, message.video),
        )
        .then(reply, (error: Error) => reply({ ok: false, error: error.message }));
      return true;
    }
    // Broadcasts of other pages (a review's 'annotated') are not for this script.
    if (!['discardSession', 'tabStatus', 'lensReachable', 'projectsChanged', 'dropMarker', 'resumeDebugger'].includes(message.kind)) return;
    const work = ready.then((): Promise<unknown> =>
      message.kind === 'dropMarker'
        ? Promise.resolve(dropMarker(message.tabId, message.label))
        : message.kind === 'discardSession'
          ? discardSession(message.tabId)
          : message.kind === 'tabStatus'
            ? status(message.tabId)
            : message.kind === 'resumeDebugger'
              ? resumeDebugger(message.tabId)
              : message.kind === 'lensReachable'
                ? client()
                    .request({ method: 'hello' })
                    .then(() => true, () => false)
                : notifyProjectsChanged(),
    );
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
      // Off the project sites a recording keeps going without collecting (syncNow notes a gap):
      // their URL is not recorded either.
      if (project && (!moved || sessions.has(tabId))) {
        const to = change.url;
        const at = Date.now();
        // Only a site the person granted, and not while Lens is paused.
        void permitted(originOf(to)).then((granted) => {
          if (!granted || paused || buffer.mode(tabId) === undefined) return;
          buffer.record(tabId, 'navigation', { url: to });
          actions.add(tabId, { timestamp: at, kind: 'navigate', url: sanitizeUrl(to), target: null, value: null, masked: false });
        });
      } else if (!sessions.has(tabId)) stop(tabId);
    }
    if (change.url || change.status === 'complete') {
      void sync(tabId, tab.url).then(async () => {
        // A new document has no recorder yet; sync starts one only when collection begins.
        if (change.status === 'complete' && collecting(tabId)) await injectRecorder(tabId);
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
  browser.tabs.onReplaced.addListener((added, removed) => void ready.then(() => replaced(added, removed)));
  function replaced(added: number, removed: number) {
    // The worker woke for this swap: the old tab was gone at restore, so its recording waits here.
    const gone = vanished.get(removed);
    if (gone && !sessions.has(removed)) {
      vanished.delete(removed);
      sessions.set(removed, gone.startedAt);
      restored.add(removed);
      if (gone.off) offProject.add(removed);
      if (gone.voiced) voiced.add(removed);
    }
    // A prerendered page swapped in: to the person it is the same tab, so a recording moves along.
    if (sessions.has(removed)) {
      for (const store of [buffer, actions, replay, shots]) store.move(removed, added);
      // The spool is named by the recording's start, not its tab: only the batch in hand moves.
      const batch = batches.get(removed);
      batches.delete(removed);
      if (batch) batches.set(added, batch);
      cancelShot(removed);
      const session = sessions.get(removed)!;
      sessions.set(added, session);
      sessions.delete(removed);
      // The voice a failed Stop kept is named by the tab too: it moves along.
      if (!import.meta.env.FIREFOX) {
        void spooled(removed, session)
          .then((found) => found && spool({ ...found, tab: added }).then(() => unspool(removed, session)))
          .catch(() => {});
      }
      if (keptVoice.has(removed)) keptVoice.set(added, keptVoice.get(removed)!);
      keptVoice.delete(removed);
      if (voiced.delete(removed)) voiced.add(added);
      if (offProject.delete(removed)) offProject.add(added);
      if (restored.delete(removed)) restored.add(added);
      checkpoint();
    } else {
      stop(removed);
    }
    urls.delete(removed);
    queues.delete(removed);
    void deep?.detach(removed);
    void browser.tabs.get(added).then((tab) => sync(added, tab.url), () => {});
  }
  browser.permissions.onAdded.addListener(() => void loadProjects());
  browser.permissions.onRemoved.addListener(() => void loadProjects());

  // The toolbar button opens the notebook beside the page.
  if (import.meta.env.FIREFOX) {
    const { sidebarAction } = browser as unknown as { sidebarAction: { toggle(): Promise<void>; open(): Promise<void> } };
    browser.action.onClicked.addListener(() => sidebarAction.toggle());
    browser.commands.onCommand.addListener((command, tab) => {
      if (tab?.id === undefined) return;
      shortcut(command, tab.id);
    });
  } else {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    browser.commands.onCommand.addListener((command, tab) => {
      if (tab?.id === undefined) return;
      shortcut(command, tab.id);
    });
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (PRIVACY_KEY in changes) applyPrivacy(changes[PRIVACY_KEY]?.newValue);
    if (PROJECTS_SYNC_KEY in changes && changes[PROJECTS_SYNC_KEY]?.newValue !== lastProjectsSync) {
      lastProjectsSync = String(changes[PROJECTS_SYNC_KEY]?.newValue ?? '');
      void ready.then(() => loadProjects()).then(() => broadcast({ kind: 'tabChanged', tabId: -1 }));
    }
  });

  // The recordings of an earlier worker first: the sync after it then resumes them.
  restoring = restore().catch(() => {});
  ready = restoring
    .then(async () => {
      await loadProjects();
      // A microphone page that no restored recording owns records nothing anyone can save. Before
      // any message is handled, so no new start loses its microphone to this.
      if (!import.meta.env.FIREFOX && offscreenIdle() && (await browser.offscreen.hasDocument().catch(() => false))) {
        await closeMicrophonePage();
      }
    })
    .catch(() => {});
  void ready.then(() => broadcast({ kind: 'tabChanged', tabId: -1 }));

  // Periodic storage retention & orphan blob sweep (replaces the old daemon hourly loop).
  const SWEEP_ALARM = 'lens.sweep';
  void browser.alarms.create(SWEEP_ALARM, { periodInMinutes: 60 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SWEEP_ALARM) return;
    void (async () => {
      try {
        const usage = await client().request({ method: 'getStorage' });
        if (usage.retentionDays !== null) {
          await client().request({
            method: 'pruneStorage',
            params: { olderThanDays: usage.retentionDays, filedOnly: usage.retentionFiledOnly },
          });
        }
      } catch {
        // ignore transient alarm errors
      }
    })();
  });
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

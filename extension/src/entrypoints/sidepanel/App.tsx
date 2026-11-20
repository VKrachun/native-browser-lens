import { useCallback, useEffect, useRef, useState } from 'react';
import { LensClient, PROTOCOL_VERSION, type LensError } from '@/lens-client';
import { originOf, send, type Broadcast, type CaptureResult, type TabStatus } from '@/messages';
import type { Capture } from '@/protocol/Capture';
import type { Hello } from '@/protocol/Hello';
import type { ObservationSummary } from '@/protocol/ObservationSummary';
import { AlertIcon, BackIcon, CameraIcon, DeleteIcon, ExportIcon, LensMark, LinkIcon, MicIcon, PenIcon, PlayIcon, SettingsIcon } from '@/ui/icons';
import { readable } from '@/findings';
import type { BlobRef } from '@/protocol/BlobRef';
import { Notes } from './Notes';
import { VoiceNotes } from './Voice';
import { RecordControls, SCREEN_ACCESS_REFUSED, useScreenAccess, useStored, type PanelMode } from './Record';
import { DestinationForm } from '@/ui/Destination';
import { InstallApp, SetupCard, appMissing } from './Onboarding';

type Connection = { state: 'connecting' } | { state: 'ready'; hello: Hello } | { state: 'failed'; message: string };

const MODE = {
  deep: { tone: 'success', label: 'Collecting', detail: 'Collecting network, console and errors' },
  limited: { tone: 'info', label: 'Collecting', detail: 'Network metadata only: this browser has no debugger' },
  screenshotOnly: { tone: 'warning', label: 'Screenshots only', detail: 'The browser refused the debugger' },
} as const;

const SHORTCUT = navigator.userAgent.includes('Mac') ? ['⌥', '⇧', 'L'] : ['Alt', 'Shift', 'L'];

function hostOf(url: string | null | undefined) {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

function ago(ms: number) {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** Chromium serves site icons to extensions; Firefox does not, so it gets the host's initial. */
function SiteIcon({ origin }: { origin: string }) {
  const [failed, setFailed] = useState(!browser.runtime.getURL('/').startsWith('chrome-extension://'));
  if (failed) return <span className="site-icon site-initial">{(hostOf(origin) ?? '?')[0]?.toUpperCase()}</span>;
  const src = browser.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(origin)}&size=32` as '/');
  return <img className="site-icon" src={src} alt="" onError={() => setFailed(true)} />;
}

export function App() {
  const [client, setClient] = useState<LensClient | null>(null);
  const [connection, setConnection] = useState<Connection>({ state: 'connecting' });
  const [observations, setObservations] = useState<ObservationSummary[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [site, setSite] = useState<TabStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const screenAccess = useScreenAccess();
  const [attempt, setAttempt] = useState(0);
  const [panelMode, setPanelMode] = useStored<PanelMode>('lens.mode', 'record');
  const lastWebTab = useRef<number | null>(null);

  /**
   * The tab this panel works on: `?tab=` when given, else the active tab of the panel's window. A
   * Lens page (review, annotate) is not a site, so the panel keeps the last web tab it targeted.
   */
  const refreshSite = useCallback(async () => {
    const pinned = Number(new URLSearchParams(location.search).get('tab'));
    let id: number | null = pinned || null;
    if (!id) {
      const [active] = await browser.tabs.query({ active: true, currentWindow: true });
      const web = originOf(active?.url) !== null;
      id = web ? (active?.id ?? null) : lastWebTab.current;
      if (id !== null && !web) await browser.tabs.get(id).catch(() => (id = null));
    }
    if (id !== null) lastWebTab.current = id;
    setTabId(id);
    setSite(id === null ? null : await send<TabStatus>({ kind: 'tabStatus', tabId: id }).catch(() => null));
  }, []);

  useEffect(() => {
    // Until the app answers, try again every few seconds: installing it continues this panel.
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failed = false;
    const fail = (error: LensError) => {
      if (failed) return;
      failed = true;
      setConnection({ state: 'failed', message: error.message });
      retry = setTimeout(() => setAttempt((n) => n + 1), 3000);
    };
    const lens = new LensClient(fail);
    setClient(lens);
    Promise.all([lens.request({ method: 'hello' }), lens.request({ method: 'listObservations' })])
      .then(([hello, list]) => {
        setConnection({ state: 'ready', hello });
        setObservations(list);
        // The background script connects and announces too, now that the app exists.
        void send({ kind: 'projectsChanged' }).catch(() => {});
      })
      .catch(fail);
    void refreshSite();
    const listener = (message: Broadcast) => {
      if (message.kind === 'tabChanged') void refreshSite();
      if (message.kind === 'captured') {
        void lens.request({ method: 'listObservations' }).then(setObservations);
        setSelected(message.capture.observation);
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => {
      clearTimeout(retry);
      browser.runtime.onMessage.removeListener(listener);
      lens.disconnect();
    };
  }, [refreshSite, attempt]);

  const reloadObservations = useCallback(() => {
    void client?.request({ method: 'listObservations' }).then(setObservations);
  }, [client]);
  // Titles and transcripts finish in the background: the list looks again now and then.
  useEffect(() => {
    if (connection.state !== 'ready') return;
    const timer = setInterval(reloadObservations, 10_000);
    return () => clearInterval(timer);
  }, [connection.state, reloadObservations]);

  async function track() {
    if (!client || !site?.origin) return;
    const origin = site.origin;
    // The permission prompt must open inside the click, before any other await. Firefox also
    // needs all sites for screenshots (see useScreenAccess); one prompt asks for both.
    const granted = await browser.permissions.request({
      origins: [`${origin}/*`, ...(import.meta.env.FIREFOX ? ['<all_urls>'] : [])],
    });
    if (!granted) return setProblem(`Lens may not read ${origin}.`);
    try {
      if (site.projectId === null) {
        await client.request({
          method: 'saveProject',
          params: { id: null, name: new URL(origin).host, origins: [origin], enabled: true },
        });
      }
      await send({ kind: 'projectsChanged' });
      await refreshSite();
      setProblem(null);
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  async function capture() {
    if (tabId === null) return;
    if (!(await screenAccess())) return setProblem(SCREEN_ACCESS_REFUSED);
    setBusy(true);
    const result = await send<CaptureResult>({ kind: 'capture', tabId, observation: selected });
    setBusy(false);
    if (!result.ok) return setProblem(`Capture failed: ${result.error}`);
    setProblem(null);
  }

  const current = observations?.find((o) => o.id === selected) ?? null;
  const mode = site?.mode ? MODE[site.mode] : null;

  return (
    <div className="panel">
      <header className="topbar">
        <LensMark />
        <span className="brand">Lens</span>
        <span
          className="conn"
          data-state={connection.state}
          role="status"
          aria-label="Connection"
          title={connection.state === 'failed' ? connection.message : undefined}
        >
          {connection.state === 'connecting' && 'Connecting…'}
          {connection.state === 'ready' && `Connected · Lens ${connection.hello.version}`}
          {connection.state === 'failed' && (appMissing(connection.message) ? 'App not installed' : 'App not running')}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          aria-label="Settings"
          title="Settings"
          onClick={() => void browser.runtime.openOptionsPage()}
        >
          <SettingsIcon />
        </button>
      </header>

      {connection.state === 'failed' && <InstallApp reason={connection.message} />}

      {connection.state === 'ready' && client && (
        <>
          {connection.hello.protocol !== PROTOCOL_VERSION && (
            <div role="alert" className="notice" data-tone="warning">
              <AlertIcon />
              <span>
                {connection.hello.protocol < PROTOCOL_VERSION
                  ? 'The Lens app is older than this extension. Run the install line again to update it.'
                  : 'This extension is older than the Lens app. Update the extension.'}
              </span>
            </div>
          )}
          <DestinationForm client={client} onboarding />
          <SetupCard client={client} refresh={site?.mode ? 1 : 0} />

          <section className="card site" aria-label="This site">
            <div className="segmented mode-switch" role="tablist" aria-label="Mode">
              {(['record', 'capture'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  className="btn btn-sm"
                  aria-selected={panelMode === m}
                  aria-pressed={panelMode === m}
                  onClick={() => setPanelMode(m)}
                  disabled={site?.session != null}
                >
                  {m === 'record' ? 'Record' : 'Capture'}
                </button>
              ))}
            </div>
            {!current && (
              <p className="small muted mode-hint">
                {panelMode === 'record'
                  ? 'Record a session with your voice, then review, cut and annotate it.'
                  : 'Capture saves the last ten minutes of this tab.'}
              </p>
            )}
            {site?.origin ? (
              <>
                <div className="site-row">
                  <SiteIcon origin={site.origin} />
                  <div className="site-text">
                    <span className="site-host" title={site.origin}>
                      {hostOf(site.origin)}
                    </span>
                    <span className="small muted">
                      {site.paused
                        ? 'Collection is paused from the Lens menu.'
                        : (mode?.detail ?? 'Lens does not collect evidence here yet.')}
                    </span>
                  </div>
                  {site.paused ? (
                    <span className="pill" data-tone="warning">
                      Paused
                    </span>
                  ) : mode ? (
                    <span className="pill" data-tone={mode.tone}>
                      {mode.label}
                    </span>
                  ) : null}
                </div>
                {!site.paused && !site.mode && (
                  <button type="button" className="btn btn-primary btn-block" onClick={track}>
                    Collect evidence on this site
                  </button>
                )}
              </>
            ) : (
              <p className="small muted">Open a web page (http or https) to capture it.</p>
            )}
            {panelMode === 'record' ? (
              <RecordControls client={client} tabId={tabId} site={site} onProblem={setProblem} />
            ) : (
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block capture"
              onClick={capture}
              disabled={busy || !site?.origin}
            >
              <CameraIcon size={18} />
              <span>{busy ? 'Capturing…' : current ? `Capture to “${current.title}”` : 'Capture to a new observation'}</span>
              <span className="keys" aria-hidden="true">
                {SHORTCUT.map((k) => (
                  <kbd key={k} className="kbd">
                    {k}
                  </kbd>
                ))}
              </span>
            </button>
            )}
            {problem && (
              <div role="alert" className="notice">
                <AlertIcon />
                <span>{problem}</span>
              </div>
            )}
          </section>

          {current ? (
            <Detail
              key={current.id}
              client={client}
              observation={current}
              onBack={() => setSelected(null)}
              onSaved={reloadObservations}
            />
          ) : (
            <Observations client={client} list={observations} onOpen={setSelected} onChanged={reloadObservations} />
          )}
        </>
      )}
    </div>
  );
}

/** Screenshots shown in the list, kept for the life of the panel. */
const thumbnails = new Map<string, Promise<string>>();

function Thumbnail({ client, blob }: { client: LensClient; blob: BlobRef | null }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    let cached = thumbnails.get(blob.sha256);
    if (!cached) {
      cached = client.readBlob(blob).then((data) => URL.createObjectURL(data));
      thumbnails.set(blob.sha256, cached);
    }
    void cached.then(setSrc).catch(() => thumbnails.delete(blob.sha256));
  }, [client, blob]);
  return <span className="obs-thumb">{src && <img src={src} alt="" />}</span>;
}

function dayOf(ms: number) {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return day.toLocaleDateString([], { weekday: days < 7 ? 'long' : undefined, day: 'numeric', month: 'short' });
}

const length = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function Observations({
  client,
  list,
  onOpen,
  onChanged,
}: {
  client: LensClient;
  list: ObservationSummary[] | null;
  onOpen: (id: number) => void;
  onChanged: () => void;
}) {
  // Search the titles and findings; show all, the ones still to file, or the filed ones.
  const [query, setQuery] = useState('');
  const [show, setShow] = useStored<'all' | 'open' | 'filed'>('lens.listFilter', 'all');
  if (list === null) {
    return (
      <div className="list-skeleton" aria-hidden="true">
        <span className="skeleton" />
        <span className="skeleton" />
      </div>
    );
  }
  const words = query.trim().toLowerCase();
  const shown = list.filter(
    (o) =>
      (show === 'all' || (show === 'filed') === (o.status === 'filed')) &&
      (!words || `${o.title} ${o.headline ?? ''}`.toLowerCase().includes(words)),
  );
  const days: [string, ObservationSummary[]][] = [];
  for (const o of shown) {
    const day = dayOf(Number(o.createdAt));
    if (days.at(-1)?.[0] === day) days.at(-1)![1].push(o);
    else days.push([day, [o]]);
  }
  async function remove(o: ObservationSummary) {
    if (!confirm(`Delete “${o.title}” with its recordings and notes? Tasks already filed stay in your tracker.`)) return;
    await client.request({ method: 'deleteObservation', params: { id: o.id } }).catch(() => {});
    onChanged();
  }
  return (
    <section className="observations" aria-label="Your observations">
      <div className="section-head">
        <h2>Recordings and captures</h2>
        {list.length > 0 && (
          <span className="small muted num">{shown.length === list.length ? list.length : `${shown.length} of ${list.length}`}</span>
        )}
      </div>
      {list.length > 5 && (
        <div className="obs-tools">
          <input
            className="input obs-search"
            type="search"
            aria-label="Search recordings and captures"
            placeholder="Search titles and findings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="segmented" role="group" aria-label="Show">
            {(
              [
                ['all', 'All'],
                ['open', 'To file'],
                ['filed', 'Filed'],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" className="btn btn-sm" aria-pressed={show === value} onClick={() => setShow(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {list.length > 0 && shown.length === 0 && <p className="small muted">Nothing matches.</p>}
      {list.length === 0 ? (
        <div className="empty">
          <p>Nothing recorded yet.</p>
          <ol className="first-steps small muted">
            <li>Press Record and use the site as usual.</li>
            <li>Say what you see as you go: what is wrong, what you expected.</li>
            <li>Press Stop. Lens opens the recording with your words, to cut, annotate and file.</li>
          </ol>
          <p className="small muted">Missed the moment? Capture keeps the last ten minutes of a collected tab.</p>
        </div>
      ) : (
        days.map(([day, items]) => (
          <div key={day} className="obs-day">
            <h3 className="label">{day}</h3>
            <ul className="obs-list" aria-label={day === dayOf(Date.now()) ? 'Observations' : `Observations from ${day}`}>
              {items.map((o) => (
                <li key={o.id} className="obs-item">
                  <button type="button" className="obs-row" onClick={() => onOpen(o.id)}>
                    <Thumbnail client={client} blob={o.thumbnail} />
                    <span className="obs-text">
                      <span className="obs-title">{o.title}</span>
                      {o.headline && <span className="obs-headline small muted">{readable(o.headline)}</span>}
                      <span className="obs-meta small muted num">
                        {o.kind === 'session' ? (
                          <span className="obs-kind">
                            <span className="rec-dot rec-dot-still" aria-hidden="true" />
                            {length(Number(o.durationMs))}
                          </span>
                        ) : (
                          <span className="obs-kind">
                            <CameraIcon size={12} />
                            {o.captureCount > 1 ? `${o.captureCount} captures` : 'Capture'}
                          </span>
                        )}
                        {o.voiceCount > 0 && (
                          <span className="obs-kind" title="With voice">
                            <MicIcon size={12} />
                          </span>
                        )}
                        <span>{ago(Number(o.createdAt))}</span>
                      </span>
                    </span>
                    {o.status !== 'draft' && (
                      <span className="pill obs-status" data-tone={o.status === 'filed' ? 'success' : 'info'}>
                        {o.status === 'filed' ? 'Filed' : 'Reviewed'}
                      </span>
                    )}
                  </button>
                  {o.taskUrl?.startsWith('https://') && (
                    <a
                      className="btn btn-ghost btn-icon btn-sm obs-task"
                      href={o.taskUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open the filed task of ${o.title}`}
                      title="Open the filed task"
                    >
                      <LinkIcon />
                    </a>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm obs-delete"
                    aria-label={`Delete ${o.title}`}
                    title="Delete"
                    onClick={() => void remove(o)}
                  >
                    <DeleteIcon />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function Detail({
  client,
  observation,
  onBack,
  onSaved,
}: {
  client: LensClient;
  observation: ObservationSummary;
  onBack: () => void;
  onSaved: () => void;
}) {
  const append = useRef<((text: string) => void) | null>(null);
  const [captures, setCaptures] = useState<Capture[] | null>(null);
  useEffect(() => {
    const load = () =>
      void client.request({ method: 'listCaptures', params: { observation: observation.id } }).then(setCaptures);
    load();
    const listener = (message: Broadcast) => {
      if ((message.kind === 'captured' || message.kind === 'annotated') && message.capture.observation === observation.id) load();
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [client, observation.id]);
  const open = (path: string) => void browser.tabs.create({ url: browser.runtime.getURL(path as '/') });
  const newest = captures?.at(-1);
  return (
    <section className="detail" aria-label="Observation">
      <div className="detail-top">
        <button type="button" className="btn btn-ghost btn-sm back" onClick={onBack}>
          <BackIcon size={14} />
          All recordings
        </button>
        {observation.taskUrl?.startsWith('https://') ? (
          <a className="pill" data-tone="success" href={observation.taskUrl} target="_blank" rel="noreferrer" title={observation.taskUrl}>
            Filed · Open task
          </a>
        ) : (
          observation.status !== 'draft' && (
            <span className="pill" data-tone={observation.status === 'filed' ? 'success' : 'info'}>
              {observation.status === 'filed' ? 'Filed' : 'Reviewed'}
            </span>
          )
        )}
      </div>
      {captures === null ? (
        <span className="hero skeleton" aria-hidden="true" />
      ) : newest ? (
        <Hero client={client} capture={newest} onOpen={() => open(newest.recording ? `/replay.html?capture=${newest.id}` : `/annotate.html?capture=${newest.id}`)} />
      ) : (
        <p className="small muted">Nothing recorded here yet.</p>
      )}
      <div className="detail-actions">
        {newest?.recording && (
          <button type="button" className="btn btn-primary" onClick={() => open(`/replay.html?capture=${newest.id}`)}>
            <PlayIcon />
            Open in editor
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={() => open(`/review.html?observation=${observation.id}`)}>
          <ExportIcon />
          Review and file
        </button>
      </div>
      <Notes client={client} id={observation.id} onSaved={onSaved} appendRef={append} />
      <VoiceNotes client={client} observation={observation.id} onAppend={(text) => append.current?.(text)} />
      {captures && captures.length > 1 && (
        <section className="more" aria-label="Captures">
          <h3 className="label">All {captures.length} captures</h3>
          <ol className="captures">
            {captures.map((c) => (
              <li key={c.id}>
                <Hero client={client} capture={c} small onOpen={() => open(c.recording ? `/replay.html?capture=${c.id}` : `/annotate.html?capture=${c.id}`)} />
              </li>
            ))}
          </ol>
        </section>
      )}
      {captures?.length === 1 && <ol aria-label="Captures" className="sr-only"><li>{captureLabel(captures[0]!)}</li></ol>}
    </section>
  );
}

function captureLabel(c: Capture) {
  const time = new Date(Number(c.createdAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (c.kind === 'session') return `Recording · ${length(Number(c.createdAt) - Number(c.startedAt))} · ${time}`;
  return `Capture · ${time}`;
}

/** A capture as a picture: its screenshot, with a play button when it has a recording. */
function Hero({ client, capture, onOpen, small = false }: { client: LensClient; capture: Capture; onOpen: () => void; small?: boolean }) {
  const marks = capture.annotations.length;
  return (
    <div className="hero-wrap" data-small={small || undefined}>
      <button
        type="button"
        className="hero"
        aria-label={capture.recording ? `Open the recording, ${captureLabel(capture)}` : `Annotate capture ${capture.id}`}
        onClick={onOpen}
      >
        <Screenshot client={client} capture={capture} />
        {capture.recording && (
          <span className="hero-play" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.2-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z" />
            </svg>
          </span>
        )}
        <span className="hero-badge num">{captureLabel(capture)}</span>
      </button>
      <div className="hero-meta small muted">
        {capture.mode === 'limited' && <span>Network answers were not recorded in this browser.</span>}
        {capture.mode === 'screenshotOnly' && <span>Only the screenshot: Lens did not collect on this site.</span>}
        {capture.kind !== 'session' && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={`Annotate capture ${capture.id}`}
            onClick={() => void browser.tabs.create({ url: browser.runtime.getURL(`/annotate.html?capture=${capture.id}`) })}
          >
            <PenIcon /> Mark up{marks ? ` · ${marks}` : ''}
          </button>
        )}
      </div>
    </div>
  );
}

function Screenshot({ client, capture }: { client: LensClient; capture: Capture }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    void client.readBlob(capture.screenshot).then((blob) => setSrc((url = URL.createObjectURL(blob))));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, capture.screenshot]);
  return src ? (
    <img className="thumb" src={src} alt={`Screenshot of ${capture.pageTitle || capture.pageUrl}`} />
  ) : (
    <span className="thumb skeleton" />
  );
}

import { StrictMode, useCallback, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { LensClient } from '@/lens-client';
import { sitePattern } from '@/messages';
import type { VibeQSettings } from '@/protocol/VibeQSettings';
import type { UpdateState } from '@/protocol/UpdateState';
import type { FindingsSettings } from '@/protocol/FindingsSettings';
import type { Agent } from '@/protocol/Agent';
import type { AgentInfo } from '@/protocol/AgentInfo';
import type { AgentSetup } from '@/protocol/AgentSetup';
import { useStored } from '../sidepanel/Record';
import { AlertIcon, DoneIcon, LensMark, LinkIcon } from '@/ui/icons';
import { Problem, useLoadOnFocus } from './shared';
import { Voice } from './VoiceSettings';
import { VideoExport } from './VideoExport';
import { Storage } from './Storage';
import { PrivacyRules } from './PrivacyRules';
import '@/ui/base.css';
import { followSystemTheme } from '@/ui/theme';
import './style.css';
import { DestinationForm } from '@/ui/Destination';
import { AppStatus } from '@/ui/AppStatus';

const DEFAULT_VIBEQ = 'https://work.sirv.studio';
/** How long Lens waits for the person to sign in to VibeQ in the other tab. */
const SIGN_IN_WAIT_MS = 10 * 60_000;

function Settings() {
  const [client] = useState(() => new LensClient());
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    client
      .request({ method: 'hello' })
      .then((hello) => setVersion(hello.version))
      .catch(() => {});
    return () => client.disconnect();
  }, [client]);

  return (
    <main className="page settings">
      <header className="settings-head">
        <LensMark />
        <h1>Settings</h1>
        {version && <span className="small muted num">Lens {version}</span>}
      </header>
      <StatusLine client={client} />
      <DestinationForm client={client} />
      <VibeQ client={client} />
      <Voice client={client} />
      <Models client={client} />
      <CodingAgents client={client} />
      <VideoExport client={client} />
      <Storage client={client} />
      <PrivacyRules client={client} />
      <Updates client={client} />
      <section className="card settings-section" aria-label="Privacy">
        <h2>What Lens reads</h2>
        <p className="small muted">
          Lens reads a site only after you allow it from the side panel. While it collects network bodies and console
          messages, Chrome shows a bar that says Lens started debugging this browser. That bar is how the debugger
          permission looks, and it goes away when the tab closes. To stop collection everywhere, use Pause collection
          in the Lens menu of your system tray.
        </p>
        {!import.meta.env.FIREFOX && <IncognitoNote />}
      </section>
    </main>
  );
}

/**
 * What is ready and what is missing, at a glance; each item jumps to its section below. It asks
 * again when the window comes back, after a sign-in or a download in another tab.
 */
function StatusLine({ client }: { client: LensClient }) {
  const [items, setItems] = useState<{ label: string; ok: boolean; target: string }[] | null>(null);
  const load = useCallback(async () => {
    const [speech, agents, setup] = await Promise.all([
      client.request({ method: 'speechStatus' }).catch(() => null),
      client.request({ method: 'listAgents' }).catch(() => null),
      client.request({ method: 'setupStatus' }).catch(() => null),
    ]);
    const ready = agents?.filter((a) => a.state === 'ready').map((a) => (a.agent === 'codex' ? 'Codex' : 'Claude Code')) ?? [];
    setItems([
      {
        label: speech?.model.state === 'ready' ? `Voice: ready (${speech.engines[0] ?? 'CPU'})` : 'Voice: needs the speech model',
        ok: speech?.model.state === 'ready',
        target: 'Voice notes',
      },
      { label: ready.length ? `AI model: ${ready.join(', ')}` : 'AI model: none signed in', ok: ready.length > 0, target: 'AI model' },
      { label: setup?.service ? 'Starts at login' : 'Does not start at login', ok: !!setup?.service, target: '' },
    ]);
  }, [client]);
  useEffect(() => {
    void load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);
  if (!items) return null;
  return (
    <nav className="status-line" aria-label="Status">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className="pill"
          data-tone={item.ok ? 'success' : 'warning'}
          disabled={!item.target}
          onClick={() => document.querySelector(`section[aria-label="${item.target}"]`)?.scrollIntoView({ behavior: 'smooth' })}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

/**
 * Lens signs in with the VibeQ session this browser already has: VibeQ mints a personal token for
 * a signed-in member, and the daemon keeps it in the system secret store.
 */
function VibeQ({ client }: { client: LensClient }) {
  const [settings, setSettings] = useState<VibeQSettings | null>(null);
  const [address, setAddress] = useState('');
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    client
      .request({ method: 'getVibeQ' })
      .then((found) => {
        setSettings(found);
        setAddress(found.endpoint ?? DEFAULT_VIBEQ);
      })
      .catch((error: Error) => setProblem(error.message));
  }, [client]);

  const save = useCallback(
    async (endpoint: string, token: string) => {
      setSettings(await client.request({ method: 'setVibeQ', params: { endpoint, token } }));
      window.dispatchEvent(new Event('lens-destination-changed'));
      setWaitingFor(null);
      setProblem(null);
    },
    [client],
  );

  /** One attempt: true when VibeQ knew the person and Lens saved the token. */
  const tryToken = useCallback(
    async (origin: string) => {
      const token = await mintToken(origin);
      if (token === null) return false;
      await save(origin, token);
      return true;
    },
    [save],
  );

  async function signIn() {
    let origin: string;
    try {
      origin = new URL(address.trim() || DEFAULT_VIBEQ).origin;
    } catch {
      return setProblem('Type the VibeQ address, for example https://work.sirv.studio');
    }
    // Chrome grants a permission only while the click is in progress, so Lens asks before anything else.
    let granted: boolean;
    try {
      granted = await browser.permissions.request({ origins: [sitePattern(origin)] });
    } catch (error) {
      return setProblem((error as Error).message);
    }
    if (!granted) return setProblem('Lens needs access to VibeQ to sign in.');
    setBusy(true);
    setProblem(null);
    try {
      if (!(await tryToken(origin))) {
        await browser.tabs.create({ url: `${origin}/` });
        setWaitingFor(origin);
      }
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // While the person signs in to VibeQ in the other tab, try again until VibeQ knows them.
  useEffect(() => {
    if (!waitingFor) return;
    const started = Date.now();
    let running = false;
    // Cancel during a request: its token, when it comes, is not saved.
    let cancelled = false;
    const attempt = async () => {
      if (running || cancelled) return;
      if (Date.now() - started > SIGN_IN_WAIT_MS) {
        setWaitingFor(null);
        return setProblem('Lens stopped waiting for the VibeQ sign-in. Try again.');
      }
      running = true;
      try {
        const token = await mintToken(waitingFor);
        if (token !== null && !cancelled) await save(waitingFor, token);
      } catch (error) {
        if (cancelled) return;
        setWaitingFor(null);
        setProblem((error as Error).message);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(attempt, 2000);
    window.addEventListener('focus', attempt);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', attempt);
    };
  }, [waitingFor, save]);

  async function signOut() {
    try {
      setSettings(await client.request({ method: 'setVibeQ', params: { endpoint: settings!.endpoint!, token: '' } }));
      window.dispatchEvent(new Event('lens-destination-changed'));
      setProblem(null);
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  if (!settings) return problem ? <Problem text={problem} /> : null;
  const signedIn = settings.hasToken && !!settings.endpoint;
  const host = settings.endpoint ? new URL(settings.endpoint).host : '';

  return (
    <section className="card settings-section" aria-label="VibeQ">
      <div className="section">
        <h2>VibeQ</h2>
        <p className="small muted">Connect your workspace to file reviewed evidence and check for duplicate tasks.</p>
      </div>
      {signedIn ? (
        <div className="account" role="status" aria-label="VibeQ account">
          <span className="avatar" aria-hidden="true">
            {(settings.account ?? host).slice(0, 1).toUpperCase()}
          </span>
          <span className="account-text">
            <strong>{settings.account ?? 'Signed in'}</strong>
            <span className="small muted">
              {settings.tokenFromEnvironment ? `${host} · token from LENS_VIBEQ_TOKEN` : host}
            </span>
          </span>
          {!settings.tokenFromEnvironment && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void signOut()}>
              Sign out
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="endpoint" className="label">
              VibeQ address
            </label>
            <input
              id="endpoint"
              className="input"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={DEFAULT_VIBEQ}
              disabled={!!waitingFor}
            />
          </div>
          {settings.secretStore.state === 'unavailable' && !settings.tokenFromEnvironment && (
            <div role="alert" className="notice" data-tone="warning">
              <AlertIcon size={16} />
              <span>
                The system secret store is unavailable ({settings.secretStore.reason}). Lens cannot keep a VibeQ
                sign-in.
              </span>
            </div>
          )}
          {waitingFor ? (
            <div role="status" aria-label="Sign-in" className="notice waiting" data-tone="info">
              <span className="spinner" aria-hidden="true" />
              <span>
                Sign in to VibeQ in the new tab. Lens continues here when you are signed in.
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setWaitingFor(null)}>
                  Cancel
                </button>
              </span>
            </div>
          ) : (
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={() => void signIn()} disabled={busy}>
                <LinkIcon />
                {busy ? 'Signing in…' : 'Sign in with VibeQ'}
              </button>
            </div>
          )}
          <TokenForm address={address} save={save} />
        </>
      )}
      {problem && <Problem text={problem} />}
    </section>
  );
}

/** For a browser without a VibeQ session: a personal token from VibeQ, pasted once. */
function TokenForm({ address, save }: { address: string; save: (endpoint: string, token: string) => Promise<void> }) {
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await save(address.trim() || DEFAULT_VIBEQ, token.trim());
      setToken('');
    } catch (error) {
      setProblem((error as Error).message);
    }
  }
  return (
    <details className="token-form">
      <summary className="small muted">Use a personal token instead</summary>
      <form onSubmit={submit}>
        <input
          aria-label="Personal token"
          className="input"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste a personal token from VibeQ"
        />
        <button type="submit" className="btn btn-secondary" disabled={!token.trim()}>
          Save token
        </button>
      </form>
      {problem && <Problem text={problem} />}
    </details>
  );
}

/** A new personal token from VibeQ for the member signed in to it in this browser, or null when nobody is. */
async function mintToken(origin: string): Promise<string | null> {
  const response = await fetch(`${origin}/auth/mcp-token?label=${encodeURIComponent('Sirv Lens')}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`VibeQ did not sign Lens in (HTTP ${response.status})`);
  const body: unknown = await response.json().catch(() => null);
  const token = (body as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || !token) throw new Error('VibeQ sent no token');
  return token;
}

const AGENT_STATE = { ready: 'Ready', signIn: 'Not signed in', missing: 'Not installed' } as const;

/**
 * Which model writes titles and findings, splits long recordings and checks for duplicates. It
 * runs through the person's own Claude Code or Codex on this computer.
 */
function Models({ client }: { client: LensClient }) {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [choice, setChoice] = useState<Agent | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [findings, setFindings] = useState<FindingsSettings | null>(null);
  // Again when the window comes back: the person may sign in to an agent in a terminal meanwhile.
  const load = useCallback(
    () =>
      Promise.all([
        client.request({ method: 'listAgents' }),
        client.request({ method: 'getSummaryAgent' }),
        client.request({ method: 'getFindingsSettings' }).catch(() => null),
      ])
        .then(([found, chosen, settings]) => {
          setAgents(found);
          setChoice(chosen);
          setFindings(settings);
        })
        .catch((error: Error) => setProblem(error.message)),
    [client],
  );
  useLoadOnFocus(load);
  if (!agents || choice === undefined) return problem ? <p role="alert" className="notice">{problem}</p> : null;
  const state = (agent: Agent) => agents.find((a) => a.agent === agent)?.state ?? 'missing';
  const options: { value: Agent | null; label: string; detail: string }[] = [
    { value: null, label: 'Automatic', detail: 'Claude Code when it is ready, otherwise Codex.' },
    { value: 'claude', label: 'Claude Code (Haiku)', detail: AGENT_STATE[state('claude')] },
    { value: 'codex', label: 'Codex', detail: AGENT_STATE[state('codex')] },
  ];
  async function choose(value: Agent | null) {
    const before = choice;
    setChoice(value);
    setProblem(null);
    try {
      await client.request({ method: 'setSummaryAgent', params: { agent: value } });
    } catch (error) {
      setChoice(before ?? null);
      setProblem((error as Error).message);
    }
  }
  /** The provider is the agent chosen above: the app keeps one setting for both. */
  async function saveFindings(change: Partial<FindingsSettings>) {
    if (!findings) return;
    setProblem(null);
    try {
      setFindings(
        await client.request({ method: 'setFindingsSettings', params: { ...findings, provider: choice ?? null, ...change } }),
      );
    } catch (error) {
      setProblem((error as Error).message);
    }
  }
  return (
    <section aria-label="AI model" className="card settings-section">
      <div className="section">
        <h2>AI model</h2>
        <p className="small muted">
          Writes the title and findings, splits long recordings into tasks and looks for duplicates. Lens runs it through
          the tool on this computer, with your own subscription. It sends text only: your words, the steps and the page
          text. Audio and screenshots stay here.
        </p>
      </div>
      <div className="choices" role="radiogroup" aria-label="AI model">
        {options.map((o) => {
          const unavailable = o.value !== null && state(o.value) !== 'ready';
          return (
            <label key={o.label} className="check">
              <input type="radio" name="summary-agent" checked={choice === o.value} onChange={() => void choose(o.value)} />
              <span>
                {o.label}
                <span className="small muted" style={{ display: 'block' }} data-unavailable={unavailable || undefined}>
                  {o.detail}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {choice !== null && state(choice) !== 'ready' && (
        <p role="alert" className="small">
          {choice === 'claude' ? 'Claude Code' : 'Codex'} is {AGENT_STATE[state(choice)].toLowerCase()}, so Lens writes no
          titles or findings until you install it and sign in, or choose Automatic.
        </p>
      )}
      {findings && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={findings.enabled}
              onChange={(e) => void saveFindings({ enabled: e.target.checked })}
            />
            <span>
              Draft the title and findings after each recording
              <span className="small muted" style={{ display: 'block' }}>
                Off: you write the title and findings yourself.
              </span>
            </span>
          </label>
          <div className="field">
            <label htmlFor="findings-model" className="label">
              Model name (optional)
            </label>
            <input
              key={findings.model ?? ''}
              id="findings-model"
              className="input"
              defaultValue={findings.model ?? ''}
              placeholder={choice === 'codex' ? 'The Codex default, or for example gpt-5' : 'haiku by default, or for example sonnet'}
              maxLength={100}
              spellCheck={false}
              onBlur={(e) => {
                const model = e.target.value.trim();
                if (model !== (findings.model ?? '')) void saveFindings({ model: model || null });
              }}
            />
          </div>
        </>
      )}
      {problem && (
        <p role="alert" className="small">
          {problem}
        </p>
      )}
    </section>
  );
}

/** Connects the coding agents here to Lens: the sirv-lens skill and MCP server. */
function CodingAgents({ client }: { client: LensClient }) {
  const [live, setLive] = useStored('lens.agentsLive', false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<AgentSetup[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Whether connect ran here (the sirv-lens skill is installed); null until the app answers. */
  const [connected, setConnected] = useState<boolean | null>(null);
  const load = useCallback(
    () =>
      client
        .request({ method: 'setupStatus' })
        .then((s) => setConnected(s.codingAgentsConnected))
        .catch(() => {}),
    [client],
  );
  useEffect(() => {
    void load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);
  async function run(method: 'connectAgents' | 'disconnectAgents') {
    setBusy(true);
    setProblem(null);
    // The result of an earlier run is not the result of this one.
    setDone(null);
    try {
      setDone(await client.request({ method }));
    } catch (error) {
      setProblem((error as Error).message);
    }
    // The buttons follow the new state, not the one before the run.
    await load();
    setBusy(false);
  }
  return (
    <section aria-label="Coding agents" className="card settings-section">
      <div className="section">
        <h2>Coding agents</h2>
        <p className="small muted">
          Lets Claude Code, Codex, Cursor and Gemini CLI read your reviews: the sirv-lens skill tells them how, and the
          Lens MCP server serves the steps, evidence, screenshots and tests. They only read, and only what you reviewed.
          The same works in a terminal with <code>lens agents connect</code>.
        </p>
      </div>
      {connected && (
        <p className="small" role="status" aria-label="Coding agents state">
          <DoneIcon size={14} /> Connected. Connect again after you install another agent.
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          className={connected ? 'btn btn-secondary' : 'btn btn-primary'}
          onClick={() => void run('connectAgents')}
          disabled={busy}
        >
          {busy ? 'Working…' : connected ? 'Connect again' : 'Connect coding agents'}
        </button>
        {/* Unknown (the app did not answer) keeps the way out. */}
        {connected !== false && (
          <button type="button" className="btn btn-ghost" onClick={() => void run('disconnectAgents')} disabled={busy}>
            Disconnect
          </button>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
        <span>
          Let coding agents read the last ten minutes
          <span className="small muted" style={{ display: 'block' }}>
            On the sites Lens collects on, while the browser is open: failed requests, console errors and steps, without a
            recording. Screenshots, the replay and your voice are not included.
          </span>
        </span>
      </label>
      {done && (
        <ul className="small agent-setup" role="status" aria-label="Coding agents result">
          {done.map((a) => (
            <li key={a.agent}>
              {a.ok ? <DoneIcon size={14} /> : <AlertIcon size={14} />} <strong>{a.agent}</strong>: {a.detail}
            </li>
          ))}
        </ul>
      )}
      {problem && <Problem text={problem} />}
    </section>
  );
}

/** Lens updates itself from signed releases, unless a package manager or the Store does. */
function Updates({ client }: { client: LensClient }) {
  const [state, setState] = useState<UpdateState | null>(null);
  /** What runs now: the button says it, and nothing else starts meanwhile. */
  const [busy, setBusy] = useState<'install' | 'check' | 'automatic' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    client.request({ method: 'getUpdates' }).then(setState).catch(() => {});
  }, [client]);
  if (!state) return null;
  const act = async (what: NonNullable<typeof busy>, work: () => Promise<UpdateState>) => {
    setBusy(what);
    try {
      setState(await work());
      setProblem(null);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label="Updates" className="card settings-section">
      <div className="section-row">
        <div className="section">
          <h2>Updates</h2>
          <p className="small muted num">
            {state.available
              ? `Lens ${state.available} is available.`
              : state.checkedAt && state.lastError
                ? `The last check failed, ${new Date(state.checkedAt).toLocaleString()}.`
                : state.checkedAt
                  ? `Up to date. Checked ${new Date(state.checkedAt).toLocaleString()}.`
                : `Lens ${state.current}`}
          </p>
        </div>
        {!state.managedBy && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            // Check now only checks; the button installs only when it says so.
            onClick={() =>
              void (state.available
                ? act('install', () => client.request({ method: 'updateNow' }))
                : act('check', () => client.request({ method: 'checkUpdates' })))
            }
            disabled={busy !== null}
          >
            {busy === 'install' ? 'Installing…' : busy === 'check' ? 'Checking…' : state.available ? 'Install now' : 'Check now'}
          </button>
        )}
      </div>
      {state.managedBy ? (
        <p className="small muted">{state.managedBy} updates this copy of Lens.</p>
      ) : (
        <label className="check">
          <input
            type="checkbox"
            checked={state.automatic}
            disabled={busy !== null}
            onChange={(e) => {
              const enabled = e.target.checked;
              void act('automatic', () => client.request({ method: 'setAutomaticUpdates', params: { enabled } }));
            }}
          />
          <span>
            Install updates automatically
            <span className="small muted" style={{ display: 'block' }}>
              Signed releases only. Lens restarts in the background.
            </span>
          </span>
        </label>
      )}
      {(problem || state.lastError) && <Problem text={(problem ?? state.lastError)!} />}
    </section>
  );
}

/** Chrome hides every extension in Incognito until the person turns on Allow in Incognito. */
function IncognitoNote() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const load = useCallback(() => {
    void browser.extension?.isAllowedIncognitoAccess?.().then(setAllowed, () => {});
  }, []);
  useLoadOnFocus(load);
  if (allowed !== false) return null;
  return (
    <div className="section-row">
      <p className="small muted">
        To use Lens in Chrome Incognito windows, turn on <strong>Allow in Incognito</strong> in Chrome&apos;s
        extension details.
      </p>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => void browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` })}
      >
        Extension details
      </button>
    </div>
  );
}

followSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStatus />
    <Settings />
  </StrictMode>,
);

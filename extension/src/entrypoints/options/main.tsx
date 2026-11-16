import { StrictMode, useCallback, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { LensClient } from '@/lens-client';
import type { VibeQSettings } from '@/protocol/VibeQSettings';
import type { UpdateState } from '@/protocol/UpdateState';
import type { SpeechStatus } from '@/protocol/SpeechStatus';
import type { Agent } from '@/protocol/Agent';
import type { AgentInfo } from '@/protocol/AgentInfo';
import type { AgentSetup } from '@/protocol/AgentSetup';
import { ModelNotice } from '../sidepanel/Voice';
import { useStored } from '../sidepanel/Record';
import { AlertIcon, DoneIcon, LensMark, LinkIcon } from '@/ui/icons';
import '@/ui/base.css';
import { followSystemTheme } from '@/ui/theme';
import './style.css';

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
      <VibeQ client={client} />
      <Voice client={client} />
      <Models client={client} />
      <CodingAgents client={client} />
      <Updates client={client} />
      <section className="card settings-section" aria-label="Privacy">
        <h2>What Lens reads</h2>
        <p className="small muted">
          Lens reads a site only after you allow it from the side panel. While it collects network bodies and console
          messages, Chrome shows a bar that says Lens started debugging this browser. That bar is how the debugger
          permission looks, and it goes away when the tab closes. To stop collection everywhere, use Pause collection
          in the Lens menu of your system tray.
        </p>
      </section>
    </main>
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
    const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
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
    const attempt = async () => {
      if (running) return;
      if (Date.now() - started > SIGN_IN_WAIT_MS) {
        setWaitingFor(null);
        return setProblem('Lens stopped waiting for the VibeQ sign-in. Try again.');
      }
      running = true;
      try {
        await tryToken(waitingFor);
      } catch (error) {
        setWaitingFor(null);
        setProblem((error as Error).message);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(attempt, 2000);
    window.addEventListener('focus', attempt);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', attempt);
    };
  }, [waitingFor, tryToken]);

  async function signOut() {
    try {
      setSettings(await client.request({ method: 'setVibeQ', params: { endpoint: settings!.endpoint!, token: '' } }));
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
        <p className="small muted">Where Lens files the defects you review. Without it, you can still export them.</p>
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
  useEffect(() => {
    Promise.all([client.request({ method: 'listAgents' }), client.request({ method: 'getSummaryAgent' })])
      .then(([found, chosen]) => {
        setAgents(found);
        setChoice(chosen);
      })
      .catch((error: Error) => setProblem(error.message));
  }, [client]);
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
  async function run(method: 'connectAgents' | 'disconnectAgents') {
    setBusy(true);
    setProblem(null);
    try {
      setDone(await client.request({ method }));
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
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
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={() => void run('connectAgents')} disabled={busy}>
          {busy ? 'Connecting…' : 'Connect coding agents'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void run('disconnectAgents')} disabled={busy}>
          Disconnect
        </button>
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

/** The speech model for voice notes: where it runs, and the one-time download. */
function Voice({ client }: { client: LensClient }) {
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const load = useCallback(() => client.request({ method: 'speechStatus' }).then(setSpeech).catch(() => {}), [client]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (speech?.model.state !== 'downloading') return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [speech?.model.state, load]);
  if (!speech) return null;
  const engines = speech.engines.length ? speech.engines.join(', then ') : 'none found';
  return (
    <section aria-label="Voice notes" className="card settings-section">
      <div className="section">
        <h2>Voice notes</h2>
        <p className="small muted">
          Lens writes down what you say with {speech.modelName}, on this computer. The recordings never leave it; transcripts leave
          only in a review you create.
        </p>
      </div>
      {speech.model.state === 'ready' ? (
        <p className="small" role="status" aria-label="Speech model">
          <DoneIcon size={14} /> {speech.modelName} is ready. Engine: {engines}.
        </p>
      ) : (
        <ModelNotice speech={speech} onInstall={() => void client.request({ method: 'installSpeech' }).then(setSpeech)} />
      )}
    </section>
  );
}

/** Lens updates itself from signed releases, unless a package manager or the Store does. */
function Updates({ client }: { client: LensClient }) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    client.request({ method: 'getUpdates' }).then(setState).catch(() => {});
  }, [client]);
  if (!state) return null;
  const act = async (work: Promise<UpdateState>) => {
    setBusy(true);
    try {
      setState(await work);
      setProblem(null);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
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
            onClick={() => void act(client.request({ method: 'updateNow' }))}
            disabled={busy}
          >
            {busy ? 'Checking…' : state.available ? 'Install now' : 'Check now'}
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
            onChange={(e) =>
              void act(client.request({ method: 'setAutomaticUpdates', params: { enabled: e.target.checked } }))
            }
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

function Problem({ text }: { text: string }) {
  return (
    <div role="alert" className="notice">
      <AlertIcon size={16} />
      <span>{text}</span>
    </div>
  );
}

followSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Settings />
  </StrictMode>,
);

import { StrictMode, useCallback, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEFAULT_LLM_MODELS,
  getLlmConfig,
  listProviderModels,
  saveLlmConfig,
  testLlmConnection,
  type LlmConfig,
  type LlmProvider,
} from '@/engine/llm';
import {
  DEFAULT_MCP_ENDPOINT,
  generateRemoteMcpToken,
  getRemoteMcpConfig,
  saveRemoteMcpConfig,
  type RemoteMcpConfig,
} from '@/engine/mcp-sync';
import { LensClient } from '@/lens-client';
import { sitePattern } from '@/messages';
import type { VibeQSettings } from '@/protocol/VibeQSettings';
import { AlertIcon, DoneIcon, LensMark, LinkIcon } from '@/ui/icons';
import { Problem, useLoadOnFocus } from './shared';
import { Voice } from './VoiceSettings';
import { Storage } from './Storage';
import { PrivacyRules } from './PrivacyRules';
import '@/ui/base.css';
import { followSystemTheme } from '@/ui/theme';
import './style.css';
import { DestinationForm } from '@/ui/Destination';

const DEFAULT_VIBEQ = 'https://work.sirv.studio';
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
      <Models />
      <CodingAgents />
      <Storage client={client} />
      <PrivacyRules client={client} />
      <section className="card settings-section" aria-label="Privacy">
        <h2>What Lens reads</h2>
        <p className="small muted">
          Lens runs completely inside your browser and stores recordings locally in IndexedDB. It reads a site only
          after you allow it from the side panel. While it collects network bodies and console messages, Chrome shows
          a bar that says Lens started debugging this browser; you can pause collection anytime from the side panel.
        </p>
        {!import.meta.env.FIREFOX && <IncognitoNote />}
      </section>
    </main>
  );
}

function StatusLine({ client }: { client: LensClient }) {
  const [items, setItems] = useState<{ label: string; ok: boolean; target: string }[] | null>(null);
  const load = useCallback(async () => {
    const [speech, llm, mcp] = await Promise.all([
      client.request({ method: 'speechStatus' }).catch(() => null),
      getLlmConfig().catch(() => null),
      getRemoteMcpConfig().catch(() => null),
    ]);
    const configuredLlm = llm
      ? (['openrouter', 'anthropic', 'openai', 'gemini'] as LlmProvider[]).filter((p) => Boolean(llm.keys[p]))
      : [];
    setItems([
      {
        label: speech?.model.state === 'ready' ? `Voice: ready (${speech.engines[0] ?? 'WASM'})` : 'Voice: click Download in Voice notes',
        ok: speech?.model.state === 'ready',
        target: 'Voice notes',
      },
      {
        label: configuredLlm.length ? `AI model: ${configuredLlm.join(', ')}` : 'AI model: add an API key',
        ok: configuredLlm.length > 0,
        target: 'AI model',
      },
      {
        label: mcp?.enabled && mcp.token ? 'Remote MCP: enabled' : 'Remote MCP: off',
        ok: Boolean(mcp?.enabled && mcp.token),
        target: 'Coding agents',
      },
    ]);
  }, [client]);
  useLoadOnFocus(load);
  if (!items) return null;
  return (
    <nav className="status-line" aria-label="Status">
      {items.map((item) => (
        <button
          key={item.target}
          type="button"
          className="pill"
          data-tone={item.ok ? 'success' : 'warning'}
          onClick={() => document.querySelector(`section[aria-label="${item.target}"]`)?.scrollIntoView({ behavior: 'smooth' })}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

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

  useEffect(() => {
    if (!waitingFor) return;
    const started = Date.now();
    let running = false;
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
            <span className="small muted">{host}</span>
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void signOut()}>
            Sign out
          </button>
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

/** Direct BYOK LLM API keys (Anthropic, OpenAI, Gemini) for findings, task splitting, and duplicate checks. */
function Models() {
  const [config, setConfig] = useState<LlmConfig | null>(null);
  const [liveModels, setLiveModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(() => {
    void getLlmConfig()
      .then(setConfig)
      .catch((error: Error) => setProblem(error.message));
  }, []);
  useLoadOnFocus(load);

  const activeProvider: LlmProvider | null = config
    ? config.provider ?? (['openrouter', 'anthropic', 'openai', 'gemini'] as LlmProvider[]).find((p) => Boolean(config.keys[p])) ?? null
    : null;
  const activeKey = config && activeProvider ? config.keys[activeProvider] : '';

  const refreshModels = useCallback(async () => {
    if (!activeProvider || !activeKey) {
      setLiveModels([]);
      return;
    }
    setLoadingModels(true);
    setProblem(null);
    try {
      setLiveModels(await listProviderModels(activeProvider, activeKey));
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setLoadingModels(false);
    }
  }, [activeProvider, activeKey]);

  useEffect(() => {
    if (!activeProvider || activeKey.trim().length < 10) {
      setLiveModels([]);
      return;
    }
    const timer = setTimeout(() => void refreshModels(), 600);
    return () => clearTimeout(timer);
  }, [activeProvider, activeKey, refreshModels]);

  if (!config) return problem ? <Problem text={problem} /> : null;

  async function update(patch: Partial<LlmConfig>) {
    setProblem(null);
    setSavedNotice(false);
    const optimistic: LlmConfig = {
      ...config!,
      ...patch,
      keys: { ...config!.keys, ...(patch.keys ?? {}) },
    };
    setConfig(optimistic);
    try {
      const next = await saveLlmConfig(patch);
      setConfig(next);
      setSavedNotice(true);
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  const providers: Array<[LlmProvider | null, string, string]> = [
    [null, 'Automatic', 'Uses the first configured key (OpenRouter → Anthropic → OpenAI → Gemini).'],
    ['openrouter', `OpenRouter (${DEFAULT_LLM_MODELS.openrouter})`, config.keys.openrouter ? 'API key saved' : 'No key set'],
    ['anthropic', `Anthropic (${DEFAULT_LLM_MODELS.anthropic})`, config.keys.anthropic ? 'API key saved' : 'No key set'],
    ['openai', `OpenAI (${DEFAULT_LLM_MODELS.openai})`, config.keys.openai ? 'API key saved' : 'No key set'],
    ['gemini', `Google Gemini (${DEFAULT_LLM_MODELS.gemini})`, config.keys.gemini ? 'API key saved' : 'No key set'],
  ];

  return (
    <section aria-label="AI model" className="card settings-section">
      <div className="section">
        <h2>AI model (BYOK)</h2>
        <p className="small muted">
          Writes the title and findings, splits long recordings into tasks, and checks for duplicates directly from your
          browser using your own API key (OpenRouter, Anthropic, OpenAI, or Gemini). Keys stay local in this browser profile.
        </p>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => void update({ enabled: e.target.checked })}
        />
        <span>
          Draft the title and findings after each recording
          <span className="small muted" style={{ display: 'block' }}>
            Off: you write the title and findings yourself.
          </span>
        </span>
      </label>

      <div className="choices" role="radiogroup" aria-label="AI provider">
        {providers.map(([value, label, detail]) => (
          <label key={label} className="check">
            <input
              type="radio"
              name="llm-provider"
              checked={config.provider === value}
              onChange={() => void update({ provider: value })}
            />
            <span>
              {label}
              <span className="small muted" style={{ display: 'block' }}>
                {detail}
              </span>
            </span>
          </label>
        ))}
      </div>

      <div className="field">
        <label htmlFor="key-openrouter" className="label">
          OpenRouter API key
        </label>
        <input
          id="key-openrouter"
          className="input"
          type="password"
          autoComplete="off"
          value={config.keys.openrouter}
          placeholder="sk-or-v1-..."
          onChange={(e) => void update({ keys: { ...config.keys, openrouter: e.target.value } })}
        />
      </div>

      <div className="field">
        <label htmlFor="key-anthropic" className="label">
          Anthropic API key
        </label>
        <input
          id="key-anthropic"
          className="input"
          type="password"
          autoComplete="off"
          value={config.keys.anthropic}
          placeholder="sk-ant-..."
          onChange={(e) => void update({ keys: { ...config.keys, anthropic: e.target.value } })}
        />
      </div>

      <div className="field">
        <label htmlFor="key-openai" className="label">
          OpenAI API key
        </label>
        <input
          id="key-openai"
          className="input"
          type="password"
          autoComplete="off"
          value={config.keys.openai}
          placeholder="sk-..."
          onChange={(e) => void update({ keys: { ...config.keys, openai: e.target.value } })}
        />
      </div>

      <div className="field">
        <label htmlFor="key-gemini" className="label">
          Google Gemini API key
        </label>
        <input
          id="key-gemini"
          className="input"
          type="password"
          autoComplete="off"
          value={config.keys.gemini}
          placeholder="AIza..."
          onChange={(e) => void update({ keys: { ...config.keys, gemini: e.target.value } })}
        />
      </div>

      <div className="field">
        <label htmlFor="findings-model" className="label">
          Model {activeProvider ? `(${activeProvider})` : '(optional)'}
        </label>
        <div className="inline-fields">
          <input
            id="findings-model"
            className="input"
            list="live-llm-models"
            defaultValue={config.model ?? ''}
            key={`${activeProvider ?? 'auto'}:${config.model ?? ''}`}
            placeholder={activeProvider ? `Default: ${DEFAULT_LLM_MODELS[activeProvider]}` : 'Leave empty for provider default'}
            maxLength={100}
            spellCheck={false}
            onBlur={(e) => {
              const model = e.target.value.trim() || null;
              if (model !== config.model) void update({ model });
            }}
          />
          {activeProvider && activeKey && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={loadingModels}
              onClick={() => void refreshModels()}
            >
              {loadingModels ? 'Loading…' : `Refresh (${liveModels.length})`}
            </button>
          )}
        </div>
        <datalist id="live-llm-models">
          {liveModels.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>

      {activeProvider && activeKey && (
        <div className="actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={testing}
            onClick={() => {
              setTesting(true);
              setTestResult(null);
              setProblem(null);
              void testLlmConnection()
                .then((res) => setTestResult(`Connected: ${res.provider} (${res.model})`))
                .catch((error: Error) => setProblem(error.message))
                .finally(() => setTesting(false));
            }}
          >
            {testing ? 'Testing…' : 'Test API key'}
          </button>
          {testResult && (
            <span className="small" role="status">
              <DoneIcon size={14} /> {testResult}
            </span>
          )}
        </div>
      )}

      {savedNotice && (
        <p className="small muted" role="status">
          <DoneIcon size={14} /> AI settings saved.
        </p>
      )}
      {problem && <Problem text={problem} />}
    </section>
  );
}

/** Remote HTTP MCP configuration so Claude Code, Codex, and Cursor can read synced reviews without any local daemon. */
function CodingAgents() {
  const [config, setConfig] = useState<RemoteMcpConfig | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(() => {
    void getRemoteMcpConfig()
      .then(setConfig)
      .catch((error: Error) => setProblem(error.message));
  }, []);
  useLoadOnFocus(load);

  if (!config) return problem ? <Problem text={problem} /> : null;

  async function update(patch: Partial<RemoteMcpConfig>) {
    setProblem(null);
    setConfig((cur) => (cur ? { ...cur, ...patch } : cur));
    try {
      setConfig(await saveRemoteMcpConfig(patch));
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  const mcpUrl = `${config.endpoint.replace(/\/+$/, '')}/mcp`;
  const claudeCmd = `claude mcp add --transport http sirv-lens ${mcpUrl} --header "Authorization: Bearer ${config.token || '<your-token>'}"`;
  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        'sirv-lens': {
          url: mcpUrl,
          headers: { Authorization: `Bearer ${config.token || '<your-token>'}` },
        },
      },
    },
    null,
    2,
  );

  async function copy(label: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2500);
  }

  return (
    <section aria-label="Coding agents" className="card settings-section">
      <div className="section">
        <h2>Coding agents (Remote HTTP MCP)</h2>
        <p className="small muted">
          Sync reviewed bug reports to your remote MCP endpoint so Claude Code, Codex, and Cursor can inspect steps,
          HARs, screenshots, and Playwright tests with zero local desktop app installed.
        </p>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => {
            const enabled = e.target.checked;
            void update({ enabled, token: enabled && !config.token ? generateRemoteMcpToken() : config.token });
          }}
        />
        <span>Enable Remote HTTP MCP sync</span>
      </label>

      {config.enabled && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={config.autoSync}
              onChange={(e) => void update({ autoSync: e.target.checked })}
            />
            <span>Automatically sync each new review when created</span>
          </label>

          <div className="field">
            <label htmlFor="mcp-endpoint" className="label">
              Remote MCP server URL
            </label>
            <input
              id="mcp-endpoint"
              className="input"
              defaultValue={config.endpoint}
              placeholder={DEFAULT_MCP_ENDPOINT}
              spellCheck={false}
              onBlur={(e) => {
                const next = e.target.value.trim().replace(/\/+$/, '') || DEFAULT_MCP_ENDPOINT;
                if (next !== config.endpoint) void update({ endpoint: next });
              }}
            />
          </div>

          <div className="field">
            <label htmlFor="mcp-token" className="label">
              Personal access token
            </label>
            <div className="inline-fields">
              <input
                id="mcp-token"
                className="input"
                type="password"
                autoComplete="off"
                value={config.token}
                onChange={(e) => void update({ token: e.target.value })}
                placeholder="lens_..."
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void update({ token: generateRemoteMcpToken() })}
              >
                Generate token
              </button>
            </div>
            <span className="small muted">
              Your extension and your coding agents share this token so only you can read your synced reviews.
            </span>
          </div>

          {config.token && (
            <div className="section">
              <p className="label">Connect Claude Code</p>
              <pre className="code small" style={{ overflowX: 'auto', padding: '8px' }}>
                {claudeCmd}
              </pre>
              <div className="actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy('Claude Code command', claudeCmd)}>
                  Copy Claude Code command
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy('MCP JSON', mcpJson)}>
                  Copy MCP JSON (Cursor / Codex)
                </button>
                {copied && (
                  <span className="small muted" role="status">
                    <DoneIcon size={14} /> Copied {copied}.
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {problem && <Problem text={problem} />}
    </section>
  );
}

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
    <Settings />
  </StrictMode>,
);

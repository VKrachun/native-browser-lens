import { StrictMode, useCallback, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEFAULT_LLM_MODELS,
  getLlmConfig,
  listProviderModels,
  saveLlmConfig,
  testLlmConnection,
  verifyLlmApiKey,
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
import type { DestinationSettings } from '@/protocol/DestinationSettings';
import type { SpeechStatus } from '@/protocol/SpeechStatus';
import type { VibeQSettings } from '@/protocol/VibeQSettings';
import { trackerNames } from '@/tracker-drafts';
import {
  AgentIcon,
  BackIcon,
  CompassIcon,
  DoneIcon,
  DraftIcon,
  LensMark,
  LinkIcon,
  MicIcon,
  NextIcon,
  RocketIcon,
  ShieldIcon,
  SlidersIcon,
} from '@/ui/icons';
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
const VIEW_KEY = 'lens.settings.view';
const WIZARD_DONE_KEY = 'lens.settings.wizardDone';

type ViewMode = 'wizard' | 'all';
type StepId = 'destination' | 'voice' | 'ai' | 'agents' | 'privacy';

interface StepDef {
  id: StepId;
  shortTitle: string;
  title: string;
  subtitle: string;
  optional: boolean;
  icon: typeof LinkIcon;
}

const STEPS: StepDef[] = [
  {
    id: 'destination',
    shortTitle: 'Destination',
    title: 'Where should bug reports go?',
    subtitle: 'Pick a default issue tracker or connect VibeQ. You can always export a ZIP or copy Markdown without one.',
    optional: false,
    icon: LinkIcon,
  },
  {
    id: 'voice',
    shortTitle: 'Voice',
    title: 'Set up voice narration',
    subtitle: 'Talk through bugs while you click. Transcribe 100% locally in your browser or with a Groq/OpenAI key.',
    optional: true,
    icon: MicIcon,
  },
  {
    id: 'ai',
    shortTitle: 'AI summaries',
    title: 'Add an AI model for auto-drafting',
    subtitle: 'Bring your own API key to write titles and findings, split long sessions into tasks, and check duplicates.',
    optional: true,
    icon: DraftIcon,
  },
  {
    id: 'agents',
    shortTitle: 'Coding agents',
    title: 'Connect Claude Code, Cursor, or Codex',
    subtitle: 'Sync reviewed reports to Remote HTTP MCP so coding agents inspect steps, HARs, screenshots, and Playwright tests.',
    optional: true,
    icon: AgentIcon,
  },
  {
    id: 'privacy',
    shortTitle: 'Privacy',
    title: 'Review your setup, storage & privacy',
    subtitle: 'Check what is ready, configure local IndexedDB retention, and add custom redaction rules.',
    optional: false,
    icon: ShieldIcon,
  },
];

interface SetupSnapshot {
  destination: DestinationSettings | null;
  speech: SpeechStatus | null;
  llm: LlmConfig | null;
  mcp: RemoteMcpConfig | null;
}

interface StepState {
  ready: boolean;
  inProgress?: boolean;
  detail: string;
}

const PROVIDER_LABELS: Record<LlmProvider, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
};

function notifySettingsChanged() {
  window.dispatchEvent(new Event('lens-settings-changed'));
}

function readInitialView(): ViewMode {
  const params = new URLSearchParams(window.location.search);
  const viewParam = params.get('view');
  if (viewParam === 'all') return 'all';
  if (viewParam === 'wizard' || params.get('setup') === '1' || params.get('step')) return 'wizard';
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'all' || saved === 'wizard') return saved;
  } catch {
    // ignore storage errors
  }
  return 'wizard';
}

function readInitialStep(): StepId {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('step') as StepId | null;
  if (requested && STEPS.some((s) => s.id === requested)) return requested;
  return 'destination';
}

function readWizardDone(): boolean {
  try {
    return localStorage.getItem(WIZARD_DONE_KEY) === '1';
  } catch {
    return false;
  }
}

function computeStepStates(snapshot: SetupSnapshot, wizardDone: boolean): Record<StepId, StepState> {
  const destTracker = snapshot.destination?.choice?.tracker ?? null;
  const destReady = Boolean(destTracker);
  const destDetail = destTracker
    ? trackerNames[destTracker]
    : snapshot.destination?.vibeqConnected
      ? 'VibeQ connected'
      : 'Not chosen';

  const speechState = snapshot.speech?.model.state;
  const voiceReady = speechState === 'ready';
  const voiceDownloading = speechState === 'downloading';
  const voiceDetail = voiceReady
    ? `Ready (${snapshot.speech?.engines[0] ?? 'local'})`
    : voiceDownloading
      ? 'Downloading…'
      : 'Not set up';

  const configuredLlm = snapshot.llm
    ? (['openrouter', 'anthropic', 'openai', 'gemini'] as LlmProvider[]).filter((p) => Boolean(snapshot.llm?.keys[p]))
    : [];
  const firstConfigured = configuredLlm[0] ?? null;
  const activeLlm = snapshot.llm?.provider ?? firstConfigured;
  const aiReady = firstConfigured !== null;
  const aiDetail = aiReady
    ? activeLlm && snapshot.llm?.keys[activeLlm]
      ? PROVIDER_LABELS[activeLlm]
      : PROVIDER_LABELS[firstConfigured]
    : 'Optional';

  const mcpReady = Boolean(snapshot.mcp?.enabled && snapshot.mcp.token);
  const mcpDetail = mcpReady ? 'MCP active' : 'Optional';

  return {
    destination: { ready: destReady, detail: destDetail },
    voice: { ready: voiceReady, inProgress: voiceDownloading, detail: voiceDetail },
    ai: { ready: aiReady, detail: aiDetail },
    agents: { ready: mcpReady, detail: mcpDetail },
    privacy: { ready: wizardDone, detail: wizardDone ? 'All set' : 'Local defaults' },
  };
}

function Settings() {
  const [client] = useState(() => new LensClient());
  const [version, setVersion] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(readInitialView);
  const [step, setStep] = useState<StepId>(readInitialStep);
  const [wizardDone, setWizardDone] = useState<boolean>(readWizardDone);
  const [justFinished, setJustFinished] = useState(false);
  const [snapshot, setSnapshot] = useState<SetupSnapshot>({
    destination: null,
    speech: null,
    llm: null,
    mcp: null,
  });

  useEffect(() => {
    client
      .request({ method: 'hello' })
      .then((hello) => setVersion(hello.version))
      .catch(() => {});
    return () => client.disconnect();
  }, [client]);

  const loadSnapshot = useCallback(async () => {
    const [destination, speech, llm, mcp] = await Promise.all([
      client.request({ method: 'getDestination' }).catch(() => null),
      client.request({ method: 'speechStatus' }).catch(() => null),
      getLlmConfig().catch(() => null),
      getRemoteMcpConfig().catch(() => null),
    ]);
    setSnapshot({ destination, speech, llm, mcp });
  }, [client]);

  useLoadOnFocus(loadSnapshot);

  useEffect(() => {
    const refresh = () => void loadSnapshot();
    window.addEventListener('lens-settings-changed', refresh);
    window.addEventListener('lens-destination-changed', refresh);
    return () => {
      window.removeEventListener('lens-settings-changed', refresh);
      window.removeEventListener('lens-destination-changed', refresh);
    };
  }, [loadSnapshot]);

  const states = computeStepStates(snapshot, wizardDone);
  const stepIndex = Math.max(
    0,
    STEPS.findIndex((s) => s.id === step),
  );
  const currentStep = STEPS[stepIndex]!;
  const prevStep = stepIndex > 0 ? (STEPS[stepIndex - 1] ?? null) : null;
  const nextStep = stepIndex < STEPS.length - 1 ? (STEPS[stepIndex + 1] ?? null) : null;
  const configuredCount = (['destination', 'voice', 'ai', 'agents'] as StepId[]).filter((id) => states[id].ready).length;

  function changeView(nextView: ViewMode) {
    setView(nextView);
    setJustFinished(false);
    try {
      localStorage.setItem(VIEW_KEY, nextView);
    } catch {
      // ignore storage errors
    }
  }

  function goToStep(nextStepId: StepId) {
    setStep(nextStepId);
    setJustFinished(false);
    if (view !== 'wizard') {
      document.querySelector(`[data-step-group="${nextStepId}"]`)?.scrollIntoView({ behavior: 'smooth' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function finishSetup() {
    setWizardDone(true);
    setJustFinished(true);
    try {
      localStorage.setItem(WIZARD_DONE_KEY, '1');
    } catch {
      // ignore storage errors
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <main className={`page settings ${view === 'wizard' ? 'settings-wizard' : 'settings-all'}`}>
      <header className="settings-head">
        <div className="settings-brand">
          <LensMark />
          <h1>Settings</h1>
          {version && <span className="version-badge small muted num">v{version}</span>}
        </div>
        <div className="segmented view-toggle" role="group" aria-label="Settings layout">
          <button
            type="button"
            className="btn btn-sm"
            aria-pressed={view === 'wizard'}
            onClick={() => changeView('wizard')}
          >
            <CompassIcon size={14} />
            Guided setup
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-pressed={view === 'all'}
            onClick={() => changeView('all')}
          >
            <SlidersIcon size={14} />
            All settings
          </button>
        </div>
      </header>

      {view === 'wizard' ? (
        <WizardStepper
          steps={STEPS}
          current={step}
          states={states}
          configuredCount={configuredCount}
          onSelect={goToStep}
        />
      ) : (
        <StatusLine states={states} onJump={goToStep} />
      )}

      {view === 'wizard' && (
        <div className="wizard-stage-head">
          <div className="wizard-stage-meta">
            <span className="small muted num">
              Step {stepIndex + 1} of {STEPS.length}
            </span>
            {states[currentStep.id].ready ? (
              <span className="pill" data-tone="success">
                {currentStep.id === 'privacy' ? 'Completed' : 'Configured'}
              </span>
            ) : states[currentStep.id].inProgress ? (
              <span className="pill" data-tone="info">
                Downloading…
              </span>
            ) : currentStep.id === 'privacy' ? (
              <span className="pill" data-tone="info">
                Final review
              </span>
            ) : currentStep.optional ? (
              <span className="pill">Optional</span>
            ) : (
              <span className="pill" data-tone="warning">
                Recommended
              </span>
            )}
          </div>
          <h2 className="wizard-stage-title">{currentStep.title}</h2>
          <p className="small muted">{currentStep.subtitle}</p>
        </div>
      )}

      <div className="wizard-panels">
        <div className="wizard-panel" data-step-group="destination" hidden={view === 'wizard' && step !== 'destination'}>
          <DestinationForm client={client} />
          <VibeQ client={client} />
        </div>

        <div className="wizard-panel" data-step-group="voice" hidden={view === 'wizard' && step !== 'voice'}>
          <Voice client={client} />
        </div>

        <div className="wizard-panel" data-step-group="ai" hidden={view === 'wizard' && step !== 'ai'}>
          <Models />
        </div>

        <div className="wizard-panel" data-step-group="agents" hidden={view === 'wizard' && step !== 'agents'}>
          <CodingAgents />
        </div>

        <div className="wizard-panel" data-step-group="privacy" hidden={view === 'wizard' && step !== 'privacy'}>
          {view === 'wizard' && (
            <SetupSummary
              states={states}
              justFinished={justFinished}
              onEditStep={goToStep}
              onShowAll={() => changeView('all')}
            />
          )}
          <Storage client={client} />
          <PrivacyRules client={client} />
          <section className="card settings-section" aria-label="Privacy">
            <h2>What Lens reads</h2>
            <p className="small muted">
              Lens runs completely inside your browser and stores recordings locally in IndexedDB. It reads a site only
              after you allow it from the side panel. While it collects network bodies and console messages, Chrome shows
              a bar that says Lens started debugging this browser; you can pause collection anytime from the side panel.
            </p>
            {import.meta.env.FIREFOX !== true && <IncognitoNote />}
          </section>
        </div>
      </div>

      {view === 'wizard' && (
        <footer className="wizard-footer" aria-label="Wizard navigation">
          <div className="wizard-footer-left">
            {prevStep ? (
              <button type="button" className="btn btn-secondary" onClick={() => goToStep(prevStep.id)}>
                <BackIcon size={15} />
                Back
              </button>
            ) : (
              <span className="small muted">Changes save automatically</span>
            )}
          </div>
          <div className="wizard-footer-right">
            {nextStep && currentStep.optional && !states[currentStep.id].ready && (
              <button type="button" className="btn btn-ghost" onClick={() => goToStep(nextStep.id)}>
                Skip for now
              </button>
            )}
            {nextStep ? (
              <button type="button" className="btn btn-primary" onClick={() => goToStep(nextStep.id)}>
                Next: {nextStep.shortTitle}
                <NextIcon size={15} />
              </button>
            ) : justFinished ? (
              <button type="button" className="btn btn-secondary" onClick={() => changeView('all')}>
                <SlidersIcon size={14} />
                View all settings
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={finishSetup}>
                <RocketIcon size={15} />
                Finish setup
              </button>
            )}
          </div>
        </footer>
      )}
    </main>
  );
}

function WizardStepper({
  steps,
  current,
  states,
  configuredCount,
  onSelect,
}: {
  steps: StepDef[];
  current: StepId;
  states: Record<StepId, StepState>;
  configuredCount: number;
  onSelect: (id: StepId) => void;
}) {
  const currentIndex = steps.findIndex((s) => s.id === current);
  const progressPct = Math.round(((currentIndex + 1) / steps.length) * 100);

  return (
    <nav className="card wizard-stepper" aria-label="Setup steps">
      <div className="wizard-stepper-top">
        <span className="small muted">
          <strong className="num">{configuredCount} of 4</strong> integrations configured
        </span>
        <span className="small muted num">{progressPct}%</span>
      </div>
      <div className="wizard-progress-track" aria-hidden="true">
        <div className="wizard-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>
      <ol className="wizard-step-list">
        {steps.map((s, idx) => {
          const st = states[s.id];
          const active = s.id === current;
          return (
            <li key={s.id}>
              <button
                type="button"
                className="wizard-step-btn"
                data-active={active || undefined}
                data-ready={st.ready || undefined}
                aria-current={active ? 'step' : undefined}
                onClick={() => onSelect(s.id)}
              >
                <span className="wizard-step-badge" aria-hidden="true">
                  {st.inProgress ? (
                    <span className="spinner" />
                  ) : st.ready ? (
                    <DoneIcon size={14} />
                  ) : (
                    <span className="num">{idx + 1}</span>
                  )}
                </span>
                <span className="wizard-step-copy">
                  <span className="wizard-step-name">{s.shortTitle}</span>
                  <span className="wizard-step-detail">{st.detail}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function SetupSummary({
  states,
  justFinished,
  onEditStep,
  onShowAll,
}: {
  states: Record<StepId, StepState>;
  justFinished: boolean;
  onEditStep: (id: StepId) => void;
  onShowAll: () => void;
}) {
  const summarySteps = STEPS.slice(0, 4);
  return (
    <section className="card settings-section setup-summary" aria-label="Setup summary">
      {justFinished && (
        <div className="notice setup-complete-banner" data-tone="info" role="status">
          <DoneIcon size={16} />
          <div>
            <strong>You&apos;re all set to record.</strong> Open the Sirv Lens side panel on any tab, allow the site,
            and hit <strong>Record</strong>.
          </div>
        </div>
      )}
      <div className="section-row">
        <div className="section">
          <h2>Setup checklist</h2>
          <p className="small muted">Everything saves locally in this browser profile. Jump back to tweak any step.</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onShowAll}>
          Open all settings
        </button>
      </div>
      <div className="summary-grid">
        {summarySteps.map((s) => {
          const st = states[s.id];
          const Icon = s.icon;
          return (
            <button key={s.id} type="button" className="summary-item" onClick={() => onEditStep(s.id)}>
              <span className="summary-icon" data-ready={st.ready || undefined}>
                {st.ready ? <DoneIcon size={15} /> : <Icon size={15} />}
              </span>
              <span className="summary-text">
                <span className="summary-title">{s.shortTitle}</span>
                <span className="small muted">{st.detail}</span>
              </span>
              <span className="summary-action small">{st.ready ? 'Edit' : 'Set up'}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function StatusLine({
  states,
  onJump,
}: {
  states: Record<StepId, StepState>;
  onJump: (id: StepId) => void;
}) {
  const items: Array<{ id: StepId; label: string; ok: boolean }> = [
    {
      id: 'destination',
      label: states.destination.ready ? `Destination: ${states.destination.detail}` : 'Destination: not chosen',
      ok: states.destination.ready,
    },
    {
      id: 'voice',
      label: states.voice.ready ? `Voice: ${states.voice.detail}` : 'Voice: click Download in Voice notes',
      ok: states.voice.ready,
    },
    {
      id: 'ai',
      label: states.ai.ready ? `AI model: ${states.ai.detail}` : 'AI model: add an API key',
      ok: states.ai.ready,
    },
    {
      id: 'agents',
      label: states.agents.ready ? 'Remote MCP: enabled' : 'Remote MCP: off',
      ok: states.agents.ready,
    },
  ];
  return (
    <nav className="status-line" aria-label="Status">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="pill"
          data-tone={item.ok ? 'success' : 'warning'}
          onClick={() => onJump(item.id)}
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

/** Direct BYOK LLM API keys (OpenRouter, Anthropic, OpenAI, Gemini) for findings, task splitting, and duplicate checks. */
function Models() {
  const [config, setConfig] = useState<LlmConfig | null>(null);
  const [liveModels, setLiveModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [verifyingProvider, setVerifyingProvider] = useState<LlmProvider | null>(null);
  const [verifyByProvider, setVerifyByProvider] = useState<Partial<Record<LlmProvider, { ok: boolean; text: string }>>>({});
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
      notifySettingsChanged();
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

  const keyInputs: Array<{ id: LlmProvider; label: string; placeholder: string }> = [
    { id: 'openrouter', label: 'OpenRouter API key', placeholder: 'sk-or-v1-...' },
    { id: 'anthropic', label: 'Anthropic API key', placeholder: 'sk-ant-...' },
    { id: 'openai', label: 'OpenAI API key', placeholder: 'sk-...' },
    { id: 'gemini', label: 'Google Gemini API key', placeholder: 'AIza...' },
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

      <div className="provider-keys-grid">
        {keyInputs.map((item) => {
          const isActive = activeProvider === item.id;
          const keyVal = config.keys[item.id];
          const verified = verifyByProvider[item.id];
          return (
            <div className="field provider-key-field" key={item.id} data-active={isActive || undefined}>
              <label htmlFor={`key-${item.id}`} className="label">
                {item.label}
              </label>
              <div className="key-input-row">
                <input
                  id={`key-${item.id}`}
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={keyVal}
                  placeholder={item.placeholder}
                  onChange={(e) => {
                    setVerifyByProvider((cur) => ({ ...cur, [item.id]: undefined }));
                    void update({ keys: { ...config.keys, [item.id]: e.target.value } });
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!keyVal.trim() || verifyingProvider === item.id}
                  onClick={() => {
                    setVerifyingProvider(item.id);
                    setVerifyByProvider((cur) => ({ ...cur, [item.id]: undefined }));
                    void verifyLlmApiKey(item.id, keyVal)
                      .then((res) => setVerifyByProvider((cur) => ({ ...cur, [item.id]: { ok: true, text: res.detail } })))
                      .catch((error: Error) => setVerifyByProvider((cur) => ({ ...cur, [item.id]: { ok: false, text: error.message } })))
                      .finally(() => setVerifyingProvider(null));
                  }}
                >
                  {verifyingProvider === item.id ? 'Checking…' : 'Verify'}
                </button>
              </div>
              {verified && (
                <span className={`small key-verify-msg ${verified.ok ? 'success-text' : 'danger-text'}`} role="status">
                  {verified.ok && <DoneIcon size={13} />} {verified.text}
                </span>
              )}
            </div>
          );
        })}
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
      notifySettingsChanged();
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

import { useEffect, useState } from 'react';
import { LensError, type LensClient } from '@/lens-client';
import type { SetupStatus } from '@/protocol/SetupStatus';
import { CopyIcon, DoneIcon } from '@/ui/icons';

/** People download Lens from its site; the terminal installers stay on the release. */
const SITE = 'https://lens.sirv.studio/#download';
const RELEASES = 'https://github.com/sirv/native-browser-lens/releases/latest/download';

/** The installer for this computer, as people know it, and the terminal line for those who prefer it. */
function installerFor(os: string) {
  if (os === 'win') return { system: 'Windows', file: 'the setup program (.exe)', shell: 'PowerShell', command: `irm ${RELEASES}/install.ps1 | iex` };
  if (os === 'mac') return { system: 'Mac', file: 'the .dmg', shell: 'Terminal', command: `curl -fsSL ${RELEASES}/install.sh | sh` };
  return { system: 'Linux', file: 'the .deb, the Arch package or the AppImage', shell: 'a terminal', command: `curl -fsSL ${RELEASES}/install.sh | sh` };
}

/** A missing registration looks the same as a missing app to the browser. */
export const hostNotFound = (reason: string) => /native messaging host not found|no such native application/i.test(reason);

/**
 * Shown while the extension cannot reach the Lens app: the installer for this computer, and a wait
 * that ends by itself when the app answers.
 */
export function InstallApp({ reason, quit = false }: { reason: string; quit?: boolean }) {
  const [os, setOs] = useState('linux');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void browser.runtime.getPlatformInfo().then((info) => setOs(info.os));
  }, []);
  const missing = hostNotFound(reason);
  const { system, file, shell, command } = installerFor(os);
  // The app is installed: the person quit it, so there is nothing to download.
  if (quit) {
    return (
      <section className="card onboarding" aria-label="Lens app">
        <h2>You quit the Lens app</h2>
        <p className="muted">Open Sirv Lens from your applications. This panel continues by itself.</p>
        <p className="waiting small muted" role="status" aria-label="Waiting for the app">
          <span className="spinner" aria-hidden="true" />
          Waiting for the app
        </p>
      </section>
    );
  }
  return (
    <section className="card onboarding" aria-label="Install the Lens app">
      <h2>{missing ? 'The browser could not find the Lens app' : 'The browser lost its connection to Lens'}</h2>
      {missing ? (
        <p className="muted">
          If Sirv Lens is installed, open it from your applications to register it with this browser.
          Otherwise, download it below.
        </p>
      ) : (
        <p className="muted">
          <em>{reason}</em>. Open Sirv Lens from your applications to reconnect.
        </p>
      )}
      <a className="btn btn-primary btn-block" href={SITE} target="_blank" rel="noreferrer">
        Download for {system}
      </a>
      <p className="small muted">
        Choose {file}, open it, and then open Sirv Lens. This panel continues by itself.
      </p>
      <details className="terminal-install">
        <summary className="small muted">Install from {shell} instead</summary>
        <div className="command">
          <code>{command}</code>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true))}
          >
            {copied ? <DoneIcon size={14} /> : <CopyIcon size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </details>
      <p className="waiting small muted" role="status" aria-label="Waiting for the app">
        <span className="spinner" aria-hidden="true" />
        Waiting for the app
      </p>
    </section>
  );
}

const loginStep = (status: SetupStatus) => status.steps.find((s) => s.name === 'Starts at login');

export function SetupCard({ client, refresh }: { client: LensClient; refresh: number }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // A new connection (the app restarted) asks again from the start.
    setTurningOn(false);
    const load = () =>
      client
        .request({ method: 'setupStatus' })
        .then((s) => {
          if (!alive) return;
          setStatus(s);
          // Once it starts at login, there is nothing left to watch.
          if (loginStep(s)?.mark !== 'todo') clearInterval(timer);
        })
        .catch(() => {});
    const timer = setInterval(load, 4000);
    void load();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, refresh]);
  if (!status) return null;
  if (loginStep(status)?.mark !== 'todo') return null;

  async function turnOn() {
    setTurningOn(true);
    setProblem(null);
    try {
      // The app restarts under the service manager; this panel reconnects by itself.
      await client.request({ method: 'installService' });
    } catch (error) {
      // The restart ends the connection: that is the service starting, not a failure.
      if (error instanceof LensError && error.code === 'disconnected') return;
      setProblem(`Lens did not turn it on: ${(error as Error).message}. Run lens service install in a terminal.`);
      setTurningOn(false);
    }
  }

  return (
    <section className="card setup" aria-label="Setup">
      <ul>
        <li data-mark="todo">
          <span className="setup-text">
            <strong>Start Lens at login</strong>
            <span className="small muted">So recordings and filing keep working after a restart.</span>
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void turnOn()} disabled={turningOn}>
            {turningOn ? 'Turning on…' : 'Turn on'}
          </button>
        </li>
      </ul>
      {problem && (
        <p role="alert" className="small">
          {problem}
        </p>
      )}
    </section>
  );
}

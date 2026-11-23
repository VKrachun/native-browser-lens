import { useEffect, useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { HandoffApp } from '@/protocol/HandoffApp';
import { AlertIcon, DoneIcon } from '@/ui/icons';
import { useStored } from '../sidepanel/Record';

const NAMES: Record<HandoffApp, string> = {
  claudeCode: 'Claude Code',
  codex: 'Codex',
  t3Code: 'T3 Code',
  zeron: 'Zeron',
};

/** What happens in each app after the hand-off. */
const NEXT: Record<HandoffApp, string> = {
  claudeCode: 'Claude Code opens in a terminal with the task. Press Enter to start it.',
  codex: 'Codex opens a new chat with the task. Send it to start.',
  t3Code: 'T3 Code works on it now.',
  zeron: 'Zeron works on it now.',
};

/**
 * The hand-off state: the apps installed here, the chosen one, and the project folder, remembered
 * for each site so the next recording of the same site goes to the same project. The review page
 * also uses it to hand off right after filing.
 */
export function useHandoff(client: LensClient, site: string) {
  const [apps, setApps] = useState<HandoffApp[]>([]);
  const [chosen, setChosen] = useStored<HandoffApp | ''>('lens.handoff.app', '');
  const [folders, setFolders] = useStored<Record<string, string>>('lens.handoff.folders', {});
  /** Hand off as soon as the review is filed to VibeQ; remembered for the next review. */
  const [afterFiling, setAfterFiling] = useStored('lens.handoff.afterFiling', false);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  /** The last hand-off, with its review: a new review on the page has not been handed off. */
  const [done, setDone] = useState<{ review: number; app: HandoffApp; report: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    client
      .request({ method: 'listHandoffApps' })
      .then(setApps)
      .catch(() => setApps([]));
  }, [client]);
  useEffect(() => {
    const saved = folders[site];
    if (saved) setFolder((typed) => typed || saved);
  }, [folders, site]);

  const first = apps[0];
  const app = chosen && apps.includes(chosen) ? chosen : first;

  async function handOff(review: number) {
    if (!app) return;
    setBusy(true);
    setProblem(null);
    try {
      const path = folder.trim();
      const handed = await client.request({ method: 'handOff', params: { review, app, folder: path } });
      setFolders({ ...folders, [site]: path });
      setChosen(app);
      setDone({ review, app, report: handed.folder });
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return {
    apps,
    app,
    choose: setChosen,
    folder,
    setFolder,
    recent: [...new Set(Object.values(folders))],
    /** An app and a folder are there: a hand-off can start. */
    ready: Boolean(app && folder.trim()),
    afterFiling,
    setAfterFiling,
    busy,
    done,
    problem,
    handOff,
  };
}

export type HandoffState = ReturnType<typeof useHandoff>;

export const handoffName = (app: HandoffApp) => NAMES[app];

/** Hands the review to a coding agent app on this computer. */
export function Handoff({ state, review }: { state: HandoffState; review: number }) {
  const { apps, app, folder, busy, problem } = state;
  const done = state.done?.review === review ? state.done : null;
  if (!app) return null;

  return (
    <section className="card handoff" aria-label="Hand off">
      <h2>Hand off to a coding agent</h2>
      <p className="small muted">
        Lens saves the report on this computer and opens the app with the task, in your project's folder.
      </p>
      <form className="handoff-form" onSubmit={(e) => (e.preventDefault(), void state.handOff(review))}>
        <select className="select" aria-label="App" value={app} onChange={(e) => state.choose(e.target.value as HandoffApp)}>
          {apps.map((a) => (
            <option key={a} value={a}>
              {NAMES[a]}
            </option>
          ))}
        </select>
        <input
          className="input"
          aria-label="Project folder"
          placeholder="Project folder, such as /home/you/projects/site"
          list="handoff-folders"
          value={folder}
          onChange={(e) => state.setFolder(e.target.value)}
          spellCheck={false}
        />
        <datalist id="handoff-folders">
          {state.recent.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        <button type="submit" className="btn btn-secondary" disabled={busy || !folder.trim()}>
          {busy ? 'Handing off…' : `Hand off to ${NAMES[app]}`}
        </button>
      </form>
      {done && (
        <p className="small" role="status" aria-label="Hand-off">
          <DoneIcon size={14} /> {NEXT[done.app]} The report is in {done.report}.
        </p>
      )}
      {problem && (
        <div role="alert" className="notice">
          <AlertIcon />
          <span>{problem}</span>
        </div>
      )}
    </section>
  );
}

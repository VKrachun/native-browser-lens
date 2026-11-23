import { useEffect, useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { Issue } from '@/protocol/Issue';
import { useStored } from '../sidepanel/Record';
import { findingsOf, seconds } from './reviewHelpers';

/**
 * A long recording with unrelated problems becomes one task per problem: the summary model names
 * them with their time ranges, and each task keeps only its part of the recording.
 */
export function Issues({ client, id, refresh }: { client: LensClient; id: number; refresh: number }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [hidden, setHidden] = useStored(`lens.issues.hidden.${id}`, false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    // The summary may still run in the background: look again a few times.
    let alive = true;
    const load = () =>
      client
        .request({ method: 'listIssues', params: { observation: id } })
        .then((found) => alive && setIssues(found))
        .catch(() => {});
    void load();
    const timer = setInterval(load, 5000);
    const stop = setTimeout(() => clearInterval(timer), 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [client, id, refresh]);
  if (issues.length < 2 || hidden) return null;

  async function split() {
    setBusy(true);
    setProblem(null);
    try {
      const latest = await client.request({ method: 'getObservation', params: { id } });
      const created = await client.request({
        method: 'splitIntoTasks',
        params: { observation: id, revision: latest.revision, issues },
      });
      // The first task opens here; the others beside it.
      for (const task of created.slice(1)) {
        void browser.tabs.create({ url: browser.runtime.getURL(`/review.html?observation=${task.id}`), active: false });
      }
      if (created[0]) location.href = browser.runtime.getURL(`/review.html?observation=${created[0].id}`);
    } catch (error) {
      setProblem((error as Error).message);
      setBusy(false);
    }
  }

  return (
    <section className="card issues" aria-label="Separate problems">
      <div className="issues-head">
        <h2>This recording shows {issues.length} separate problems</h2>
        <p className="small muted">
          One task each is easier to fix and to check. Each task keeps only its part of the recording, with your words.
        </p>
      </div>
      <ol className="issue-list">
        {issues.map((issue, i) => (
          <li key={i}>
            <div className="issue-title">
              <strong>{issue.title}</strong>
              {issue.fromSeconds !== null && issue.toSeconds !== null && (
                <span className="small muted num">
                  {seconds(issue.fromSeconds)}–{seconds(issue.toSeconds)}
                </span>
              )}
            </div>
            {issue.findings.length > 0 && (
              <ul className="small muted">
                {issue.findings.map((f, n) => (
                  <li key={n}>{f}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      <div className="note-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHidden(true)} disabled={busy}>
          Keep as one task
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void split()} disabled={busy}>
          {busy ? 'Making tasks…' : `Make ${issues.length} tasks`}
        </button>
      </div>
      {problem && (
        <p role="alert" className="small">
          {problem}
        </p>
      )}
    </section>
  );
}

/**
 * One recording with unrelated defects becomes two tasks: the chosen findings move to a new
 * observation that has copies of every capture and voice note, and each is trimmed and filed alone.
 */
export function Split({ client, id, onSplit }: { client: LensClient; id: number; onSplit: () => void }) {
  const [open, setOpen] = useState<{ revision: number; findings: string[] } | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  async function start() {
    setMessage(null);
    const found = await client.request({ method: 'getObservation', params: { id } });
    const findings = findingsOf(found.notes);
    if (findings.length < 2) {
      setMessage('Split needs two or more findings at the top of the notes.');
      return;
    }
    setOpen({ revision: found.revision, findings });
    setChosen([]);
    setTitle('');
  }
  async function split() {
    if (!open) return;
    try {
      const copy = await client.request({
        method: 'splitObservation',
        params: { observation: id, revision: open.revision, findings: chosen, title },
      });
      setOpen(null);
      setMessage(`Moved to “${copy.title}”. It opened in a new tab; trim each recording to its own defect.`);
      onSplit();
      void browser.tabs.create({ url: browser.runtime.getURL(`/review.html?observation=${copy.id}`) });
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  if (!open) {
    return (
      <div className="split">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void start().catch((e: Error) => setMessage(e.message))}>
          Split into two tasks
        </button>
        {message && (
          <span className="small muted" role="status" aria-label="Split">
            {message}
          </span>
        )}
      </div>
    );
  }
  return (
    <fieldset className="split card">
      <legend className="label">Move these findings to a new task</legend>
      {open.findings.map((f, i) => (
        <label key={i} className="check">
          <input
            type="checkbox"
            checked={chosen.includes(i)}
            onChange={(e) => {
              const next = e.target.checked ? [...chosen, i] : chosen.filter((c) => c !== i);
              setChosen(next);
              if (!title.trim() || open.findings.some((g) => g.slice(0, 80) === title)) setTitle(open.findings[next[0] ?? -1]?.slice(0, 80) ?? '');
            }}
          />
          <span>{f}</span>
        </label>
      ))}
      <label className="field">
        <span className="label">Title of the new task</span>
        <input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="note-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(null)}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={chosen.length === 0 || chosen.length === open.findings.length || !title.trim()}
          onClick={() => void split()}
        >
          Move {chosen.length || ''} to a new task
        </button>
      </div>
      {message && (
        <span role="alert" className="small">
          {message}
        </span>
      )}
    </fieldset>
  );
}

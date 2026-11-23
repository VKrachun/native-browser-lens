import { useEffect, useState } from 'react';
import type { LensClient } from '@/lens-client';
import { originOf } from '@/messages';
import type { Duplicate } from '@/protocol/Duplicate';
import { DoneIcon } from '@/ui/icons';

/**
 * Before filing: open VibeQ tasks that may be the same problem, so the person can add to one
 * instead of filing it twice. A small model judges VibeQ's title matches.
 */
export function Duplicates({ client, id }: { client: LensClient; id: number }) {
  const [state, setState] = useState<{ kind: 'checking' } | { kind: 'done'; found: Duplicate[] } | { kind: 'off' }>({
    kind: 'checking',
  });
  useEffect(() => {
    let alive = true;
    client
      .request({ method: 'findDuplicates', params: { observation: id } })
      .then((found) => alive && setState({ kind: 'done', found }))
      // VibeQ not set up, or unreachable: filing shows its own problem, this stays quiet.
      .catch(() => alive && setState({ kind: 'off' }));
    return () => {
      alive = false;
    };
  }, [client, id]);
  if (state.kind === 'off') return null;
  if (state.kind === 'checking') {
    return (
      <p className="small muted waiting" role="status" aria-label="Duplicates">
        <span className="spinner" aria-hidden="true" />
        Looking for the same problem in VibeQ…
      </p>
    );
  }
  if (state.found.length === 0) {
    return (
      <p className="small muted" role="status" aria-label="Duplicates">
        <DoneIcon size={14} /> No open VibeQ task looks like this one.
      </p>
    );
  }
  const same = state.found.some((d) => d.verdict === 'same');
  return (
    <section className="card duplicates" aria-label="Duplicates" data-tone={same ? 'warning' : undefined}>
      <h2>{same ? 'This may already be a task' : 'Similar tasks in VibeQ'}</h2>
      <p className="small muted">
        {same
          ? 'Open it and add what you found there, or file this as a new task if it is different.'
          : 'Their titles are close. Check them before you file.'}
      </p>
      <ul className="duplicate-list">
        {state.found.map((d) => (
          <li key={d.taskId}>
            <span className="pill" data-tone={d.verdict === 'same' ? 'warning' : 'info'}>
              {d.verdict === 'same' ? 'Same problem' : 'Similar title'}
            </span>
            <span className="duplicate-text">
              <a href={originOf(d.url) ? d.url : undefined} target="_blank" rel="noreferrer">
                {d.title}
              </a>
              <span className="small muted">
                {d.status}
                {d.reason && ` · ${d.reason}`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

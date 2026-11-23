import { useCallback, useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { StorageUsage } from '@/protocol/StorageUsage';
import { Problem, formatBytes, useLoadOnFocus } from './shared';

const KEEP = [7, 14, 30, 90];

/** What Lens keeps on this computer, how long it keeps it, and a manual clean-up. */
export function Storage({ client }: { client: LensClient }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  /** The clean-up's days as typed; until then, the retention's (or 30). */
  const [typed, setDays] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(
    () =>
      client
        .request({ method: 'getStorage' })
        .then((found) => (setUsage(found), setProblem(null)))
        .catch((error: Error) => setProblem(error.message)),
    [client],
  );
  useLoadOnFocus(load);

  async function retain(next: number | null, filedOnly: boolean) {
    setProblem(null);
    try {
      setUsage(await client.request({ method: 'setRetention', params: { days: next, filedOnly } }));
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  async function prune() {
    if (!usage) return;
    const days = typed ?? String(usage.retentionDays ?? 30);
    const olderThanDays = Math.floor(Number(days));
    if (!(olderThanDays >= 1)) return setProblem('Type a number of days, 1 or more.');
    const which = usage.retentionFiledOnly ? 'filed observations' : 'observations';
    if (!confirm(`Delete the ${which} older than ${olderThanDays} days, with their recordings and notes?`)) return;
    setBusy(true);
    setProblem(null);
    setResult(null);
    try {
      const pruned = await client.request({
        method: 'pruneStorage',
        params: { olderThanDays, filedOnly: usage.retentionFiledOnly },
      });
      setResult(`Removed ${pruned.deletedObservations} observations, freed ${formatBytes(pruned.freedBytes)}.`);
      await load();
      // The app removes the files a moment later: look again for the new sizes.
      setTimeout(() => void load(), 2000);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!usage) return problem ? <Problem text={problem} /> : null;
  const parts = [
    ['Recordings', usage.recordingsBytes, 'var(--primary)'],
    ['Audio', usage.audioBytes, 'var(--info)'],
    ['Screenshots', usage.screenshotsBytes, 'var(--success)'],
    ['Speech models', usage.modelsBytes, 'var(--warning)'],
    ['Other', usage.otherBytes, 'var(--neutral)'],
  ] as const;
  const total = Math.max(1, usage.totalBytes);
  const keep = usage.retentionDays === null ? '' : String(usage.retentionDays);
  const keepOptions = usage.retentionDays === null || KEEP.includes(usage.retentionDays) ? KEEP : [...KEEP, usage.retentionDays];
  return (
    <section aria-label="Storage" className="card settings-section">
      <div className="section-row">
        <div className="section">
          <h2>Storage and retention</h2>
          <p className="small muted num">
            {usage.observationCount} observations, {usage.reviewCount} reviews
          </p>
        </div>
        <strong className="num">{formatBytes(usage.totalBytes)}</strong>
      </div>
      <div className="storage-bar" aria-hidden="true">
        {parts.map(([label, bytes, color]) => (
          <span key={label} style={{ width: `${(bytes / total) * 100}%`, background: color }} />
        ))}
      </div>
      <dl className="storage-list small">
        {parts.map(([label, bytes, color]) => (
          <div key={label}>
            <dt>
              <span className="storage-swatch" style={{ background: color }} aria-hidden="true" />
              {label}
            </dt>
            <dd className="num">{formatBytes(bytes)}</dd>
          </div>
        ))}
        <div>
          <dt>Total</dt>
          <dd className="num">{formatBytes(usage.totalBytes)}</dd>
        </div>
      </dl>
      <div className="field">
        <label htmlFor="retention" className="label">
          Keep observations
        </label>
        <select
          id="retention"
          className="select"
          value={keep}
          onChange={(e) => void retain(e.target.value ? Number(e.target.value) : null, usage.retentionFiledOnly)}
        >
          <option value="">Keep forever</option>
          {keepOptions.map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </select>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={usage.retentionFiledOnly}
          onChange={(e) => void retain(usage.retentionDays, e.target.checked)}
        />
        <span>
          Only delete filed reviews
          <span className="small muted" style={{ display: 'block' }}>
            Observations you did not file yet stay until you delete them.
          </span>
        </span>
      </label>
      <div className="cleanup">
        <label htmlFor="prune-days" className="small">
          Delete now what is older than
        </label>
        <input
          id="prune-days"
          className="input num"
          type="number"
          min={1}
          max={3650}
          value={typed ?? String(usage.retentionDays ?? 30)}
          onChange={(e) => setDays(e.target.value)}
        />
        <span className="small">days</span>
        <button type="button" className="btn btn-secondary" onClick={() => void prune()} disabled={busy}>
          {busy ? 'Cleaning up…' : 'Clean up now'}
        </button>
      </div>
      {result && (
        <p className="small" role="status" aria-label="Clean-up result">
          {result}
        </p>
      )}
      {problem && <Problem text={problem} />}
    </section>
  );
}

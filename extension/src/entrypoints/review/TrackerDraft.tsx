import { useState } from 'react';
import { basecampNotes, draftDescription, draftTarget, trackerNames, type DraftTracker } from '@/tracker-drafts';
import type { Review } from '@/protocol/Review';
const buttons: Record<DraftTracker, string> = {
  jira: 'Copy and open Jira Cloud',
  basecamp: 'Copy title and open Basecamp',
  github: 'Open draft in GitHub Issues',
  linear: 'Open draft in Linear',
  clipboard: 'Copy summary',
};

export function TrackerDraft({ tracker, address, review }: { tracker: DraftTracker; address: string; review: Review }) {
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [manual, setManual] = useState<{ text: string; url: string | null; label: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function copyField(text: string, label: string, url: string | null = null) {
    setManual(null);
    setStatus('');
    setError('');
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      setManual({ text, url, label });
      setError(`Select and copy the ${label.toLowerCase()} below.`);
      return false;
    }
  }

  async function open() {
    setBusy(true);
    setStatus('');
    setError('');
    setManual(null);
    try {
      const { url, copy } = draftTarget(tracker, address, review.title, draftDescription(review));
      if (copy && !(await copyField(copy, tracker === 'basecamp' ? 'Title' : 'Summary', url))) return;
      if (url) {
        await browser.tabs.create({ url });
        if (tracker === 'basecamp') setStatus('Paste the title in Basecamp. Copy notes here for its Notes field.');
        else setStatus(copy ? 'Summary copied. Paste it into your draft.' : 'Draft opened.');
      } else {
        setStatus('Review summary copied.');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn btn-primary" type="button" disabled={busy} onClick={open}>
        {buttons[tracker]}
      </button>
      {tracker === 'basecamp' && (
        <button className="btn btn-secondary" type="button" disabled={busy} onClick={async () => {
          if (await copyField(basecampNotes(review), 'Notes')) setStatus('Notes copied. Paste them into the Basecamp Notes field.');
        }}>
          Copy notes
        </button>
      )}
      {error && <span role="alert" className="small">{error}</span>}
      {manual && (
        <>
          <textarea className="input" aria-label={`${manual.label} to copy`} value={manual.text} readOnly onFocus={(e) => e.target.select()} />
          {manual.url && <a href={manual.url} target="_blank" rel="noreferrer">Open {trackerNames[tracker]}</a>}
        </>
      )}
      {status && <span role="status" className="small">{status}</span>}
    </>
  );
}

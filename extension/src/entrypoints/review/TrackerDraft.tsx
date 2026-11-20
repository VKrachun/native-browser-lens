import { useState } from 'react';
import { draftDescription, draftTarget, trackerNames, type DraftTracker } from '@/tracker-drafts';
import type { Review } from '@/protocol/Review';
const buttons: Record<DraftTracker, string> = {
  jira: 'Copy and open Jira Cloud',
  basecamp: 'Copy and open Basecamp',
  github: 'Open draft in GitHub Issues',
  linear: 'Open draft in Linear',
  clipboard: 'Copy summary',
};

export function TrackerDraft({ tracker, address, review }: { tracker: DraftTracker; address: string; review: Review }) {
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [manual, setManual] = useState<{ text: string; url: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    setStatus('');
    setError('');
    setManual(null);
    try {
      const { url, copy } = draftTarget(tracker, address, review.title, draftDescription(review));
      if (copy) {
        try {
          await navigator.clipboard.writeText(copy);
        } catch {
          setManual({ text: copy, url });
          setError('Select and copy the summary below.');
          return;
        }
      }
      if (url) {
        await browser.tabs.create({ url });
        setStatus(copy ? 'Summary copied. Paste it into your draft.' : 'Draft opened.');
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
      {error && <span role="alert" className="small">{error}</span>}
      {manual && (
        <>
          <textarea className="input" aria-label="Summary to copy" value={manual.text} readOnly onFocus={(e) => e.target.select()} />
          {manual.url && <a href={manual.url} target="_blank" rel="noreferrer">Open {trackerNames[tracker]}</a>}
        </>
      )}
      {status && <span role="status" className="small">{status}</span>}
    </>
  );
}

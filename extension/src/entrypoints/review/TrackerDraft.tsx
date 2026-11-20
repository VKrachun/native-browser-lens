import { useState } from 'react';
import { openBasecamp } from '@/basecamp-handoff';
import { basecampNotes, draftDescription, draftTarget, trackerNames, type DraftTracker } from '@/tracker-drafts';
import type { Review } from '@/protocol/Review';
const buttons: Record<DraftTracker, string> = {
  jira: 'Copy and open Jira Cloud',
  basecamp: 'Open Basecamp draft',
  github: 'Open draft in GitHub Issues',
  linear: 'Open draft in Linear',
  clipboard: 'Copy summary',
};

export function TrackerDraft({ tracker, address, review, includeVoice }: { tracker: DraftTracker; address: string; review: Review; includeVoice: boolean }) {
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [manual, setManual] = useState<{ text: string; url: string | null; label: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [fallback, setFallback] = useState(false);
  const [zip, setZip] = useState(true);
  const [video, setVideo] = useState(false);

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
    setFallback(false);
    setBusy(true);
    setStatus('');
    setError('');
    setManual(null);
    try {
      if (tracker === 'basecamp') {
        setStatus('Opening Basecamp…');
        await openBasecamp(address, review, zip, video, includeVoice, setStatus);
        setStatus('Draft filled. Review it in Basecamp and add the to-do when ready.');
        return;
      }
      const { url, copy } = draftTarget(tracker, address, review.title, draftDescription(review));
      if (copy && !(await copyField(copy, 'Summary', url))) return;
      if (url) {
        await browser.tabs.create({ url });
        setStatus(copy ? 'Summary copied. Paste it into your draft.' : 'Draft opened.');
      } else {
        setStatus('Review summary copied.');
      }
    } catch (err) {
      setFallback(tracker === 'basecamp');
      setStatus('');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {tracker === 'basecamp' && <fieldset className="basecamp-files" disabled={busy}>
        <legend>Upload to the Basecamp draft</legend>
        <label><input type="checkbox" checked={zip} onChange={e => setZip(e.target.checked)} /> Evidence ZIP</label>
        {review.items.some(item => item.recording) &&
          <label><input type="checkbox" checked={video} onChange={e => setVideo(e.target.checked)} /> Replay MP4 {includeVoice ? '(with recorded voice)' : '(muted)'}</label>}
      </fieldset>}
      <button className="btn btn-primary" type="button" disabled={busy} onClick={open}>
        {buttons[tracker]}
      </button>
      {error && <span role="alert" className="small">{error}</span>}
      {fallback && <details className="small">
        <summary>Finish manually</summary>
        <button type="button" className="btn btn-secondary" onClick={async () => {
          if (await copyField(review.title, 'Title')) setStatus('Title copied.');
        }}>Copy title</button>
        <button type="button" className="btn btn-secondary" onClick={async () => {
          if (await copyField(basecampNotes(review), 'Notes')) setStatus('Notes copied.');
        }}>Copy notes</button>
        <p>Use Save evidence ZIP or Save replay as MP4 under Attachments.</p>
      </details>}
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

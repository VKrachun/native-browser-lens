import { useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { Review } from '@/protocol/Review';

export function Attachments({ client, review, basecamp }: { client: LensClient; review: Review; basecamp: boolean }) {
  const [busy, setBusy] = useState<number | 'zip' | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [error, setError] = useState('');
  const recordings = review.items.filter(item => item.recording);

  async function save(capture: number | null) {
    setBusy(capture ?? 'zip');
    setError('');
    try {
      const file = await client.request({ method: 'exportAttachment', params: { review: review.id, capture } });
      setSaved(files => [...files, file]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card attachments" aria-label="Attachments">
      <h2>Attachments</h2>
      <p className="small muted">The ZIP contains the reviewed diagnostic files and any included recordings.
        {basecamp && ' Attach the saved file with the paperclip in Basecamp Notes.'}</p>
      <div className="attachment-actions">
        <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void save(null)}>
          {busy === 'zip' ? 'Saving ZIP…' : 'Save evidence ZIP'}
        </button>
        {recordings.map(item => (
          <button key={item.capture} type="button" className="btn btn-secondary" disabled={busy !== null}
            onClick={() => void save(item.capture)}>
            {busy === item.capture ? 'Rendering MP4…' : recordings.length === 1 ? 'Save replay as MP4' : `Save MP4 · capture ${item.capture}`}
          </button>
        ))}
      </div>
      {recordings.length > 0 && <p className="small muted">The MP4 shows the kept replay without audio. Screenshot masks apply to the still images.</p>}
      <div role="status" aria-live="polite">
        {saved.map(file => <p key={file} className="small">Saved to {file}</p>)}
      </div>
      {error && <p role="alert" className="small">{error}</p>}
    </section>
  );
}

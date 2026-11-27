import { useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { Review } from '@/protocol/Review';

export function Attachments({
  client,
  review,
}: {
  client: LensClient;
  review: Review;
  includeVoice: boolean;
  setIncludeVoice: (include: boolean) => void;
}) {
  const [busy, setBusy] = useState<number | 'zip' | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [error, setError] = useState('');

  async function save(capture: number | null) {
    setBusy(capture ?? 'zip');
    setError('');
    try {
      const file = await client.request({
        method: 'exportAttachment',
        params: { review: review.id, capture, includeVoice: false },
      });
      setSaved((files) => [...files, file]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card attachments" aria-label="Attachments">
      <h2>Attachments</h2>
      <p className="small muted">
        The ZIP contains report.md, the Playwright reproduction test, HAR, screenshots, timeline, and rrweb replay.
      </p>
      <div className="attachment-actions">
        <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void save(null)}>
          {busy === 'zip' ? 'Saving ZIP…' : 'Save evidence ZIP'}
        </button>
      </div>
      <div role="status" aria-live="polite">
        {saved.map((file) => (
          <p key={file} className="small">
            Downloaded {file}
          </p>
        ))}
      </div>
      {error && (
        <p role="alert" className="small">
          {error}
        </p>
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { Video } from './reviewHelpers';

/**
 * The tab video Lens kept with the recording. It can be large (up to 200 MiB), so it loads only
 * when the person opens it, and its URL goes when the page leaves it.
 */
export function VideoCapturePreview({ client, video, name }: { client: LensClient; video: Video; name: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let made: string | null = null;
    client
      .readBlob(video.blob)
      .then((data) => alive && setUrl((made = URL.createObjectURL(data))))
      .catch((error: Error) => alive && setProblem(`The video did not load: ${error.message}`));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [client, video.blob, open]);
  return (
    <details className="card video-preview" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="small">Tab video{video.truncated ? ' (ends at 200 MiB)' : ''}</summary>
      {url ? (
        <>
          <video controls src={url} aria-label="Tab video" />
          <a className="btn btn-ghost btn-sm" href={url} download={`${name}.webm`}>
            Download WebM
          </a>
        </>
      ) : problem ? (
        <p role="alert" className="small">
          {problem}
        </p>
      ) : (
        open && <span className="small muted">Loading the video…</span>
      )}
    </details>
  );
}

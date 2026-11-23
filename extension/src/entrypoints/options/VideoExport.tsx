import { useCallback, useEffect, useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { VideoToolsStatus } from '@/protocol/VideoToolsStatus';
import { Problem, useLoadOnFocus } from './shared';

/** The tools that turn a recording into an MP4: Node.js, FFmpeg and the replay renderer. */
export function VideoExport({ client }: { client: LensClient }) {
  const [tools, setTools] = useState<VideoToolsStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(
    () =>
      client
        .request({ method: 'getVideoTools' })
        .then((found) => (setTools(found), setProblem(null)))
        .catch((error: Error) => setProblem(error.message)),
    [client],
  );
  useLoadOnFocus(load);
  useEffect(() => {
    if (!tools?.installing) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [tools?.installing, load]);

  const [starting, setStarting] = useState(false);
  async function install() {
    setStarting(true);
    setProblem(null);
    try {
      setTools(await client.request({ method: 'installVideoTools' }));
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setStarting(false);
    }
  }

  if (!tools) return problem ? <Problem text={problem} /> : null;
  const chips = [
    ['Node.js', tools.node],
    ['FFmpeg', tools.ffmpeg],
    ['Replay renderer', tools.ready],
  ] as const;
  return (
    <section aria-label="Video export" className="card settings-section">
      <div className="section">
        <h2>Video export</h2>
        <p className="small muted">
          Lens turns a recording into an MP4 video for a review. The tools run on this computer.
        </p>
      </div>
      <div className="status-chips" role="list" aria-label="Video tools">
        {chips.map(([label, ok]) => (
          <span key={label} role="listitem" className="pill" data-tone={ok ? 'success' : 'warning'}>
            {label}: {ok ? 'ready' : 'missing'}
          </span>
        ))}
      </div>
      {tools.installing ? (
        <div role="status" aria-label="Video tools install" className="notice waiting" data-tone="info">
          <span className="spinner" aria-hidden="true" />
          <span>{tools.progress ?? 'Installing the video renderer…'}</span>
        </div>
      ) : (
        !tools.ready && (
          <>
            {tools.detail && (
              <div role="note" className="notice" data-tone="warning">
                <span>{tools.detail}</span>
              </div>
            )}
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={() => void install()} disabled={starting}>
                {starting ? 'Starting…' : 'Install video renderer'}
              </button>
            </div>
          </>
        )
      )}
      {problem && <Problem text={problem} />}
    </section>
  );
}

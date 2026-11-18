import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LensClient } from '@/lens-client';
import type { Capture } from '@/protocol/Capture';
import type { VoiceNote } from '@/protocol/VoiceNote';
import '@/ui/base.css';
import '@/ui/page.css';
import { followSystemTheme } from '@/ui/theme';
import { RecordingEditor } from '../review/RecordingEditor';
import './style.css';
import { AppStatus } from '@/ui/AppStatus';

/** One recording in the editor: the replay with the voice of its observation, notes and cuts. */
function Recording({ id }: { id: number }) {
  const [client] = useState(() => new LensClient());
  const [capture, setCapture] = useState<Capture | null>(null);
  const [voice, setVoice] = useState<VoiceNote[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    client
      .request({ method: 'getCapture', params: { id } })
      .then(async (found) => {
        if (!found.recording) throw new Error('This capture has no recording.');
        setCapture(found);
        setVoice(await client.request({ method: 'listVoiceNotes', params: { observation: found.observation } }));
      })
      .catch((error: Error) => setProblem(error.message));
    return () => client.disconnect();
  }, [client, id]);

  // Transcripts finish in the daemon: look again until each one is done.
  const transcribing = voice.some((v) => v.state === 'waiting' || v.state === 'transcribing');
  useEffect(() => {
    if (!transcribing || !capture) return;
    const timer = setInterval(() => {
      void client
        .request({ method: 'listVoiceNotes', params: { observation: capture.observation } })
        .then(setVoice)
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [client, capture, transcribing]);

  return (
    <main className="page recording">
      <header className="page-head">
        <span className="pill" data-tone="info">
          {capture?.kind === 'session' ? 'Recording' : 'Capture'}
        </span>
        <h1>{capture ? capture.pageTitle || capture.pageUrl : 'Recording'}</h1>
        <p role="status" className="muted small">
          {problem ??
            (capture
              ? `${capture.kind === 'session' ? 'From Record to Stop' : 'The minutes before the capture'} · inputs masked${voice.length ? ' · with your voice' : ''}`
              : 'Loading…')}
        </p>
      </header>
      {capture && <RecordingEditor client={client} capture={capture} voice={voice} onVoice={(note) => setVoice((all) => all.map((v) => (v.id === note.id ? note : v)))} />}
      {capture && (
        <footer className="action-bar">
          <span className="small muted">Cuts, notes and fixes save as you make them.</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              void browser.tabs.create({ url: browser.runtime.getURL(`/review.html?observation=${capture.observation}`) })
            }
          >
            Review and export
          </button>
        </footer>
      )}
    </main>
  );
}

followSystemTheme();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStatus />
    <Recording id={Number(new URLSearchParams(location.search).get('capture'))} />
  </StrictMode>,
);

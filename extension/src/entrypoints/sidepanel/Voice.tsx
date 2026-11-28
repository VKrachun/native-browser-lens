import { useCallback, useEffect, useRef, useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { SpeechStatus } from '@/protocol/SpeechStatus';
import type { VoiceNote } from '@/protocol/VoiceNote';
import { AddNoteIcon, DeleteIcon, MicIcon, PlayIcon, StopIcon } from '@/ui/icons';
import { MicrophoneBlocked, record, type Recording } from '@/voice';

export const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const transcriptText = (note: VoiceNote) => note.segments.map((s) => s.text.trim()).join(' ');

/** Time since a value last changed, for "Writing down… 0:07". */
export function useSince(key: string) {
  const [since, setSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setSince(Date.now()), [key]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now - since;
}

/**
 * Where one voice note's words are: in line, being written down (with the time so far), not
 * written down (with the reason and Try again), or no speech found. Nothing for a note with words.
 */
export function VoiceProgress({
  client,
  note,
  label,
  ariaLabel,
  onChange,
}: {
  client: LensClient;
  note: VoiceNote;
  /** Which note, when there are several, such as "Voice note 2". */
  label?: string;
  /** The accessible name of the state line, such as "Transcript". */
  ariaLabel?: string;
  onChange: (note: VoiceNote) => void;
}) {
  const elapsed = useSince(`${note.id}-${note.state}`);
  const [retrying, setRetrying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const prefix = label ? `${label}: ` : '';
  async function retry() {
    setRetrying(true);
    setProblem(null);
    try {
      onChange(await client.request({ method: 'retryVoiceNote', params: { id: note.id } }));
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setRetrying(false);
    }
  }
  if (note.state === 'done') {
    return note.segments.length ? null : (
      <p className="small muted voice-progress" role="status" aria-label={ariaLabel}>
        {prefix}No speech found in this recording.
      </p>
    );
  }
  if (note.state === 'failed') {
    return (
      <div className="small voice-progress" role="alert" aria-label={ariaLabel}>
        <span className="danger-text">
          {prefix}Not written down: {note.detail ?? 'the speech program stopped'}
        </span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void retry()} disabled={retrying}>
          {retrying ? 'Starting…' : 'Try again'}
        </button>
        {problem && <span className="danger-text">{problem}</span>}
      </div>
    );
  }
  // Waiting with a reason is waiting for something the person does, such as the model download.
  const blocked = note.state === 'waiting' && note.detail;
  const activeText =
    note.state === 'transcribing'
      ? `${note.detail ?? 'Writing down what you said…'} ${clock(elapsed)}`
      : (note.detail ?? 'In line to be written down…');
  return (
    <div className="small muted voice-progress waiting" role="status" aria-live="polite" aria-label={ariaLabel}>
      {!blocked && <span className="spinner" aria-hidden="true" />}
      <span>
        {prefix}
        {activeText}
      </span>
      {!blocked && elapsed >= 15_000 && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void retry()} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
      {problem && <span className="danger-text">{problem}</span>}
    </div>
  );
}

/**
 * Spoken notes for one observation. Lens writes them down on this computer; while the person
 * speaks during a reproduction, the words land in the capture's timeline next to the steps.
 */
export function VoiceNotes({
  client,
  observation,
  onAppend,
}: {
  client: LensClient;
  observation: number;
  onAppend: (text: string) => void;
}) {
  const [notes, setNotes] = useState<VoiceNote[] | null>(null);
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [now, setNow] = useState(Date.now());
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, status] = await Promise.all([
      client.request({ method: 'listVoiceNotes', params: { observation } }),
      client.request({ method: 'speechStatus' }),
    ]);
    setNotes(list);
    setSpeech(status);
  }, [client, observation]);

  useEffect(() => {
    void load().catch((error: Error) => setProblem(error.message));
  }, [load]);

  // Transcripts and downloads finish in the daemon: look again until nothing is in progress.
  const busy =
    notes?.some((n) => n.state === 'waiting' || n.state === 'transcribing') || speech?.model.state === 'downloading';
  const ready = speech?.model.state === 'ready';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load().catch(() => {}), 2000);
    return () => clearInterval(timer);
  }, [busy, load]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [recording]);

  // A recording in progress ends with the panel; nothing half-saved stays behind.
  const live = useRef<Recording | null>(null);
  live.current = recording;
  useEffect(() => () => live.current?.cancel(), []);

  const starting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  async function start() {
    // One microphone at a time: a second click while the first one starts does nothing.
    if (starting.current || live.current) return;
    starting.current = true;
    setProblem(null);
    try {
      const started = await record();
      if (!mounted.current) return started.cancel();
      setRecording(started);
      setNow(Date.now());
    } catch (error) {
      if (error instanceof MicrophoneBlocked) {
        await browser.tabs.create({ url: browser.runtime.getURL('/microphone.html') });
        setProblem('Allow the microphone in the tab that opened, then press Record again.');
      } else {
        setProblem(`The microphone did not start: ${(error as Error).message}`);
      }
    } finally {
      starting.current = false;
    }
  }

  async function stop() {
    if (!recording) return;
    const started = recording.startedAt;
    setRecording(null);
    setSaving(true);
    try {
      const wav = await recording.stop();
      const audio = await client.upload(wav, 'audio/wav');
      await client.request({ method: 'addVoiceNote', params: { observation, startedAt: started, audio } });
      await load();
    } catch (error) {
      setProblem(`The voice note was not saved: ${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (!confirm('Delete this voice note?')) return;
    await client.request({ method: 'deleteVoiceNote', params: { id } }).catch((e: Error) => setProblem(e.message));
    await load();
  }

  const install = () => client.request({ method: 'installSpeech' }).then(setSpeech);

  return (
    <section className="voice" aria-label="Voice notes">
      <div className="voice-head">
        <span className="label">Voice notes</span>
        {recording ? (
          <button type="button" className="btn btn-danger btn-sm" onClick={() => void stop()}>
            <StopIcon />
            Stop <span className="num">{clock(now - recording.startedAt)}</span>
          </button>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void start()} disabled={saving}>
            <MicIcon />
            {saving ? 'Saving…' : 'Record'}
          </button>
        )}
      </div>
      {recording && (
        <p className="small muted" role="status" aria-label="Recording">
          <span className="rec-dot" aria-hidden="true" /> Recording. Reproduce the defect and say what you see; the words
          join the steps in the timeline.
        </p>
      )}
      {speech && !ready && (notes?.length || recording) ? <ModelNotice speech={speech} onInstall={install} /> : null}
      {notes && notes.length > 0 && (
        <ol className="voice-list" aria-label="Voice note list">
          {notes.map((note) => (
            <li key={note.id} className="voice-note">
              <div className="voice-meta small muted num">
                <span>
                  {new Date(Number(note.startedAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
                  {clock(Number(note.durationMs))}
                  {note.state === 'done' && note.language ? ` · ${note.language}` : ''}
                </span>
                <span className="voice-actions">
                  <Player client={client} note={note} />
                  {note.state === 'done' && note.segments.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      aria-label="Add to notes"
                      title="Add to notes"
                      onClick={() => onAppend(transcriptText(note))}
                    >
                      <AddNoteIcon />
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    aria-label="Delete voice note"
                    title="Delete"
                    onClick={() => void remove(note.id)}
                  >
                    <DeleteIcon />
                  </button>
                </span>
              </div>
              {note.state === 'done' && note.segments.length > 0 ? (
                <p className="voice-text" aria-label="Transcript">
                  {transcriptText(note)}
                </p>
              ) : (
                <VoiceProgress
                  client={client}
                  note={note}
                  ariaLabel="Transcript"
                  onChange={(changed) => setNotes((all) => all?.map((n) => (n.id === changed.id ? changed : n)) ?? null)}
                />
              )}
            </li>
          ))}
        </ol>
      )}
      {problem && (
        <div role="alert" className="notice">
          {problem}
        </div>
      )}
    </section>
  );
}

/** The one-time speech model download, asked for when it is first needed. */
export function ModelNotice({
  speech,
  onInstall,
  onCancel,
}: {
  speech: SpeechStatus;
  onInstall: () => Promise<unknown>;
  /** Stops a download in progress; without it, the download has no Cancel. */
  onCancel?: () => Promise<unknown>;
}) {
  const mb = (bytes: number) => Math.round(bytes / 1e6);
  const model = speech.model;
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function install() {
    setStarting(true);
    setProblem(null);
    try {
      await onInstall();
    } catch (error) {
      setProblem(`The download did not start: ${(error as Error).message}`);
    } finally {
      setStarting(false);
    }
  }
  if (model.state === 'downloading') {
    return (
      <div className="notice" data-tone="info" role="status" aria-label="Speech model">
        <span className="model-progress">
          Downloading {speech.modelName}: <span className="num">{mb(Number(model.received))}</span> of{' '}
          <span className="num">{mb(Number(model.total))}</span> MB
          <span className="meter" aria-hidden="true">
            <span style={{ width: `${(Number(model.received) / Math.max(1, Number(model.total))) * 100}%` }} />
          </span>
          {onCancel && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void onCancel().catch((error: Error) => setProblem(error.message))}
            >
              Cancel download
            </button>
          )}
          {problem && <span className="danger-text">{problem}</span>}
        </span>
      </div>
    );
  }
  return (
    <div className="notice" data-tone={model.state === 'failed' ? undefined : 'info'} role="status" aria-label="Speech model">
      <span>
        {model.state === 'failed'
          ? `The speech model did not download: ${model.reason}`
          : `Your voice needs the speech model, a one-time ${mb(Number(speech.downloadBytes))} MB download. It runs on this computer.`}{' '}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void install()} disabled={starting}>
          {starting ? 'Starting the download…' : model.state === 'failed' ? 'Try again' : 'Download the speech model'}
        </button>
        {problem && <span className="danger-text"> {problem}</span>}
      </span>
    </div>
  );
}

function Player({ client, note }: { client: LensClient; note: VoiceNote }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  /** One toggle at a time: a second click while the audio loads would load and play it twice. */
  const busy = useRef(false);
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      audio.current?.pause();
      if (audio.current) URL.revokeObjectURL(audio.current.src);
    };
  }, []);
  async function toggle() {
    if (busy.current) return;
    busy.current = true;
    try {
      if (!audio.current) {
        const url = URL.createObjectURL(await client.readBlob(note.audio));
        if (gone.current) return URL.revokeObjectURL(url);
        const element = new Audio(url);
        element.onended = () => setPlaying(false);
        audio.current = element;
      }
      if (playing) {
        audio.current.pause();
        setPlaying(false);
      } else {
        await audio.current.play();
        setPlaying(true);
      }
    } finally {
      busy.current = false;
    }
  }
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon btn-sm"
      aria-label={playing ? 'Pause' : 'Play'}
      aria-pressed={playing}
      title={playing ? 'Pause' : 'Play'}
      onClick={() => void toggle()}
    >
      {playing ? <StopIcon /> : <PlayIcon />}
    </button>
  );
}

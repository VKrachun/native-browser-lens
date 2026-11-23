import { useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { VoiceNote } from '@/protocol/VoiceNote';
import { at } from './Evidence';
import { correctSegment } from './reviewHelpers';

/**
 * The transcripts before the review: a click on a line corrects what Whisper heard. Enter saves,
 * Escape keeps the old words. After the review the transcripts are read-only (VoiceList).
 */
export function VoiceTranscriptEditor({
  client,
  notes,
  label,
  onChange,
}: {
  client: LensClient;
  notes: VoiceNote[];
  label: string;
  onChange: (note: VoiceNote) => void;
}) {
  const [editing, setEditing] = useState<{ note: number; index: number; text: string } | null>(null);
  const [state, setState] = useState<{ kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; reason: string } | null>(null);
  if (!notes.length) return null;

  async function save() {
    const current = editing;
    setEditing(null);
    const note = notes.find((n) => n.id === current?.note);
    const segments = current && note && correctSegment(note.segments, current.index, current.text);
    if (!segments) return;
    setState({ kind: 'saving' });
    try {
      onChange(await client.request({ method: 'updateVoiceNote', params: { id: note.id, segments } }));
      setState({ kind: 'saved' });
    } catch (error) {
      setState({ kind: 'failed', reason: (error as Error).message });
    }
  }

  return (
    <section className="section voice-review-list">
      <h2>Voice notes</h2>
      <p className="small muted">Click a line to correct what Lens heard.</p>
      <ol aria-label={label} className="small">
        {notes.map((note) => (
          <li key={note.id}>
            {note.segments.map((s, i) =>
              editing?.note === note.id && editing.index === i ? (
                <textarea
                  key={i}
                  className="textarea"
                  rows={2}
                  autoFocus
                  aria-label="Correct the transcript"
                  value={editing.text}
                  onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditing(null);
                    if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), void save());
                  }}
                  onBlur={() => void save()}
                />
              ) : (
                <p key={i}>
                  <button
                    type="button"
                    className="transcript-line"
                    title="Correct this line"
                    disabled={state?.kind === 'saving'}
                    onClick={() => setEditing({ note: note.id, index: i, text: s.text })}
                  >
                    <span className="muted num">[{at(Number(s.startMs))}]</span> {s.text}
                  </button>
                </p>
              ),
            )}
          </li>
        ))}
      </ol>
      {state && (
        <p className="small muted" role={state.kind === 'failed' ? 'alert' : 'status'} aria-label="Transcript status">
          {state.kind === 'saving' ? 'Saving…' : state.kind === 'saved' ? 'Saved' : `Not saved: ${state.reason}`}
        </p>
      )}
    </section>
  );
}

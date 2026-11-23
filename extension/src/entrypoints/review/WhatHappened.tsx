import { useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { VoiceNote } from '@/protocol/VoiceNote';
import { PenIcon } from '@/ui/icons';
import { clock, correctSegment } from './reviewHelpers';

export type Word = { note: number; index: number; at: number; end: number; text: string };
export type Row = { at: number; word: Word | null; events: { at: number; text: string; error: boolean; count: number }[] };

/** What happened, row by row: the person's words beside what they did and what failed. */
export function WhatHappened({
  client,
  voice,
  rows,
  currentRow,
  start,
  onSeek,
  onVoice,
  onProblem,
}: {
  client: LensClient;
  voice: VoiceNote[];
  rows: Row[];
  currentRow: number;
  /** The replay's start; null until it loads. */
  start: number | null;
  onSeek: (at: number) => void;
  onVoice?: (note: VoiceNote) => void;
  onProblem: (problem: string) => void;
}) {
  const [fixing, setFixing] = useState<{ note: number; index: number; text: string } | null>(null);
  const time = (at: number) => (start === null ? '' : clock(at - start));

  /** Saves a corrected line of the transcript; the words leave as the person fixed them. */
  async function saveWords() {
    const current = fixing;
    setFixing(null);
    const note = voice.find((v) => v.id === current?.note);
    const segments = current && note && correctSegment(note.segments, current.index, current.text);
    if (!segments) return;
    try {
      onVoice?.(await client.request({ method: 'updateVoiceNote', params: { id: note.id, segments } }));
    } catch (error) {
      onProblem(`The correction was not saved: ${(error as Error).message}`);
    }
  }

  return (
    <section aria-label="What happened" className="happened">
      <table>
        <thead>
          <tr>
            <th scope="col" className="happened-time">
              Time
            </th>
            <th scope="col">You said</th>
            <th scope="col">On the page</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const w = row.word;
            return (
              <tr key={w ? `${w.note}-${w.index}` : `step-${row.at}`} data-state={i === currentRow ? 'selected' : undefined}>
                <td className="happened-time">
                  <button type="button" className="happened-seek num" onClick={() => onSeek(row.at)}>
                    {time(row.at)}
                  </button>
                </td>
                <td className="happened-said">
                  {w && fixing && fixing.note === w.note && fixing.index === w.index ? (
                    <textarea
                      className="textarea"
                      rows={2}
                      autoFocus
                      aria-label="Correct the transcript"
                      value={fixing.text}
                      onChange={(e) => setFixing({ ...fixing, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setFixing(null);
                        if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), void saveWords());
                      }}
                      onBlur={() => void saveWords()}
                    />
                  ) : (
                    w && (
                      <div className="happened-line">
                        <button type="button" className="happened-seek" onClick={() => onSeek(w.at)}>
                          {w.text}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm line-edit"
                          aria-label="Correct this line"
                          title="Correct this line"
                          onClick={() => setFixing({ note: w.note, index: w.index, text: w.text })}
                        >
                          <PenIcon size={14} />
                        </button>
                      </div>
                    )
                  )}
                </td>
                <td className="happened-events">
                  {row.events.length > 0 && (
                    <ul>
                      {row.events.map((e) => (
                        <li key={`${e.at}-${e.text}`} data-error={e.error || undefined}>
                          <button type="button" className="happened-seek" title={e.text} onClick={() => onSeek(e.at)}>
                            {e.text}
                          </button>
                          {e.count > 1 && <span className="happened-count num">×{e.count}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && (
        <p className="small muted">{voice.length ? 'Your words and steps appear here.' : 'No voice and no steps in this recording.'}</p>
      )}
    </section>
  );
}

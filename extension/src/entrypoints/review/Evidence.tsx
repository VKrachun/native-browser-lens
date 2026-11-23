import { useEffect, useState } from 'react';
import type { LensClient } from '@/lens-client';
import { originOf } from '@/messages';
import { splitNotes } from '@/findings';
import type { Action } from '@/protocol/Action';
import type { BlobRef } from '@/protocol/BlobRef';
import type { Review as FrozenReview } from '@/protocol/Review';
import type { ReviewVoice } from '@/protocol/ReviewVoice';
import type { VoiceNote } from '@/protocol/VoiceNote';
import { clock, useSince } from '../sidepanel/Voice';
import { describeStep, describeTarget } from './reviewHelpers';

// ponytail: one page reads few evidence blobs and never changes them (content-addressed); no eviction.
const texts = new Map<string, Promise<string>>();
/** A blob's text, read once per page: the steps and the privacy summary share it. */
export function readText(client: LensClient, blob: BlobRef): Promise<string> {
  let found = texts.get(blob.sha256);
  if (!found) {
    found = client.readBlob(blob).then((data) => data.text());
    found.catch(() => texts.delete(blob.sha256));
    texts.set(blob.sha256, found);
  }
  return found;
}

export function ReviewedNotes({ review }: { review: FrozenReview }) {
  const { findings, rest } = splitNotes(review.notes);
  return (
    <>
      {review.tags.length > 0 && (
        <div className="tag-chips" aria-label="Tags">
          {review.tags.map((tag) => <span key={tag} className="tag-chip">{tag}</span>)}
        </div>
      )}
      {findings && findings.length > 0 && (
        <section className="section" aria-label="Report findings">
          <h2>Findings</h2>
          <ul>{findings.map((finding, i) => <li key={i}>{finding}</li>)}</ul>
        </section>
      )}
      {rest && <p className="notes-text">{rest}</p>}
    </>
  );
}

/** A voice segment's start as m:ss. */
export const at = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** Transcripts, with the time of each stretch of speech. */
export function VoiceList({ notes, label }: { notes: (VoiceNote | ReviewVoice)[]; label: string }) {
  if (!notes.length) return null;
  return (
    <section className="section voice-review-list">
      <h2>Voice notes</h2>
      <ol aria-label={label} className="small">
        {notes.map((note, n) => (
          <li key={n}>
            {note.segments.map((s, i) => (
              <p key={i}>
                <span className="muted num">[{at(Number(s.startMs))}]</span> {s.text}
              </p>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The person's steps from a capture's evidence, as the review will share them. */
export function Steps({
  client,
  evidence,
  label,
  hideValues = false,
}: {
  client: LensClient;
  evidence: BlobRef;
  label: string;
  hideValues?: boolean;
}) {
  const [actions, setActions] = useState<Action[] | null>(null);
  useEffect(() => {
    void readText(client, evidence)
      .then((text) => setActions((JSON.parse(text) as { actions?: Action[] }).actions ?? []))
      .catch(() => setActions([]));
  }, [client, evidence]);
  if (!actions?.length) return actions ? <p className="small muted">Lens recorded no steps.</p> : null;
  const shown = actions.filter((a) => a.kind !== 'scroll');
  return (
    <details className="steps">
      <summary className="small">
        {shown.length} {shown.length === 1 ? 'step' : 'steps'}
      </summary>
      <ol aria-label={label} className="small">
        {shown.map((a, n) => (
          <li key={n}>{describeStep(a, hideValues)}</li>
        ))}
      </ol>
    </details>
  );
}

export function BlobImage({ client, blob, alt }: { client: LensClient; blob: BlobRef; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    client
      .readBlob(blob)
      .then((data) => alive && setSrc((url = URL.createObjectURL(data))))
      .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, blob]);
  return src ? <img className="review-shot" src={src} alt={alt} /> : <span className="review-shot skeleton" />;
}

/** Work in progress, with a spinner and the time so far. */
export function Running({ text }: { text: string }) {
  const elapsed = useSince(text);
  return (
    <span className="waiting">
      <span className="spinner" aria-hidden="true" />
      {text} {clock(elapsed)}
    </span>
  );
}

/** The frozen review as it leaves: each capture with its rendered image, findings, steps and files. */
export function SharedEvidence({ client, review }: { client: LensClient; review: FrozenReview }) {
  return (
    <details className="card shared-evidence">
      <summary>View shared evidence ({review.items.length} {review.items.length === 1 ? 'capture' : 'captures'})</summary>
      <p className="muted small">
        {review.items.every((i) => i.kind === 'session')
          ? 'The steps, your words and notes from the parts you kept, with a test that repeats them. Evidence is redacted.'
          : 'The screenshots below are rendered with your marks, and masks are burned in. Evidence is redacted.'}
      </p>
      <ol aria-label="Reviewed captures" className="review-list">
        {review.items.map((item, index) => (
          <li key={item.capture} className="card review-item" data-session={item.kind === 'session' || undefined}>
            {item.kind !== 'session' && <BlobImage client={client} blob={item.screenshot} alt={`Reviewed capture ${item.capture}`} />}
            <div className="review-side">
              <a className="small url" href={originOf(item.pageUrl) ? item.pageUrl : undefined} target="_blank" rel="noreferrer">
                {item.pageUrl}
              </a>
              {item.findings.length > 0 ? (
                <ul aria-label={`Findings of capture ${item.capture}`} className="findings">
                  {item.findings.map((finding, n) => (
                    <li key={n}>
                      <code>{finding}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">No failed requests, console errors or exceptions.</p>
              )}
              <Steps client={client} evidence={item.evidence} label={`Steps of capture ${index + 1}`} />
              {item.annotations.length > 0 && (
                <ul className="small notes-shared" aria-label={`Notes of capture ${index + 1}`}>
                  {item.annotations.map((a) => (
                    <li key={a.id}>
                      {a.text || 'Drawing'}
                      {a.elements.length > 0 && <span className="muted"> · {a.elements.map(describeTarget).join(', ')}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <p className="small muted" aria-label={`Files of capture ${item.capture}`}>
                Files: capture-{index + 1}.lens.json, capture-{index + 1}.png
                {item.shots.length > 0 && `, ${item.shots.length} shots`}
                {item.shotsDropped > 0 && ` (${item.shotsDropped} left out to fit the filing)`}
                {item.recording && `, capture-${index + 1}.rrweb.json`}
              </p>
            </div>
          </li>
        ))}
      </ol>

      {review.voice.length > 0 && <VoiceList notes={review.voice} label="Reviewed voice notes" />}
    </details>
  );
}

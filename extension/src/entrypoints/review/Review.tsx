import { useCallback, useEffect, useRef, useState } from 'react';
import { LensClient } from '@/lens-client';
import type { Capture } from '@/protocol/Capture';
import type { Observation } from '@/protocol/Observation';
import type { Review as FrozenReview } from '@/protocol/Review';
import type { BlobRef } from '@/protocol/BlobRef';
import type { Filing } from '@/protocol/Filing';
import type { Member } from '@/protocol/Member';
import type { AgentInfo } from '@/protocol/AgentInfo';
import type { Agent } from '@/protocol/Agent';
import type { Suggestion } from '@/protocol/Suggestion';
import type { Action } from '@/protocol/Action';
import type { Locator } from '@/protocol/Locator';
import type { VoiceNote } from '@/protocol/VoiceNote';
import type { ReviewVoice } from '@/protocol/ReviewVoice';
import { AlertIcon, DoneIcon, DraftIcon, ExportIcon, FileIcon, MaskIcon } from '@/ui/icons';
import { RecordingEditor } from './RecordingEditor';
import { Handoff, handoffName, useHandoff } from './Handoff';
import { Notes } from '../sidepanel/Notes';
import { useStored } from '../sidepanel/Record';
import { clock, useSince } from '../sidepanel/Voice';
import type { SirvantRun } from '@/protocol/SirvantRun';
import type { Issue } from '@/protocol/Issue';
import type { Duplicate } from '@/protocol/Duplicate';

/**
 * What leaves the notebook: every capture with its recording, as the edits left it. The daemon freezes the
 * review and renders the images, and the page then shows exactly those images before any export.
 */
export function Review({ observation: id }: { observation: number }) {
  const [client] = useState(() => new LensClient());
  const [observation, setObservation] = useState<Observation | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [typedValues, setTypedValues] = useState(true);
  const [voice, setVoice] = useState<VoiceNote[]>([]);
  const [review, setReview] = useState<FrozenReview | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [assignee, setAssignee] = useState('');
  const [filing, setFiling] = useState<Filing | null>(null);
  const [sending, setSending] = useState(false);
  /** Put Sirvant, VibeQ's agent, to work right after filing; remembered for the next review. */
  const [sirvantNext, setSirvantNext] = useStored('lens.sirvant', false);
  const [sirvant, setSirvant] = useState<SirvantRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [drafting, setDrafting] = useState<Agent | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The task of an earlier filing of this observation, when the page opens again. */
  const [filedTask, setFiledTask] = useState<string | null>(null);
  const handoff = useHandoff(client, siteOf(review?.items[0]?.pageUrl ?? captures[0]?.pageUrl));

  // Until the app answers, the page tries again every few seconds (the banner says why).
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    Promise.all([
      client.request({ method: 'getObservation', params: { id } }),
      client.request({ method: 'listCaptures', params: { observation: id } }),
      client.request({ method: 'listVoiceNotes', params: { observation: id } }),
    ])
      .then(([found, list, notes]) => {
        void client
          .request({ method: 'listObservations' })
          .then((all) => setFiledTask(all.find((o) => o.id === id)?.taskUrl ?? null))
          .catch(() => {});
        setProblem(null);
        setObservation(found);
        setCaptures(list);
        setVoice(notes);
      })
      .catch((error: Error) => {
        setProblem(error.message);
        retry = setTimeout(() => setLoadAttempt((n) => n + 1), 5000);
      });
    return () => {
      clearTimeout(retry);
      client.disconnect();
    };
  }, [client, id, loadAttempt]);

  // A title and findings from a small model, once the person's words are written down.
  const [summary, setSummary] = useState<
    { state: 'idle' } | { state: 'running' } | { state: 'done'; agent: Agent } | { state: 'failed'; reason: string }
  >({ state: 'idle' });
  const [notesVersion, setNotesVersion] = useState(0);
  const summarized = useRef(false);
  const summarize = useCallback(async () => {
    setSummary({ state: 'running' });
    try {
      const found = await client.request({ method: 'summarize', params: { observation: id } });
      const latest = await client.request({ method: 'getObservation', params: { id } });
      // The findings go first in the notes; what the person wrote stays below them.
      const previous = latest.notes.replace(/^Findings[^\n]*:\n(- .*\n?)+\n*/, '').trim();
      // The model read page text: its words cannot add links, images or HTML to the notes.
      const escape = (text: string) => text.replace(/[\\`*_{}[\]()#+!|<>~&]/g, (c) => `\\${c}`);
      const findings = found.findings.length
        ? `${FINDINGS_HEADER}\n${found.findings.map((f) => `- ${escape(f)}`).join('\n')}`
        : '';
      const saved = await client.request({
        method: 'updateObservation',
        params: {
          id,
          revision: latest.revision,
          title: found.title.replace(/[[\]()<>!`*_#|\\]/g, '').trim(),
          notes: [findings, previous].filter(Boolean).join('\n\n'),
          // The person's own tags win; the model's only fill an empty list.
          ...(latest.tags.length ? {} : { tags: found.tags }),
        },
      });
      setObservation(saved);
      setNotesVersion((v) => v + 1);
      setSummary({ state: 'done', agent: found.agent });
    } catch (error) {
      setSummary({ state: 'failed', reason: (error as Error).message });
    }
  }, [client, id]);
  // The daemon may have written them already, in the background.
  useEffect(() => {
    if (summary.state === 'idle' && observation?.notes.startsWith(FINDINGS_HEADER)) {
      summarized.current = true;
      setSummary({ state: 'done', agent: 'claude' });
    }
  }, [observation, summary.state]);
  const waitingForWords = voice.some((v) => v.state === 'transcribing' || (v.state === 'waiting' && !v.detail));
  useEffect(() => {
    if (review || !observation || summarized.current || waitingForWords || captures.length === 0) return;
    // Only a title nobody chose: the page's own title, or its address.
    const automatic = captures.some((c) => observation.title === c.pageTitle || observation.title === c.pageUrl) || !observation.title.trim();
    if (!automatic) return;
    summarized.current = true;
    void summarize();
  }, [review, observation, captures, waitingForWords, summarize]);

  // Transcripts finish in the daemon after the page opens: look again until each one is done.
  const transcribing = voice.some((v) => v.state === 'waiting' || v.state === 'transcribing');
  useEffect(() => {
    if (!transcribing) return;
    const timer = setInterval(() => {
      void client
        .request({ method: 'listVoiceNotes', params: { observation: id } })
        .then(setVoice)
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [client, id, transcribing]);

  async function freeze() {
    if (!observation) return;
    try {
      // The title and notes are edited on this page: the review takes their latest revision.
      const latest = await client.request({ method: 'getObservation', params: { id } });
      setObservation(latest);
      const frozen = await client.request({
        method: 'createReview',
        params: {
          observation: observation.id,
          revision: latest.revision,
          // Everything goes in: every capture with its recording.
          captures: captures.map((c) => c.id),
          recordings: captures.filter((c) => c.recording).map((c) => c.id),
          typedValues,
          screenshotsChecked: true,
        },
      });
      setReview(frozen);
      setProblem(null);
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  async function file() {
    if (!review) return;
    setSending(true);
    try {
      const done = await client.request({ method: 'fileReview', params: { review: review.id, assignee: assignee || null } });
      setFiling(done);
      setProblem(done.missingFiles ? `${done.missingFiles} files did not reach VibeQ; file again to send them.` : null);
      if (done.taskUrl && sirvantNext && !sirvant) await startSirvant();
      // The agent's prompt then links the VibeQ task.
      if (done.taskUrl && handoff.afterFiling && handoff.ready && !handoff.done) await handoff.handOff(review.id);
    } catch (error) {
      setProblem(`Not filed: ${(error as Error).message}. Filing again is safe: it never creates a second task.`);
    } finally {
      setSending(false);
    }
  }

  async function startSirvant() {
    if (!review) return;
    setStarting(true);
    try {
      setSirvant(await client.request({ method: 'startSirvant', params: { review: review.id } }));
    } catch (error) {
      setProblem(`Filed, but Sirvant did not start: ${(error as Error).message}.`);
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    if (!review) return;
    client
      .request({ method: 'listMembers' })
      .then(setMembers)
      .catch(() => setMembers([]));
    client
      .request({ method: 'listAgents' })
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [client, review]);

  async function draft(agent: Agent) {
    if (!review) return;
    setDrafting(agent);
    try {
      setSuggestion(await client.request({ method: 'investigate', params: { review: review.id, agent } }));
      setProblem(null);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setDrafting(null);
    }
  }

  /** The draft replaces the notes: a new revision, so this review no longer matches and is redone. */
  async function useDraft() {
    if (!observation || !suggestion) return;
    try {
      const saved = await client.request({
        method: 'updateObservation',
        params: { id: observation.id, revision: observation.revision, title: observation.title, notes: suggestion.markdown },
      });
      setObservation(saved);
      setReview(null);
      setSuggestion(null);
      setNotice('Your notes now hold the draft. Check them, then create a new review before you file.');
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  async function exportReview() {
    if (!review) return;
    try {
      const done = await client.request({ method: 'exportReview', params: { review: review.id } });
      setExported(done.folder);
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  if (!observation) {
    return (
      <main className="page review">
        {problem ? <div role="alert" className="notice">{problem}</div> : <span className="thumb skeleton" />}
      </main>
    );
  }
  const readyAgents = agents.filter((a) => a.state === 'ready');
  const name = (agent: Agent) => (agent === 'codex' ? 'Codex' : 'Claude');
  return (
    <main className="page review">
      <header className="page-head">
        <span className="step-pill pill" data-tone={review ? 'success' : 'info'}>
          {review ? 'Reviewed' : 'Review'}
        </span>
        {review && <h1>{observation.title}</h1>}
        {review && (observation.notes ? <p className="notes-text">{observation.notes}</p> : <p className="muted">No notes.</p>)}
      </header>
      {!review && (
        <section className="summary" aria-label="Title and findings">
          <Notes key={notesVersion} client={client} id={id} onSaved={() => {}} />
          <p className="small muted summary-state" role="status" aria-label="Summary">
            {summary.state === 'running' && <Running text="Claude is writing a title and the findings…" />}
            {summary.state === 'idle' && waitingForWords && <>The title and findings follow once your words are written down.</>}
            {summary.state === 'done' && <>{summary.agent === 'claude' ? 'Claude Haiku' : 'Codex'} wrote the title and the findings. Edit them as you like.</>}
            {summary.state === 'failed' && <>No title was written: {summary.reason}</>}
            {summary.state !== 'running' && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void summarize()}>
                <DraftIcon /> {summary.state === 'done' ? 'Write them again' : 'Write a title and findings'}
              </button>
            )}
          </p>
          <Split client={client} id={id} onSplit={() => setNotesVersion((v) => v + 1)} />
        </section>
      )}

      {notice && (
        <div role="status" className="notice" data-tone="info">
          <DoneIcon />
          <span>{notice}</span>
        </div>
      )}

      {review ? (
        <>
          <section className="section">
            <h2>What leaves your computer</h2>
            <p className="muted small">
              {review.items.every((i) => i.kind === 'session')
                ? 'The steps, your words and notes from the parts you kept, with a test that repeats them. Evidence is redacted.'
                : 'The screenshots below are rendered with your marks, and masks are burned in. Evidence is redacted.'}
            </p>
          </section>
          <ol aria-label="Reviewed captures" className="review-list">
            {review.items.map((item, index) => (
              <li key={item.capture} className="card review-item" data-session={item.kind === 'session' || undefined}>
                {item.kind !== 'session' && (
                  <BlobImage client={client} blob={item.screenshot} alt={`Reviewed capture ${item.capture}`} />
                )}
                <div className="review-side">
                  <a className="small url" href={item.pageUrl} target="_blank" rel="noreferrer">
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

          {suggestion && (
            <section aria-label="Draft report" className="card draft">
              <div className="draft-head">
                <h2>
                  <DraftIcon /> Draft from {name(suggestion.agent)}
                </h2>
                <span className="small muted">A suggestion; nothing is saved until you use it.</span>
              </div>
              <pre>{suggestion.markdown}</pre>
              {suggestion.findings.length > 0 && (
                <ul className="findings">
                  {suggestion.findings.map((f, n) => (
                    <li key={n}>
                      <strong>{f.kind}:</strong> {f.text}
                    </li>
                  ))}
                </ul>
              )}
              <div>
                <button type="button" className="btn btn-secondary" onClick={useDraft}>
                  Use as my notes
                </button>
              </div>
            </section>
          )}

          {filing?.taskUrl && (
            <div role="status" aria-label="Filing" className="notice" data-tone="info">
              <DoneIcon />
              <span>
                Filed:{' '}
                <a href={filing.taskUrl} target="_blank" rel="noreferrer">
                  {filing.taskUrl}
                </a>
                {sirvant && <>. {sirvant.alreadyRunning ? 'Sirvant already works on it.' : 'Sirvant works on it now.'}</>}
              </span>
            </div>
          )}
          {exported && (
            <div role="status" aria-label="Export" className="notice" data-tone="info">
              <DoneIcon />
              <span>Exported to {exported}</span>
            </div>
          )}
          {problem && (
            <div role="alert" className="notice">
              <AlertIcon />
              <span>{problem}</span>
            </div>
          )}
          {!filing && <Duplicates client={client} id={id} />}
          <Handoff state={handoff} review={review.id} />

          <footer className="action-bar">
            {readyAgents.map((a) => (
              <button
                key={a.agent}
                type="button"
                className="btn btn-ghost"
                onClick={() => void draft(a.agent)}
                disabled={drafting !== null}
              >
                <DraftIcon />
                {drafting === a.agent ? 'Drafting…' : `Draft the report with ${name(a.agent)}`}
              </button>
            ))}
            <span className="spacer" />
            <button type="button" className="btn btn-secondary" onClick={exportReview} disabled={exported !== null}>
              <ExportIcon />
              Export to Downloads
            </button>
            {members && members.length > 0 && (
              <label className="assign">
                <span className="small muted">Assign to</span>
                <select
                  className="select"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  disabled={filing !== null}
                >
                  <option value="">Nobody</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {filing?.taskUrl ? (
              !sirvant && (
                <button type="button" className="btn btn-secondary" onClick={() => void startSirvant()} disabled={starting}>
                  {starting ? 'Starting Sirvant…' : 'Put Sirvant to work'}
                </button>
              )
            ) : (
              <label className="check" title="VibeQ's agent takes the task and starts on it. VibeQ operators only.">
                <input type="checkbox" checked={sirvantNext} onChange={(e) => setSirvantNext(e.target.checked)} />
                <span>Then put Sirvant to work</span>
              </label>
            )}
            {!filing?.taskUrl && handoff.app && (
              <label
                className="check"
                title={handoff.ready ? 'Files the task, then hands it off with its VibeQ link.' : 'Choose the project folder under Hand off first.'}
              >
                <input
                  type="checkbox"
                  checked={handoff.afterFiling && handoff.ready}
                  disabled={!handoff.ready}
                  onChange={(e) => handoff.setAfterFiling(e.target.checked)}
                />
                <span>Then hand off to {handoffName(handoff.app)}</span>
              </label>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={file}
              disabled={sending || (filing !== null && filing.missingFiles === 0)}
            >
              <FileIcon />
              {sending ? 'Filing…' : filing ? 'Filed' : 'File to VibeQ'}
            </button>
          </footer>
        </>
      ) : (
        <>
          {filedTask?.startsWith('https://') && (
            <div role="status" aria-label="Filed earlier" className="notice" data-tone="info">
              <DoneIcon />
              <span>
                Filed earlier:{' '}
                <a href={filedTask} target="_blank" rel="noreferrer">
                  {filedTask}
                </a>
                . Filing again updates that task.
              </span>
            </div>
          )}
          <section className="section">
            <h2>Choose what to share</h2>
            <p className="muted small">
              Nothing leaves your computer until you create the review.
            </p>
            <label className="check">
              <input type="checkbox" checked={typedValues} onChange={(e) => setTypedValues(e.target.checked)} />
              <span>
                Include what I typed and the site’s API data
                <span className="small muted" style={{ display: 'block' }}>
                  So an agent can repeat the steps and replay the server. Without it, only failed answers leave, and the
                  shots after your steps stay here. Passwords, card numbers and private fields are always masked.
                </span>
              </span>
            </label>
          </section>
          {captures
            .filter((c) => c.kind === 'session' && c.recording)
            .map((c) => (
              <RecordingEditor key={c.id} client={client} capture={c} voice={voice} onVoice={(note) => setVoice((all) => all.map((v) => (v.id === note.id ? note : v)))} />
            ))}
          {/* Below the editor: it arrives when the summary does and must not move the replay. */}
          <Issues client={client} id={id} refresh={notesVersion} />
          {captures.length > 0 && (
            <ol aria-label="Captures to review" className="review-list">
              {captures.map((c) => (
                  <li key={c.id} className="card review-item">
                    <BlobImage client={client} blob={c.screenshot} alt={`Capture ${c.id} before review`} />
                    <div className="review-side">
                      <span className="small muted num">{c.eventCount} events</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void browser.tabs.create({ url: browser.runtime.getURL(`/annotate.html?capture=${c.id}`) })}
                      >
                        <MaskIcon />
                        Mark up or mask
                      </button>
                      <Steps client={client} evidence={c.evidence} label={`Steps of capture ${c.id}`} hideValues={!typedValues} />
                      {c.kind === 'session' && (
                        <p className="small muted">This screenshot of the page at Stop goes with the recording.</p>
                      )}
                    </div>
                  </li>
                ))}
            </ol>
          )}
          {voice.length > 0 && !captures.some((c) => c.kind === 'session') && (
            <section className="card voice-review">
              <VoiceList notes={voice.filter((v) => v.state === 'done')} label="Voice notes to share" />
              {voice.some((v) => v.state !== 'done') && (
                <p className="small muted">Voice notes that are not transcribed yet stay out of this review.</p>
              )}
              <p className="small muted">Only the transcripts leave; the recordings stay on this computer.</p>
            </section>
          )}
          {problem && (
            <div role="alert" className="notice">
              <AlertIcon />
              <span>{problem}</span>
            </div>
          )}
          <footer className="action-bar">
            <span className="spacer" />
            <button type="button" className="btn btn-primary" onClick={freeze} disabled={captures.length === 0}>
              Create review
            </button>
          </footer>
        </>
      )}
    </main>
  );
}

/** Transcripts, with the time of each stretch of speech. */
function VoiceList({ notes, label }: { notes: (VoiceNote | ReviewVoice)[]; label: string }) {
  if (!notes.length) return null;
  const at = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
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

/** Must equal FINDINGS_HEADER in src/daemon.rs. */
const FINDINGS_HEADER = 'Findings (written by Claude Haiku from the recording; check them):';

/** The person's steps from a capture's evidence, as the review will share them. */
function Steps({
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
    void client
      .readBlob(evidence)
      .then((data) => data.text())
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

function describeTarget(l: Locator | null) {
  if (!l) return 'the page';
  if (l.testId) return `[data-testid=${l.testId}]`;
  if (l.role && l.name) return `${l.role} “${l.name}”`;
  if (l.text) return `“${l.text}”`;
  return l.css;
}

function describeStep(a: Action, hideValues: boolean) {
  const target = describeTarget(a.target);
  const hidden = a.masked || hideValues;
  switch (a.kind) {
    case 'click':
      return `Click ${target}`;
    case 'fill':
      return hidden ? `Type a private value into ${target}` : `Type “${a.value}” into ${target}`;
    case 'press':
      return `Press ${a.value} in ${target}`;
    case 'select':
      return hidden ? `Choose a private option in ${target}` : `Choose “${a.value}” in ${target}`;
    case 'check':
      return `Check ${target}`;
    case 'uncheck':
      return `Uncheck ${target}`;
    case 'upload':
      return `Choose files (${a.value}) in ${target}`;
    case 'navigate':
      return `Go to ${a.url}`;
    default:
      return `Scroll to ${a.value}`;
  }
}

const seconds = (s: number | null) => (s === null ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

/**
 * A long recording with unrelated problems becomes one task per problem: the summary model names
 * them with their time ranges, and each task keeps only its part of the recording.
 */
function Issues({ client, id, refresh }: { client: LensClient; id: number; refresh: number }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [hidden, setHidden] = useStored(`lens.issues.hidden.${id}`, false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    // The summary may still run in the background: look again a few times.
    let alive = true;
    const load = () =>
      client
        .request({ method: 'listIssues', params: { observation: id } })
        .then((found) => alive && setIssues(found))
        .catch(() => {});
    void load();
    const timer = setInterval(load, 5000);
    const stop = setTimeout(() => clearInterval(timer), 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [client, id, refresh]);
  if (issues.length < 2 || hidden) return null;

  async function split() {
    setBusy(true);
    setProblem(null);
    try {
      const latest = await client.request({ method: 'getObservation', params: { id } });
      const created = await client.request({
        method: 'splitIntoTasks',
        params: { observation: id, revision: latest.revision, issues },
      });
      // The first task opens here; the others beside it.
      for (const task of created.slice(1)) {
        void browser.tabs.create({ url: browser.runtime.getURL(`/review.html?observation=${task.id}`), active: false });
      }
      if (created[0]) location.href = browser.runtime.getURL(`/review.html?observation=${created[0].id}`);
    } catch (error) {
      setProblem((error as Error).message);
      setBusy(false);
    }
  }

  return (
    <section className="card issues" aria-label="Separate problems">
      <div className="issues-head">
        <h2>This recording shows {issues.length} separate problems</h2>
        <p className="small muted">
          One task each is easier to fix and to check. Each task keeps only its part of the recording, with your words.
        </p>
      </div>
      <ol className="issue-list">
        {issues.map((issue, i) => (
          <li key={i}>
            <div className="issue-title">
              <strong>{issue.title}</strong>
              {issue.fromSeconds !== null && issue.toSeconds !== null && (
                <span className="small muted num">
                  {seconds(issue.fromSeconds)}–{seconds(issue.toSeconds)}
                </span>
              )}
            </div>
            {issue.findings.length > 0 && (
              <ul className="small muted">
                {issue.findings.map((f, n) => (
                  <li key={n}>{f}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      <div className="note-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHidden(true)} disabled={busy}>
          Keep as one task
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void split()} disabled={busy}>
          {busy ? 'Making tasks…' : `Make ${issues.length} tasks`}
        </button>
      </div>
      {problem && (
        <p role="alert" className="small">
          {problem}
        </p>
      )}
    </section>
  );
}

/**
 * Before filing: open VibeQ tasks that may be the same problem, so the person can add to one
 * instead of filing it twice. A small model judges VibeQ's title matches.
 */
function Duplicates({ client, id }: { client: LensClient; id: number }) {
  const [state, setState] = useState<{ kind: 'checking' } | { kind: 'done'; found: Duplicate[] } | { kind: 'off' }>({
    kind: 'checking',
  });
  useEffect(() => {
    let alive = true;
    client
      .request({ method: 'findDuplicates', params: { observation: id } })
      .then((found) => alive && setState({ kind: 'done', found }))
      // VibeQ not set up, or unreachable: filing shows its own problem, this stays quiet.
      .catch(() => alive && setState({ kind: 'off' }));
    return () => {
      alive = false;
    };
  }, [client, id]);
  if (state.kind === 'off') return null;
  if (state.kind === 'checking') {
    return (
      <p className="small muted waiting" role="status" aria-label="Duplicates">
        <span className="spinner" aria-hidden="true" />
        Looking for the same problem in VibeQ…
      </p>
    );
  }
  if (state.found.length === 0) {
    return (
      <p className="small muted" role="status" aria-label="Duplicates">
        <DoneIcon size={14} /> No open VibeQ task looks like this one.
      </p>
    );
  }
  const same = state.found.some((d) => d.verdict === 'same');
  return (
    <section className="card duplicates" aria-label="Duplicates" data-tone={same ? 'warning' : undefined}>
      <h2>{same ? 'This may already be a task' : 'Similar tasks in VibeQ'}</h2>
      <p className="small muted">
        {same
          ? 'Open it and add what you found there, or file this as a new task if it is different.'
          : 'Their titles are close. Check them before you file.'}
      </p>
      <ul className="duplicate-list">
        {state.found.map((d) => (
          <li key={d.taskId}>
            <span className="pill" data-tone={d.verdict === 'same' ? 'warning' : 'info'}>
              {d.verdict === 'same' ? 'Same problem' : 'Similar title'}
            </span>
            <span className="duplicate-text">
              <a href={d.url} target="_blank" rel="noreferrer">
                {d.title}
              </a>
              <span className="small muted">
                {d.status}
                {d.reason && ` · ${d.reason}`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Work in progress, with a spinner and the time so far. */
function Running({ text }: { text: string }) {
  const elapsed = useSince(text);
  return (
    <span className="waiting">
      <span className="spinner" aria-hidden="true" />
      {text} {clock(elapsed)}
    </span>
  );
}

/** The site a page belongs to, for settings remembered per site. */
function siteOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').origin;
  } catch {
    return '';
  }
}

/** The findings lines at the top of the notes, as the person reads them. */
function findingsOf(notes: string): string[] {
  const lines = notes.split('\n');
  if (lines[0]?.trim() !== FINDINGS_HEADER && lines[0]?.trim() !== 'Findings:') return [];
  const out: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trimStart().startsWith('- ')) break;
    out.push(line.trim().slice(2).replace(/\\(.)/g, '$1'));
  }
  return out;
}

/**
 * One recording with unrelated defects becomes two tasks: the chosen findings move to a new
 * observation that has copies of every capture and voice note, and each is trimmed and filed alone.
 */
function Split({ client, id, onSplit }: { client: LensClient; id: number; onSplit: () => void }) {
  const [open, setOpen] = useState<{ revision: number; findings: string[] } | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  async function start() {
    setMessage(null);
    const found = await client.request({ method: 'getObservation', params: { id } });
    const findings = findingsOf(found.notes);
    if (findings.length < 2) {
      setMessage('Split needs two or more findings at the top of the notes.');
      return;
    }
    setOpen({ revision: found.revision, findings });
    setChosen([]);
    setTitle('');
  }
  async function split() {
    if (!open) return;
    try {
      const copy = await client.request({
        method: 'splitObservation',
        params: { observation: id, revision: open.revision, findings: chosen, title },
      });
      setOpen(null);
      setMessage(`Moved to “${copy.title}”. It opened in a new tab; trim each recording to its own defect.`);
      onSplit();
      void browser.tabs.create({ url: browser.runtime.getURL(`/review.html?observation=${copy.id}`) });
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  if (!open) {
    return (
      <div className="split">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void start().catch((e: Error) => setMessage(e.message))}>
          Split into two tasks
        </button>
        {message && (
          <span className="small muted" role="status" aria-label="Split">
            {message}
          </span>
        )}
      </div>
    );
  }
  return (
    <fieldset className="split card">
      <legend className="label">Move these findings to a new task</legend>
      {open.findings.map((f, i) => (
        <label key={i} className="check">
          <input
            type="checkbox"
            checked={chosen.includes(i)}
            onChange={(e) => {
              const next = e.target.checked ? [...chosen, i] : chosen.filter((c) => c !== i);
              setChosen(next);
              if (!title.trim() || open.findings.some((g) => g.slice(0, 80) === title)) setTitle(open.findings[next[0] ?? -1]?.slice(0, 80) ?? '');
            }}
          />
          <span>{f}</span>
        </label>
      ))}
      <label className="field">
        <span className="label">Title of the new task</span>
        <input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="note-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(null)}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={chosen.length === 0 || chosen.length === open.findings.length || !title.trim()}
          onClick={() => void split()}
        >
          Move {chosen.length || ''} to a new task
        </button>
      </div>
      {message && (
        <span role="alert" className="small">
          {message}
        </span>
      )}
    </fieldset>
  );
}

function BlobImage({ client, blob, alt }: { client: LensClient; blob: BlobRef; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    void client.readBlob(blob).then((data) => setSrc((url = URL.createObjectURL(data))));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, blob]);
  return src ? <img className="review-shot" src={src} alt={alt} /> : <span className="review-shot skeleton" />;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { activeLlmSummary, getLlmConfig } from '@/engine/llm';
import { enqueueTranscription } from '@/engine/speech';
import { LensClient, LensError } from '@/lens-client';
import { originOf } from '@/messages';
import type { Capture } from '@/protocol/Capture';
import type { Observation } from '@/protocol/Observation';
import type { Review as FrozenReview } from '@/protocol/Review';
import type { Filing } from '@/protocol/Filing';
import type { Member } from '@/protocol/Member';
import type { AgentInfo } from '@/protocol/AgentInfo';
import type { Agent } from '@/protocol/Agent';
import type { Suggestion } from '@/protocol/Suggestion';
import type { VoiceNote } from '@/protocol/VoiceNote';
import { AlertIcon, DoneIcon, DraftIcon, ExportIcon, FileIcon, MaskIcon } from '@/ui/icons';
import { useDestination } from '@/ui/Destination';
import { Attachments } from './Attachments';
import { TrackerDraft } from './TrackerDraft';
import { Handoff, handoffName, useHandoff } from './Handoff';
import { Notes } from '../sidepanel/Notes';
import { findingsHeader, findingsLabel, joinNotes, modelLabel } from '@/findings';
import type { FindingsSettings } from '@/protocol/FindingsSettings';
import type { Summary } from '@/protocol/Summary';
import { useStored } from '../sidepanel/Record';
import type { SirvantRun } from '@/protocol/SirvantRun';
import { BlobImage, ReviewedNotes, Running, SharedEvidence, Steps } from './Evidence';
import { Issues, Split } from './Issues';
import { Duplicates } from './Duplicates';
import { VoiceTranscriptEditor } from './VoiceTranscriptEditor';
import { siteOf } from './reviewHelpers';

/**
 * What leaves the notebook: every capture with its recording, as the edits left it. The daemon freezes the
 * review and renders the images, and the page then shows exactly those images before any export.
 */
export function Review({ observation: id }: { observation: number }) {
  const [client] = useState(() => new LensClient());
  const [includeVoice, setIncludeVoice] = useState(true);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [typedValues, setTypedValues] = useState(true);
  const [voice, setVoice] = useState<VoiceNote[]>([]);
  const [review, setReview] = useState<FrozenReview | null>(null);
  // An export, a filing and a running request each belong to one review: a new review starts clean.
  const [lastExport, setExported] = useState<{ review: number; folder: string } | null>(null);
  const exported = review && lastExport?.review === review.id ? lastExport.folder : null;
  const [exporting, setExporting] = useState<number | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [assignee, setAssignee] = useState('');
  const { settings: destinations, error: destinationError } = useDestination(client);
  const defaultChoice = destinations?.choice;
  const destination = defaultChoice?.tracker;
  const [lastFiling, setFiling] = useState<Filing | null>(null);
  // A filing reply can land after a newer review replaced its own: it then belongs to no review here.
  const filing = review && lastFiling?.review === review.id ? lastFiling : null;
  /** Filed for good: the task is there with every file. Otherwise filing again finishes it. */
  const filed = Boolean(filing?.taskUrl && filing.missingFiles === 0);
  const [sendingReview, setSending] = useState<number | null>(null);
  const sending = review !== null && sendingReview === review.id;
  /** Put Sirvant, VibeQ's agent, to work right after filing; remembered for the next review. */
  const [sirvantNext, setSirvantNext] = useStored('lens.sirvant', false);
  const [lastSirvant, setSirvant] = useState<{ review: number; run: SirvantRun } | null>(null);
  const sirvant = review && lastSirvant?.review === review.id ? lastSirvant.run : null;
  const [startingReview, setStarting] = useState<number | null>(null);
  const starting = review !== null && startingReview === review.id;
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [aiLabel, setAiLabel] = useState<string | null>(null);
  const [drafting, setDrafting] = useState<Agent | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [usingDraft, setUsingDraft] = useState(false);
  const [freezing, setFreezing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The task of an earlier filing of this observation, when the page opens again. */
  const [filedTask, setFiledTask] = useState<string | null>(null);
  const handoff = useHandoff(client, siteOf(review?.items[0]?.pageUrl ?? captures[0]?.pageUrl));
  /** The review whose tracker draft opens by itself: it came from the one-click button. */
  const [autoDraft, setAutoDraft] = useState<number | null>(null);
  // The review and filing on the page now. A reply that comes back after the person made a new
  // review, or cleared it with "Use as my notes", belongs to the old one and must not show here:
  // the page would offer Sirvant or filing for a review the reply was not about.
  const shown = useRef({ review, filing });
  shown.current = { review, filing };
  const stillShown = (one: FrozenReview) => shown.current.review?.id === one.id;

  // A filing cut short (the page closed, the network went) belongs to its frozen review: after a
  // reload the page shows that review again, so filing again finishes the same submission.
  const restoreUnfinished = useCallback(
    async (revision: number) => {
      // This observation's reviews only: the whole list can outgrow a reply.
      const mine = await client
        .request({ method: 'listReviewsPage', params: { before: null, limit: 50, observation: id } })
        .catch(() => []);
      // Newest first: only the latest filed review of these notes counts.
      for (const summary of mine.filter((r) => r.revision === revision)) {
        const earlier = await client.request({ method: 'getFiling', params: { review: summary.id } }).catch(() => null);
        if (!earlier) continue;
        if (earlier.taskUrl && earlier.missingFiles === 0) return;
        const frozen = await client.request({ method: 'getReview', params: { review: summary.id } }).catch(() => null);
        // A review made meanwhile wins: the earlier filing is shown with its own review or not at all.
        if (!frozen || shown.current.review || shown.current.filing) return;
        setReview(frozen);
        setFiling(earlier);
        setNotice('An earlier filing of this review did not finish. File again to finish it: VibeQ gets no second task.');
        return;
      }
    },
    [client, id],
  );

  // Until the app answers, the page tries again every few seconds (the banner says why).
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    // The client serves the whole page: this load only stops listening, it never disconnects it.
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    Promise.all([
      client.request({ method: 'getObservation', params: { id } }),
      client.request({ method: 'listCaptures', params: { observation: id } }),
      client.request({ method: 'listVoiceNotes', params: { observation: id } }),
    ])
      .then(([found, list, notes]) => {
        if (!alive) return;
        void client
          .request({ method: 'listObservations' })
          .then((all) => setFiledTask(all.find((o) => o.id === id)?.taskUrl ?? null))
          .catch(() => {});
        setProblem(null);
        setObservation(found);
        setCaptures(list);
        setVoice(notes);
        void restoreUnfinished(found.revision);
      })
      .catch((error: Error) => {
        if (!alive) return;
        // Split into tasks or deleted (an old tab, Back): asking again will not bring it back.
        if (error instanceof LensError && error.code === 'notFound') {
          return setProblem('This recording no longer exists: it was split into separate tasks or deleted.');
        }
        setProblem(error.message);
        retry = setTimeout(() => setLoadAttempt((n) => n + 1), 5000);
      });
    return () => {
      alive = false;
      clearTimeout(retry);
    };
  }, [client, id, loadAttempt]);

  // A title and findings from a small model, once the person's words are written down.
  const [summary, setSummary] = useState<
    { state: 'idle' } | { state: 'running' } | { state: 'done'; label: string } | { state: 'failed'; reason: string }
  >({ state: 'idle' });
  const [notesVersion, setNotesVersion] = useState(0);
  const summarized = useRef(false);
  const flushNotes = useRef<(() => Promise<void>) | null>(null);
  // Undefined until the app answers. An app too old to answer has findings on, as before.
  const [findingsSettings, setFindingsSettings] = useState<FindingsSettings | null | undefined>(undefined);
  useEffect(() => {
    client.request({ method: 'getFindingsSettings' }).then(setFindingsSettings, () => setFindingsSettings(null));
  }, [client]);
  const findingsOff = findingsSettings?.enabled === false;
  const summarize = useCallback(async () => {
    setSummary({ state: 'running' });
    try {
      const found: Summary & { label?: string } = await client.request({ method: 'summarize', params: { observation: id } });
      const latest = await client.request({ method: 'getObservation', params: { id } });
      // The model that wrote them, as the app names it in its own headers.
      const chosen = findingsSettings && (!findingsSettings.provider || findingsSettings.provider === found.agent);
      const label = found.label || modelLabel(found.agent, chosen ? findingsSettings.model : null);
      // The findings go first in the notes; what the person wrote stays below them.
      const previous = latest.notes.replace(/^Findings[^\n]*:\n(- .*\n?)+\n*/, '').trim();
      const findings = joinNotes(found.findings, '', findingsHeader(label));
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
      setSummary({ state: 'done', label });
    } catch (error) {
      setSummary({ state: 'failed', reason: (error as Error).message });
    }
  }, [client, id, findingsSettings]);
  // The daemon may have written them already, in the background, with any model.
  useEffect(() => {
    const label = findingsLabel(observation?.notes.split('\n', 1)[0] ?? '');
    if (summary.state === 'idle' && label) {
      summarized.current = true;
      setSummary({ state: 'done', label });
    }
  }, [observation, summary.state]);
  const waitingForWords = voice.some((v) => v.state === 'transcribing' || (v.state === 'waiting' && !v.detail));
  useEffect(() => {
    // Findings off in Settings: no model runs, and the page says so quietly instead of an error.
    if (findingsSettings === undefined || findingsOff) return;
    if (review || !observation || summarized.current || waitingForWords || captures.length === 0) return;
    // Only a title nobody chose: the page's own title, or its address.
    const automatic = captures.some((c) => observation.title === c.pageTitle || observation.title === c.pageUrl) || !observation.title.trim();
    if (!automatic) return;
    summarized.current = true;
    void summarize();
  }, [review, observation, captures, waitingForWords, summarize, findingsSettings, findingsOff]);

  // Kick off local/cloud transcription for any waiting or orphaned 'transcribing' voice notes,
  // and poll until every note finishes.
  const transcribing = voice.some((v) => v.state === 'waiting' || v.state === 'transcribing');
  useEffect(() => {
    for (const v of voice) {
      if (v.state === 'waiting' || v.state === 'transcribing') enqueueTranscription(v.id);
    }
    if (!transcribing) return;
    const timer = setInterval(() => {
      void client
        .request({ method: 'listVoiceNotes', params: { observation: id } })
        .then((next) => setVoice((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)))
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [client, id, transcribing, voice]);

  /** Freezes the review; returns it, or null when it did not freeze. */
  async function freeze(): Promise<FrozenReview | null> {
    if (!observation || freezing) return null;
    setFreezing(true);
    // The title and notes are edited on this page: the review takes their latest revision, after
    // the draft typed in the last moment is saved. An autosave or the background title can still
    // land between that read and the review: then once more, with the revision after it.
    const attempt = async () => {
      await flushNotes.current?.();
      const latest = await client.request({ method: 'getObservation', params: { id } });
      setObservation(latest);
      return client.request({
        method: 'createReview',
        params: {
          observation: observation.id,
          revision: latest.revision,
          // Every capture goes in, each with its recording unless it is masked.
          captures: captures.map((c) => c.id),
          // A mask hides pixels only: the replay of that page would show the same text.
          recordings: captures.filter((c) => c.recording && !c.annotations.some((s) => s.kind === 'mask')).map((c) => c.id),
          typedValues,
          screenshotsChecked: true,
        },
      });
    };
    try {
      const frozen = await attempt().catch((error: Error) => {
        if (error instanceof LensError && error.code === 'conflict') return attempt();
        throw error;
      });
      // Before the next render: a reply about the old review that lands meanwhile is ignored.
      shown.current = { review: frozen, filing: null };
      setReview(frozen);
      // A new revision is not filed yet: the last filing was of the review before it.
      setFiling(null);
      setProblem(null);
      // "Create a new review" is done: that notice is old now.
      setNotice(null);
      return frozen;
    } catch (error) {
      setProblem((error as Error).message);
      return null;
    } finally {
      setFreezing(false);
    }
  }

  /** One click: the review, then the tracker draft or clipboard copy right after it. */
  async function freezeAndSend() {
    const frozen = await freeze();
    if (!frozen) return;
    setAutoDraft(frozen.id);
  }

  // The review comes as an argument from the one-click path: the state has not caught up yet.
  async function file(target = review) {
    if (!target || sendingReview === target.id) return;
    setSending(target.id);
    try {
      const done = await client.request({ method: 'fileReview', params: { review: target.id, assignee: assignee || null } });
      if (!stillShown(target)) return;
      setFiling(done);
      setProblem(done.missingFiles ? `${done.missingFiles} files did not reach VibeQ; file again to send them.` : null);
      // An agent starts on the whole evidence only: a filing with missing files waits for the retry.
      const complete = done.taskUrl && !done.missingFiles;
      if (complete && sirvantNext && !sirvant) await startSirvant(target);
      // The agent's prompt then links the VibeQ task.
      if (complete && handoff.afterFiling && handoff.ready && handoff.done?.review !== target.id) await handoff.handOff(target.id);
    } catch (error) {
      if (stillShown(target)) setProblem(`Not filed: ${(error as Error).message}. Filing again is safe: it never creates a second task.`);
    } finally {
      // Only this review's flag: a newer review's filing may run now.
      setSending((current) => (current === target.id ? null : current));
    }
  }

  async function startSirvant(target = review) {
    if (!target || startingReview === target.id) return;
    setStarting(target.id);
    try {
      const run = await client.request({ method: 'startSirvant', params: { review: target.id } });
      setSirvant({ review: target.id, run });
    } catch (error) {
      if (stillShown(target)) setProblem(`Filed, but Sirvant did not start: ${(error as Error).message}.`);
    } finally {
      setStarting((current) => (current === target.id ? null : current));
    }
  }

  useEffect(() => {
    if (!review) return;
    client
      .request({ method: 'listAgents' })
      .then(setAgents)
      .catch(() => setAgents([]));
    void getLlmConfig()
      .then((cfg) => {
        const active = activeLlmSummary(cfg);
        setAiLabel(active ? `${active.label} (${active.model})` : null);
      })
      .catch(() => setAiLabel(null));
  }, [client, review]);

  useEffect(() => {
    if (destination !== 'vibeq') return;
    client.request({ method: 'listMembers' }).then(setMembers).catch(() => setMembers([]));
  }, [client, destination]);

  async function draft(agent: Agent) {
    if (!review) return;
    setDrafting(agent);
    try {
      const drafted = await client.request({ method: 'investigate', params: { review: review.id, agent } });
      if (!stillShown(review)) return;
      setSuggestion(drafted);
      setProblem(null);
    } catch (error) {
      if (stillShown(review)) setProblem((error as Error).message);
    } finally {
      setDrafting(null);
    }
  }

  /** The draft replaces the notes: a new revision, so this review no longer matches and is redone. */
  async function useDraft() {
    if (!observation || !suggestion || usingDraft) return;
    // A second click before the first save returns would save on the old revision: a conflict.
    setUsingDraft(true);
    try {
      // The notes editor saves on its own: the page's copy of the revision can be old.
      const latest = await client.request({ method: 'getObservation', params: { id: observation.id } });
      const saved = await client.request({
        method: 'updateObservation',
        params: { id: observation.id, revision: latest.revision, title: latest.title, notes: suggestion.markdown },
      });
      setObservation(saved);
      // The editor loads the new notes and revision; its old ones would conflict on the next save.
      setNotesVersion((v) => v + 1);
      shown.current = { review: null, filing: null };
      setReview(null);
      setFiling(null);
      setSuggestion(null);
      setNotice('Your notes now hold the draft. Check them, then create a new review before you file.');
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setUsingDraft(false);
    }
  }

  async function exportReview() {
    if (!review || exporting === review.id) return;
    setExporting(review.id);
    try {
      const done = await client.request({ method: 'exportReview', params: { review: review.id } });
      setExported({ review: review.id, folder: done.folder });
    } catch (error) {
      if (stillShown(review)) setProblem((error as Error).message);
    } finally {
      setExporting((current) => (current === review.id ? null : current));
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
  // VibeQ never auto-files on review creation so the person can assign, check duplicates and hand off first.
  const quickLabel =
    destination === 'vibeq'
      ? null
      : destination === 'clipboard'
        ? 'Create the review and copy summary'
        : destination && defaultChoice
          ? 'Create the review and open draft'
          : null;
  return (
    <main className="page review">
      <header className="page-head">
        <h1>{review ? review.title : 'Review report'}</h1>
        {review && <ReviewedNotes review={review} />}
      </header>

      {notice && (
        <div role="status" className="notice" data-tone="info">
          <DoneIcon />
          <span>{notice}</span>
        </div>
      )}

      {review ? (
        <>
          <SharedEvidence client={client} review={review} />

          <Attachments includeVoice={includeVoice} setIncludeVoice={setIncludeVoice} key={review.id} client={client} review={review} />

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
                <button type="button" className="btn btn-secondary" onClick={useDraft} disabled={usingDraft}>
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
                <a href={originOf(filing.taskUrl) ? filing.taskUrl : undefined} target="_blank" rel="noreferrer">
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
          {destination === 'vibeq' && !filing && <Duplicates client={client} id={id} />}
          <Handoff state={handoff} review={review.id} />

          <footer className="action-bar">
            {readyAgents.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void draft(readyAgents[0]!.agent)}
                disabled={drafting !== null}
                title={aiLabel ?? undefined}
              >
                <DraftIcon />
                {drafting !== null ? 'Drafting…' : aiLabel ? `Draft report with ${aiLabel.split(' ')[0]}` : 'Draft report with AI'}
              </button>
            )}
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={exportReview}
              disabled={exported !== null || exporting === review.id}
            >
              <ExportIcon />
              {exporting === review.id ? 'Exporting…' : 'Export to Downloads'}
            </button>
            {destination === 'vibeq' ? <>
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
              {filed ? (
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
              {!filed && handoff.app && (
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
                onClick={() => void file()}
                disabled={sending || filed}
              >
                <FileIcon />
                {sending ? 'Filing…' : filed ? 'Filed' : filing ? 'File again' : 'File to VibeQ'}
              </button>
            </> : destination && defaultChoice ? (
              <TrackerDraft
                includeVoice={includeVoice}
                key={destination + defaultChoice.address + review.id}
                tracker={destination}
                address={defaultChoice.address}
                review={review}
                autoOpen={autoDraft === review.id}
              />
            ) : destinationError ? <span role="alert">{destinationError}</span> : destinations ? (
              <button type="button" className="btn btn-primary" onClick={() => void browser.runtime.openOptionsPage()}>Choose default destination</button>
            ) : null}
          </footer>
        </>
      ) : (
        <>
          <section className="card summary" aria-label="Title and findings">
            <Notes key={notesVersion} client={client} id={id} onSaved={() => {}} flushRef={flushNotes} />
            <p className="small muted summary-state" role="status" aria-label="Summary">
              {summary.state === 'running' && <Running text="AI is writing a title and the findings…" />}
              {summary.state === 'idle' && findingsOff && <>Automatic findings are off in Settings.</>}
              {summary.state === 'idle' && !findingsOff && waitingForWords && <>The title and findings follow once your words are written down.</>}
              {summary.state === 'done' && <>{summary.label} wrote the title and the findings. Edit them as you like.</>}
              {summary.state === 'failed' && <>No title was written: {summary.reason}</>}
              {summary.state !== 'running' && !findingsOff && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void summarize()}>
                  <DraftIcon /> {summary.state === 'done' ? 'Write them again' : 'Write a title and findings'}
                </button>
              )}
            </p>
            <Split client={client} id={id} onSplit={() => setNotesVersion((v) => v + 1)} />
          </section>
          <Issues client={client} id={id} refresh={notesVersion} />
          {captures.filter((c) => c.kind === 'session' && c.recording).map((c) => (
            <a key={c.id} className="recording-link" href={browser.runtime.getURL(`/replay.html?capture=${c.id}`)} target="_blank" rel="noreferrer">
              Open replay and transcript · {c.pageTitle || c.pageUrl || `Recording ${c.id}`}
            </a>
          ))}
          {captures.some((c) => c.kind !== 'session') && (
            <ol aria-label="Captures to review" className="review-list">
              {captures
                .filter((c) => c.kind !== 'session')
                .map((c) => (
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
                    </div>
                  </li>
                ))}
            </ol>
          )}
          {voice.length > 0 && !captures.some((c) => c.kind === 'session') && (
            <details className="card shared-evidence">
              <summary>View voice notes</summary>
              <VoiceTranscriptEditor
                client={client}
                notes={voice.filter((v) => v.state === 'done')}
                label="Voice notes to share"
                onChange={(note) => setVoice((all) => all.map((v) => (v.id === note.id ? note : v)))}
              />
              {voice.some((v) => v.state !== 'done') && (
                <p className="small muted">Voice notes that are not transcribed yet stay out of this review.</p>
              )}
              <p className="small muted">The review includes transcripts. MP4 exports can also include your recorded voice.</p>
            </details>
          )}
          {originOf(filedTask ?? undefined) && (
            <div role="status" aria-label="Filed earlier" className="notice" data-tone="info">
              <DoneIcon />
              <span>
                Filed earlier:{' '}
                <a href={filedTask ?? undefined} target="_blank" rel="noreferrer">
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
          {problem && (
            <div role="alert" className="notice">
              <AlertIcon />
              <span>{problem}</span>
            </div>
          )}
          <footer className="action-bar">
            <button
              type="button"
              className={quickLabel ? 'btn btn-secondary' : 'btn btn-primary'}
              onClick={() => void freeze()}
              disabled={captures.length === 0 || freezing}
            >
              {freezing ? 'Creating review…' : 'Create review'}
            </button>
            {quickLabel && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void freezeAndSend()}
                disabled={captures.length === 0 || freezing}
              >
                <FileIcon />
                {quickLabel}
              </button>
            )}
          </footer>
        </>
      )}
    </main>
  );
}

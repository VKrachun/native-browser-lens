import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { LensError, type LensClient } from '@/lens-client';
import type { Observation } from '@/protocol/Observation';
import { joinNotes, splitNotes } from '@/findings';

/** Tags as chips: Enter or a comma adds one, × or Backspace in an empty field removes one. */
function TagChips({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const tag = draft.trim();
    if (tag && !tags.includes(tag)) onChange([...tags, tag]);
    setDraft('');
  };
  return (
    <div className="tag-chips" role="group" aria-label="Tags">
      {tags.map((tag) => (
        <span key={tag} className="tag-chip">
          {tag}
          <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange(tags.filter((t) => t !== tag))}>
            ×
          </button>
        </span>
      ))}
      <input
        className="tag-draft"
        aria-label="Add a tag"
        placeholder={tags.length ? 'Add a tag' : 'Add a tag, like assets or bug'}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(',', ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') (e.preventDefault(), add());
          if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
        }}
        onBlur={add}
      />
    </div>
  );
}

const AUTOSAVE_MS = 800;

type SaveState =
  | { kind: 'saved' }
  | { kind: 'editing' }
  | { kind: 'saving' }
  | { kind: 'failed'; message: string }
  | { kind: 'conflict' };

/** Title and notes of one observation. A failed or conflicting save never drops the draft. */
export function Notes({
  client,
  id,
  onSaved,
  appendRef,
  flushRef,
}: {
  client: LensClient;
  id: number;
  onSaved: () => void;
  /** Filled with a function that adds text at the end of the notes, for transcripts. */
  appendRef?: RefObject<((text: string) => void) | null>;
  /** Filled with a function that saves the draft now, for a review that freezes the notes. */
  flushRef?: RefObject<(() => Promise<void>) | null>;
}) {
  const [record, setRecord] = useState<Observation | null>(null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');
  const [state, setState] = useState<SaveState>({ kind: 'saved' });
  const saving = useRef(false);
  const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
  const dirty =
    record !== null && (title !== record.title || notes !== record.notes || tagList.join(',') !== record.tags.join(','));
  if (appendRef) {
    appendRef.current = (text: string) => {
      setNotes((current) => (current.trim() ? `${current.trimEnd()}\n\n${text}` : text));
      setState((s) => (s.kind === 'conflict' ? s : { kind: 'editing' }));
    };
  }

  const load = useCallback(async () => {
    const found = await client.request({ method: 'getObservation', params: { id } });
    setRecord(found);
    setTitle(found.title);
    setNotes(found.notes);
    setTags(found.tags.join(', '));
    setState({ kind: 'saved' });
  }, [client, id]);

  useEffect(() => {
    void load().catch((error: Error) => setState({ kind: 'failed', message: error.message }));
  }, [load]);

  const save = useCallback(async () => {
    if (!record || !dirty || saving.current || !title.trim()) return;
    saving.current = true;
    setState({ kind: 'saving' });
    try {
      const saved = await client.request({
        method: 'updateObservation',
        params: { id, revision: record.revision, title, notes, tags: tagList },
      });
      setRecord(saved);
      // The daemon cleans tags ("AI Tools" becomes ai-tools): show what it kept.
      if (saved.tags.join(',') !== tagList.join(',')) setTags(saved.tags.join(', '));
      // Typing during the save leaves a newer draft: the effect below saves it next.
      setState(saved.title === title && saved.notes === notes ? { kind: 'saved' } : { kind: 'editing' });
      onSaved();
    } catch (error) {
      const conflict = error instanceof LensError && error.code === 'conflict';
      if (conflict) {
        // Lens titles observations in the background: a new title and findings put in front of
        // the notes. That change and the person's edit combine; anything else is a real conflict.
        const latest = await client.request({ method: 'getObservation', params: { id } }).catch(() => null);
        const prepended = latest && latest.notes.endsWith(record.notes);
        if (latest && prepended) {
          const merged = {
            title: title === record.title ? latest.title : title,
            notes: latest.notes.slice(0, latest.notes.length - record.notes.length) + notes,
          };
          try {
            const merging = { ...merged, tags: tagList.length || record.tags.length ? tagList : latest.tags };
            const saved = await client.request({ method: 'updateObservation', params: { id, revision: latest.revision, ...merging } });
            setRecord(saved);
            setTitle(saved.title);
            setNotes(saved.notes);
            setTags(saved.tags.join(', '));
            setState({ kind: 'saved' });
            onSaved();
            return;
          } catch {
            // Fall through: show the conflict.
          }
        }
      }
      setState(conflict ? { kind: 'conflict' } : { kind: 'failed', message: (error as Error).message });
    } finally {
      saving.current = false;
    }
  }, [client, id, record, dirty, title, notes, tags, onSaved]);
  const latestSave = useRef(save);
  latestSave.current = save;
  if (flushRef) {
    flushRef.current = async () => {
      // A save in flight first; then the newest draft, with the revision that save returned.
      for (let i = 0; i < 100 && saving.current; i++) await new Promise((done) => setTimeout(done, 50));
      await new Promise((done) => setTimeout(done, 0));
      await latestSave.current();
    };
  }

  useEffect(() => {
    if (!dirty || state.kind === 'conflict' || state.kind === 'saving') return;
    const timer = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [dirty, title, notes, tags, state.kind, save]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('keydown', keys);
    window.addEventListener('beforeunload', leave);
    return () => {
      window.removeEventListener('keydown', keys);
      window.removeEventListener('beforeunload', leave);
    };
  }, [save, dirty]);

  if (!record) return state.kind === 'failed' ? <p role="alert" className="notice">{state.message}</p> : null;
  const editing = (s: SaveState) => (s.kind === 'conflict' ? s : ({ kind: 'editing' } as SaveState));
  // The notes stay one text; the page shows the model's findings as lines and the rest as the
  // person's own words.
  const parts = splitNotes(notes);
  const setParts = (findings: string[] | null, rest: string) => (setNotes(joinNotes(findings, rest)), setState(editing));
  const setTagList = (list: string[]) => (setTags(list.join(', ')), setState(editing));
  return (
    <div className="notes">
      {/* A long title wraps instead of hiding its end; it stays one line of text. */}
      <textarea
        className="input input-quiet title-input"
        aria-label="Title"
        rows={Math.max(1, Math.ceil(title.length / 32))}
        value={title}
        onChange={(e) => (setTitle(e.target.value.replace(/\n/g, ' ')), setState(editing))}
        onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
      />
      <TagChips tags={tagList} onChange={setTagList} />
      <div className="notes-head">
        <span className="small muted" role="status" aria-label="Notes status">
          {state.kind === 'saved' && 'Saved'}
          {state.kind === 'editing' && (title.trim() ? 'Unsaved changes' : 'A title is required')}
          {state.kind === 'saving' && 'Saving…'}
        </span>
      </div>
      {parts.findings && (
        <section className="findings-edit" aria-label="Findings">
          <h3 className="label">
            Findings <span className="muted">· written by a model from the recording; check them</span>
          </h3>
          <ul>
            {parts.findings.map((finding, i) => (
              <li key={i}>
                <textarea
                  className="textarea finding-input"
                  rows={Math.max(1, Math.ceil(finding.length / 52))}
                  aria-label={`Finding ${i + 1}`}
                  value={finding}
                  onChange={(e) =>
                    setParts(
                      parts.findings!.map((f, k) => (k === i ? e.target.value.replace(/\n/g, ' ') : f)),
                      parts.rest,
                    )
                  }
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label={`Remove finding ${i + 1}`}
                  title="Remove this finding"
                  onClick={() => setParts(parts.findings!.filter((_, k) => k !== i), parts.rest)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setParts([...parts.findings!, ''], parts.rest)}>
            Add a finding
          </button>
        </section>
      )}
      <div className="field">
        <label htmlFor={`notes-${id}`} className="label">
          {parts.findings ? 'Your notes' : 'Notes'}
        </label>
        <textarea
          id={`notes-${id}`}
          className="textarea"
          rows={parts.findings ? 3 : 5}
          value={parts.rest}
          placeholder="What did you do, what happened, and what did you expect?"
          onChange={(e) => setParts(parts.findings, e.target.value)}
        />
      </div>
      {state.kind === 'failed' && (
        <div role="alert" className="notice">
          <span>
            Not saved: {state.message}. Your text is still here.{' '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void save()}>
              Try again
            </button>
          </span>
        </div>
      )}
      {state.kind === 'conflict' && (
        <div role="alert" className="notice" data-tone="warning">
          <span>
            This observation changed in another window. Your text is still here.{' '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void load()}>
              Discard mine and load theirs
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

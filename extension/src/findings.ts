import type { Agent } from './protocol/Agent';

const HEAD = 'Findings (written by ';
const TAIL = ' from the recording; check them):';
/** Notes from before models wrote the findings. */
const PLAIN_HEADER = 'Findings:';

/** The first line of a findings block, naming the model. Must equal `findings_header` in src/record.rs. */
export const findingsHeader = (label: string) => `${HEAD}${label}${TAIL}`;
/** The header Lens wrote before the model was a setting. */
export const FINDINGS_HEADER = findingsHeader('Claude Haiku');

/** The model a findings header names, or null when the line is no model's header. As `is_findings_header` in src/record.rs. */
export function findingsLabel(line: string): string | null {
  const flat = line.trim();
  if (!flat.startsWith(HEAD) || !flat.endsWith(TAIL)) return null;
  const label = flat.slice(HEAD.length, flat.length - TAIL.length).trim();
  return label || null;
}

/** A findings block a model wrote, whichever model. */
export const isFindingsHeader = (line: string) => findingsLabel(line) !== null;

/** As `model_label` in src/investigate.rs: "Claude Haiku", "Codex", "Codex gpt-5". */
export function modelLabel(agent: Agent, model: string | null): string {
  const provider = agent === 'codex' ? 'Codex' : 'Claude';
  if (!model) return provider;
  const lower = model.toLowerCase();
  return ['haiku', 'sonnet', 'opus'].includes(lower) ? `${provider} ${lower[0]!.toUpperCase()}${lower.slice(1)}` : `${provider} ${model}`;
}

/** A model read page text: its words cannot form links, images, HTML or code in the notes. */
export function escapeFinding(text: string): string {
  return text.replace(/\n/g, ' ').replace(/[\\`[\]<>]/g, (c) => `\\${c}`);
}

/** As people read it: older notes escaped all punctuation ("regression\."). */
export function readable(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/**
 * Notes as the page edits them: the model's findings, one per line, and the person's own text.
 * Notes without a findings block are all the person's.
 */
export function splitNotes(notes: string): { findings: string[] | null; rest: string; header: string | null } {
  const lines = notes.split('\n');
  const head = lines[0]?.trim() ?? '';
  if (head !== PLAIN_HEADER && !isFindingsHeader(head)) return { findings: null, rest: notes, header: null };
  let end = 1;
  const findings: string[] = [];
  for (let line = lines[end]; line?.trimStart().startsWith('- '); line = lines[++end]) {
    // Not trimmed at the end: a space just typed between two words stays.
    findings.push(readable(line.replace(/^\s*- /, '')));
  }
  // Only the blank lines after the block go: a newline the person just typed stays.
  return { findings, rest: lines.slice(end).join('\n').replace(/^\n+/, ''), header: head };
}

/**
 * The notes again, from the findings and the person's text, under the header they came with. A
 * finding being typed may be empty for a moment and stays; with no findings left, the block goes.
 */
export function joinNotes(findings: string[] | null, rest: string, header: string | null = FINDINGS_HEADER): string {
  const list = findings ?? [];
  const block = list.length ? `${header ?? FINDINGS_HEADER}\n${list.map((f) => `- ${escapeFinding(f)}`).join('\n')}` : '';
  return [block, rest.replace(/^\n+/, '')].filter(Boolean).join('\n\n');
}

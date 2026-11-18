/** Must equal FINDINGS_HEADER in src/daemon.rs. */
export const FINDINGS_HEADER = 'Findings (written by Claude Haiku from the recording; check them):';

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
export function splitNotes(notes: string): { findings: string[] | null; rest: string } {
  const lines = notes.split('\n');
  const head = lines[0]?.trim();
  if (head !== FINDINGS_HEADER && head !== 'Findings:') return { findings: null, rest: notes };
  let end = 1;
  const findings: string[] = [];
  for (let line = lines[end]; line?.trimStart().startsWith('- '); line = lines[++end]) {
    // Not trimmed at the end: a space just typed between two words stays.
    findings.push(readable(line.replace(/^\s*- /, '')));
  }
  // Only the blank lines after the block go: a newline the person just typed stays.
  return { findings, rest: lines.slice(end).join('\n').replace(/^\n+/, '') };
}

/**
 * The notes again, from the findings and the person's text. A finding being typed may be empty
 * for a moment and stays; with no findings left, the block goes.
 */
export function joinNotes(findings: string[] | null, rest: string): string {
  const list = findings ?? [];
  const block = list.length ? `${FINDINGS_HEADER}\n${list.map((f) => `- ${escapeFinding(f)}`).join('\n')}` : '';
  return [block, rest.replace(/^\n+/, '')].filter(Boolean).join('\n\n');
}

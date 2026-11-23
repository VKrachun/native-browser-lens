import { describe, expect, it } from 'vitest';
import { FINDINGS_HEADER, findingsHeader, findingsLabel, isFindingsHeader, joinNotes, modelLabel, splitNotes } from './findings';

describe('findings headers', () => {
  it('name any model, as the app does (src/record.rs)', () => {
    for (const header of [FINDINGS_HEADER, '  Findings (written by Claude Sonnet from the recording; check them):', findingsHeader('Codex')]) {
      expect(isFindingsHeader(header)).toBe(true);
    }
    for (const other of ['Findings:', 'Findings (written by  from the recording; check them):', 'Findings (written by me) and more']) {
      expect(isFindingsHeader(other)).toBe(false);
    }
    expect(findingsLabel(findingsHeader('Codex gpt-5'))).toBe('Codex gpt-5');
  });

  it('label models as src/investigate.rs does', () => {
    expect(modelLabel('claude', 'haiku')).toBe('Claude Haiku');
    expect(modelLabel('claude', 'OPUS')).toBe('Claude Opus');
    expect(modelLabel('codex', 'gpt-5')).toBe('Codex gpt-5');
    expect(modelLabel('codex', null)).toBe('Codex');
  });

  it('keep the header they came with when the notes are joined again', () => {
    for (const header of [findingsHeader('Codex'), 'Findings:']) {
      const { findings, rest, header: found } = splitNotes(`${header}\n- One\n\nMine.`);
      expect(findings).toEqual(['One']);
      expect(found).toBe(header);
      expect(joinNotes(findings, rest, found)).toBe(`${header}\n- One\n\nMine.`);
    }
  });
});

describe('findings in the notes', () => {
  it('reads old escaped findings cleanly and writes them back escaped only where it matters', () => {
    const notes = `${FINDINGS_HEADER}\n- It's just a regression\\.\n- Ctrl\\+A skips \\[folders\\]\n\nMy own words.`;
    const { findings, rest } = splitNotes(notes);
    expect(findings).toEqual(["It's just a regression.", 'Ctrl+A skips [folders]']);
    expect(rest).toBe('My own words.');
    expect(joinNotes(findings, rest)).toBe(
      `${FINDINGS_HEADER}\n- It's just a regression.\n- Ctrl+A skips \\[folders\\]\n\nMy own words.`,
    );
  });

  it('leaves notes without findings alone, and drops the block when no finding is left', () => {
    expect(splitNotes('Just mine.')).toEqual({ findings: null, rest: 'Just mine.', header: null });
    expect(joinNotes([], 'Just mine.')).toBe('Just mine.');
    // A finding being typed stays, even empty or with a space at its end for a moment.
    expect(splitNotes(joinNotes(['a ', ''], 'mine\n')).findings).toEqual(['a ', '']);
    expect(splitNotes(joinNotes(['a'], 'mine\n')).rest).toBe('mine\n');
  });
});

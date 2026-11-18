import { describe, expect, it } from 'vitest';
import { FINDINGS_HEADER, joinNotes, splitNotes } from './findings';

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
    expect(splitNotes('Just mine.')).toEqual({ findings: null, rest: 'Just mine.' });
    expect(joinNotes([], 'Just mine.')).toBe('Just mine.');
    // A finding being typed stays, even empty or with a space at its end for a moment.
    expect(splitNotes(joinNotes(['a ', ''], 'mine\n')).findings).toEqual(['a ', '']);
    expect(splitNotes(joinNotes(['a'], 'mine\n')).rest).toBe('mine\n');
  });
});

import { expect, it } from 'vitest';
import { basecampNotes, draftDescription, draftTarget } from './tracker-drafts';

it.each([
  ['linear', '', 'https://linear.app/new', 'description'],
  ['github', 'https://github.com/owner/repo/issues', 'https://github.com/owner/repo/issues/new', 'body'],
] as const)('opens a prefilled %s draft and preserves long text for pasting', (tracker, address, route, field) => {
  const title = 'A & B 🐞';
  const body = 'Failure #2\n?param';
  const draft = draftTarget(tracker, address, title, body);
  const url = new URL(draft.url!);
  expect(url.origin + url.pathname).toBe(route);
  expect(url.searchParams.get('title')).toBe(title);
  expect(url.searchParams.get(field)).toBe(body);
  expect(draft.copy).toBeNull();
  const longText = body.repeat(2000);
  const long = draftTarget(tracker, address, title, longText);
  expect(long.copy).toBe(longText);
  expect(new URL(long.url!).searchParams.has(field)).toBe(false);
});

it('opens the Basecamp form and keeps the full Jira and clipboard summaries', () => {
  const list = 'https://app.basecamp.com/1/buckets/2/todolists/3';
  expect(draftTarget('basecamp', list, 'Bug\n title', 'Notes')).toEqual({ url: list + '/todos/new', copy: null });
  expect(draftTarget('jira', 'https://team.atlassian.net/browse/BUG-1', 'Bug', 'Notes')).toEqual({
    url: 'https://team.atlassian.net/secure/CreateIssue!default.jspa', copy: 'Bug\n\nNotes',
  });
  expect(draftTarget('clipboard', '', 'Bug', 'Notes')).toEqual({ url: null, copy: 'Bug\n\nNotes' });
});

it('rejects lookalike destinations and non-tracker links', () => {
  expect(() => draftTarget('jira', 'https://x.atlassian.net.example.com', '', '')).toThrow();
  expect(() => draftTarget('basecamp', 'https://app.basecamp.com/1/buckets/2', '', '')).toThrow();
  expect(() => draftTarget('github', 'javascript:alert(1)', '', '')).toThrow();
});

it('copies readable Basecamp findings and preserves the author’s notes', () => {
  expect(basecampNotes({
    id: 1, observation: 1, revision: 1, createdAt: 0, title: 'Popover', tags: [], items: [], voice: [],
    notes: 'Findings (written by Claude Haiku from the recording; check them):\n- Escape fails\\.\n- Ctrl\\+K fails\\.\n\nMy own notes.',
  })).toBe('• Escape fails.\n• Ctrl+K fails.\n\nMy own notes.');
});

it('keeps what the person said in the draft', () => {
  const review = {
    id: 1, observation: 1, revision: 1, createdAt: 0, title: 'Cart', tags: [], items: [], notes: '',
    voice: [{ startedAt: 0, durationMs: 1000, language: 'en', segments: [{ startMs: 0, endMs: 900, text: ' Open the cart twice. ' }] }],
  } as unknown as Parameters<typeof basecampNotes>[0];
  expect(basecampNotes(review)).toBe('Spoken notes:\nOpen the cart twice.');
  expect(draftDescription(review)).toContain('Open the cart twice.');
});

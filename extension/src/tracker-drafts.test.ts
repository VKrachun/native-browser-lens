import { expect, it } from 'vitest';
import { draftTarget } from './tracker-drafts';

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

it('keeps the Jira and Basecamp summaries on the clipboard for the user to paste', () => {
  const list = 'https://app.basecamp.com/1/buckets/2/todolists/3';
  expect(draftTarget('basecamp', list, 'Bug', 'Notes')).toEqual({ url: list + '/todos/new', copy: 'Bug\n\nNotes' });
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

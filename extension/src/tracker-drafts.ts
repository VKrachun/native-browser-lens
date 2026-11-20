import { splitNotes } from './findings';
import type { Tracker } from './protocol/Tracker';
import type { Review } from './protocol/Review';

export const trackerNames = {
  linear: 'Linear',
  jira: 'Jira Cloud',
  basecamp: 'Basecamp',
  github: 'GitHub Issues',
  clipboard: 'Clipboard',
  vibeq: 'VibeQ',
} satisfies Record<Tracker, string>;

export type Destination = keyof typeof trackerNames;
export type DraftTracker = Exclude<Destination, 'vibeq'>;

// Browser text is untrusted. Keep it literal in Markdown-capable issue descriptions.
function literal(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [fence, text, fence].join('\n');
}

export function draftDescription(review: Review): string {
  const parts = [review.notes.trim()];
  for (const item of review.items) {
    const evidence = [item.pageUrl, ...item.findings, ...item.annotations.map((note) => note.text)].filter(Boolean);
    if (evidence.length) parts.push(literal(evidence.join('\n')));
  }
  return parts.filter(Boolean).join('\n\n');
}

/** Basecamp's Notes field accepts plain text. Keep full request URLs in the exported evidence. */
export function basecampNotes(review: Review): string {
  const { findings, rest } = splitNotes(review.notes);
  const sections = [findings?.map((finding) => `• ${finding}`).join('\n'), rest.trim()];
  for (const item of review.items) {
    const evidence = [
      item.pageUrl && `Page: ${item.pageUrl.split(/[?#]/, 1)[0]}`,
      ...item.findings.map((text) => text.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1')),
      ...item.annotations.map((note) => note.text),
    ].filter(Boolean);
    if (evidence.length) sections.push([...new Set(evidence)].join('\n'));
  }
  return sections.filter(Boolean).join('\n\n');
}

export function draftTarget(tracker: DraftTracker, address: string, title: string, description: string) {
  const text = [title, description].filter(Boolean).join('\n\n');
  if (tracker === 'clipboard') return { url: null, copy: text };
  let url = new URL('https://linear.app/new');
  if (tracker !== 'linear') {
    try {
      url = new URL(address);
    } catch {
      throw new Error('Enter the full HTTPS address for this destination.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      throw new Error('Use an HTTPS address without credentials or a port.');
  }

  switch (tracker) {
    case 'jira':
      if (!/^[a-z0-9-]+\.atlassian\.net$/.test(url.hostname))
        throw new Error('Enter your Jira Cloud site, such as https://team.atlassian.net.');
      return { url: new URL('/secure/CreateIssue!default.jspa', url).href, copy: text };
    case 'basecamp':
      if (!['app.basecamp.com', '3.basecamp.com'].includes(url.hostname) ||
          !/^\/\d+\/buckets\/\d+\/(todolists\/\d+(\/todos\/new)?|todos\/new)\/?$/.test(url.pathname))
        throw new Error('Paste the link to your Basecamp to-do list or its new to-do form.');
      if (/\/todolists\/\d+\/?$/.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\/?$/, '/todos/new');
        url.search = '';
        url.hash = '';
      }
      return { url: url.href, copy: title.replace(/\s+/g, ' ').trim() };
    case 'github': {
      const repo = url.pathname.match(/^\/([\w.-]+\/[\w.-]+)(?:\/issues(?:\/new)?)?\/?$/);
      if (url.hostname !== 'github.com' || !repo) throw new Error('Paste the GitHub repository URL.');
      url = new URL('/' + repo[1] + '/issues/new', url);
      break;
    }
  }

  const field = tracker === 'github' ? 'body' : 'description';
  url.searchParams.set('title', title);
  url.searchParams.set(field, description);
  // Large captures can exceed a proxy's request-line limit. Keep the full text for pasting.
  if (url.href.length <= 7000) return { url: url.href, copy: null };
  url.searchParams.delete(field);
  if (url.href.length > 7000) {
    url.search = '';
    return { url: url.href, copy: text };
  }
  return { url: url.href, copy: description };
}

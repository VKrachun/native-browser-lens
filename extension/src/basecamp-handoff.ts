import { LensClient } from './lens-client';
import { basecampNotes, draftTarget } from './tracker-drafts';
import type { Review } from './protocol/Review';

type Part = { data: string } | { name: string; type: string } | { finish: true };
type DraftScope = typeof globalThis & { lensDraft?: { key: string; receive: (part: Part) => Promise<void> } };

const titleSelector = [
  'textarea[name="todo[content]"]', 'input[name="todo[content]"]',
  'textarea[name="todo[title]"]', 'input[name="todo[title]"]',
  'textarea[placeholder^="What needs to be done" i]', 'input[placeholder^="What needs to be done" i]',
].join(', ');

// This function runs in the extension's isolated world in the newly opened tab.
// Keep the form and its files together. A navigation or Turbo form swap invalidates both.
async function prepare(url: string, key: string, titleSelector: string): Promise<string> {
  if (location.href !== url) return 'Sign in to Basecamp and open the selected list, then try again.';
  const findTitle = () => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    titleSelector,
  );
  const findNotes = (form?: HTMLFormElement | null) => form?.querySelector<HTMLElement>(
    'trix-editor, lexxy-editor [contenteditable="true"]',
  );
  let title = findTitle();
  for (let i = 0; i < 50 && !findNotes(title?.form); i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    title = findTitle();
  }
  const field = title;
  const form = field?.form;
  const notes = findNotes(form);
  if (!field || !form || !notes) return 'Lens could not find the title and Notes on this Basecamp form.';
  const editor = notes;
  function assertBlank() {
    if (field!.value.trim() || editor.innerText.trim() || editor.querySelector('figure, action-text-attachment, [data-trix-attachment]'))
      throw new Error('This to-do already has content. Lens left it as you wrote it.');
  }
  try { assertBlank(); } catch (error) { return (error as Error).message; }

  let chunks: BlobPart[] = [];
  const files: File[] = [];
  (globalThis as DraftScope).lensDraft = { key, async receive(part) {
    if (location.href !== url || !form.isConnected || !field.isConnected || !notes.isConnected)
      throw new Error('The Basecamp draft changed. Open the handoff again.');
    if ('data' in part) {
      chunks.push(Uint8Array.from(atob(part.data), byte => byte.charCodeAt(0)));
    } else if ('name' in part) {
      files.push(new File(chunks, part.name, { type: part.type }));
      chunks = [];
    } else {
      assertBlank();
      const carrier = document.createElement('input');
      carrier.type = 'file';
      carrier.hidden = true;
      carrier.id = key;
      carrier.multiple = true;
      const data = new DataTransfer();
      for (const file of files) data.items.add(file);
      carrier.files = data.files;
      form.append(carrier);
    }
  }};
  return '';
}

// Call the same editor methods Basecamp uses when someone types or attaches a file.
// The page world supplies those methods. It receives only the finished files for this form.
async function fill(url: string, key: string, titleSelector: string, title: string, body: string): Promise<string> {
  if (location.href !== url) return 'The selected draft changed.';
  const carrier = document.getElementById(key) as HTMLInputElement | null;
  const form = carrier?.form;
  const files = Array.from(carrier?.files ?? []);
  carrier?.remove();
  if (!form) return 'The selected draft closed.';
  const field = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    titleSelector,
  );
  const trix = form.querySelector<HTMLElement & { editor: {
    insertString(text: string): void; insertFiles(files: File[]): void;
    setSelectedRange(end: number): void; getDocument(): { getLength(): number };
  } }>('trix-editor');
  const lexxy = form.querySelector<HTMLElement & { value: string; contents: {
    uploadFiles(files: File[]): void;
  } }>('lexxy-editor');
  const notes = trix ?? lexxy?.querySelector<HTMLElement>('[contenteditable=true]');
  if (!field || !notes || (!trix?.editor && !lexxy?.contents) ||
      (files.length && !trix?.editor?.insertFiles && !lexxy?.contents?.uploadFiles))
    return 'Lens could not recognize the Basecamp Notes editor. Your review is available to export.';
  if (field.value.trim() || notes.innerText.trim() || notes.querySelector('figure, action-text-attachment'))
    return 'This to-do already has content. Open an empty draft.';
  field.value = title;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  if (trix) {
    trix.editor.insertString(body);
    trix.editor.setSelectedRange(Math.max(0, trix.editor.getDocument().getLength() - 1));
    if (files.length) trix.editor.insertFiles(files);
  } else if (lexxy) {
    const block = document.createElement('div');
    for (const line of body.split('\n')) {
      const paragraph = document.createElement('p');
      if (line) paragraph.textContent = line;
      else paragraph.append(document.createElement('br'));
      block.append(paragraph);
    }
    lexxy.value = block.innerHTML;
    if (files.length) lexxy.contents.uploadFiles(files);
  }
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  let placed = false;
  // The files show in the editor at once, with a progress bar until Basecamp has them: a draft
  // saved before that loses them. Up to two minutes for the uploads.
  for (let i = 0; i < 1200; i++) {
    if (location.href !== url || !form.isConnected) break;
    const attachments = Array.from(notes.querySelectorAll('figure, action-text-attachment, [data-trix-attachment]'));
    placed = normalize(notes.innerText).includes(normalize(body)) &&
      files.every(file => attachments.some(node => node.textContent?.includes(file.name) ||
        node.getAttribute('filename') === file.name || node.getAttribute('data-trix-attachment')?.includes(file.name)));
    // Only a visible bar that is not full: an editor can keep a finished or hidden one.
    const uploading = Array.from(notes.querySelectorAll('progress')).some(bar =>
      !bar.hidden && bar.getClientRects().length > 0 && !(bar.hasAttribute('value') && bar.value >= bar.max));
    if (placed && !uploading) return '';
    if (!placed && i >= 50) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (placed) return 'The files still upload in the Basecamp tab. Wait until their progress bars are gone, then save the to-do.';
  return 'Check the open draft. Lens could not confirm all of the Notes and attachments.';
}

async function deliver(key: string, part: Part): Promise<string> {
  const draft = (globalThis as DraftScope).lensDraft;
  if (!draft || key !== draft.key) return 'The Basecamp tab changed before the handoff finished.';
  try { await draft.receive(part); return ''; }
  catch (error) { return (error as Error).message; }
}

export async function openBasecamp(address: string, review: Review, zip: boolean, video: boolean, includeVoice: boolean, status: (text: string) => void) {
  const requested = draftTarget('basecamp', address, '', '').url!;
  const expected = new URL(requested);
  const origins = [expected.origin + '/*'];
  // The old 3.basecamp.com links can open the same list on the current app domain.
  if (expected.hostname === '3.basecamp.com') origins.push('https://app.basecamp.com/*');
  const data = ['websiteContent', 'browsingActivity'];
  if (zip || video) data.push('websiteActivity');
  if (video && includeVoice) data.push('personallyIdentifyingInfo');
  const allowed = await browser.permissions.request({
    origins,
    ...(import.meta.env.FIREFOX ? { data_collection: data } : {}),
  });
  if (!allowed) throw new Error('Allow the requested access to share your selected review with Basecamp.');
  const tab = await browser.tabs.create({ url: requested, active: false });
  if (tab.id == null) throw new Error('Could not open the Basecamp draft.');
  const tabId = tab.id;
  const target = { tabId, frameIds: [0] };
  const key = crypto.randomUUID();
  let client: LensClient | undefined;
  try {
    let loaded = await browser.tabs.get(tabId);
    for (let i = 0; i < 150 && (loaded.status !== 'complete' || !loaded.url || loaded.url === 'about:blank'); i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      loaded = await browser.tabs.get(tabId);
    }
    const current = new URL(loaded.url || 'about:blank');
    if (!origins.includes(current.origin + '/*') || expected.pathname.replace(/\/$/, '') !== current.pathname.replace(/\/$/, '') ||
        expected.search !== current.search) {
      await browser.tabs.update(tabId, { active: true });
      throw new Error('Sign in to Basecamp and check the list address in Lens Settings, then try again.');
    }
    const url = current.href;
    const [ready] = await browser.scripting.executeScript({ target, func: prepare, args: [url, key, titleSelector] });
    if (ready?.result !== '') throw new Error(ready?.result || 'Could not open the Basecamp form.');
    async function send(part: Part) {
      const [ack] = await browser.scripting.executeScript({ target, func: deliver, args: [key, part] });
      if (ack?.result !== '') throw new Error(ack?.result || 'The Basecamp tab closed during the handoff.');
    }
    const captures: (number | null)[] = zip ? [null] : [];
    if (video) captures.push(...review.items.filter(item => item.recording).map(item => item.capture));
    if (captures.length) client = new LensClient();
    for (const capture of captures) {
      status(capture === null ? 'Preparing evidence ZIP…' : 'Rendering replay MP4…');
      let offset = 0;
      for (;;) {
        const chunk = await client!.request({ method: 'readAttachment', params: { review: review.id, capture, offset, includeVoice: capture !== null && includeVoice } });
        const length = atob(chunk.data).length;
        if (!length || offset + length > chunk.totalSize) throw new Error('Lens returned an incomplete attachment.');
        await send({ data: chunk.data });
        offset += length;
        if (offset === chunk.totalSize) break;
      }
      const stem = 'lens-review-' + review.id;
      await send(capture === null ? { name: stem + '-evidence.zip', type: 'application/zip' } :
        { name: stem + '-capture-' + capture + '.mp4', type: 'video/mp4' });
    }
    await send({ finish: true });
    // Browsers slow timers and skip frames in a background tab, and Basecamp's editors need both.
    await browser.tabs.update(tabId, { active: true });
    const [result] = await browser.scripting.executeScript({ target, world: 'MAIN', func: fill,
      args: [url, key, titleSelector, review.title.replace(/\s+/g, ' ').trim(), basecampNotes(review, zip)] });
    if (result?.result !== '') throw new Error(result?.result || 'Check the Notes and files in the open Basecamp draft.');
  } catch (error) {
    // Keep partial drafts accessible. An untouched sign-in tab can also be used for the retry.
    const message = (error as Error).message;
    throw new Error(message.includes('unknown variant') ? 'Update the Lens desktop app to attach files, or open a text-only draft.' : message);
  } finally {
    client?.disconnect();
    await browser.scripting.executeScript({ target, func: (token: string) => {
      const scope = globalThis as DraftScope;
      if (scope.lensDraft?.key === token) {
        delete scope.lensDraft;
        document.getElementById(token)?.remove();
      }
    }, args: [key] }).catch(() => {});
  }
}

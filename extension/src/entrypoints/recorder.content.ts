import { record } from '@rrweb/record';
import type { eventWithTime } from '@rrweb/types';
import { ActionRecorder, elementMap } from '@/collector/actions';
import { BLOCK_SELECTOR, scrubRecording } from '@/collector/recording';
import type { Action } from '@/protocol/Action';
import type { PageElement } from '@/protocol/PageElement';

/** A full DOM checkpoint this often, so a replay can start near any moment of the window. */
const CHECKOUT_MS = 60_000;
/** The page sends what it recorded this often; the background keeps the window across pages. */
const SEND_MS = 1000;
/** Elements named for marks; the daemon keeps at most 800. */
const MAX_ELEMENTS = 800;

export type RecorderRequest = { kind: 'lens-prepare' } | { kind: 'lens-snapshot' };
/** What the page holds for a capture: recording and steps not sent yet, and what is on screen. */
export interface Prepared {
  recording: eventWithTime[];
  pending: Action[];
  elements: PageElement[];
}
export type RecorderMessage =
  | { kind: 'lens-action'; action: Action }
  | { kind: 'lens-replay'; events: eventWithTime[] }
  | { kind: 'lens-should-record' };

// Started by the background (registration: 'runtime'): registered for the granted project sites at
// document_start, and injected into tabs that were open before. Started with the page, it records
// nothing until the background says the tab collects; on a no, it ends and forgets what it held.
export default defineContentScript({
  registration: 'runtime',
  main() {
    const scope = globalThis as typeof globalThis & { __lensRecorder?: boolean };
    if (scope.__lensRecorder) return;
    scope.__lensRecorder = true;

    /** Undefined while the background has not answered: everything waits in this page. */
    let allowed: boolean | undefined;
    let held: Action[] = [];
    let unsent: eventWithTime[] = [];
    const stopRecording = record({
      emit(event) {
        scrubRecording(event);
        unsent.push(event);
      },
      checkoutEveryNms: CHECKOUT_MS,
      // Typed values and editable text never leave the page. Hidden inputs, token meta tags and
      // marked elements are not recorded at all.
      maskAllInputs: true,
      maskTextSelector: '[contenteditable], [contenteditable] *',
      blockSelector: BLOCK_SELECTOR,
      recordCanvas: false,
      collectFonts: false,
      // Started at document_start: the first copy of the page as soon as its HTML is parsed.
      recordAfter: 'DOMContentLoaded',
    });

    // Steps go to the background as they happen, so they outlive this document.
    let collecting: Action[] | null = null;
    const steps = new ActionRecorder(document, (action) => {
      if (collecting) return void collecting.push(action);
      if (allowed === undefined) return void held.push(action);
      send({ kind: 'lens-action', action });
    });
    steps.start();
    // After the extension reloads or updates, this script stays without an extension: sending
    // then throws at once. It stops itself instead of failing on every event.
    const send = (message: RecorderMessage) => {
      try {
        if (!browser.runtime?.id) return retire();
        void browser.runtime.sendMessage(message).catch(() => {});
      } catch {
        retire();
      }
    };
    const sendReplay = () => {
      if (allowed !== true || !unsent.length) return;
      const events = unsent;
      unsent = [];
      send({ kind: 'lens-replay', events });
    };
    const timer = setInterval(sendReplay, SEND_MS);
    // A click that navigates ends this document before the next send: its last changes and steps
    // go now, while the page is still here.
    const leave = () => {
      steps.flushAll();
      sendReplay();
    };
    const hidden = () => document.visibilityState === 'hidden' && leave();
    addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hidden);
    function retire() {
      retired = true;
      browser.runtime.onMessage.removeListener(listen);
      clearInterval(timer);
      removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', hidden);
      steps.stop();
      stopRecording?.();
      unsent = [];
      held = [];
    }
    let retired = false;

    function listen(message: RecorderRequest, _sender: unknown, reply: (prepared: Prepared) => void) {
      if (retired) return;
      if (message?.kind === 'lens-snapshot') {
        // A session starts: its replay begins with a fresh copy of the page.
        // Before DOMContentLoaded rrweb has no copy yet, and its first one is fresh anyway.
        try {
          record.takeFullSnapshot(true);
        } catch {
          // Not recording yet.
        }
        return;
      }
      if (message?.kind !== 'lens-prepare') return;
      collecting = [];
      steps.flushAll();
      // Asked for a capture: the background collects here, so the steps held for its answer go too.
      const pending = [...held, ...collecting];
      held = [];
      collecting = null;
      const recording = unsent;
      unsent = [];
      reply({ recording, pending, elements: elementMap(document, MAX_ELEMENTS) } satisfies Prepared);
    }
    browser.runtime.onMessage.addListener(listen);

    const answer = (yes: unknown) => {
      if (retired) return;
      if (yes !== true) {
        // Not a page Lens collects on: nothing it held leaves, and a later start can run again.
        retire();
        scope.__lensRecorder = false;
        return;
      }
      allowed = true;
      for (const action of held) send({ kind: 'lens-action', action });
      held = [];
      sendReplay();
    };
    try {
      void browser.runtime.sendMessage({ kind: 'lens-should-record' } satisfies RecorderMessage).then(answer, () => answer(false));
    } catch {
      answer(false);
    }
  },
});

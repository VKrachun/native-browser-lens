// Properties for every extension page; Bombadil checks them while it clicks, types and reloads at random.
import { always, eventually, next, now } from "@antithesishq/bombadil";
import { actions, extract, getFingerprint, registerCustomAction, weighted } from "@antithesishq/bombadil/browser";
import { clicks, inputs, navigation, scroll, waitOnce } from "@antithesishq/bombadil/browser/defaults/actions";
export * from "@antithesishq/bombadil/browser/defaults/properties";

/** A page that is still loading after a reload offers nothing else to do: wait for it. */
const idle = extract(
  (state) =>
    state.document.readyState !== "complete" ||
    state.document.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), textarea, select").length === 0,
);
const keepWaiting = actions(() => (idle.current ? ["Wait"] : []));

/** The main button of a page (Record, Stop, Create review, File to VibeQ): the way forward. */
const primary = extract((state) =>
  Array.from(state.document.querySelectorAll(".btn-primary:not([disabled])"), (button) => {
    const box = button.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || box.bottom < 0 || box.top > state.window.innerHeight) return null;
    return { fingerprint: getFingerprint(button), point: { x: box.left + box.width / 2, y: box.top + box.height / 2 } };
  }).filter((target) => target !== null),
);
const primaryClicks = actions(() => primary.current.map((target) => ({ Click: target })));

// Bombadil closes every tab a page opens and drives one tab only. Lens opens its pages in new
// tabs (Stop opens the review, the review opens the replay), so these actions bring them here.

/** Moves the newest other Lens tab into this one: the review that Stop opened, the settings. */
const followNewTab = registerCustomAction("followNewTab", async (_document, window) => {
  const tabs = (window as unknown as { chrome: { tabs: any } }).chrome.tabs;
  const self = await tabs.getCurrent();
  const lens = `${window.location.origin}/`;
  const found = (await tabs.query({}))
    .filter((t: any) => t.id !== self?.id && (t.url || t.pendingUrl || "").startsWith(lens))
    .sort((a: any, b: any) => b.id - a.id)[0];
  if (!found) return;
  const url = found.url || found.pendingUrl;
  await tabs.remove(found.id);
  window.location.href = url;
});
const followTabs = actions(() => [followNewTab()]);

/** Opens a Lens link that would open a new tab ("Open replay and transcript") in this one. */
const newTabLinks = extract((state) =>
  Array.from(state.document.querySelectorAll('a[target="_blank"][href]'), (a) => (a as HTMLAnchorElement).href).filter((href) =>
    href.startsWith(`${state.window.location.origin}/`),
  ),
);
const openHere = registerCustomAction("openLinkHere", async (_document, window, href: string) => {
  window.location.href = href;
});
const openLinksHere = actions(() => newTabLinks.current.map((href) => openHere(href)));

/** Hand off needs a folder that exists; random text never is one. */
const hasFolderField = extract((state) => state.document.querySelector('input[aria-label="Project folder"]') !== null);
const chooseFolder = registerCustomAction("chooseProjectFolder", async (document, window) => {
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Project folder"]');
  if (!field) return;
  // React reads the value through the prototype's setter, then the input event.
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(field, "/tmp");
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
});
const chooseFolders = actions(() => (hasFolderField.current ? [chooseFolder()] : []));

/** Bombadil weighs exported generators equally, so there is one: the defaults first, then Lens's own. */
export const lensActions = weighted([
  [100, clicks],
  [100, inputs],
  [50, scroll],
  [10, navigation],
  [30, primaryClicks],
  [5, followTabs],
  [5, openLinksHere],
  [5, chooseFolders],
  [1, waitOnce],
  [1, keepWaiting],
]);

const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? null;

/** The notes editor (side panel and review page): its status and what it holds. */
const notes = extract((state) => {
  const box = state.document.querySelector(".notes");
  if (!box) return null;
  return {
    status: text(box.querySelector('[aria-label="Notes status"]')) ?? "",
    fields: Array.from(box.querySelectorAll("textarea, input"), (f) => (f as HTMLInputElement).value),
    tags: Array.from(box.querySelectorAll('[aria-label="Tags"] .tag-chip, [aria-label="Tags"] li'), (t) => t.textContent ?? ""),
  };
});
const lastAction = extract((state) => state.lastAction as unknown as string | Record<string, unknown> | null);
const waiting = extract((state) =>
  Array.from(state.document.querySelectorAll(".waiting"), (w) => w.textContent?.trim() ?? "").filter(Boolean),
);
const connection = extract((state) => text(state.document.querySelector('[role="status"][aria-label="Connection"]')));

/** A save never hangs. */
export const saveEnds = always(
  now(() => notes.current?.status === "Saving…").implies(
    eventually(() => notes.current?.status !== "Saving…").within(10, "seconds"),
  ),
);

/** A draft with a title is saved by itself, unless the person keeps typing. */
export const draftGetsSaved = always(
  now(() => notes.current?.status === "Unsaved changes").implies(
    eventually(() => notes.current?.status !== "Unsaved changes").within(20, "seconds"),
  ),
);

/** What the page calls saved is there again after a reload. */
export const savedSurvivesReload = always(() => {
  const before = notes.current;
  if (!before || before.status !== "Saved") return now(() => true);
  return next(() => {
    if (lastAction.current !== "Reload" || !notes.current) return true;
    return JSON.stringify(notes.current.fields) === JSON.stringify(before.fields);
  });
});

/** Nothing waits for ever. */
export const waitingEnds = always(
  now(() => waiting.current.length > 0).implies(eventually(() => waiting.current.length === 0).within(60, "seconds")),
);

/** A button that shows work in progress ("Filing…", "Drafting…", "Saving ZIP…") finishes it. */
const busy = extract((state) =>
  Array.from(state.document.querySelectorAll("button"), (b) => b.textContent?.trim() ?? "").filter((t) => t.endsWith("…")),
);
export const busyEnds = always(() => {
  const labels = busy.current;
  if (labels.length === 0) return now(() => true);
  return eventually(() => labels.every((label) => !busy.current.includes(label))).within(90, "seconds");
});

/** Messages shown to the person: no rule, but the trace keeps them to read after a run. */
const alerts = extract((state) =>
  Array.from(state.document.querySelectorAll('[role="alert"]'), (a) => a.textContent?.trim() ?? "").filter(Boolean),
);
/** What the review page says about filing, to follow a filing through the trace. */
const filingShown = extract((state) => ({
  filed: text(state.document.querySelector('[aria-label="Filing"] a')),
  earlier: text(state.document.querySelector('[aria-label="Filed earlier"]')),
  sirvantButton: Array.from(state.document.querySelectorAll("button"), (b) => b.textContent?.trim() ?? "").some((t) => t.includes("Sirvant")),
}));
export const alertsShown = always(() => alerts.current !== null && filingShown.current !== null);

/** The side panel finds the app again. */
export const connectionRecovers = always(
  now(() => connection.current !== null && !connection.current.startsWith("Connected")).implies(
    eventually(() => connection.current?.startsWith("Connected") ?? false).within(15, "seconds"),
  ),
);

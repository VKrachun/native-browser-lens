import type { Capture } from './protocol/Capture';
import type { CaptureMode } from './protocol/CaptureMode';

/** Side panel → background. */
export type BackgroundRequest =
  /** Record mode: everything from now until stopSession becomes one recording. */
  /** `voice`: Chrome records the microphone in the background's offscreen page. */
  /**
   * `videoMode`: Chrome also films the tab (canvas, WebGL, video that the DOM recording cannot
   * replay). The panel asks for the optional tabCapture permission first, in the click.
   */
  | { kind: 'startSession'; tabId: number; voice?: boolean; videoMode?: boolean }
  | { kind: 'stopSession'; tabId: number }
  /** A timestamped marker in the tab's running recording: "here it went wrong". */
  | { kind: 'dropMarker'; tabId: number; label?: string }
  /** Ends the recording without saving it: the way out when Stop cannot save it. */
  | { kind: 'discardSession'; tabId: number }
  | { kind: 'tabStatus'; tabId: number }
  | { kind: 'projectsChanged' }
  /** Re-enable Chrome's debugger after the person clicked Cancel on the debugging bar. */
  | { kind: 'resumeDebugger'; tabId: number }
  /** Whether the background's own connection to the app answers: true or false. */
  | { kind: 'lensReachable' };

export type CaptureResult = { ok: true; capture: Capture } | { ok: false; error: string };

export type SessionStart =
  | { ok: true; startedAt: number }
  /** `microphoneBlocked`: the person must allow the microphone in a tab first. */
  | { ok: false; error: string; microphoneBlocked?: boolean };

/** Background → the offscreen page (Chrome), which holds a session's microphone. */
export type OffscreenRequest =
  | { target: 'offscreen'; kind: 'mic-start' | 'mic-stop' | 'mic-cancel' | 'video-stop' | 'video-cancel' }
  | { target: 'offscreen'; kind: 'mic-part' | 'video-part'; id: number; offset: number }
  /** `streamId`: from tabCapture.getMediaStreamId in the background. */
  | { target: 'offscreen'; kind: 'video-start'; streamId: string };
/**
 * mic-stop gives the WAV's size and an id; mic-part then gives that WAV in base64 parts from
 * `offset` on. The id makes sure every part comes from the same WAV. The video (WebM) goes the
 * same way, its parts also in `wav`; `truncated` says it stopped at its size limit.
 */
export type OffscreenReply =
  | { ok: true; startedAt: number; size?: number; id?: number; wav?: string; truncated?: boolean }
  | { ok: false; error: string; blocked?: boolean };
/** One message carries at most 64 MiB: a long voice note goes in parts of this many bytes. */
export const OFFSCREEN_PART_BYTES = 8 * 1024 * 1024;

export interface TabStatus {
  /** The origin when the tab shows an http(s) page. */
  origin: string | null;
  projectId: number | null;
  /** Lens may read this origin (the person granted it). */
  permitted: boolean;
  /** Null when Lens is not collecting on this tab. */
  mode: CaptureMode | null;
  /** The person clicked Cancel on Chrome's debugging bar. */
  debuggerDeclined?: boolean;
  /** Collection is paused from the Lens menu. */
  paused: boolean;
  /** When a Record mode session started in this tab, if one runs. */
  session: number | null;
  /** The session records the microphone in the background (Chrome). */
  voice: boolean;
  /**
   * Whether the recorder runs in the page; null when Lens does not collect here. False on a page
   * that was open before its site was allowed and the browser kept the recorder out: a reload fixes it.
   */
  recorder: boolean | null;
  /** The page shows a large canvas or a video, which the DOM recording replays blank. */
  hasHeavyMedia?: boolean;
  /** The session also films the tab (Chrome). */
  videoMode?: boolean;
}

/** Background → every extension page. */
export type Broadcast =
  | { kind: 'captured'; capture: Capture }
  | { kind: 'annotated'; capture: Capture }
  | { kind: 'tabChanged'; tabId: number };

/**
 * The reply, or undefined when no part of the extension answered (the background was restarting):
 * a caller that reads `ok` uses NO_ANSWER then.
 */
export function send<T>(request: BackgroundRequest): Promise<T | undefined> {
  return browser.runtime.sendMessage(request) as Promise<T | undefined>;
}

export const NO_ANSWER: { ok: false; error: string; microphoneBlocked?: boolean } = {
  ok: false,
  error: 'Lens did not answer in the browser; try again',
};

/**
 * The permission pattern Lens asks for to collect on a site. Firefox grants nothing to scripts for
 * a pattern with a port (the recorder never ran on localhost:3000), so there it is the host on
 * every port. Lens still collects only on the project's exact origins.
 */
export function sitePattern(origin: string): string {
  if (!import.meta.env.FIREFOX) return `${origin}/*`;
  const { protocol, hostname } = new URL(origin);
  return `${protocol}//${hostname}/*`;
}

export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

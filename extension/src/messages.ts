import type { Capture } from './protocol/Capture';
import type { CaptureMode } from './protocol/CaptureMode';

/** Side panel → background. */
export type BackgroundRequest =
  | { kind: 'capture'; tabId: number; observation: number | null }
  /** Record mode: everything from now until stopSession becomes one recording. */
  /** `voice`: Chrome records the microphone in the background's offscreen page. */
  | { kind: 'startSession'; tabId: number; voice?: boolean }
  | { kind: 'stopSession'; tabId: number }
  | { kind: 'tabStatus'; tabId: number }
  | { kind: 'projectsChanged' }
  /** Whether the background's own connection to the app answers: true or false. */
  | { kind: 'lensReachable' };

export type CaptureResult = { ok: true; capture: Capture } | { ok: false; error: string };

export type SessionStart =
  | { ok: true; startedAt: number }
  /** `microphoneBlocked`: the person must allow the microphone in a tab first. */
  | { ok: false; error: string; microphoneBlocked?: boolean };

/** Background → the offscreen page (Chrome), which holds a session's microphone. */
export type OffscreenRequest =
  | { target: 'offscreen'; kind: 'mic-start' | 'mic-stop' | 'mic-cancel' }
  | { target: 'offscreen'; kind: 'mic-part'; id: number; offset: number };
/**
 * mic-stop gives the WAV's size and an id; mic-part then gives that WAV in base64 parts from
 * `offset` on. The id makes sure every part comes from the same WAV.
 */
export type OffscreenReply =
  | { ok: true; startedAt: number; size?: number; id?: number; wav?: string }
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
  /** Collection is paused from the Lens menu. */
  paused: boolean;
  /** When a Record mode session started in this tab, if one runs. */
  session: number | null;
  /** The session records the microphone in the background (Chrome). */
  voice: boolean;
}

/** Background → every extension page. */
export type Broadcast =
  | { kind: 'captured'; capture: Capture }
  | { kind: 'annotated'; capture: Capture }
  | { kind: 'tabChanged'; tabId: number };

export function send<T>(request: BackgroundRequest): Promise<T> {
  return browser.runtime.sendMessage(request) as Promise<T>;
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

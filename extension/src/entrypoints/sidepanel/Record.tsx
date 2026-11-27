import { useEffect, useRef, useState } from 'react';
import type { LensClient } from '@/lens-client';
import { NO_ANSWER, send, type CaptureResult, type RecordedVideoRef, type SessionStart, type TabStatus } from '@/messages';
import { MicIcon, StopIcon } from '@/ui/icons';
import { recordTabVideo, VideoCancelled, type RecordedVideo, type VideoRecording } from '@/video';
import { MicrophoneBlocked, record, toWav, type Recording } from '@/voice';
import { purge, spool, spooled, unspool } from '@/voice-spool';
import type { SpeechStatus } from '@/protocol/SpeechStatus';
import { ModelNotice } from './Voice';

type Kept = { wav: Blob; startedAt: number; tab: number; session: number };

/** The voice a closed panel left for this recording, as a WAV; null when none. */
async function fromSpool(tab: number, session: number): Promise<Kept | null> {
  const found = await spooled(tab, session);
  if (!found?.parts.length) return null;
  const wav = found.type === 'audio/wav' ? found.parts[0]! : await toWav(new Blob(found.parts, { type: found.type })).catch(() => null);
  return wav && { wav, startedAt: found.startedAt, tab, session };
}

/** The default shortcut with Alt, Shift and this key, as the keyboard shows it. */
export const shortcut = (key: string) => (navigator.userAgent.includes('Mac') ? ['⌥', '⇧', key] : ['Alt', 'Shift', key]);
export const shortcutText = (key: string) => shortcut(key).join(navigator.userAgent.includes('Mac') ? '' : '+');

/** The keys of a shortcut inside a button; hidden from its accessible name. */
export function Keys({ letter }: { letter: string }) {
  return (
    <span className="keys" aria-hidden="true">
      {shortcut(letter).map((k) => (
        <kbd key={k} className="kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Firefox takes a tab screenshot only with access to all sites (or right after a toolbar click). Without
 * it, the Lens app renders the screenshots from the replay; the grant stays optional, offered here once.
 * Lens still collects only on the sites the person adds.
 */
const ALL_SITES = { origins: ['<all_urls>'] };
export function ScreenNotice() {
  const [seen, setSeen] = useStored('lens.screenNotice', false);
  const [granted, setGranted] = useState(true);
  useEffect(() => {
    if (import.meta.env.FIREFOX) void browser.permissions.contains(ALL_SITES).then(setGranted, () => {});
  }, []);
  if (!import.meta.env.FIREFOX || granted || seen) return null;
  return (
    <div role="note" className="notice" data-tone="info">
      <span>
        Screenshots: Firefox takes them only with access to all sites. Without it, the Lens app makes them from the
        replay. Lens still collects only on the sites you add.{' '}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={async () => {
            // The first await of the click: Firefox asks only during the person's gesture.
            setGranted(await browser.permissions.request(ALL_SITES).catch(() => false));
            setSeen(true);
          }}
        >
          Allow
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSeen(true)}>
          Not now
        </button>
      </span>
    </div>
  );
}

/** A setting kept in the browser profile; stays in sync across already-open extension tabs. */
export function useStored<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState(initial);
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    let alive = true;
    void browser.storage.local
      .get(key)
      .then((found) => alive && found[key] !== undefined && setValue(found[key] as T))
      .catch(() => {});
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local' || !(key in changes)) return;
      const next = changes[key]?.newValue;
      setValue(next === undefined ? initialRef.current : (next as T));
    };
    browser.storage.onChanged?.addListener(onChanged);
    return () => {
      alive = false;
      browser.storage.onChanged?.removeListener(onChanged);
    };
  }, [key]);
  return [value, (next: T) => (setValue(next), void browser.storage.local.set({ [key]: next }).catch(() => {}))];
}

/**
 * Record mode: Record starts a session in this tab (and the microphone, when chosen); Stop saves
 * everything since as one recording and opens it for review.
 */
export function RecordControls({
  client,
  tabId,
  site,
  onProblem,
}: {
  client: LensClient;
  tabId: number | null;
  site: TabStatus | null;
  onProblem: (message: string | null) => void;
}) {
  const [voice, setVoice] = useStored('lens.voice', true);
  /** Also film the tab via getDisplayMedia, for canvas, WebGL and video that the DOM recording replays blank. */
  const [videoMode, setVideoMode] = useStored('lens.videoMode', false);
  const [notice, setNotice] = useState<string | null>(null);
  const [marked, setMarked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  /** Firefox: the panel's one microphone, and the tab whose recording it belongs to. */
  const microphone = useRef<Recording | null>(null);
  const microphoneTab = useRef<number | null>(null);
  /** The tab video recorded in the panel via getDisplayMedia, and which tab it belongs to. */
  const videoRec = useRef<VideoRecording | null>(null);
  const videoTab = useRef<number | null>(null);
  const keptVideo = useRef<{ film: RecordedVideo; tab: number; session: number } | null>(null);
  /** The voice of a Stop that the app did not take: the next Stop in that tab saves it. */
  const keptVoice = useRef<Kept | null>(null);
  /** The recording the panel's microphone spools for, once the background named it. */
  const spoolFor = useRef<number | null>(null);
  const spoolFailed = useRef(false);
  const running = site?.session ?? null;
  /** The recording whose Stop failed: it can then be discarded, after a second click to confirm. */
  const [failedStop, setFailedStop] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // A confirmation belongs to one recording in one tab.
  useEffect(() => setConfirmDiscard(false), [tabId, running]);
  // With the voice on, the speech model must be there to write it down: offer it here, once.
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const downloading = speech?.model.state === 'downloading';
  useEffect(() => {
    if (!voice) return;
    let alive = true;
    const load = () =>
      client
        .request({ method: 'speechStatus' })
        .then((s) => alive && setSpeech(s))
        .catch(() => {});
    void load();
    const timer = downloading ? setInterval(load, 1000) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, voice, downloading]);

  useEffect(() => {
    if (running === null) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  // Firefox: if the session stopped externally (e.g. Alt+Shift+R shortcut) while the sidebar held the mic,
  // release the microphone so the browser mic indicator does not stay stuck on.
  useEffect(() => {
    if (running !== null || tabId === null) return;
    if (microphoneTab.current === tabId && microphone.current) {
      microphone.current.cancel();
      microphone.current = microphoneTab.current = null;
    }
    if (videoTab.current === tabId && videoRec.current) {
      videoRec.current.cancel();
      videoRec.current = videoTab.current = null;
    }
  }, [running, tabId]);

  // Firefox only: closing the panel ends its microphone; the session keeps running in the tab, and
  // the voice so far waits in the spool for its Stop. Chrome records the voice in the background,
  // so it survives the panel.
  useEffect(() => () => (microphone.current?.cancel(), videoRec.current?.cancel()), []);
  const inBackground = !import.meta.env.FIREFOX;

  // One start at a time: a second click while the first starts would start the microphone again,
  // and the second start cancels the first one's voice.
  async function start() {
    if (busy || tabId === null) return;
    setBusy(true);
    let film: VideoRecording | null = null;
    try {
      // The first await of the click: browsers open the screen-share picker only during a user gesture.
      if (videoMode) {
        try {
          film = await recordTabVideo();
          setNotice(null);
        } catch (error) {
          setNotice(
            error instanceof VideoCancelled
              ? 'No tab video: screen sharing was cancelled. Lens records the page and steps.'
              : `No tab video: ${(error as Error).message}. Lens records the page and steps.`,
          );
        }
      } else {
        setNotice(null);
      }
      await begin(film);
    } finally {
      setBusy(false);
    }
  }

  async function mark() {
    if (tabId === null) return;
    const reply = (await send<{ ok: boolean; error?: string }>({ kind: 'dropMarker', tabId })) ?? NO_ANSWER;
    if (!reply.ok) return onProblem(`The marker was not added: ${reply.error}`);
    setMarked(true);
  }
  useEffect(() => {
    if (!marked) return;
    const timer = setTimeout(() => setMarked(false), 1500);
    return () => clearTimeout(timer);
  }, [marked]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function begin(film: VideoRecording | null) {
    if (tabId === null) {
      film?.cancel();
      return;
    }
    onProblem(null);
    if (voice && !inBackground) {
      // One microphone: a recording with voice in another tab keeps it until its Stop.
      if (microphone.current && microphoneTab.current !== tabId) {
        film?.cancel();
        return onProblem('Stop the recording in the other tab first: it is using the microphone.');
      }
      try {
        // Earlier recordings of this tab are over: their voice can only be stale now.
        await purge((entry) => entry.tab !== tabId);
        const tab = tabId;
        spoolFor.current = null;
        spoolFailed.current = false;
        microphone.current = await record((parts, type, startedAt) => {
          const session = spoolFor.current;
          if (session === null) return;
          spool({ tab, session, startedAt, type, parts }).catch((error: Error) => {
            if (spoolFailed.current) return;
            spoolFailed.current = true;
            onProblem(`Keep this panel open until Stop: the browser does not keep your voice (${error.message}).`);
          });
        });
        microphoneTab.current = tabId;
      } catch (error) {
        film?.cancel();
        if (error instanceof MicrophoneBlocked) {
          await browser.tabs.create({ url: browser.runtime.getURL('/microphone.html') });
          return onProblem('Allow the microphone in the tab that opened, then press Record again.');
        }
        return onProblem(`The microphone did not start: ${(error as Error).message}`);
      }
    }
    const started = (await send<SessionStart>({ kind: 'startSession', tabId, voice: voice && inBackground })) ?? NO_ANSWER;
    if (!started.ok) {
      film?.cancel();
      if (microphoneTab.current === tabId) {
        microphone.current?.cancel();
        microphone.current = microphoneTab.current = null;
      }
      if (started.microphoneBlocked) {
        await browser.tabs.create({ url: browser.runtime.getURL('/microphone.html') });
        return onProblem('Allow the microphone in the tab that opened, then press Record again.');
      }
      return onProblem(started.error);
    }
    if (film) {
      videoRec.current?.cancel();
      videoRec.current = film;
      videoTab.current = tabId;
    }
    if (microphoneTab.current === tabId) spoolFor.current = started.startedAt;
    setNow(Date.now());
  }

  async function stop() {
    if (tabId === null || running === null) return;
    const session = running;
    setBusy(true);
    setConfirmDiscard(false);
    const mine = microphoneTab.current === tabId;
    const spoken = mine ? microphone.current : null;
    if (mine) microphone.current = microphoneTab.current = null;
    const mineVideo = videoTab.current === tabId;
    const activeVideo = mineVideo ? videoRec.current : null;
    if (mineVideo) videoRec.current = videoTab.current = null;
    try {
      const mineKept = keptVoice.current?.tab === tabId && keptVoice.current.session === session;
      const kept = mineKept ? keptVoice.current : spoken ? null : await fromSpool(tabId, session);
      const mineKeptVideo = keptVideo.current?.tab === tabId && keptVideo.current.session === session;
      const film = mineKeptVideo ? keptVideo.current!.film : activeVideo ? await activeVideo.stop().catch(() => null) : null;
      let uploadedVideo: RecordedVideoRef | null = null;
      if (film) {
        const blob = await client
          .upload(film.webm, 'video/webm' as Parameters<LensClient['upload']>[1])
          .catch(() => null);
        if (blob) uploadedVideo = { blob, startedAt: film.startedAt, truncated: film.truncated };
        else keptVideo.current = { film, tab: tabId, session };
      }
      let decodeVoiceError: string | null = null;
      const [result, wav] = await Promise.all([
        send<CaptureResult>({ kind: 'stopSession', tabId, video: uploadedVideo }).then((reply) => reply ?? NO_ANSWER),
        kept
          ? Promise.resolve(kept.wav)
          : spoken
            ? spoken.stop().catch((error: Error) => {
                decodeVoiceError = error.message;
                return null;
              })
            : Promise.resolve(null),
      ]);
      const startedAt = kept?.startedAt ?? spoken?.startedAt;
      if (!result.ok) {
        setFailedStop(session);
        if (film) keptVideo.current = { film, tab: tabId, session };
        // The background keeps the session; the voice waits here for Stop again.
        if (wav && startedAt !== undefined) {
          keptVoice.current = { wav, startedAt, tab: tabId, session };
          // Also past this panel: closing it before Stop again keeps the voice.
          const kept = spool({ tab: tabId, session, startedAt, type: 'audio/wav', parts: [wav] }).then(
            () => '',
            (error: Error) => ` Keep this panel open: the browser does not keep your voice (${error.message}).`,
          );
          return onProblem(`The recording was not saved: ${result.error}${await kept}`);
        }
        return onProblem(`The recording was not saved: ${result.error}`);
      }
      if (kept) keptVoice.current = null;
      if (film) keptVideo.current = null;
      setFailedStop(null);
      // The recording is saved: a voice note that fails says so, and the review still opens.
      let voiceProblem: string | null = result.voiceError ?? null;
      if (decodeVoiceError) {
        voiceProblem = `The recording is saved, but its voice note could not be decoded: ${decodeVoiceError}`;
      }
      try {
        if (wav && startedAt !== undefined) {
          const audio = await client.upload(wav, 'audio/wav');
          await client.request({
            method: 'addVoiceNote',
            params: { observation: result.capture.observation, startedAt, audio },
          });
        }
        await unspool(tabId, session).catch(() => {});
      } catch (error) {
        // The voice stays in the browser's spool; only the voice note is missing.
        voiceProblem = `The recording is saved, but its voice note is not: ${(error as Error).message}`;
      }
      onProblem(voiceProblem);
      const nextPage = result.capture.recording
        ? `/replay.html?capture=${result.capture.id}`
        : `/review.html?observation=${result.capture.observation}`;
      await browser.tabs.create({
        url: browser.runtime.getURL(nextPage as '/'),
        active: true,
      });
    } catch (error) {
      onProblem(`The recording was not saved: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  /** The way out when Stop cannot save: the recording and its voice go, the tab collects on. */
  async function discard() {
    if (tabId === null || running === null) return;
    if (!confirmDiscard) return setConfirmDiscard(true);
    setBusy(true);
    try {
      // The voice goes only once the background confirms: else Stop again can still save it.
      const done = (await send<{ ok: boolean; error?: string }>({ kind: 'discardSession', tabId })) ?? NO_ANSWER;
      if (!done.ok) return onProblem(`The recording was not discarded: ${done.error}`);
      if (microphoneTab.current === tabId) {
        microphone.current?.cancel();
        microphone.current = microphoneTab.current = null;
      }
      if (videoTab.current === tabId) {
        videoRec.current?.cancel();
        videoRec.current = videoTab.current = null;
      }
      keptVoice.current = null;
      keptVideo.current = null;
      await unspool(tabId, running).catch(() => {});
      setFailedStop(null);
      onProblem(null);
    } catch (error) {
      onProblem(`The recording was not discarded: ${(error as Error).message}`);
    } finally {
      setConfirmDiscard(false);
      setBusy(false);
    }
  }

  if (running !== null) {
    return (
      <div className="record-live">
        <span className="rec-dot" aria-hidden="true" />
        <span className="record-time num">{clock(now - running)}</span>
        {/* The status is what is recorded, not the clock: a ticking live region reads out every second. */}
        <span className="small muted record-what" role="status" aria-label="Recording">
          {microphone.current || keptVoice.current || site?.voice ? 'Screen, steps and your voice' : 'Screen and steps'}
          {(videoTab.current === tabId || keptVideo.current?.tab === tabId) && ' · video'}
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm record-mark"
          title={`Drop a marker (${shortcutText('M')})`}
          onClick={() => void mark()}
        >
          {marked ? 'Marked ✓' : 'Mark'}
        </button>
        {failedStop === running && (
          <button type="button" className="btn btn-ghost" onClick={() => void discard()} disabled={busy}>
            {confirmDiscard ? 'Discard it for good' : 'Discard recording'}
          </button>
        )}
        <button
          type="button"
          className="btn btn-danger"
          title={`Stop and save (${shortcutText('R')})`}
          onClick={() => void stop()}
          disabled={busy}
        >
          <StopIcon />
          {busy ? 'Saving…' : failedStop === running ? 'Stop again' : 'Stop'}
        </button>
        {notice && (
          <span className="small muted record-notice" role="note">
            {notice}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="record-start">
      {site?.recorder === false && tabId !== null && (
        <div role="note" className="notice" data-tone="warning">
          <span>
            Reload this page to record it: it was open before Lens could read this site, so the browser keeps the
            recorder out until it loads again.{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void browser.tabs.reload(tabId)}>
              Reload
            </button>
          </span>
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
        <span>
          <MicIcon size={14} /> Record my voice
        </span>
      </label>
      {voice && speech && speech.model.state !== 'ready' && (
        <ModelNotice
          speech={speech}
          onInstall={() => client.request({ method: 'installSpeech' }).then(setSpeech)}
          onCancel={() => client.request({ method: 'cancelSpeechDownload' }).then(setSpeech)}
        />
      )}
      <label className="check">
        <input type="checkbox" checked={videoMode} onChange={(e) => setVideoMode(e.target.checked)} />
        <span>
          Video mode
          <span className="small muted" style={{ display: 'block' }}>
            Record tab video for canvas, WebGL and video (keep panel open)
          </span>
        </span>
      </label>
      {!videoMode && site?.hasHeavyMedia && (
        <p className="small muted record-hint" role="note">
          Canvas or video detected on this page — turn on Video mode to capture pixels.
        </p>
      )}
      <button
        type="button"
        className="btn btn-primary btn-lg btn-block record-go"
        onClick={() => void start()}
        disabled={!site?.mode || busy}
        title={`Record (${shortcutText('R')})`}
      >
        <span className="rec-dot rec-dot-still" aria-hidden="true" />
        Record
        <Keys letter="R" />
      </button>
    </div>
  );
}

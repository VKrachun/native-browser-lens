import { useEffect, useRef, useState } from 'react';
import type { LensClient } from '@/lens-client';
import { NO_ANSWER, send, type CaptureResult, type SessionStart, type TabStatus } from '@/messages';
import { MicIcon, StopIcon } from '@/ui/icons';
import { MicrophoneBlocked, record, toWav, type Recording } from '@/voice';
import { purge, spool, spooled, unspool } from '@/voice-spool';
import type { SpeechStatus } from '@/protocol/SpeechStatus';
import { ModelNotice } from './Voice';

export type PanelMode = 'record' | 'capture';

type Kept = { wav: Blob; startedAt: number; tab: number; session: number };

/** The voice a closed panel left for this recording, as a WAV; null when none. */
async function fromSpool(tab: number, session: number): Promise<Kept | null> {
  const found = await spooled(tab, session);
  if (!found?.parts.length) return null;
  const wav = found.type === 'audio/wav' ? found.parts[0]! : await toWav(new Blob(found.parts, { type: found.type })).catch(() => null);
  return wav && { wav, startedAt: found.startedAt, tab, session };
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

/** A setting kept in the browser profile; it never matters enough to fail over. */
export function useStored<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    void browser.storage.local
      .get(key)
      .then((found) => found[key] !== undefined && setValue(found[key] as T))
      .catch(() => {});
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
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  /** Firefox: the panel's one microphone, and the tab whose recording it belongs to. */
  const microphone = useRef<Recording | null>(null);
  const microphoneTab = useRef<number | null>(null);
  /** The voice of a Stop that the app did not take: the next Stop in that tab saves it. */
  const keptVoice = useRef<Kept | null>(null);
  /** The recording the panel's microphone spools for, once the background named it. */
  const spoolFor = useRef<number | null>(null);
  const spoolFailed = useRef(false);
  const running = site?.session ?? null;
  /** The recording whose Stop failed: it can then be discarded, after a second click to confirm. */
  const [failedStop, setFailedStop] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
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

  // Firefox only: closing the panel ends its microphone; the session keeps running in the tab, and
  // the voice so far waits in the spool for its Stop. Chrome records the voice in the background,
  // so it survives the panel.
  useEffect(() => () => microphone.current?.cancel(), []);
  const inBackground = !import.meta.env.FIREFOX;

  // One start at a time: a second click while the first starts would start the microphone again,
  // and the second start cancels the first one's voice.
  async function start() {
    if (busy) return;
    setBusy(true);
    try {
      await begin();
    } finally {
      setBusy(false);
    }
  }

  async function begin() {
    if (tabId === null) return;
    onProblem(null);
    if (voice && !inBackground) {
      // One microphone: a recording with voice in another tab keeps it until its Stop.
      if (microphone.current && microphoneTab.current !== tabId)
        return onProblem('Stop the recording in the other tab first: it is using the microphone.');
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
        if (error instanceof MicrophoneBlocked) {
          await browser.tabs.create({ url: browser.runtime.getURL('/microphone.html') });
          return onProblem('Allow the microphone in the tab that opened, then press Record again.');
        }
        return onProblem(`The microphone did not start: ${(error as Error).message}`);
      }
    }
    const started = (await send<SessionStart>({ kind: 'startSession', tabId, voice: voice && inBackground })) ?? NO_ANSWER;
    if (!started.ok) {
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
    if (microphoneTab.current === tabId) spoolFor.current = started.startedAt;
    setNow(Date.now());
  }

  async function stop() {
    if (tabId === null || running === null) return;
    const session = running;
    setBusy(true);
    const mine = microphoneTab.current === tabId;
    const spoken = mine ? microphone.current : null;
    if (mine) microphone.current = microphoneTab.current = null;
    try {
      const mineKept = keptVoice.current?.tab === tabId && keptVoice.current.session === session;
      const kept = mineKept ? keptVoice.current : spoken ? null : await fromSpool(tabId, session);
      const [result, wav] = await Promise.all([
        send<CaptureResult>({ kind: 'stopSession', tabId }).then((reply) => reply ?? NO_ANSWER),
        kept ? Promise.resolve(kept.wav) : spoken ? spoken.stop() : Promise.resolve(null),
      ]);
      const startedAt = kept?.startedAt ?? spoken?.startedAt;
      if (!result.ok) {
        setFailedStop(session);
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
      setFailedStop(null);
      try {
        if (wav && startedAt !== undefined) {
          const audio = await client.upload(wav, 'audio/wav');
          await client.request({
            method: 'addVoiceNote',
            params: { observation: result.capture.observation, startedAt, audio },
          });
        }
      } finally {
        // The recording is saved: its voice, attached or not, belongs to no later recording.
        await unspool(tabId, session);
      }
      onProblem(null);
      await browser.tabs.create({
        url: browser.runtime.getURL(`/review.html?observation=${result.capture.observation}`),
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
      if (microphoneTab.current === tabId) {
        microphone.current?.cancel();
        microphone.current = microphoneTab.current = null;
      }
      keptVoice.current = null;
      await send({ kind: 'discardSession', tabId });
      await unspool(tabId, running).catch(() => {});
      setFailedStop(null);
      onProblem(null);
    } finally {
      setConfirmDiscard(false);
      setBusy(false);
    }
  }

  if (running !== null) {
    return (
      <div className="record-live" role="status" aria-label="Recording">
        <span className="rec-dot" aria-hidden="true" />
        <span className="record-time num">{clock(now - running)}</span>
        <span className="small muted record-what">
          {microphone.current || keptVoice.current || site?.voice ? 'Screen, steps and your voice' : 'Screen and steps'}
        </span>
        {failedStop === running && (
          <button type="button" className="btn btn-ghost" onClick={() => void discard()} disabled={busy}>
            {confirmDiscard ? 'Discard it for good' : 'Discard recording'}
          </button>
        )}
        <button type="button" className="btn btn-danger" onClick={() => void stop()} disabled={busy}>
          <StopIcon />
          {busy ? 'Saving…' : failedStop === running ? 'Stop again' : 'Stop'}
        </button>
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
        <ModelNotice speech={speech} onInstall={() => void client.request({ method: 'installSpeech' }).then(setSpeech)} />
      )}
      <button
        type="button"
        className="btn btn-primary btn-lg btn-block"
        onClick={() => void start()}
        disabled={!site?.mode || busy}
      >
        <span className="rec-dot rec-dot-still" aria-hidden="true" />
        Record
      </button>
    </div>
  );
}

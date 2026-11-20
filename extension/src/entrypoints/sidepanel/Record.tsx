import { useEffect, useRef, useState } from 'react';
import type { LensClient } from '@/lens-client';
import { send, type CaptureResult, type SessionStart, type TabStatus } from '@/messages';
import { MicIcon, StopIcon } from '@/ui/icons';
import { MicrophoneBlocked, record, type Recording } from '@/voice';
import type { SpeechStatus } from '@/protocol/SpeechStatus';
import { ModelNotice } from './Voice';

export type PanelMode = 'record' | 'capture';

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Firefox takes a tab screenshot only with access to all sites; a granted site is not enough.
 * `ensure` asks once, and must be the first await of a click handler, while the click counts as
 * the person's gesture. Lens still collects only on the sites the person adds.
 */
const ALL_SITES = { origins: ['<all_urls>'] };
export function useScreenAccess(): () => Promise<boolean> {
  const granted = useRef(!import.meta.env.FIREFOX);
  useEffect(() => {
    if (import.meta.env.FIREFOX) void browser.permissions.contains(ALL_SITES).then((yes) => (granted.current = yes));
  }, []);
  return async () => {
    if (granted.current) return true;
    granted.current = await browser.permissions.request(ALL_SITES).catch(() => false);
    return granted.current;
  };
}
export const SCREEN_ACCESS_REFUSED =
  'Firefox lets Lens take screenshots only with access to all sites. Lens still collects only on the sites you add. Allow it and press again.';

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
  const keptVoice = useRef<{ wav: Blob; startedAt: number; tab: number } | null>(null);
  const running = site?.session ?? null;
  const screenAccess = useScreenAccess();
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

  // Firefox only: closing the panel ends its microphone; the session keeps running in the tab.
  // Chrome records the voice in the background, so it survives the panel.
  useEffect(() => () => microphone.current?.cancel(), []);
  const inBackground = !import.meta.env.FIREFOX;

  async function start() {
    if (tabId === null) return;
    if (!(await screenAccess())) return onProblem(SCREEN_ACCESS_REFUSED);
    onProblem(null);
    if (voice && !inBackground) {
      // One microphone: a recording with voice in another tab keeps it until its Stop.
      if (microphone.current && microphoneTab.current !== tabId)
        return onProblem('Stop the recording in the other tab first: it is using the microphone.');
      try {
        microphone.current = await record();
        microphoneTab.current = tabId;
      } catch (error) {
        if (error instanceof MicrophoneBlocked) {
          await browser.tabs.create({ url: browser.runtime.getURL('/microphone.html') });
          return onProblem('Allow the microphone in the tab that opened, then press Record again.');
        }
        return onProblem(`The microphone did not start: ${(error as Error).message}`);
      }
    }
    const started = await send<SessionStart>({ kind: 'startSession', tabId, voice: voice && inBackground });
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
    setNow(Date.now());
  }

  async function stop() {
    if (tabId === null) return;
    if (!(await screenAccess())) return onProblem(SCREEN_ACCESS_REFUSED);
    setBusy(true);
    const mine = microphoneTab.current === tabId;
    const spoken = mine ? microphone.current : null;
    if (mine) microphone.current = microphoneTab.current = null;
    try {
      const kept = keptVoice.current?.tab === tabId ? keptVoice.current : null;
      const [result, wav] = await Promise.all([
        send<CaptureResult>({ kind: 'stopSession', tabId }),
        kept ? Promise.resolve(kept.wav) : spoken ? spoken.stop() : Promise.resolve(null),
      ]);
      const startedAt = kept?.startedAt ?? spoken?.startedAt;
      if (!result.ok) {
        // The background keeps the session; the voice waits here for Stop again.
        if (wav && startedAt !== undefined) keptVoice.current = { wav, startedAt, tab: tabId };
        return onProblem(`The recording was not saved: ${result.error}`);
      }
      if (kept) keptVoice.current = null;
      if (wav && startedAt !== undefined) {
        const audio = await client.upload(wav, 'audio/wav');
        await client.request({
          method: 'addVoiceNote',
          params: { observation: result.capture.observation, startedAt, audio },
        });
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

  if (running !== null) {
    return (
      <div className="record-live" role="status" aria-label="Recording">
        <span className="rec-dot" aria-hidden="true" />
        <span className="record-time num">{clock(now - running)}</span>
        <span className="small muted record-what">
          {microphone.current || keptVoice.current || site?.voice ? 'Screen, steps and your voice' : 'Screen and steps'}
        </span>
        <button type="button" className="btn btn-danger" onClick={() => void stop()} disabled={busy}>
          <StopIcon />
          {busy ? 'Saving…' : 'Stop'}
        </button>
      </div>
    );
  }
  return (
    <div className="record-start">
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

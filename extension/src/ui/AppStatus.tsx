import { useEffect, useRef, useState } from 'react';
import { LensClient, LensError } from '@/lens-client';
import { AlertIcon } from './icons';

const EVERY_MS = 10_000;
/** After failures the page asks less often, up to once a minute; Try again asks at once. */
const AT_MOST_EVERY_MS = 60_000;
const ANSWER_WITHIN_MS = 8_000;

/**
 * Says so when the Lens app does not answer, on every page that needs it. It asks the app on a
 * connection of its own, so a long request of the page never reads as an app that is down. A
 * new connection starts the app when it is installed but not running, unless the person quit it.
 */
export function AppStatus({ onBack }: { onBack?: () => void }) {
  const [down, setDown] = useState<string | null>(null);
  /** The person quit the app (the host said so): the banner says that, not that it failed. */
  const [quit, setQuit] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  // When the app answers again after it was down, the page catches up: by default it loads again.
  const wasDown = useRef(false);
  const back = useRef(onBack ?? (() => location.reload()));
  useEffect(() => {
    if (down) wasDown.current = true;
    else if (wasDown.current) {
      wasDown.current = false;
      back.current();
    }
  }, [down]);

  useEffect(() => {
    const lens = new LensClient();
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const check = async () => {
      let late: ReturnType<typeof setTimeout> | undefined;
      if (alive) setChecking(true);
      try {
        await Promise.race([
          lens.request({ method: 'hello' }),
          new Promise((_, fail) => {
            late = setTimeout(() => fail(new Error('it does not answer')), ANSWER_WITHIN_MS);
          }),
        ]);
        failures = 0;
        if (alive) (setDown(null), setQuit(false));
      } catch (error) {
        // A fresh connection next time, which also starts the app again (not after Quit).
        lens.disconnect();
        failures++;
        if (alive) {
          setDown((error as Error).message);
          setQuit(error instanceof LensError && error.code === 'quit');
        }
      } finally {
        clearTimeout(late);
        if (alive) setChecking(false);
      }
      // 10 s, then 20, 40 and 60 s while the app stays away.
      const wait = Math.min(AT_MOST_EVERY_MS, EVERY_MS * 2 ** Math.max(0, failures - 1));
      if (alive) timer = setTimeout(() => void check(), wait);
    };
    void check();
    return () => {
      alive = false;
      clearTimeout(timer);
      lens.disconnect();
    };
  }, [attempt]);

  if (!down) return null;
  return (
    <div className="notice app-status" data-tone="warning" role="alert">
      <AlertIcon />
      <span>
        {quit ? 'You quit the Lens app.' : `The Lens app is not running (${down}).`} Open Sirv Lens from your
        applications. This page continues when the app answers.
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAttempt((n) => n + 1)} disabled={checking}>
        {checking ? 'Checking…' : 'Try again'}
      </button>
    </div>
  );
}

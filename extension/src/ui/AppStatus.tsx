import { useEffect, useRef, useState } from 'react';
import { LensClient } from '@/lens-client';
import { AlertIcon } from './icons';

const EVERY_MS = 10_000;
const ANSWER_WITHIN_MS = 8_000;

/**
 * Says so when the Lens app does not answer, on every page that needs it. It asks the app on a
 * connection of its own, so a long request of the page never reads as an app that is down. A
 * new connection starts the app when it is installed but not running.
 */
export function AppStatus({ onBack }: { onBack?: () => void }) {
  const [down, setDown] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
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
    const check = async () => {
      let late: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          lens.request({ method: 'hello' }),
          new Promise((_, fail) => {
            late = setTimeout(() => fail(new Error('it does not answer')), ANSWER_WITHIN_MS);
          }),
        ]);
        if (alive) setDown(null);
      } catch (error) {
        // A fresh connection next time, which also starts the app again.
        lens.disconnect();
        if (alive) setDown((error as Error).message);
      } finally {
        clearTimeout(late);
      }
      if (alive) timer = setTimeout(() => void check(), EVERY_MS);
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
        The Lens app is not running ({down}). Open Sirv Lens from your applications. This page continues when the app
        answers.
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAttempt((n) => n + 1)}>
        Try again
      </button>
    </div>
  );
}

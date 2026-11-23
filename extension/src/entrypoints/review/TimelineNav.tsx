import { jumpTarget } from './reviewHelpers';

export const SPEEDS = [1, 1.5, 2] as const;

/** Playback speed, jumps to the next moment of each kind, and the one-click trim of idle ends. */
export function TimelineNav({
  disabled,
  now,
  speed,
  onSpeed,
  errors,
  steps,
  markers,
  speech,
  onSeek,
  onAutoTrim,
  trimmed,
  onResetTrim,
}: {
  disabled: boolean;
  now: number;
  speed: number;
  onSpeed: (speed: number) => void;
  errors: number[];
  steps: number[];
  markers: number[];
  speech: number[];
  onSeek: (at: number) => void;
  /** Null when nothing happened that could set the bounds. */
  onAutoTrim: (() => void) | null;
  trimmed: boolean;
  onResetTrim: () => void;
}) {
  const jump = (label: string, times: number[], direction: 1 | -1) => {
    const target = jumpTarget(times, now, direction);
    return (
      <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || target === null} onClick={() => target !== null && onSeek(target)}>
        {label}
      </button>
    );
  };
  return (
    <div className="controls timeline-nav" role="toolbar" aria-label="Jump and trim">
      <label className="speed small">
        <span className="muted">Speed</span>
        <select className="select" aria-label="Playback speed" value={speed} disabled={disabled} onChange={(e) => onSpeed(Number(e.target.value))}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      </label>
      {jump('Previous error', errors, -1)}
      {jump('Next error', errors, 1)}
      {jump('Next step', steps, 1)}
      {jump('Next marker', markers, 1)}
      {jump('Next voice line', speech, 1)}
      <span className="spacer" />
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={disabled || !onAutoTrim}
        title="Keep from one second before the first activity to a second and a half after the last"
        onClick={() => onAutoTrim?.()}
      >
        Auto-trim idle
      </button>
      {trimmed && (
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={onResetTrim}>
          Reset trim
        </button>
      )}
    </div>
  );
}

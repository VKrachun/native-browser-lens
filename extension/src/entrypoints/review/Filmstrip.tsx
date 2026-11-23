import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { LensClient } from '@/lens-client';
import type { Area } from '@/protocol/Area';
import type { Edits } from '@/protocol/Edits';
import type { Shot } from '@/protocol/Shot';
import { MaskIcon } from '@/ui/icons';
import { clock } from './reviewHelpers';

/**
 * The shots Lens took after the person's steps. They leave with the recording; the person
 * removes any that show what should not leave.
 */
export function Filmstrip({
  client,
  shots,
  hidden,
  masks,
  start,
  onSeek,
  onToggle,
  onMask,
}: {
  client: LensClient;
  shots: Shot[];
  hidden: number[];
  masks: Edits['shotMasks'];
  start: number;
  onSeek: (at: number) => void;
  onToggle: (at: number) => void;
  onMask: (at: number, areas: Area[]) => void;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [masking, setMasking] = useState<Shot | null>(null);
  const areasOf = (at: number) => masks.find((m) => Number(m.at) === at)?.areas ?? [];
  useEffect(() => {
    const made: string[] = [];
    let alive = true;
    void Promise.all(
      shots.map(async (s) => {
        const url = URL.createObjectURL(await client.readBlob(s.image));
        // Read after the strip closed: nothing shows it.
        if (!alive) URL.revokeObjectURL(url);
        else made.push(url);
        return [s.image.sha256, url] as const;
      }),
    ).then((pairs) => alive && setUrls(Object.fromEntries(pairs)));
    return () => {
      alive = false;
      made.forEach(URL.revokeObjectURL);
    };
  }, [client, shots]);
  return (
    <section className="filmstrip" aria-label="Shots">
      <h3 className="label">
        Shots after your steps · {shots.length - hidden.filter((h) => shots.some((s) => Number(s.at) === h)).length} leave
      </h3>
      <ol>
        {shots.map((s) => {
          const removed = hidden.includes(Number(s.at));
          return (
            <li key={s.image.sha256 + s.at} data-removed={removed || undefined}>
              <button type="button" className="shot-thumb" onClick={() => onSeek(Number(s.at))} title="Show this moment">
                <span className="shot-frame">
                  {urls[s.image.sha256] && <img src={urls[s.image.sha256]} alt={`Shot at ${clock(Number(s.at) - start)}`} />}
                  <MaskBoxes areas={areasOf(Number(s.at))} />
                </span>
                <span className="num">{clock(Number(s.at) - start)}</span>
              </button>
              {!removed && (
                <button
                  type="button"
                  className="shot-mask"
                  aria-label={`Mask parts of the shot at ${clock(Number(s.at) - start)}`}
                  title="Black out parts of this shot"
                  onClick={() => setMasking(s)}
                >
                  <MaskIcon />
                </button>
              )}
              <button
                type="button"
                className="shot-toggle"
                aria-label={removed ? `Keep the shot at ${clock(Number(s.at) - start)}` : `Remove the shot at ${clock(Number(s.at) - start)}`}
                title={removed ? 'Keep it' : 'Do not share this shot'}
                onClick={() => onToggle(Number(s.at))}
              >
                {removed ? '↺' : '×'}
              </button>
            </li>
          );
        })}
      </ol>
      {masking && urls[masking.image.sha256] && (
        <ShotMasker
          url={urls[masking.image.sha256]!}
          label={`Mask the shot at ${clock(Number(masking.at) - start)}`}
          areas={areasOf(Number(masking.at))}
          onClose={() => setMasking(null)}
          onSave={(areas) => {
            onMask(Number(masking.at), areas);
            setMasking(null);
          }}
        />
      )}
    </section>
  );
}

function MaskBoxes({ areas }: { areas: Area[] }) {
  return (
    <>
      {areas.map((a, i) => (
        <span
          key={i}
          className="mask-box"
          style={{
            left: `${Math.min(a.x, a.x + a.width) * 100}%`,
            top: `${Math.min(a.y, a.y + a.height) * 100}%`,
            width: `${Math.abs(a.width) * 100}%`,
            height: `${Math.abs(a.height) * 100}%`,
          }}
        />
      ))}
    </>
  );
}

/** The shot large, where the person drags boxes over what must not leave. Lens burns them in. */
function ShotMasker({
  url,
  label,
  areas,
  onClose,
  onSave,
}: {
  url: string;
  label: string;
  areas: Area[];
  onClose: () => void;
  onSave: (areas: Area[]) => void;
}) {
  const [list, setList] = useState<Area[]>(areas);
  const [drag, setDrag] = useState<Area | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const at = (event: ReactPointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return { x: clamp((event.clientX - r.left) / r.width), y: clamp((event.clientY - r.top) / r.height) };
  };
  // A modal dialog of the browser: it takes the focus, keeps it inside and gives it back on close.
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="mask-scrim"
      aria-label={label}
      onCancel={(e) => (e.preventDefault(), onClose())}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="mask-dialog card">
        <div
          ref={stage}
          className="mask-stage"
          aria-label="Shot to mask"
          onPointerCancel={() => setDrag(null)}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = at(e);
            setDrag({ x: p.x, y: p.y, width: 0, height: 0 });
          }}
          onPointerMove={(e) => {
            if (!drag) return;
            const p = at(e);
            setDrag({ ...drag, width: p.x - drag.x, height: p.y - drag.y });
          }}
          onPointerUp={() => {
            if (drag && Math.abs(drag.width) > 0.005 && Math.abs(drag.height) > 0.005) {
              setList([
                ...list,
                {
                  x: Math.min(drag.x, drag.x + drag.width),
                  y: Math.min(drag.y, drag.y + drag.height),
                  width: Math.abs(drag.width),
                  height: Math.abs(drag.height),
                },
              ]);
            }
            setDrag(null);
          }}
        >
          <img src={url} alt="" draggable={false} />
          <MaskBoxes areas={drag ? [...list, drag] : list} />
        </div>
        <div className="note-actions">
          <span className="small muted spacer">Drag over what must not leave. The shared shot gets solid black there.</span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={list.length === 0} onClick={() => setList(list.slice(0, -1))}>
            Undo
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onSave(list)}>
            Save masks
          </button>
        </div>
      </div>
    </dialog>
  );
}

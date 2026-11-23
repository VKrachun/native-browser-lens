import type Konva from 'konva';
import { getStroke } from 'perfect-freehand';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Arrow, Circle, Group, Image as KonvaImage, Layer, Line, Rect, Stage, Text } from 'react-konva';
import { LensClient, captureProblem } from '@/lens-client';
import type { Broadcast } from '@/messages';
import type { Capture } from '@/protocol/Capture';
import type { Point } from '@/protocol/Point';
import type { Shape } from '@/protocol/Shape';
import {
  AddNoteIcon,
  ArrowIcon,
  DeleteIcon,
  EraseIcon,
  MaskIcon,
  PenIcon,
  RectangleIcon,
  SaveIcon,
  TargetIcon,
  UndoIcon,
} from '@/ui/icons';
import { MAX_LABEL, badgeRadius, bounds, box, ink, label, moved, nextBadge, shapeAt, textScale } from './shapes';

type Tool = 'select' | 'rectangle' | 'arrow' | 'pen' | 'text' | 'badge' | 'blur' | 'mask';
const BadgeIcon = () => (
  <span className="badge-glyph" aria-hidden>
    1
  </span>
);
const TOOLS: { tool: Tool; label: string; key: string; Icon: typeof TargetIcon }[] = [
  { tool: 'select', label: 'Select', key: 'v', Icon: TargetIcon },
  { tool: 'rectangle', label: 'Rectangle', key: 'r', Icon: RectangleIcon },
  { tool: 'arrow', label: 'Arrow', key: 'a', Icon: ArrowIcon },
  { tool: 'pen', label: 'Pen', key: 'p', Icon: PenIcon },
  { tool: 'text', label: 'Text', key: 't', Icon: AddNoteIcon },
  { tool: 'badge', label: 'Step', key: 'n', Icon: BadgeIcon },
  { tool: 'blur', label: 'Blur', key: 'b', Icon: EraseIcon },
  { tool: 'mask', label: 'Mask', key: 'm', Icon: MaskIcon },
];
const COLORS = ['#ff3355', '#ffb000', '#2f7bff'];
const MIN_SIZE = 4;
const ZOOM = { min: 0.25, max: 4, step: 1.25 };
/** Pixels on screen that a click may miss a thin line by. */
const SLACK = 6;

type History = { stack: Shape[][]; at: number };
type Drag = { index: number; start: Point; shape: Shape };
type Callout = { x: number; y: number; text: string };

/** Draws marks on a copy of the screenshot. Shapes are stored in the screenshot's own pixels. */
export function Editor({ capture: captureId, back = 0 }: { capture: number; back?: number }) {
  const [client] = useState(() => new LensClient());
  const [capture, setCapture] = useState<Capture | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [history, setHistory] = useState<History>({ stack: [[]], at: 0 });
  const [draft, setDraft] = useState<Shape | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [callout, setCallout] = useState<Callout | null>(null);
  const calloutRef = useRef<Callout | null>(null);
  const calloutInput = useRef<HTMLInputElement>(null);
  const [tool, setTool] = useState<Tool>('rectangle');
  const [color, setColor] = useState(COLORS[0]!);
  const [saved, setSaved] = useState<Shape[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [width, setWidth] = useState(() => window.innerWidth - 64);
  const [zoom, setZoom] = useState<number | null>(null);
  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const well = useRef<HTMLDivElement>(null);
  const stage = useRef<Konva.Stage>(null);
  const anchor = useRef<{ client: Point; at: Point } | null>(null);
  const shapes = history.stack[history.at]!;
  const dirty = JSON.stringify(shapes) !== JSON.stringify(saved);

  // Loads once; `back` (the app answers again) loads what a failed load left out.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    let alive = true;
    client
      .request({ method: 'getCapture', params: { id: captureId } })
      .then(async (found) => {
        if (!alive) return;
        setCapture(found);
        setHistory({ stack: [found.annotations], at: 0 });
        setSaved(found.annotations);
        const blob = await client.readBlob(found.screenshot);
        if (!alive) return;
        // The picture lives as long as the page.
        const img = new window.Image();
        img.onload = () => setImage(img);
        img.src = URL.createObjectURL(blob);
        loaded.current = true;
        setProblem(null);
      })
      .catch((error: Error) => alive && setProblem(captureProblem(error)));
    return () => {
      alive = false;
    };
  }, [client, captureId, back]);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth - 64);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  /** A new step in the history: the steps after the current one go. */
  const change = useCallback((next: (shapes: Shape[]) => Shape[]) => {
    setHistory((h) => ({ stack: [...h.stack.slice(0, h.at + 1), next(h.stack[h.at]!)], at: h.at + 1 }));
  }, []);
  const undo = useCallback(() => {
    setSelected(null);
    setHistory((h) => (h.at > 0 ? { ...h, at: h.at - 1 } : h));
  }, []);
  const redo = useCallback(() => {
    setSelected(null);
    setHistory((h) => (h.at < h.stack.length - 1 ? { ...h, at: h.at + 1 } : h));
  }, []);
  const remove = useCallback(() => {
    if (selected === null) return;
    change((list) => list.filter((_, i) => i !== selected));
    setSelected(null);
  }, [change, selected]);

  const editCallout = (next: Callout | null) => {
    calloutRef.current = next;
    setCallout(next);
  };
  /** Ends the open callout once: Enter, a click away and a tool change keep it; Escape drops it. */
  const finishCallout = useCallback(
    (keep: boolean) => {
      const open = calloutRef.current;
      if (!open) return;
      calloutRef.current = null;
      setCallout(null);
      const text = open.text.trim();
      if (keep && text) change((list) => [...list, { kind: 'text', x: open.x, y: open.y, text, color }]);
    },
    [change, color],
  );
  // Focus after the click is over: the click itself moves focus to the page and would end the callout.
  const openAt = callout && `${callout.x},${callout.y}`;
  useEffect(() => {
    if (!openAt) return;
    const frame = requestAnimationFrame(() => calloutInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [openAt]);
  const pick = useCallback(
    (next: Tool) => {
      finishCallout(true);
      setSelected(null);
      setTool(next);
    },
    [finishCallout],
  );

  const save = useCallback(async () => {
    try {
      const updated = await client.request({ method: 'saveAnnotations', params: { capture: captureId, shapes } });
      setSaved(updated.annotations);
      setProblem(null);
      void browser.runtime.sendMessage({ kind: 'annotated', capture: updated } satisfies Broadcast).catch(() => {});
    } catch (error) {
      setProblem(`Not saved: ${(error as Error).message}`);
    }
  }, [client, captureId, shapes]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      // The callout input and other fields keep their own keys.
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (command && ((key === 'z' && event.shiftKey) || key === 'y')) return event.preventDefault(), redo();
      if (command && key === 'z') return event.preventDefault(), undo();
      // Only a changed drawing saves: an untouched tab must not replace marks saved elsewhere.
      if (command && key === 's') return event.preventDefault(), void (dirty && save());
      if (command || event.altKey) return;
      if (event.key === ' ') {
        if (event.target instanceof Element && event.target.closest('button')) return;
        event.preventDefault();
        return setSpace(true);
      }
      if ((key === 'delete' || key === 'backspace') && selected !== null) return event.preventDefault(), remove();
      if (key === 'escape') return setSelected(null);
      const picked = TOOLS.find((t) => t.key === key);
      if (picked) pick(picked.tool);
    };
    const release = (event: KeyboardEvent) => event.key === ' ' && setSpace(false);
    const away = () => setSpace(false);
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('keydown', keys);
    window.addEventListener('keyup', release);
    window.addEventListener('blur', away);
    window.addEventListener('beforeunload', leave);
    return () => {
      window.removeEventListener('keydown', keys);
      window.removeEventListener('keyup', release);
      window.removeEventListener('blur', away);
      window.removeEventListener('beforeunload', leave);
    };
  }, [undo, redo, save, remove, pick, dirty, selected]);

  const fit = image ? Math.min(1, width / image.width) : 1;
  const scale = zoom ?? fit;
  const s = image ? textScale(image.width) : 2;

  /** Zooms about a point on screen (the well's middle when none), which stays where it is. */
  const zoomTo = (next: number | null, point?: Point) => {
    const view = well.current?.getBoundingClientRect();
    const area = stage.current?.container().getBoundingClientRect();
    if (view && area) {
      const at = point ?? { x: view.left + view.width / 2, y: view.top + view.height / 2 };
      anchor.current = { client: at, at: { x: (at.x - area.left) / scale, y: (at.y - area.top) / scale } };
    }
    setZoom(next === null ? null : Math.min(ZOOM.max, Math.max(ZOOM.min, next)));
  };
  useLayoutEffect(() => {
    const kept = anchor.current;
    anchor.current = null;
    const area = stage.current?.container().getBoundingClientRect();
    if (!kept || !area || !well.current) return;
    well.current.scrollLeft += area.left + kept.at.x * scale - kept.client.x;
    well.current.scrollTop += area.top + kept.at.y * scale - kept.client.y;
  }, [scale]);
  const zoomBy = useRef(zoomTo);
  useEffect(() => {
    zoomBy.current = zoomTo;
  });
  useEffect(() => {
    const view = well.current;
    if (!view) return;
    // Not passive: Ctrl+wheel must not zoom the whole page as well.
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy.current(scale * Math.exp(-event.deltaY * 0.002), { x: event.clientX, y: event.clientY });
    };
    view.addEventListener('wheel', wheel, { passive: false });
    return () => view.removeEventListener('wheel', wheel);
  }, [scale]);

  // A blur shows the screenshot in large blocks, as render.rs exports it.
  const blocks = useMemo(() => {
    if (!image) return null;
    const block = Math.min(48, Math.max(12, Math.floor(image.width / 120)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(image.width / block);
    canvas.height = Math.ceil(image.height / block);
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { canvas, x: canvas.width / image.width, y: canvas.height / image.height };
  }, [image]);

  const pointer = (): Point | null => {
    const at = stage.current?.getPointerPosition();
    return at ? { x: at.x / scale, y: at.y / scale } : null;
  };

  function begin(event: Konva.KonvaEventObject<PointerEvent>) {
    const at = pointer();
    if (event.evt.button !== 0 || !at) return;
    if (tool === 'select') {
      const index = shapeAt(shapes, at, s, SLACK / scale);
      setSelected(index);
      if (index !== null) setDrag({ index, start: at, shape: shapes[index]! });
      return;
    }
    if (tool === 'text') {
      // A click away from an open callout only keeps it.
      if (calloutRef.current) return finishCallout(true);
      return editCallout({ x: at.x, y: at.y, text: '' });
    }
    if (tool === 'badge') {
      const number = nextBadge(shapes);
      if (number !== null) change((list) => [...list, { kind: 'badge', x: at.x, y: at.y, number, color }]);
      return;
    }
    const area = { x: at.x, y: at.y, width: 0, height: 0 };
    if (tool === 'rectangle') setDraft({ kind: 'rectangle', ...area, color });
    if (tool === 'mask') setDraft({ kind: 'mask', ...area });
    if (tool === 'blur') setDraft({ kind: 'blur', ...area });
    if (tool === 'arrow') setDraft({ kind: 'arrow', from: at, to: at, color });
    if (tool === 'pen') setDraft({ kind: 'pen', points: [at], color });
  }

  function move() {
    const at = pointer();
    if (!at) return;
    if (drag) return setDrag({ ...drag, shape: moved(shapes[drag.index]!, at.x - drag.start.x, at.y - drag.start.y) });
    if (!draft) return;
    if (draft.kind === 'rectangle' || draft.kind === 'mask' || draft.kind === 'blur') {
      setDraft({ ...draft, width: at.x - draft.x, height: at.y - draft.y });
    } else if (draft.kind === 'arrow') {
      setDraft({ ...draft, to: at });
    } else if (draft.kind === 'pen' && draft.points.length < 5000) {
      setDraft({ ...draft, points: [...draft.points, at] });
    }
  }

  function end() {
    if (drag) {
      setDrag(null);
      if (drag.shape !== shapes[drag.index]) change((list) => list.map((shape, i) => (i === drag.index ? drag.shape : shape)));
    }
    if (!draft) return;
    const shape = normalized(draft);
    setDraft(null);
    if (shape) change((list) => [...list, shape]);
  }

  /** Space or the middle button drags the view, not the drawing. */
  const panHandlers = {
    onPointerDownCapture(event: React.PointerEvent<HTMLDivElement>) {
      if (!space && event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      const view = event.currentTarget;
      view.setPointerCapture(event.pointerId);
      pan.current = { x: event.clientX, y: event.clientY, left: view.scrollLeft, top: view.scrollTop };
      setPanning(true);
    },
    onPointerMoveCapture(event: React.PointerEvent<HTMLDivElement>) {
      const from = pan.current;
      if (!from) return;
      event.stopPropagation();
      event.currentTarget.scrollLeft = from.left - (event.clientX - from.x);
      event.currentTarget.scrollTop = from.top - (event.clientY - from.y);
    },
    onPointerUpCapture() {
      pan.current = null;
      setPanning(false);
    },
    onPointerCancelCapture() {
      pan.current = null;
      setPanning(false);
    },
    // No autoscroll or paste from the middle button.
    onMouseDown(event: React.MouseEvent) {
      if (event.button === 1) event.preventDefault();
    },
  };

  const shown = shapes.map((shape, i) => (drag?.index === i ? drag.shape : shape));
  const all = draft ? [...shown, draft] : shown;
  const marks = all.flatMap((shape, i) => (shape.kind === 'mask' || shape.kind === 'blur' ? [] : [{ shape, i }]));
  // Blurs and masks over every mark, masks last: the order of the exported screenshot.
  const covers = [
    ...all.flatMap((shape, i) => (shape.kind === 'blur' ? [{ shape, i }] : [])),
    ...all.flatMap((shape, i) => (shape.kind === 'mask' ? [{ shape, i }] : [])),
  ];
  const outline = selected !== null && shown[selected] ? bounds(shown[selected], s) : null;
  const pad = 4 / scale;

  return (
    <main className="editor">
      <header className="toolbar">
        <div className="toolbar-title">
          <h1>{capture ? capture.pageTitle || capture.pageUrl : 'Annotate'}</h1>
          <span role="status" className="small muted num">
            {dirty ? 'Unsaved changes' : `Saved · ${shapes.length} marks`}
          </span>
          {/* In the title row, so switching tools never moves the canvas under the pointer. */}
          {(tool === 'mask' || tool === 'blur') && (
            <span className="small muted hint">
              Masks and blurs hide what is under them in every export and filing. A masked capture leaves without its replay.
            </span>
          )}
        </div>
        <div role="toolbar" aria-label="Tools" className="tools">
          <div className="segmented">
            {TOOLS.map(({ tool: t, label: name, key, Icon }) => (
              <button
                key={t}
                type="button"
                className="btn btn-sm"
                aria-pressed={tool === t}
                aria-label={name}
                title={`${name} (${key.toUpperCase()})`}
                onClick={() => pick(t)}
              >
                <Icon />
                <span className="tool-label">{name}</span>
              </button>
            ))}
          </div>
          <div className="swatches">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="swatch"
                aria-label={`Color ${c}`}
                aria-pressed={color === c}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <div className="zoom" role="group" aria-label="Zoom">
            <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Zoom out" onClick={() => zoomTo(scale / ZOOM.step)} disabled={scale <= ZOOM.min}>
              −
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm num"
              aria-label={`Fit to window, now ${Math.round(scale * 100)}%`}
              aria-pressed={zoom === null}
              title="Fit to window"
              onClick={() => zoomTo(null)}
            >
              {zoom === null ? 'Fit' : `${Math.round(scale * 100)}%`}
            </button>
            <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Zoom in" onClick={() => zoomTo(scale * ZOOM.step)} disabled={scale >= ZOOM.max}>
              +
            </button>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="Actual size" aria-pressed={zoom === 1} onClick={() => zoomTo(1)}>
              100%
            </button>
          </div>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={remove} disabled={selected === null} title="Delete (Delete)">
            <DeleteIcon />
            Delete
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={undo} disabled={history.at === 0} title="Undo (Ctrl+Z)">
            <UndoIcon />
            Undo
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={redo} disabled={history.at === history.stack.length - 1} title="Redo (Ctrl+Shift+Z)">
            <span className="mirror">
              <UndoIcon />
            </span>
            Redo
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={!dirty} title="Save (Ctrl+S)">
            <SaveIcon />
            Save
          </button>
        </div>
        {problem && (
          <div role="alert" className="notice">
            {problem}
          </div>
        )}
      </header>
      <div ref={well} className="well" data-tool={tool} data-pan={panning ? 'drag' : space ? 'ready' : undefined} {...panHandlers}>
        {image ? (
          <div className="canvas">
            <Stage
              ref={stage}
              width={image.width * scale}
              height={image.height * scale}
              onPointerDown={begin}
              onPointerMove={move}
              onPointerUp={end}
              onPointerLeave={end}
              aria-label="Screenshot"
            >
              <Layer scaleX={scale} scaleY={scale} listening={false}>
                <KonvaImage image={image} />
                {marks.map(({ shape, i }) => (
                  <ShapeView key={i} shape={shape} scale={scale} s={s} />
                ))}
              </Layer>
              {/* Without smoothing, so the blur blocks stay sharp. */}
              <Layer scaleX={scale} scaleY={scale} listening={false} imageSmoothingEnabled={false}>
                {covers.map(({ shape, i }) =>
                  shape.kind === 'blur' && blocks ? (
                    <BlurView key={i} area={box(shape)} blocks={blocks} />
                  ) : (
                    <ShapeView key={i} shape={shape} scale={scale} s={s} />
                  ),
                )}
                {outline && (
                  <>
                    <Rect x={outline.x - pad} y={outline.y - pad} width={outline.width + 2 * pad} height={outline.height + 2 * pad} stroke="#ffffff" strokeWidth={3 / scale} />
                    <Rect
                      x={outline.x - pad}
                      y={outline.y - pad}
                      width={outline.width + 2 * pad}
                      height={outline.height + 2 * pad}
                      stroke="#000000"
                      strokeWidth={1.5 / scale}
                      dash={[4 / scale, 4 / scale]}
                    />
                  </>
                )}
              </Layer>
            </Stage>
            {callout && (
              <input
                ref={calloutInput}
                className="callout"
                aria-label="Callout text"
                maxLength={MAX_LABEL}
                value={callout.text}
                placeholder="Callout"
                style={{
                  left: callout.x * scale,
                  top: callout.y * scale,
                  background: color,
                  color: ink(color),
                  fontSize: 10 * s * scale,
                  padding: 3 * s * scale,
                  borderRadius: 2 * s * scale,
                }}
                onChange={(event) => editCallout({ ...callout, text: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') finishCallout(true);
                  if (event.key === 'Escape') finishCallout(false);
                }}
                onBlur={() => finishCallout(true)}
              />
            )}
          </div>
        ) : (
          <span className="thumb skeleton" style={{ width: '100%' }} />
        )}
      </div>
    </main>
  );
}

/** Positive sizes, and nothing for a click that did not drag. */
function normalized(shape: Shape): Shape | null {
  if (shape.kind === 'rectangle' || shape.kind === 'mask' || shape.kind === 'blur') {
    const area = box(shape);
    return area.width < MIN_SIZE || area.height < MIN_SIZE ? null : { ...shape, ...area };
  }
  if (shape.kind === 'arrow') {
    return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) < MIN_SIZE ? null : shape;
  }
  if (shape.kind === 'pen') return shape.points.length < 2 ? null : shape;
  return shape;
}

function BlurView({
  area,
  blocks,
}: {
  area: { x: number; y: number; width: number; height: number };
  blocks: { canvas: HTMLCanvasElement; x: number; y: number };
}) {
  if (area.width < 1 || area.height < 1) return null;
  return (
    <KonvaImage
      image={blocks.canvas}
      {...area}
      crop={{ x: area.x * blocks.x, y: area.y * blocks.y, width: area.width * blocks.x, height: area.height * blocks.y }}
    />
  );
}

/** `scale` is the zoom; `s` is render.rs's text scale for this screenshot. */
function ShapeView({ shape, scale, s }: { shape: Shape; scale: number; s: number }) {
  const line = 3 / scale;
  switch (shape.kind) {
    case 'rectangle':
      return <Rect {...box(shape)} stroke={shape.color} strokeWidth={line} />;
    case 'mask':
      return <Rect {...box(shape)} fill="#000" opacity={0.85} />;
    case 'blur':
      return null;
    case 'arrow':
      return (
        <Arrow
          points={[shape.from.x, shape.from.y, shape.to.x, shape.to.y]}
          stroke={shape.color}
          fill={shape.color}
          strokeWidth={line}
          pointerLength={12 / scale}
          pointerWidth={12 / scale}
        />
      );
    case 'pen': {
      const outline = getStroke(
        shape.points.map((p) => [p.x, p.y]),
        { size: 4 / scale, thinning: 0.5, smoothing: 0.5 },
      );
      return <Line points={outline.flat()} closed fill={shape.color} />;
    }
    case 'text': {
      const pill = label(shape.text, s);
      return (
        <Group x={shape.x} y={shape.y}>
          <Rect width={pill.width} height={pill.height} cornerRadius={2 * s} fill={shape.color} />
          <Text
            x={pill.pad}
            y={pill.pad}
            text={pill.lines.join('\n')}
            fontFamily="ui-monospace, monospace"
            fontStyle="bold"
            fontSize={10 * s}
            lineHeight={0.8}
            fill={ink(shape.color)}
          />
        </Group>
      );
    }
    case 'badge': {
      const r = badgeRadius(shape.number, s);
      return (
        <Group x={shape.x} y={shape.y}>
          <Circle radius={r + s} fill="#ffffff" />
          <Circle radius={r} fill={shape.color} />
          <Text
            x={-r}
            y={-r}
            width={2 * r}
            height={2 * r}
            align="center"
            verticalAlign="middle"
            text={String(shape.number)}
            fontFamily="ui-monospace, monospace"
            fontStyle="bold"
            fontSize={10 * s}
            fill={ink(shape.color)}
          />
        </Group>
      );
    }
  }
}

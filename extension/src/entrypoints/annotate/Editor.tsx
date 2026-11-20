import type Konva from 'konva';
import { getStroke } from 'perfect-freehand';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Arrow, Image as KonvaImage, Layer, Line, Rect, Stage } from 'react-konva';
import { LensClient } from '@/lens-client';
import type { Broadcast } from '@/messages';
import type { Capture } from '@/protocol/Capture';
import type { Point } from '@/protocol/Point';
import type { Shape } from '@/protocol/Shape';
import { ArrowIcon, MaskIcon, PenIcon, RectangleIcon, SaveIcon, UndoIcon } from '@/ui/icons';

type Tool = 'rectangle' | 'arrow' | 'pen' | 'mask';
const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: 'rectangle', label: 'Rectangle', key: 'r' },
  { tool: 'arrow', label: 'Arrow', key: 'a' },
  { tool: 'pen', label: 'Pen', key: 'p' },
  { tool: 'mask', label: 'Mask', key: 'm' },
];
const TOOL_ICONS = { rectangle: RectangleIcon, arrow: ArrowIcon, pen: PenIcon, mask: MaskIcon };
const COLORS = ['#ff3355', '#ffb000', '#2f7bff'];
const MIN_SIZE = 4;

/** Draws marks on a copy of the screenshot. Shapes are stored in the screenshot's own pixels. */
export function Editor({ capture: captureId }: { capture: number }) {
  const [client] = useState(() => new LensClient());
  const [capture, setCapture] = useState<Capture | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [history, setHistory] = useState<Shape[][]>([[]]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [tool, setTool] = useState<Tool>('rectangle');
  const [color, setColor] = useState(COLORS[0]!);
  const [saved, setSaved] = useState<Shape[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [width, setWidth] = useState(() => window.innerWidth - 64);
  const shapes = history[history.length - 1]!;
  const dirty = JSON.stringify(shapes) !== JSON.stringify(saved);

  useEffect(() => {
    let url: string | null = null;
    client
      .request({ method: 'getCapture', params: { id: captureId } })
      .then(async (found) => {
        setCapture(found);
        setHistory([found.annotations]);
        setSaved(found.annotations);
        url = URL.createObjectURL(await client.readBlob(found.screenshot));
        const img = new window.Image();
        img.onload = () => setImage(img);
        img.src = url;
      })
      .catch((error: Error) => setProblem(error.message));
    const resize = () => setWidth(window.innerWidth - 64);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      if (url) URL.revokeObjectURL(url);
      client.disconnect();
    };
  }, [client, captureId]);

  const commit = (next: Shape[]) => setHistory((h) => [...h, next]);
  const undo = useCallback(() => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h)), []);

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
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === 'z') return event.preventDefault(), undo();
      if (command && event.key.toLowerCase() === 's') return event.preventDefault(), void save();
      const picked = !command && TOOLS.find((t) => t.key === event.key.toLowerCase());
      if (picked) setTool(picked.tool);
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('keydown', keys);
    window.addEventListener('beforeunload', leave);
    return () => {
      window.removeEventListener('keydown', keys);
      window.removeEventListener('beforeunload', leave);
    };
  }, [undo, save, dirty]);

  const scale = image ? Math.min(1, width / image.width) : 1;
  const pointer = (stage: Konva.Stage | null): Point | null => {
    const at = stage?.getPointerPosition();
    return at ? { x: at.x / scale, y: at.y / scale } : null;
  };

  function begin(event: Konva.KonvaEventObject<PointerEvent>) {
    const at = pointer(event.target.getStage());
    if (!at) return;
    const box = { x: at.x, y: at.y, width: 0, height: 0 };
    if (tool === 'rectangle') setDraft({ kind: 'rectangle', ...box, color });
    if (tool === 'mask') setDraft({ kind: 'mask', ...box });
    if (tool === 'arrow') setDraft({ kind: 'arrow', from: at, to: at, color });
    if (tool === 'pen') setDraft({ kind: 'pen', points: [at], color });
  }

  function move(event: Konva.KonvaEventObject<PointerEvent>) {
    const at = pointer(event.target.getStage());
    if (!draft || !at) return;
    if (draft.kind === 'rectangle' || draft.kind === 'mask') {
      setDraft({ ...draft, width: at.x - draft.x, height: at.y - draft.y });
    } else if (draft.kind === 'arrow') {
      setDraft({ ...draft, to: at });
    } else if (draft.points.length < 5000) {
      setDraft({ ...draft, points: [...draft.points, at] });
    }
  }

  function end() {
    if (!draft) return;
    const shape = normalized(draft);
    setDraft(null);
    if (shape) commit([...shapes, shape]);
  }

  return (
    <main className="editor">
      <header className="toolbar">
        <div className="toolbar-title">
          <h1>{capture ? capture.pageTitle || capture.pageUrl : 'Annotate'}</h1>
          <span role="status" className="small muted num">
            {dirty ? 'Unsaved changes' : `Saved · ${shapes.length} marks`}
          </span>
          {/* In the title row, so switching tools never moves the canvas under the pointer. */}
          {tool === 'mask' && (
            <span className="small muted hint">Masks hide what is under them in every export and filing. A masked capture leaves without its replay.</span>
          )}
        </div>
        <div role="toolbar" aria-label="Tools" className="tools">
          <div className="segmented">
            {TOOLS.map((t) => {
              const Icon = TOOL_ICONS[t.tool];
              return (
                <button
                  key={t.tool}
                  type="button"
                  className="btn btn-sm"
                  aria-pressed={tool === t.tool}
                  aria-label={t.label}
                  title={`${t.label} (${t.key.toUpperCase()})`}
                  onClick={() => setTool(t.tool)}
                >
                  <Icon />
                  <span className="tool-label">{t.label}</span>
                </button>
              );
            })}
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
          <span className="spacer" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={undo} disabled={history.length < 2} title="Undo (Ctrl+Z)">
            <UndoIcon />
            Undo
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
      <div className="well">
        {image ? (
          <Stage
            width={image.width * scale}
            height={image.height * scale}
            onPointerDown={begin}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={end}
            aria-label="Screenshot"
          >
            <Layer scaleX={scale} scaleY={scale}>
              <KonvaImage image={image} />
              {[...shapes, ...(draft ? [draft] : [])].map((shape, index) => (
                <ShapeView key={index} shape={shape} scale={scale} />
              ))}
            </Layer>
          </Stage>
        ) : (
          <span className="thumb skeleton" style={{ width: '100%' }} />
        )}
      </div>
    </main>
  );
}

/** Positive sizes, and nothing for a click that did not drag. */
function normalized(shape: Shape): Shape | null {
  if (shape.kind === 'rectangle' || shape.kind === 'mask') {
    const box = {
      x: Math.min(shape.x, shape.x + shape.width),
      y: Math.min(shape.y, shape.y + shape.height),
      width: Math.abs(shape.width),
      height: Math.abs(shape.height),
    };
    return box.width < MIN_SIZE || box.height < MIN_SIZE ? null : { ...shape, ...box };
  }
  if (shape.kind === 'arrow') {
    return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) < MIN_SIZE ? null : shape;
  }
  return shape.points.length < 2 ? null : shape;
}

function ShapeView({ shape, scale }: { shape: Shape; scale: number }) {
  const line = 3 / scale;
  switch (shape.kind) {
    case 'rectangle':
      return <Rect {...box(shape)} stroke={shape.color} strokeWidth={line} />;
    case 'mask':
      return <Rect {...box(shape)} fill="#000" opacity={0.85} />;
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
  }
}

function box(shape: { x: number; y: number; width: number; height: number }) {
  return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
}

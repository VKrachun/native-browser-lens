import { stepsOf } from '@/steps';
import rrwebPlayer from 'rrweb-player';
import 'rrweb-player/dist/style.css';
import './editor.css';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { locatorOf } from '@/collector/actions';
import type { LensClient } from '@/lens-client';
import type { Action } from '@/protocol/Action';
import type { Annotation } from '@/protocol/Annotation';
import type { Capture } from '@/protocol/Capture';
import type { Edits } from '@/protocol/Edits';
import type { Locator } from '@/protocol/Locator';
import type { Point } from '@/protocol/Point';
import type { TimeRange } from '@/protocol/TimeRange';
import type { VoiceNote } from '@/protocol/VoiceNote';
import { AddNoteIcon, CutIcon, DeleteIcon, PenIcon, TargetIcon } from '@/ui/icons';
import { VoiceProgress } from '../sidepanel/Voice';
import { offlineEvents } from '@/replay-offline';
import { Filmstrip } from './Filmstrip';
import { TimelineNav } from './TimelineNav';
import { VideoCapturePreview } from './VideoCapturePreview';
import { WhatHappened, type Row, type Word } from './WhatHappened';
import {
  autoTrimBounds,
  clock,
  keptRanges,
  markersOf,
  sameStep,
  ticks,
  videoOf,
  type EvidenceEvent,
  type Marker,
  type Video,
} from './reviewHelpers';

type Player = InstanceType<typeof rrwebPlayer>;
type Mark = { at: number; kind: 'step' | 'error' | 'note' | 'marker'; label: string };
type Stroke = Point[];
/** Draw: free lines; Highlight: one element, outlined, under the pointer. */
type Tool = 'draw' | 'highlight' | null;

const describe = (l: Locator | null) => (!l ? 'the page' : l.role && l.name ? `${l.role} “${l.name}”` : l.text ? `“${l.text}”` : l.css);
const ELEMENTS_PER_NOTE = 5;
/** A drawing stays on screen this long around its moment. */
const DRAWING_SHOWS_MS = 2500;

/**
 * The review of a recording: the replay as the video, the person's voice in sync, a timeline
 * with steps, errors, markers, speech and notes, and the edits that decide what leaves: trimmed
 * ends, cut parts, notes at moments and drawings that name the elements under them.
 */
export function RecordingEditor({
  client,
  capture,
  voice,
  onVoice,
}: {
  client: LensClient;
  capture: Capture;
  voice: VoiceNote[];
  /** A transcript the person corrected, as the daemon saved it. */
  onVoice?: (note: VoiceNote) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const player = useRef<Player | null>(null);
  const [span, setSpan] = useState<{ start: number; end: number } | null>(null);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [edits, setEdits] = useState<Edits>(capture.edits);
  const [saved, setSaved] = useState(true);
  const [selection, setSelection] = useState<TimeRange | null>(null);
  const [tool, setTool] = useState<Tool>(null);
  const [hover, setHover] = useState<{ x: number; y: number; width: number; height: number; label: string } | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [draft, setDraft] = useState<{ at: number; text: string; drawing: Stroke[]; elements: Locator[] } | null>(null);
  const [steps, setSteps] = useState<{ at: number; text: string; error: boolean }[]>([]);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [video, setVideo] = useState<Video | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pointer, setPointer] = useState<number | null>(null);
  const [cutting, setCutting] = useState(false);
  const audio = useRef<Map<number, HTMLAudioElement>>(new Map());
  // The replay fetches nothing from the recorded site unless the person asks for it, for this
  // capture: then the site sees the visit, and its images can differ from what was recorded.
  const imagesKey = `lens.replay.siteImages.${capture.id}`;
  const [siteImages, setSiteImages] = useState<boolean | null>(null);
  useEffect(() => {
    void browser.storage.local
      .get(imagesKey)
      .then((found) => setSiteImages(found[imagesKey] === true), () => setSiteImages(false));
  }, [imagesKey]);
  const chooseSiteImages = (on: boolean) => {
    setSiteImages(on);
    void browser.storage.local.set({ [imagesKey]: on }).catch(() => {});
  };

  // The replay and the steps.
  useEffect(() => {
    if (!capture.recording || !stage.current || siteImages === null) return;
    let cancelled = false;
    const target = stage.current;
    void (async () => {
      try {
        const recorded = JSON.parse(await (await client.readBlob(capture.recording!)).text());
        const events = siteImages ? recorded : offlineEvents(recorded);
        const evidence = JSON.parse(await (await client.readBlob(capture.evidence)).text()) as {
          actions?: Action[];
          events?: EvidenceEvent[];
        };
        if (cancelled) return;
        // The stage takes the shape of the recorded window, as large as the column and the
        // window allow: no bars around a tall or narrow page. The person may resize the window
        // while recording, so the stage follows each resize the replay reaches.
        const fit = (recordedWidth: number, recordedHeight: number) => {
          const aspect = recordedHeight / recordedWidth;
          // Room for the controls and the timeline below it; the shots may scroll.
          const room = Math.max(360, window.innerHeight - 300);
          const column = target.closest('.editor-main')?.clientWidth || target.clientWidth;
          const height = Math.min(Math.round(column * aspect), room);
          return { width: Math.round(height / aspect), height };
        };
        const viewport = (events as { type: number; data: { width?: number; height?: number } }[]).find(
          (e) => e.type === 4 && e.data.width && e.data.height,
        )?.data;
        const instance = new rrwebPlayer({
          target,
          props: {
            events,
            ...(viewport ? fit(viewport.width!, viewport.height!) : fit(16, 9)),
            autoPlay: false,
            showController: false,
            skipInactive: false,
          },
        });
        instance.getReplayer().on('resize', (size) => {
          const { width, height } = size as { width: number; height: number };
          if (!width || !height) return;
          // A Svelte 4 component: $set is there at run time; its types need Svelte, which Lens lacks.
          (instance as unknown as { $set: (props: { width: number; height: number }) => void }).$set(fit(width, height));
          instance.triggerResize();
        });
        player.current = instance;
        const meta = instance.getMetaData();
        // A replay starts at the snapshot before the recording; the recording starts at Record.
        setSpan({ start: meta.startTime, end: meta.endTime });
        setNow(Math.max(meta.startTime, capture.startedAt));
        // Seeking once also sets rrweb's base time: before it, getCurrentTime() is not a position.
        instance.goto(Math.max(0, capture.startedAt - meta.startTime), false);
        setSteps(stepsOf(evidence.actions ?? [], evidence.events ?? [], capture.pageUrl));
        setMarkers(markersOf(evidence.events ?? [], Array.isArray(recorded) ? recorded : []));
        setVideo(videoOf(evidence.events ?? []));
      } catch (error) {
        setProblem(`The recording did not load: ${(error as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
      player.current?.pause();
      player.current?.getReplayer().destroy();
      player.current = null;
      target.replaceChildren();
    };
  }, [client, capture.recording, capture.evidence, siteImages]);

  // The replay plays at the chosen speed; the voice follows it in the clock below. A new replay
  // (site images on or off) takes the speed again.
  useEffect(() => {
    try {
      player.current?.getReplayer().setConfig({ speed });
    } catch {
      // The replay is not there yet: the next span sets it.
    }
  }, [speed, span]);

  // One clock: the replay's time drives the voice and the drawings.
  useEffect(() => {
    if (!span) return;
    let frame = 0;
    const tick = () => {
      // The next frame is asked for first: one failure must not stop the clock for good.
      frame = requestAnimationFrame(tick);
      let replayer: ReturnType<Player['getReplayer']> | undefined;
      try {
        replayer = player.current?.getReplayer();
      } catch {
        return;
      }
      if (replayer) {
        const offset = replayer.getCurrentTime();
        if (!(offset >= 0 && offset <= span.end - span.start + 1000)) return;
        const at = Math.round(span.start + offset);
        setNow(at);
        const kept = keptRanges(edits, { start: Math.max(span.start, capture.startedAt), end: span.end });
        // A cut part plays as if it were not there: the replay jumps over it.
        if (playing) {
          const inCut = !kept.some((r) => at >= r.from && at < r.to);
          if (inCut) {
            const next = kept.find((r) => r.from > at);
            if (next) player.current!.goto(next.from - span.start, true);
            else (player.current!.pause(), setPlaying(false));
          }
        }
        for (const note of voice) {
          const element = audio.current.get(note.id);
          if (!element) continue;
          if (element.playbackRate !== speed) element.playbackRate = speed;
          const offset = (at - Number(note.startedAt)) / 1000;
          const inside = offset >= 0 && offset < Number(note.durationMs) / 1000;
          if (playing && inside) {
            if (Math.abs(element.currentTime - offset) > 0.3 * speed) element.currentTime = offset;
            if (element.paused) void element.play().catch(() => {});
          } else if (!element.paused) element.pause();
        }
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [span, playing, edits, voice, capture.startedAt, speed]);

  // The voice recordings. A changed list (a corrected transcript, a deleted note) loads them again:
  // the old elements go with their revoked URLs, so none plays a revoked or deleted note.
  useEffect(() => {
    let live = true;
    const urls: string[] = [];
    const elements = audio.current;
    for (const note of voice) {
      void client.readBlob(note.audio).then((blob) => {
        if (!live) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        elements.set(note.id, new Audio(url));
      });
    }
    return () => {
      live = false;
      for (const element of elements.values()) element.pause();
      elements.clear();
      urls.forEach(URL.revokeObjectURL);
    };
  }, [client, voice]);

  // Edits save shortly after each change. A failed save says so; Try again (or the next edit) saves again.
  const [saveFailed, setSaveFailed] = useState<string | null>(null);
  const [saveAttempt, setSaveAttempt] = useState(0);
  useEffect(() => {
    if (saved) return;
    const sent = edits;
    const timer = setTimeout(() => {
      client
        .request({ method: 'saveEdits', params: { capture: capture.id, edits: sent } })
        // A newer edit made during this save stays unsaved, so its own save still runs.
        .then(() => (setSaveFailed(null), latestEdits.current === sent && setSaved(true)))
        .catch((error: Error) => setSaveFailed(error.message));
    }, 500);
    return () => clearTimeout(timer);
  }, [client, capture.id, edits, saved, saveAttempt]);
  // Closing the tab before the edits are saved would lose them: the browser asks first.
  useEffect(() => {
    if (saved) return;
    const leave = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [saved]);

  const latestEdits = useRef(edits);
  latestEdits.current = edits;
  const change = (next: Edits) => (setEdits(next), setSaved(false));
  const seek = useCallback(
    (at: number) => {
      if (!span || !player.current) return;
      player.current.goto(Math.min(Math.max(at, span.start), span.end) - span.start, playing);
      setNow(at);
    },
    [span, playing],
  );
  function toggle() {
    if (!player.current || !span) return;
    if (playing) {
      player.current.pause();
      setPlaying(false);
    } else {
      const kept = keptRanges(edits, { start: Math.max(span.start, capture.startedAt), end: span.end });
      const inside = kept.some((r) => now >= r.from && now < r.to - 50);
      player.current.goto((inside ? now : (kept[0]?.from ?? span.start)) - span.start, true);
      setPlaying(true);
    }
  }

  // Space plays and pauses; the arrows jump five seconds, one with Shift. An open dialog (masking a
  // shot) keeps its keys, and a focused control keeps Space and its own arrows.
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (document.querySelector('dialog[open]')) return;
    if (target?.closest('input, textarea, select, [contenteditable], [role="slider"]') || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === ' ') {
      if (target?.closest('button, a, summary, video')) return;
      event.preventDefault();
      toggle();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (target?.closest('video')) return;
      event.preventDefault();
      const step = (event.shiftKey ? 1000 : 5000) * (event.key === 'ArrowLeft' ? -1 : 1);
      seek(now + step);
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    // A click on the replay (Highlight, a mark) focuses its iframe, whose keys never reach this
    // window: the replay needs no keyboard, so the focus comes straight back.
    const refocus = () =>
      setTimeout(() => {
        const active = document.activeElement;
        if (active instanceof HTMLIFrameElement && stage.current?.contains(active)) active.blur();
      });
    window.addEventListener('keydown', listener);
    window.addEventListener('blur', refocus);
    return () => {
      window.removeEventListener('keydown', listener);
      window.removeEventListener('blur', refocus);
    };
  }, []);

  // Speech, as words at their moments.
  const words = useMemo<Word[]>(
    () =>
      voice
        .flatMap((note) =>
          note.segments.map((s, index) => ({
            note: note.id,
            index,
            at: Number(note.startedAt) + Number(s.startMs),
            end: Number(note.startedAt) + Number(s.endMs),
            text: s.text,
          })),
        )
        .sort((a, b) => a.at - b.at),
    [voice],
  );
  /**
   * What happened, row by row: each spoken line, with what the person did and what failed from
   * that line until the next. Steps before the first line get a row of their own; a step done
   * again and again in a row shows once, with a count.
   */
  const rows = useMemo(() => {
    const out: Row[] = words.map((word) => ({ at: word.at, word, events: [] }));
    for (const step of steps) {
      let row = out.findLast((r) => r.at <= step.at);
      if (!row || (!words.length && row.events.length && !sameStep(row.events.at(-1)!, step))) {
        row = { at: step.at, word: null, events: [] };
        out.push(row);
        out.sort((a, b) => a.at - b.at);
      }
      const last = row.events.at(-1);
      if (last && sameStep(last, step)) last.count += 1;
      else row.events.push({ ...step, count: 1 });
    }
    return out;
  }, [words, steps]);
  const currentRow = rows.findLastIndex((r) => r.at <= now);
  // While it plays, the row being played stays in view.
  const side = useRef<HTMLElement>(null);
  useEffect(() => {
    if (playing) side.current?.querySelector('tr[data-state="selected"]')?.scrollIntoView({ block: 'nearest' });
  }, [currentRow, playing]);
  const caption = words.find((w) => now >= w.at && now <= w.end + 500)?.text;

  // Drawing and highlighting over the replay. Shapes are kept in the recorded page's CSS pixels.
  const frameGeometry = () => {
    const iframe = stage.current?.querySelector('iframe');
    if (!iframe) return null;
    const rect = iframe.getBoundingClientRect();
    // offsetWidth is the page's own width; the rect is scaled by the player's transform.
    return { iframe, rect, scale: rect.width / (iframe.offsetWidth || rect.width) };
  };
  useEffect(() => {
    const canvas = overlay.current;
    if (!canvas) return;
    // The canvas covers the stage; its own box is the one to size and to draw against.
    const box = canvas.getBoundingClientRect();
    const ratio = devicePixelRatio || 1;
    if (canvas.width !== Math.round(box.width * ratio) || canvas.height !== Math.round(box.height * ratio)) {
      canvas.width = Math.round(box.width * ratio);
      canvas.height = Math.round(box.height * ratio);
    }
    const context = canvas.getContext('2d')!;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, box.width, box.height);
    const geometry = frameGeometry();
    if (!geometry) return;
    const toCanvas = (p: Point) => ({
      x: geometry.rect.left - box.left + p.x * geometry.scale,
      y: geometry.rect.top - box.top + p.y * geometry.scale,
    });
    const line = (stroke: Stroke, color: string, width: number) => {
      context.strokeStyle = color;
      context.lineWidth = width;
      context.lineCap = context.lineJoin = 'round';
      context.beginPath();
      stroke.forEach((p, i) => {
        const at = toCanvas(p);
        if (i) context.lineTo(at.x, at.y);
        else context.moveTo(at.x, at.y);
      });
      context.stroke();
    };
    const visible = [
      ...edits.annotations.filter((a) => Math.abs(now - Number(a.at)) < DRAWING_SHOWS_MS).flatMap((a) => a.drawing),
      ...(draft?.drawing ?? []),
      ...strokes,
    ];
    for (const stroke of visible) {
      // A light halo under the red line keeps it readable on dark and light pages.
      line(stroke, 'rgba(255,255,255,0.9)', 6);
      line(stroke, '#ff2d55', 3);
    }
    if (hover) {
      const a = toCanvas({ x: hover.x, y: hover.y });
      const w = hover.width * geometry.scale;
      const h = hover.height * geometry.scale;
      context.fillStyle = 'rgba(0, 85, 240, 0.16)';
      context.fillRect(a.x, a.y, w, h);
      context.strokeStyle = '#0055f0';
      context.lineWidth = 2;
      context.strokeRect(a.x, a.y, w, h);
      context.font = '600 12px Inter, system-ui, sans-serif';
      const label = hover.label;
      const textWidth = context.measureText(label).width + 12;
      const top = a.y >= 24 ? a.y - 22 : a.y + h + 2;
      context.fillStyle = '#0055f0';
      context.fillRect(a.x, top, textWidth, 20);
      context.fillStyle = '#fff';
      context.fillText(label, a.x + 6, top + 14);
    }
  });

  const toPage = (event: ReactPointerEvent) => {
    const geometry = frameGeometry();
    if (!geometry) return null;
    return { x: (event.clientX - geometry.rect.left) / geometry.scale, y: (event.clientY - geometry.rect.top) / geometry.scale };
  };
  /** The element a person means at a point of the replay: the nearest control or text block. */
  function elementAt(p: Point): Element | null {
    const doc = frameGeometry()?.iframe.contentDocument;
    const at = doc?.elementFromPoint(p.x, p.y);
    if (!doc || !at || at === doc.body || at === doc.documentElement) return null;
    return at.closest('a,button,input,select,textarea,label,[role],[data-testid],h1,h2,h3,h4,h5,h6,img,li,td,p') ?? at;
  }
  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const p = toPage(event);
    if (!p) return;
    if (tool === 'highlight') {
      const target = elementAt(p);
      if (!target) return;
      const r = target.getBoundingClientRect();
      const box: Stroke = [
        { x: r.left, y: r.top },
        { x: r.right, y: r.top },
        { x: r.right, y: r.bottom },
        { x: r.left, y: r.bottom },
        { x: r.left, y: r.top },
      ];
      setTool(null);
      setHover(null);
      return startNote([box], [locatorOf(target)]);
    }
    if (tool !== 'draw') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setStrokes((s) => [...s, [p]]);
  }
  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const p = toPage(event);
    if (!p) return;
    if (tool === 'highlight') {
      const target = elementAt(p);
      if (!target) return setHover(null);
      const r = target.getBoundingClientRect();
      const name = describe(locatorOf(target));
      return setHover({ x: r.left, y: r.top, width: r.width, height: r.height, label: name.length > 60 ? `${name.slice(0, 57)}…` : name });
    }
    if (tool !== 'draw' || !(event.buttons & 1)) return;
    setStrokes((s) => (s.length ? [...s.slice(0, -1), [...s.at(-1)!, p].slice(0, 2000)] : s));
  }
  /** The page elements under a drawing, found in the replay's own DOM. */
  function elementsUnder(lines: Stroke[]): Locator[] {
    const found = new Map<string, Locator>();
    for (const p of lines.flatMap((line) => line.filter((_, i) => i % 6 === 0))) {
      const target = elementAt(p);
      if (!target) continue;
      const locator = locatorOf(target);
      if (!found.has(locator.css)) found.set(locator.css, locator);
      if (found.size >= ELEMENTS_PER_NOTE) break;
    }
    return [...found.values()];
  }

  function startNote(withDrawing: Stroke[] = [], elements?: Locator[]) {
    player.current?.pause();
    setPlaying(false);
    setDraft({ at: now, text: '', drawing: withDrawing, elements: elements ?? (withDrawing.length ? elementsUnder(withDrawing) : []) });
  }
  function choose(next: Tool) {
    if (tool === 'draw' && strokes.length) startNote(strokes);
    setStrokes([]);
    setHover(null);
    if (next && next !== tool) {
      player.current?.pause();
      setPlaying(false);
    }
    setTool(next === tool ? null : next);
  }
  function saveNote() {
    if (!draft || (!draft.text.trim() && !draft.drawing.length)) return setDraft(null);
    const note: Annotation = { id: crypto.randomUUID(), at: draft.at, text: draft.text.trim(), drawing: draft.drawing, elements: draft.elements };
    change({ ...edits, annotations: [...edits.annotations, note].sort((a, b) => Number(a.at) - Number(b.at)) });
    setDraft(null);
  }

  // The timeline: click to seek, drag to select a part to cut, handles to trim the ends.
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ from: number; moved: boolean } | null>(null);
  const timeAt = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    const share = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return span ? Math.round(span.start + share * (span.end - span.start)) : 0;
  };
  const left = (at: number) => (span ? `${((at - span.start) / Math.max(1, span.end - span.start)) * 100}%` : '0%');
  // Dragging scrubs through the replay; with the Cut tool on, it selects a part to cut instead.
  const scrub = useRef<{ resume: boolean; frame: number; at: number } | null>(null);
  function trackDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).dataset.handle || (event.target as HTMLElement).closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = timeAt(event.clientX);
    if (cutting) {
      dragging.current = { from: at, moved: false };
      return;
    }
    // Paused while scrubbing, so each frame shows the page at that moment; playing resumes after.
    const resume = playing;
    if (playing) {
      player.current?.pause();
      setPlaying(false);
    }
    scrub.current = { resume, frame: 0, at };
    show(at);
  }
  function trackMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (scrub.current) {
      const current = scrub.current;
      current.at = timeAt(event.clientX);
      setNow(current.at);
      if (!current.frame) {
        current.frame = requestAnimationFrame(() => {
          current.frame = 0;
          show(current.at);
        });
      }
      return;
    }
    const drag = dragging.current;
    if (!drag) return;
    const at = timeAt(event.clientX);
    if (Math.abs(at - drag.from) > (span ? (span.end - span.start) / 200 : 0)) drag.moved = true;
    if (drag.moved) setSelection({ from: Math.min(drag.from, at), to: Math.max(drag.from, at) });
  }
  function trackUp() {
    const current = scrub.current;
    if (current) {
      scrub.current = null;
      cancelAnimationFrame(current.frame);
      show(current.at);
      if (current.resume && span && player.current) {
        player.current.goto(current.at - span.start, true);
        setPlaying(true);
      }
      return;
    }
    dragging.current = null;
  }
  /** The page as it was at a moment, without playing. */
  function show(at: number) {
    if (!span || !player.current) return;
    const clamped = Math.min(Math.max(at, span.start), span.end);
    player.current.goto(clamped - span.start, false);
    setNow(clamped);
  }
  /** A trim never passes the other one: at least a second stays, so the save is never refused and a review never takes the ranges saved before. */
  function setTrim(which: 'trimStart' | 'trimEnd', at: number) {
    setEdits((current) => {
      if (!span) return current;
      const start = current.trimStart ?? span.start;
      const end = current.trimEnd ?? span.end;
      const value = which === 'trimStart' ? Math.min(at, end - 1000) : Math.max(at, start + 1000);
      return { ...current, [which]: Math.min(Math.max(value, span.start), span.end) };
    });
  }
  function trim(which: 'trimStart' | 'trimEnd', event: ReactPointerEvent<HTMLSpanElement>) {
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => setTrim(which, Math.round(timeAt(e.clientX)));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      setSaved(false);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  /** The arrows move a trim handle by a second, five with Shift. */
  function trimKey(which: 'trimStart' | 'trimEnd', from: number, event: ReactKeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setTrim(which, from + (event.shiftKey ? 5000 : 1000) * (event.key === 'ArrowLeft' ? -1 : 1));
    setSaved(false);
  }

  if (!capture.recording) return null;
  const marks: Mark[] = [
    ...steps.map((s) => ({ at: s.at, kind: s.error ? ('error' as const) : ('step' as const), label: s.text })),
    ...edits.annotations.map((a) => ({ at: Number(a.at), kind: 'note' as const, label: a.text || 'Drawing' })),
    ...markers.map((m) => ({ at: m.at, kind: 'marker' as const, label: m.label })),
  ];
  const trimStart = edits.trimStart ?? Math.max(span?.start ?? 0, capture.startedAt);
  const trimEnd = edits.trimEnd ?? span?.end ?? 0;
  const recorded = span ? { start: Math.max(span.start, capture.startedAt), end: span.end } : null;
  const kept = recorded ? keptRanges(edits, recorded) : [];
  const keptMs = kept.reduce((sum, r) => sum + (r.to - r.from), 0);
  // Activity that bounds the auto-trim: steps (clicks, typing, navigation), errors, markers and speech.
  const bounds = recorded
    ? autoTrimBounds([...steps.map((s) => s.at), ...markers.map((m) => m.at), ...words.flatMap((w) => [w.at, w.end])], recorded)
    : null;

  return (
    <section className="editor" aria-label="Recording editor">
      <div className="editor-main">
        <div className="stage-wrap">
          <div ref={stage} className="stage" />
          <canvas
            ref={overlay}
            className="draw-layer"
            data-tool={tool ?? undefined}
            aria-label={tool ? 'Drawing layer' : undefined}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerLeave={() => setHover(null)}
          />
          {caption && <p className="caption">{caption}</p>}
        </div>
        {capture.recording && siteImages !== null && (
          <label className="check small">
            <input type="checkbox" checked={siteImages} onChange={(e) => chooseSiteImages(e.target.checked)} />
            <span>
              Show images from the site
              <span className="muted"> (this replay then loads them from the site, so the site sees the visit)</span>
            </span>
          </label>
        )}

        <div className="controls" role="toolbar" aria-label="Playback">
          <button type="button" className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle} disabled={!span}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {playing ? (
                <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
              ) : (
                <path d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.2-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z" />
              )}
            </svg>
          </button>
          <span className="clock num" aria-label="Time">
            {span ? clock(now - span.start) : '0:00'}
            <span className="muted"> / {span ? clock(span.end - span.start) : '0:00'}</span>
          </span>
          <span className="spacer" />
          {selection ? (
            <>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => (change({ ...edits, cuts: [...edits.cuts, selection] }), setSelection(null), setCutting(false))}
              >
                Cut {clock(selection.to - selection.from)} out
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelection(null)}>
                Clear
              </button>
            </>
          ) : (
            cutting && <span className="small muted">Drag across the part to cut</span>
          )}
          <button
            type="button"
            className={cutting ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            aria-pressed={cutting}
            title="Select a part of the timeline to cut out"
            onClick={() => (setCutting(!cutting), setSelection(null))}
            disabled={!span}
          >
            <CutIcon /> Cut
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => startNote()} disabled={!span}>
            <AddNoteIcon /> Note
          </button>
          <button
            type="button"
            className={tool === 'highlight' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            aria-pressed={tool === 'highlight'}
            title="Point at an element and click it"
            onClick={() => choose('highlight')}
            disabled={!span}
          >
            <TargetIcon /> {tool === 'highlight' ? 'Click an element' : 'Highlight'}
          </button>
          <button
            type="button"
            className={tool === 'draw' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            aria-pressed={tool === 'draw'}
            onClick={() => choose('draw')}
            disabled={!span}
          >
            <PenIcon /> {tool === 'draw' ? 'Done drawing' : 'Draw'}
          </button>
        </div>

        <TimelineNav
          disabled={!span}
          now={now}
          speed={speed}
          onSpeed={setSpeed}
          errors={steps.filter((s) => s.error).map((s) => s.at)}
          steps={steps.filter((s) => !s.error).map((s) => s.at)}
          markers={markers.map((m) => m.at)}
          speech={words.map((w) => w.at)}
          onSeek={seek}
          onAutoTrim={bounds && (() => change({ ...edits, ...bounds }))}
          trimmed={edits.trimStart !== null || edits.trimEnd !== null}
          onResetTrim={() => change({ ...edits, trimStart: null, trimEnd: null })}
        />

        <div
          ref={track}
          className="timeline"
          aria-label="Timeline"
          onPointerDown={trackDown}
          onPointerMove={(e) => (trackMove(e), setPointer(timeAt(e.clientX)))}
          data-cutting={cutting || undefined}
          onPointerUp={trackUp}
          onPointerCancel={trackUp}
          onPointerLeave={() => setPointer(null)}
        >
          {span && (
            <>
              <span className="ruler" aria-hidden="true">
                {ticks(span.end - span.start).map((t) => (
                  <span key={t} className="tick" style={{ left: left(span.start + t) }}>
                    {clock(t)}
                  </span>
                ))}
              </span>
              <span className="lane lane-marks" aria-hidden="true" />
              <span className="lane lane-speech" aria-hidden="true" />
              <span className="played" style={{ left: left(trimStart), width: `max(0px, calc(${left(now)} - ${left(trimStart)}))` }} />
              <span className="trimmed" style={{ left: 0, width: left(trimStart) }} />
              <span className="trimmed" style={{ left: left(trimEnd), right: 0 }} />
              {edits.cuts.map((c, i) => (
                <span key={i} className="cut" style={{ left: left(c.from), width: `calc(${left(c.to)} - ${left(c.from)})` }}>
                  <button
                    type="button"
                    className="cut-remove"
                    aria-label="Restore this part"
                    title="Restore this part"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => change({ ...edits, cuts: edits.cuts.filter((_, j) => j !== i) })}
                  >
                    ×
                  </button>
                </span>
              ))}
              {words.map((w, i) => (
                <span key={`w${i}`} className="speech" style={{ left: left(w.at), width: `calc(${left(w.end)} - ${left(w.at)})` }} title={w.text} />
              ))}
              {marks.map((m, i) => (
                <span key={`m${i}`} className="mark" data-kind={m.kind} style={{ left: left(m.at) }} title={m.label} />
              ))}
              {selection && (
                <span className="selection" style={{ left: left(selection.from), width: `calc(${left(selection.to)} - ${left(selection.from)})` }} />
              )}
              {(
                [
                  ['trimStart', 'start', trimStart, 'Trim the start'],
                  ['trimEnd', 'end', trimEnd, 'Trim the end'],
                ] as const
              ).map(([which, handle, at, name]) => (
                <span
                  key={handle}
                  className="handle"
                  data-handle={handle}
                  style={{ left: left(at) }}
                  role="slider"
                  tabIndex={0}
                  aria-label={name}
                  aria-valuemin={0}
                  aria-valuemax={span.end - span.start}
                  aria-valuenow={at - span.start}
                  aria-valuetext={clock(at - span.start)}
                  onPointerDown={(e) => trim(which, e)}
                  onKeyDown={(e) => trimKey(which, at, e)}
                  title={`Drag to ${name.toLowerCase()}, or use the arrow keys`}
                />
              ))}
              {pointer !== null && !dragging.current && (
                <span className="hover-time num" style={{ left: left(pointer) }}>
                  {clock(pointer - span.start)}
                </span>
              )}
              <span className="playhead" style={{ left: left(now) }} />
            </>
          )}
        </div>
        {capture.shots.length > 0 && (
          <Filmstrip
            client={client}
            shots={capture.shots}
            hidden={edits.hiddenShots}
            masks={edits.shotMasks}
            start={span?.start ?? capture.startedAt}
            onSeek={seek}
            onMask={(at, areas) =>
              change({
                ...edits,
                shotMasks: [...edits.shotMasks.filter((m) => Number(m.at) !== at), ...(areas.length > 0 ? [{ at, areas }] : [])],
              })
            }
            onToggle={(at) =>
              change({
                ...edits,
                hiddenShots: edits.hiddenShots.includes(at)
                  ? edits.hiddenShots.filter((h) => h !== at)
                  : [...edits.hiddenShots, at],
              })
            }
          />
        )}
        {video && <VideoCapturePreview client={client} video={video} name={`capture-${capture.id}`} />}
        {(edits.cuts.length > 0 || edits.trimStart !== null || edits.trimEnd !== null) && (
          <p className="small muted">
            Only the kept parts leave. The replay of each part starts from the page as it was then.
          </p>
        )}
        <p className="small muted num" role="status" aria-label="Edits">
          {span && `${clock(keptMs)} of ${clock(span.end - span.start)} kept · ${edits.annotations.length} notes · ${saved ? 'Saved' : saveFailed ? 'Not saved' : 'Saving…'}`}
        </p>
        {!saved && saveFailed && (
          <div role="alert" className="notice">
            <span>
              Your edits are not saved: {saveFailed}.{' '}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setSaveFailed(null), setSaveAttempt((n) => n + 1))}>
                Try again
              </button>
            </span>
          </div>
        )}

        {draft && (
          <div className="note-draft card" role="dialog" aria-label="New note">
            <span className="small muted num">
              At {span ? clock(draft.at - span.start) : ''}
              {draft.elements.length ? ` · marks ${draft.elements.map(describe).join(', ')}` : ''}
            </span>
            <textarea
              className="textarea"
              rows={2}
              autoFocus
              aria-label="Note"
              placeholder="What is wrong here, and what did you expect?"
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              onKeyDown={(e) => (e.key === 'Enter' && (e.metaKey || e.ctrlKey) ? saveNote() : undefined)}
            />
            <div className="note-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft(null)}>
                Discard
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={saveNote}>
                Add note
              </button>
            </div>
          </div>
        )}
        {problem && (
          <div role="alert" className="notice">
            {problem}
          </div>
        )}
      </div>

      <aside className="editor-side" ref={side}>
        {/* Words appear as each note is written down; the others say where they are. */}
        {voice.map((note, index) => (
          <VoiceProgress
            key={note.id}
            client={client}
            note={note}
            label={voice.length > 1 ? `Voice note ${index + 1}` : undefined}
            onChange={(changed) => onVoice?.(changed)}
          />
        ))}
        <WhatHappened
          client={client}
          voice={voice}
          rows={rows}
          currentRow={currentRow}
          start={span?.start ?? null}
          onSeek={seek}
          onVoice={onVoice}
          onProblem={setProblem}
        />
        <section aria-label="Notes">
          <h3 className="label">Notes</h3>
          {edits.annotations.length ? (
            <ol className="lines">
              {edits.annotations.map((a) => (
                <li key={a.id}>
                  <button type="button" className="line" onClick={() => seek(Number(a.at))}>
                    <span className="num muted">{span ? clock(Number(a.at) - span.start) : ''}</span> {a.text || 'Drawing'}
                    {a.elements.length > 0 && <span className="muted"> · {a.elements.map(describe).join(', ')}</span>}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    aria-label="Delete note"
                    onClick={() => change({ ...edits, annotations: edits.annotations.filter((x) => x.id !== a.id) })}
                  >
                    <DeleteIcon />
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="small muted">Pause where something is wrong and add a note, or draw on it.</p>
          )}
        </section>
      </aside>
    </section>
  );
}

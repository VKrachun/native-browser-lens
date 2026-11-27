import { HugeiconsIcon } from '@hugeicons/react';
import {
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  Camera01Icon,
  CheckmarkCircle02Icon,
  Compass01Icon,
  Copy01Icon,
  CpuIcon,
  Download04Icon,
  EraserIcon,
  FloppyDiskIcon,
  ImageNotFound01Icon,
  LinkSquare02Icon,
  PencilEdit02Icon,
  PlayCircleIcon,
  Rocket01Icon,
  Settings02Icon,
  Shield01Icon,
  SlidersHorizontalIcon,
  SquareIcon,
  ArrowUpRight01Icon,
  SparklesIcon,
  TaskDone02Icon,
  ViewOffSlashIcon,
  Mic01Icon,
  StopCircleIcon,
  Delete02Icon,
  NoteAddIcon,
  CursorPointer01Icon,
  ScissorIcon,
} from '@hugeicons/core-free-icons';

/** Studio's icon set (Hugeicons) at Studio's 1.5px stroke. */
function make(icon: typeof Camera01Icon) {
  return function Icon({ size = 16, label }: { size?: number; label?: string }) {
    return (
      <HugeiconsIcon
        icon={icon}
        size={size}
        strokeWidth={1.5}
        aria-hidden={label ? undefined : true}
        aria-label={label}
      />
    );
  };
}

export const CameraIcon = make(Camera01Icon);
export const SettingsIcon = make(Settings02Icon);
export const BackIcon = make(ArrowLeft01Icon);
export const NextIcon = make(ArrowRight01Icon);
export const AlertIcon = make(Alert02Icon);
export const DoneIcon = make(CheckmarkCircle02Icon);
export const CompassIcon = make(Compass01Icon);
export const AgentIcon = make(CpuIcon);
export const ShieldIcon = make(Shield01Icon);
export const SlidersIcon = make(SlidersHorizontalIcon);
export const RocketIcon = make(Rocket01Icon);
export const CopyIcon = make(Copy01Icon);
export const ExportIcon = make(Download04Icon);
export const PenIcon = make(PencilEdit02Icon);
export const PlayIcon = make(PlayCircleIcon);
export const RectangleIcon = make(SquareIcon);
export const ArrowIcon = make(ArrowUpRight01Icon);
export const MaskIcon = make(ViewOffSlashIcon);
export const UndoIcon = make(ArrowTurnBackwardIcon);
export const SaveIcon = make(FloppyDiskIcon);
export const DraftIcon = make(SparklesIcon);
export const FileIcon = make(TaskDone02Icon);
export const LinkIcon = make(LinkSquare02Icon);
export const MissingImageIcon = make(ImageNotFound01Icon);
export const EraseIcon = make(EraserIcon);
export const MicIcon = make(Mic01Icon);
export const StopIcon = make(StopCircleIcon);
export const DeleteIcon = make(Delete02Icon);
export const AddNoteIcon = make(NoteAddIcon);
export const TargetIcon = make(CursorPointer01Icon);
export const CutIcon = make(ScissorIcon);

/** The Lens logo: viewfinder corners around a lens. It takes the color of `.mark`. */
export function LensMark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round">
      <path d="M3.5 8V5.5a2 2 0 0 1 2-2H8M16 3.5h2.5a2 2 0 0 1 2 2V8M20.5 16v2.5a2 2 0 0 1-2 2H16M8 20.5H5.5a2 2 0 0 1-2-2V16" strokeWidth="2" />
      <circle cx="12" cy="12" r="3.6" strokeWidth="2" />
    </svg>
  );
}

import { memo, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AudioLines, Eye, EyeOff, Film, GripVertical, Layers, Lock, LockOpen, Type, Volume2, VolumeX } from "lucide-react";
import type { Track } from "@/lib/video/timelineSchema";
import type { Translations } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const KIND_ICON = { video: Film, audio: AudioLines, text: Type, overlay: Layers } as const;

export interface TrackHeaderProps {
  track: Track;
  height: number;
  selected: boolean;
  editing: boolean;
  t: Translations["videoTimeline"];
  onSelect(trackId: string): void;
  onEdit(trackId: string | null): void;
  onRename(trackId: string, name: string): void;
  onToggle(trackId: string, flag: "hidden" | "muted" | "locked"): void;
  onVolume(trackId: string, volume: number): void;
  onReorderStart(e: ReactPointerEvent, trackId: string): void;
  onResizeStart(e: ReactPointerEvent, trackId: string): void;
  onResetHeight(trackId: string): void;
  onContextMenu(e: ReactMouseEvent, trackId: string): void;
}

export const TrackHeader = memo(function TrackHeader(p: TrackHeaderProps) {
  const { track, t } = p;
  const Icon = KIND_ICON[track.kind];
  const hasAudio = track.kind === "audio" || track.kind === "video";
  const showVolume = hasAudio && p.height >= 52;
  return (
    <div
      className={cn(
        "group/header relative flex select-none flex-col justify-center gap-1 overflow-hidden border-b border-r border-bg-300 bg-bg-100 pl-1 pr-1.5",
        p.selected && "bg-bg-200",
      )}
      style={{ height: p.height }}
      onPointerDown={() => p.onSelect(track.id)}
      onContextMenu={(e) => p.onContextMenu(e, track.id)}
    >
      <div className="flex min-w-0 items-center gap-1">
        <span
          className="flex h-5 w-3.5 shrink-0 cursor-grab items-center justify-center text-text-500 opacity-0 transition-opacity group-hover/header:opacity-100"
          onPointerDown={(e) => {
            e.stopPropagation();
            p.onReorderStart(e, track.id);
          }}
          aria-hidden
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
        <Icon className="h-3.5 w-3.5 shrink-0 text-text-400" aria-hidden />
        {p.editing ? (
          <NameInput name={track.name} onDone={(name) => (name === null ? p.onEdit(null) : p.onRename(track.id, name))} />
        ) : (
          <span
            className={cn("min-w-0 flex-1 truncate text-[12px] font-medium text-text-200", track.hidden && "text-text-400")}
            onDoubleClick={() => p.onEdit(track.id)}
          >
            {track.name}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center">
          <HeaderToggle
            on={!!track.hidden}
            label={track.hidden ? t.showTrack : t.hideTrack}
            onClick={() => p.onToggle(track.id, "hidden")}
            icon={track.hidden ? EyeOff : Eye}
          />
          {hasAudio && (
            <HeaderToggle
              on={!!track.muted}
              label={track.muted ? t.unmuteTrack : t.muteTrack}
              onClick={() => p.onToggle(track.id, "muted")}
              icon={track.muted ? VolumeX : Volume2}
            />
          )}
          <HeaderToggle
            on={!!track.locked}
            label={track.locked ? t.unlockTrack : t.lockTrack}
            onClick={() => p.onToggle(track.id, "locked")}
            icon={track.locked ? Lock : LockOpen}
          />
        </div>
      </div>
      {showVolume && (
        <div className="flex items-center gap-1.5 pl-[22px] pr-1" onPointerDown={(e) => e.stopPropagation()}>
          <input
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={track.volume ?? 1}
            aria-label={t.volume}
            disabled={track.muted}
            onChange={(e) => p.onVolume(track.id, Number(e.target.value))}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--accent)] disabled:opacity-40"
          />
          <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-text-400">
            {Math.round((track.volume ?? 1) * 100)}%
          </span>
        </div>
      )}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t.resizeTrack}
        className="absolute inset-x-0 bottom-0 h-[5px] cursor-row-resize hover:bg-accent/40"
        onPointerDown={(e) => {
          e.stopPropagation();
          p.onResizeStart(e, track.id);
        }}
        onDoubleClick={() => p.onResetHeight(track.id)}
      />
    </div>
  );
});

function HeaderToggle({ on, label, onClick, icon: Icon }: { on: boolean; label: string; onClick(): void; icon: typeof Eye }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      data-tooltip={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded-[4px] hover:bg-bg-200",
        on ? "text-accent" : "text-text-400 hover:text-text-200",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function NameInput({ name, onDone }: { name: string; onDone(name: string | null): void }) {
  const [value, setValue] = useState(name);
  return (
    <input
      autoFocus
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(value);
        if (e.key === "Escape") onDone(null);
      }}
      onBlur={() => onDone(value)}
      className="h-5 min-w-0 flex-1 rounded-[4px] border border-accent bg-bg-100 px-1 text-[12px] text-text-100 outline-none"
    />
  );
}

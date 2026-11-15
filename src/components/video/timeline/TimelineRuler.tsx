import { memo, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Marker } from "@/lib/video/timelineSchema";
import { usePlayhead } from "@/lib/video/timelineStore";
import { cn } from "@/lib/utils";
import { RULER_HEIGHT, rulerLabel, rulerStep } from "./geometry";

export interface TimelineRulerProps {
  width: number;
  zoom: number;
  fps: number;
  durationInFrames: number;
  viewLeft: number;
  viewRight: number;
  markers: Marker[];
  selectedMarkerId: string | null;
  editingMarkerId: string | null;
  inPoint: number | null;
  outPoint: number | null;
  markerLabel: string;
  onScrubStart(e: ReactPointerEvent): void;
  onMarkerPointerDown(e: ReactPointerEvent, markerId: string): void;
  onMarkerContextMenu(e: ReactMouseEvent, markerId: string): void;
  onMarkerEdit(markerId: string | null): void;
  onMarkerRename(markerId: string, label: string): void;
}

export const TimelineRuler = memo(function TimelineRuler(p: TimelineRulerProps) {
  const { major, minor } = rulerStep(p.zoom, p.fps);
  const withFrames = major < Math.round(p.fps);
  const firstFrame = Math.max(0, Math.floor(p.viewLeft / p.zoom / major) * major);
  const lastFrame = p.viewRight / p.zoom;
  const ticks: { x: number; major: boolean; frame: number }[] = [];
  const sub = major / minor;
  for (let f = firstFrame; f <= lastFrame; f += sub) {
    ticks.push({ x: f * p.zoom, major: f % major === 0, frame: f });
  }
  const endX = p.durationInFrames * p.zoom;

  return (
    <div
      className="relative shrink-0 cursor-text border-b border-bg-300 bg-bg-100"
      style={{ width: p.width, height: RULER_HEIGHT }}
      onPointerDown={p.onScrubStart}
    >
      {/* Past the composition end. */}
      <div className="pointer-events-none absolute inset-y-0 right-0 bg-bg-200/70" style={{ left: endX }} />
      {p.inPoint !== null || p.outPoint !== null ? (
        <div
          className="pointer-events-none absolute bottom-0 h-[4px] bg-accent/70"
          style={{
            left: (p.inPoint ?? 0) * p.zoom,
            width: Math.max(1, ((p.outPoint ?? p.durationInFrames) - (p.inPoint ?? 0)) * p.zoom),
          }}
        />
      ) : null}
      <svg className="pointer-events-none absolute inset-0" width="100%" height={RULER_HEIGHT} aria-hidden>
        {ticks.map((tick) => (
          <line
            key={tick.frame}
            x1={tick.x + 0.5}
            x2={tick.x + 0.5}
            y1={tick.major ? 12 : 20}
            y2={RULER_HEIGHT}
            className={tick.major ? "stroke-text-400" : "stroke-bg-300"}
            strokeWidth={1}
          />
        ))}
      </svg>
      {ticks
        .filter((tick) => tick.major)
        .map((tick) => (
          <span
            key={tick.frame}
            className="pointer-events-none absolute top-[2px] whitespace-nowrap pl-1 font-mono text-[10.5px] tabular-nums text-text-400"
            style={{ left: tick.x }}
          >
            {rulerLabel(tick.frame, p.fps, withFrames)}
          </span>
        ))}
      {p.markers.map((m) => (
        <MarkerFlag key={m.id} marker={m} {...p} />
      ))}
      <PlayheadHead zoom={p.zoom} />
    </div>
  );
});

function MarkerFlag(p: TimelineRulerProps & { marker: Marker }) {
  const { marker } = p;
  const x = marker.frame * p.zoom;
  const editing = p.editingMarkerId === marker.id;
  const color = marker.color ?? "var(--warning)";
  return (
    <div
      className="absolute bottom-0 z-10 flex items-end"
      style={{ left: x - 5 }}
      onPointerDown={(e) => {
        e.stopPropagation();
        p.onMarkerPointerDown(e, marker.id);
      }}
      onContextMenu={(e) => p.onMarkerContextMenu(e, marker.id)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        p.onMarkerEdit(marker.id);
      }}
      data-tooltip={editing ? undefined : marker.label || p.markerLabel}
    >
      <svg width="10" height="13" viewBox="0 0 10 13" className="cursor-grab" aria-hidden>
        <path
          d="M0.5 0.5h9v8l-4.5 4-4.5-4z"
          fill={color}
          className={cn(p.selectedMarkerId === marker.id ? "stroke-text-100" : "stroke-bg-100")}
          strokeWidth={1}
        />
      </svg>
      {editing ? (
        <MarkerInput marker={marker} onDone={(label) => (label === null ? p.onMarkerEdit(null) : p.onMarkerRename(marker.id, label))} />
      ) : (
        marker.label && (
          <span className="mb-[1px] ml-0.5 max-w-[120px] truncate text-[10.5px] font-medium text-text-200">{marker.label}</span>
        )
      )}
    </div>
  );
}

function MarkerInput({ marker, onDone }: { marker: Marker; onDone(label: string | null): void }) {
  const [value, setValue] = useState(marker.label);
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(value.trim());
        if (e.key === "Escape") onDone(null);
      }}
      onBlur={() => onDone(value.trim())}
      className="mb-[1px] ml-0.5 h-[18px] w-[120px] rounded-[4px] border border-accent bg-bg-100 px-1 text-[11px] text-text-100 outline-none"
    />
  );
}

/** The playhead's grip on the ruler; subscribes to the playhead on its own. */
function PlayheadHead({ zoom }: { zoom: number }) {
  const frame = usePlayhead();
  return (
    <div className="pointer-events-none absolute bottom-0 z-20 -translate-x-1/2" style={{ left: frame * zoom + 0.5 }}>
      <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden>
        <path d="M0.5 0.5h10v6.5l-5 4.5-5-4.5z" className="fill-danger" />
      </svg>
    </div>
  );
}

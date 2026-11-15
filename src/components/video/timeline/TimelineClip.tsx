import { memo, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { AudioLines, Braces, Captions, Film, Image, Plus, Shapes, Type } from "lucide-react";
import type { Asset, Clip, ClipType } from "@/lib/video/timelineSchema";
import { assetFramesInComp, keyframeFrames } from "@/lib/video/timelineOps";
import { cn } from "@/lib/utils";
import { TRIM_HANDLE_PX } from "./geometry";
import { useThumbnails, useWaveform, type MediaProject } from "./mediaCache";

export type ClipPart = "body" | "start" | "end";

/** Colours per clip type; translucent so they read on both themes. */
const TYPE_STYLE: Record<ClipType, { box: string; icon: string; wave: string }> = {
  video: { box: "bg-sky-500/20 border-sky-500/55", icon: "text-sky-600 dark:text-sky-300", wave: "fill-sky-600/60 dark:fill-sky-300/60" },
  image: { box: "bg-teal-500/20 border-teal-500/55", icon: "text-teal-600 dark:text-teal-300", wave: "" },
  audio: { box: "bg-emerald-500/20 border-emerald-500/55", icon: "text-emerald-700 dark:text-emerald-300", wave: "fill-emerald-600/70 dark:fill-emerald-300/70" },
  text: { box: "bg-amber-500/20 border-amber-500/55", icon: "text-amber-700 dark:text-amber-300", wave: "" },
  shape: { box: "bg-violet-500/20 border-violet-500/55", icon: "text-violet-600 dark:text-violet-300", wave: "" },
  scene: { box: "bg-pink-500/20 border-pink-500/55", icon: "text-pink-600 dark:text-pink-300", wave: "" },
  captions: { box: "bg-orange-500/20 border-orange-500/55", icon: "text-orange-700 dark:text-orange-300", wave: "" },
};

const TYPE_ICON = { video: Film, image: Image, audio: AudioLines, text: Type, shape: Shapes, scene: Braces, captions: Captions } as const;

export interface TimelineClipProps {
  clip: Clip;
  asset: Asset | undefined;
  project: MediaProject | null;
  fps: number;
  zoom: number;
  height: number;
  selected: boolean;
  /** The agent just edited it. */
  agentTouched?: boolean;
  locked: boolean;
  dimmed: boolean;
  /** Draw keyframe diamonds (the only selected clip). */
  showKeyframes: boolean;
  /** Touches the previous clip, so a transition can join them. */
  canTransition: boolean;
  /** Visible part of the lane, in px from the lane origin, rounded so scrolling re-renders rarely. */
  viewLeft: number;
  viewRight: number;
  typeLabel: string;
  addTransitionLabel: string;
  transitionLabel: string;
  keyframeLabel: string;
  onPointerDown(e: ReactPointerEvent, clipId: string, part: ClipPart): void;
  onContextMenu(e: ReactMouseEvent, clipId: string): void;
  onKeyframePointerDown(e: ReactPointerEvent, clipId: string, frame: number): void;
  onKeyframeDelete(clipId: string, frame: number): void;
  onTransitionPointerDown(e: ReactPointerEvent, clipId: string): void;
  onAddTransition(clipId: string): void;
  onRemoveTransition(clipId: string): void;
}

function clipLabel(clip: Clip, asset: Asset | undefined, typeLabel: string): string {
  if (clip.name) return clip.name;
  if (clip.type === "text") return clip.text;
  if (clip.type === "scene") return clip.exportName;
  return asset?.name ?? typeLabel;
}

export const TimelineClip = memo(function TimelineClip(p: TimelineClipProps) {
  const { clip, zoom, height } = p;
  const left = clip.from * zoom;
  const width = Math.max(2, clip.durationInFrames * zoom);
  const style = TYPE_STYLE[clip.type];
  const Icon = TYPE_ICON[clip.type];
  const label = clipLabel(clip, p.asset, p.typeLabel);
  // The part of the clip on screen, relative to the clip's left edge.
  const visFrom = Math.max(0, p.viewLeft - left);
  const visTo = Math.min(width, p.viewRight - left);
  const roomy = width > 36;
  const transition = clip.transitionIn;

  return (
    <div
      data-clip-id={clip.id}
      className={cn(
        "group/clip absolute top-[3px] overflow-hidden rounded-[5px] border select-none",
        style.box,
        p.selected && "border-accent ring-1 ring-inset ring-accent",
        p.agentTouched && "ring-2 ring-inset ring-amber-400 motion-safe:animate-pulse",
        p.dimmed && "opacity-45",
        p.locked ? "cursor-default" : "cursor-grab active:cursor-grabbing",
      )}
      style={{ left, width, height: height - 6 }}
      onPointerDown={(e) => p.onPointerDown(e, clip.id, "body")}
      onContextMenu={(e) => p.onContextMenu(e, clip.id)}
    >
      {(clip.type === "video" || clip.type === "image") && (
        <ThumbStrip {...p} width={width} visFrom={visFrom} visTo={visTo} />
      )}
      {clip.type === "audio" && <Waveform {...p} width={width} visFrom={visFrom} visTo={visTo} className={style.wave} />}

      {transition && transition.kind !== "none" && (
        <div
          className="absolute inset-y-0 left-0 border-r border-accent/70 bg-[repeating-linear-gradient(135deg,transparent_0_5px,color-mix(in_srgb,var(--accent)_22%,transparent)_5px_7px)]"
          style={{ width: Math.min(width, transition.durationInFrames * zoom) }}
          data-tooltip={p.transitionLabel.replace("{kind}", transition.kind)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            p.onRemoveTransition(clip.id);
          }}
        >
          {!p.locked && (
            <span
              className="absolute inset-y-0 -right-[3px] w-[6px] cursor-ew-resize"
              onPointerDown={(e) => {
                e.stopPropagation();
                p.onTransitionPointerDown(e, clip.id);
              }}
            />
          )}
        </div>
      )}

      {roomy && (
        <div className="pointer-events-none relative flex h-[18px] items-center gap-1 px-1.5" style={{ maxWidth: width }}>
          <Icon className={cn("h-3 w-3 shrink-0", style.icon)} aria-hidden />
          <span className="truncate text-[11px] font-medium leading-none text-text-100 [text-shadow:0_0_3px_var(--bg-100)]">{label}</span>
        </div>
      )}

      {p.canTransition && !transition && !p.locked && width > 28 && (
        <button
          type="button"
          aria-label={p.addTransitionLabel}
          data-tooltip={p.addTransitionLabel}
          className="absolute left-[7px] bottom-[3px] hidden h-4 w-4 items-center justify-center rounded-[4px] border border-bg-300 bg-bg-100 text-text-300 hover:text-text-100 group-hover/clip:flex"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            p.onAddTransition(clip.id);
          }}
        >
          <Plus className="h-3 w-3" />
        </button>
      )}

      {p.showKeyframes && <KeyframeDiamonds {...p} width={width} />}

      {!p.locked && (
        <>
          <span
            className="absolute inset-y-0 left-0 cursor-ew-resize hover:bg-accent/30"
            style={{ width: Math.min(TRIM_HANDLE_PX, width / 3) }}
            onPointerDown={(e) => {
              e.stopPropagation();
              p.onPointerDown(e, clip.id, "start");
            }}
          />
          <span
            className="absolute inset-y-0 right-0 cursor-ew-resize hover:bg-accent/30"
            style={{ width: Math.min(TRIM_HANDLE_PX, width / 3) }}
            onPointerDown={(e) => {
              e.stopPropagation();
              p.onPointerDown(e, clip.id, "end");
            }}
          />
        </>
      )}
    </div>
  );
});

type StripProps = TimelineClipProps & { width: number; visFrom: number; visTo: number };

/** Video frames (or the image) tiled along the clip, each tile showing the source frame at its
 *  position. Only tiles on screen are drawn. */
function ThumbStrip(p: StripProps) {
  const tileH = p.height - 8;
  const tileW = Math.max(24, Math.round((tileH * 16) / 9));
  const isVideo = p.clip.type === "video";
  const count = isVideo ? 24 : 1;
  const urls = useThumbnails(p.project, p.asset?.id ?? null, count);
  if (urls.length === 0 || p.visTo <= p.visFrom) return null;
  const total = isVideo ? assetFramesInComp(p.asset, p.fps) : Infinity;
  const rate = p.clip.type === "video" ? p.clip.playbackRate ?? 1 : 1;
  const trimStart = p.clip.type === "video" ? p.clip.trimStart : 0;
  const first = Math.floor(p.visFrom / tileW);
  const last = Math.min(Math.ceil(p.visTo / tileW), first + 80);
  const tiles: { x: number; url: string }[] = [];
  for (let i = first; i < last; i++) {
    const x = i * tileW;
    let idx = 0;
    if (isVideo && Number.isFinite(total) && total > 0) {
      const srcFrame = trimStart + ((x + tileW / 2) / p.zoom) * rate;
      idx = Math.min(urls.length - 1, Math.max(0, Math.floor((srcFrame / total) * urls.length)));
    }
    tiles.push({ x, url: urls[idx] });
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 top-0 opacity-70">
      {tiles.map((tile) => (
        <img
          key={tile.x}
          src={tile.url}
          alt=""
          draggable={false}
          className="absolute top-0 h-full object-cover"
          style={{ left: tile.x, width: tileW }}
        />
      ))}
    </div>
  );
}

function Waveform(p: StripProps & { className: string }) {
  const total = assetFramesInComp(p.asset, p.fps);
  const buckets = Number.isFinite(total) ? Math.min(4000, Math.max(200, Math.round(total / 2))) : 1000;
  const peaks = useWaveform(p.project, p.asset?.id ?? null, buckets);
  if (peaks.length === 0 || p.visTo <= p.visFrom) return null;
  const trimStart = p.clip.type === "audio" ? p.clip.trimStart : 0;
  const framesTotal = Number.isFinite(total) ? total : p.clip.durationInFrames + trimStart;
  const h = p.height - 6;
  // Under the name row when there is room; on a thin track the name sits over the wave.
  const reserved = h >= 34 ? 18 : 0;
  const mid = reserved + (h - reserved) / 2;
  const amp = Math.max(1, (h - reserved) / 2 - 2);
  const step = 2;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let x = Math.floor(p.visFrom / step) * step; x <= p.visTo; x += step) {
    const frame = trimStart + x / p.zoom;
    const i = Math.floor((frame / framesTotal) * peaks.length);
    const v = i >= 0 && i < peaks.length ? peaks[i] : 0;
    const dy = Math.max(0.5, v * amp);
    top.push(`${x},${(mid - dy).toFixed(1)}`);
    bottom.push(`${x},${(mid + dy).toFixed(1)}`);
  }
  return (
    <svg className="pointer-events-none absolute left-0 top-0" width={p.width} height={h} aria-hidden>
      <polygon className={p.className} points={[...top, ...bottom.reverse()].join(" ")} />
    </svg>
  );
}

function KeyframeDiamonds(p: TimelineClipProps & { width: number }) {
  const frames = keyframeFrames(p.clip).filter((k) => k.frame >= 0 && k.frame <= p.clip.durationInFrames);
  return (
    <div className="absolute inset-x-0 bottom-[2px] h-[10px]">
      {frames.map((k) => (
        <span
          key={k.frame}
          role="button"
          tabIndex={-1}
          aria-label={p.keyframeLabel}
          data-tooltip={`${p.keyframeLabel} · ${k.paths.join(", ")}`}
          className="absolute top-0 h-[9px] w-[9px] -translate-x-1/2 rotate-45 cursor-ew-resize rounded-[1px] border border-bg-100 bg-amber-400 hover:bg-amber-300"
          style={{ left: Math.min(p.width - 5, Math.max(5, k.frame * p.zoom)) }}
          onPointerDown={(e) => {
            e.stopPropagation();
            p.onKeyframePointerDown(e, p.clip.id, k.frame);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            p.onKeyframeDelete(p.clip.id, k.frame);
          }}
        />
      ))}
    </div>
  );
}

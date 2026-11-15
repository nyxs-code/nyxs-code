import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Grid3x3,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  ScanLine,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ACTIVE_TOGGLE } from "@/lib/uiClasses";
import { usePlayhead, useTimelineStore } from "@/lib/video/timelineStore";
import { Button } from "@/components/ui/button";
import { formatTimecode, parseTimecode } from "./timecode";
import { PLAYBACK_RATES, type PlayerActions, type PlayerState, type PlayerZoom } from "./usePlayer";

const ZOOMS: PlayerZoom[] = ["fit", 0.5, 1, 2];

interface Props {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  state: PlayerState;
  actions: PlayerActions;
  /** The project's latest still, shown until the player is ready. */
  poster: string | null;
}

/** The center of the editor: the player iframe and its transport. */
export function PlayerPane({ iframeRef, state, actions, poster }: Props) {
  const t = useTranslations().videoPanel;
  const boxRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const comp = useTimelineStore((s) => s.timeline?.compositions.find((c) => c.id === s.compositionId) ?? null);
  const playhead = usePlayhead();
  const fps = comp?.fps ?? 30;
  const duration = comp?.durationInFrames ?? 1;

  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === boxRef.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void boxRef.current?.requestFullscreen().catch(() => {});
  };

  const waiting = !state.ready && !state.startError && !state.timedOut && !state.sceneError;
  const VolumeIcon = state.muted || state.volume === 0 ? VolumeX : state.volume < 0.5 ? Volume1 : Volume2;

  return (
    <div ref={boxRef} className={cn("flex h-full min-h-0 flex-col", fullscreen && "bg-bg-100")}>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-bg-200/70 dark:bg-black/30">
        {state.url && (
          <iframe
            ref={iframeRef}
            src={state.url}
            title={t.playerTitle}
            // The player runs the project's own code (scenes the agent wrote): scripts only, with
            // an opaque origin, so it can reach neither the app nor its own server's storage. The
            // player's server sends CORS headers for what it fetches (fonts, media data).
            sandbox="allow-scripts"
            allow="autoplay; fullscreen"
            onLoad={actions.frameLoaded}
            className={cn("absolute inset-0 h-full w-full border-0 bg-transparent transition-opacity", state.ready || state.sceneError || state.timedOut ? "opacity-100" : "opacity-0")}
          />
        )}
        {/* The wait looks like the video: its latest still (or its background) where the canvas
            will be, fading out over the player once it has painted. */}
        <div
          aria-hidden
          style={{ containerType: "size" }}
          className={cn(
            "pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity",
            waiting ? "opacity-100 duration-0" : "opacity-0 delay-100 duration-300",
          )}
        >
          {comp && (
            <div
              className="relative overflow-hidden"
              style={{
                aspectRatio: `${comp.width} / ${comp.height}`,
                width: `min(100cqw, calc(100cqh * ${comp.width / comp.height}))`,
                background: comp.background,
              }}
            >
              {poster && <img src={poster} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />}
            </div>
          )}
        </div>
        {waiting && (
          <div role="status" className="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-[6px] bg-black/55 px-2 py-1 text-[11px] text-white/85">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>{t.playerStarting}</span>
          </div>
        )}
        {!state.ready && !state.startError && state.timedOut && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            <p className="text-[13px] font-medium text-text-100">{t.playerTimeout}</p>
            <ul className="max-w-md space-y-0.5 text-left font-mono text-[11.5px] leading-snug text-text-300">
              <li>{t.playerDiagServer}: {state.url ?? t.playerDiagNone}</li>
              <li>{t.playerDiagPage}: {state.url ? (state.loaded ? t.playerDiagLoaded : t.playerDiagNotLoaded) : "—"}</li>
              <li>{t.playerDiagMessage}: {state.lastMessage ?? t.playerDiagNone}</li>
            </ul>
            <Button variant="secondary" onClick={actions.retry}>
              <RotateCcw className="h-3.5 w-3.5" />
              {t.retry}
            </Button>
          </div>
        )}
        {state.startError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            <p className="max-w-md whitespace-pre-wrap text-[12.5px] leading-relaxed text-text-200">{t.playerFailed.replace("{error}", state.startError)}</p>
            <Button variant="secondary" onClick={actions.retry}>
              <RotateCcw className="h-3.5 w-3.5" />
              {t.retry}
            </Button>
          </div>
        )}
        {state.sceneError && (
          <div className="absolute inset-x-2 top-2 max-h-[60%] overflow-auto rounded-[8px] border border-red-500/40 bg-bg-100/95 p-2.5 shadow-lg custom-scrollbar">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium text-text-100">{t.sceneError}</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-text-200">{state.sceneError.message}</p>
                {state.sceneError.stack && (
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-snug text-text-400 custom-scrollbar">{state.sceneError.stack}</pre>
                )}
              </div>
              <button type="button" onClick={actions.dismissError} aria-label={t.dismiss} className="rounded-[6px] p-1 text-text-400 hover:bg-bg-200 hover:text-text-100">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="@container flex h-10 shrink-0 items-center gap-1 border-t border-bg-300/70 px-2">
        <IconBtn label={t.toStart} kbd="Home" onClick={actions.toStart}>
          <SkipBack className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn label={t.frameBack} kbd="Left" onClick={() => actions.step(-1)}>
          <StepBack className="h-3.5 w-3.5" />
        </IconBtn>
        <button
          type="button"
          onClick={actions.toggle}
          aria-label={state.playing ? t.pause : t.play}
          data-tooltip={state.playing ? t.pause : t.play}
          data-tooltip-kbd="Space"
          aria-keyshortcuts="Space"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-text-100 text-bg-100 transition-opacity hover:opacity-85"
        >
          {state.playing ? <Pause className="h-3.5 w-3.5 fill-current" /> : <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />}
        </button>
        <IconBtn label={t.frameForward} kbd="Right" onClick={() => actions.step(1)}>
          <StepForward className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn label={t.toEnd} kbd="End" onClick={actions.toEnd}>
          <SkipForward className="h-3.5 w-3.5" />
        </IconBtn>

        <TimecodeField frame={playhead} fps={fps} duration={duration} onSeek={actions.seek} hint={t.timecodeHint} />
        <span className="hidden text-[11.5px] tabular-nums text-text-400 @[560px]:inline">
          {t.frame} {playhead} / {Math.max(0, duration - 1)}
        </span>
        {state.rate !== 1 && state.playing && (
          <span className="rounded-[4px] bg-bg-200 px-1 text-[11px] font-medium tabular-nums text-text-200">{state.rate}×</span>
        )}

        <div className="ml-auto flex items-center gap-0.5">
          <IconBtn label={t.loop} active={state.loop} onClick={() => actions.setLoop(!state.loop)}>
            <Repeat className="h-3.5 w-3.5" />
          </IconBtn>
          <MiniSelect
            label={t.playbackRate}
            value={String(Math.abs(state.rate))}
            options={PLAYBACK_RATES.map((r) => ({ value: String(r), label: `${r}×` }))}
            onChange={(v) => actions.setRate(Number(v))}
          />
          <div className="group/vol flex items-center">
            <IconBtn label={state.muted ? t.unmute : t.mute} onClick={() => actions.setMuted(!state.muted)}>
              <VolumeIcon className="h-3.5 w-3.5" />
            </IconBtn>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={state.muted ? 0 : state.volume}
              aria-label={t.volume}
              onChange={(e) => actions.setVolume(Number(e.target.value))}
              onKeyDown={(e) => e.stopPropagation()}
              className="h-1 w-0 cursor-pointer accent-[var(--color-accent,currentColor)] opacity-0 transition-all group-hover/vol:mx-1 group-hover/vol:w-16 group-hover/vol:opacity-100 focus:mx-1 focus:w-16 focus:opacity-100"
            />
          </div>
          <span className="mx-1 h-4 w-px bg-bg-300" />
          <MiniSelect
            label={t.zoom}
            value={String(state.zoom)}
            options={ZOOMS.map((z) => ({ value: String(z), label: z === "fit" ? t.zoomFit : `${z * 100}%` }))}
            onChange={(v) => actions.setZoom(v === "fit" ? "fit" : Number(v))}
          />
          <IconBtn label={t.safeAreas} active={state.safeAreas} onClick={() => actions.setSafeAreas(!state.safeAreas)}>
            <ScanLine className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn label={t.grid} active={state.grid} onClick={() => actions.setGrid(!state.grid)}>
            <Grid3x3 className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn label={fullscreen ? t.exitFullscreen : t.fullscreen} kbd="F" onClick={toggleFullscreen}>
            {fullscreen ? <Minimize className="h-3.5 w-3.5" /> : <Maximize className="h-3.5 w-3.5" />}
          </IconBtn>
        </div>
      </div>
    </div>
  );
}

export function IconBtn({ label, kbd, active, onClick, children, disabled }: { label: string; kbd?: string; active?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      aria-keyshortcuts={kbd}
      data-tooltip={label}
      data-tooltip-kbd={kbd}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] transition-colors disabled:pointer-events-none disabled:opacity-40",
        active ? ACTIVE_TOGGLE : "text-text-300 hover:bg-bg-200 hover:text-text-100",
      )}
    >
      {children}
    </button>
  );
}

function MiniSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <label data-tooltip={label} className="relative flex h-7 shrink-0 cursor-pointer items-center gap-0.5 rounded-[6px] px-1.5 text-[12px] tabular-nums text-text-200 hover:bg-bg-200">
      <span>{current}</span>
      <ChevronDown className="h-3 w-3 text-text-400" />
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

/** HH:MM:SS:FF; click to type a timecode or a frame number. */
function TimecodeField({ frame, fps, duration, onSeek, hint }: { frame: number; fps: number; duration: number; onSeek: (f: number) => void; hint: string }) {
  const [text, setText] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = () => {
    if (text !== null && !cancelled.current) {
      const f = parseTimecode(text, fps);
      if (f !== null) onSeek(Math.min(duration - 1, f));
    }
    cancelled.current = false;
    setText(null);
  };
  return (
    <input
      value={text ?? formatTimecode(frame, fps)}
      aria-label={hint}
      data-tooltip={text === null ? hint : undefined}
      onFocus={(e) => {
        setText(formatTimecode(frame, fps));
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      spellCheck={false}
      className="ml-1.5 h-7 w-[92px] shrink-0 rounded-[6px] border border-transparent bg-transparent px-1.5 font-mono text-[12.5px] tabular-nums text-text-100 outline-none hover:border-bg-300 focus:border-accent/70 focus:bg-bg-0"
    />
  );
}

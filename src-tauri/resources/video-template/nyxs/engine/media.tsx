import React, { useEffect, useRef } from "react";
import * as Remotion from "remotion";
import { Img, OffthreadVideo } from "remotion";
import { applyEasing, resolveAnimatable } from "./schema";
import type { Asset, AudioClip, ImageClip, VideoClip } from "./schema";
import { assetUrl, clamp01 } from "./assets";
import { findEffect, useChromaCanvas } from "./effects";

const fill: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%" };

// The engine also runs inside adopted projects pinned to older Remotion 4 releases, so the
// media components and prop names are picked at runtime instead of imported by name.
type AnyMedia = React.ComponentType<Record<string, unknown>>;
const R = Remotion as unknown as Record<string, unknown>;
const HtmlVideo = (R.Html5Video ?? R.Video) as AnyMedia;
const HtmlAudio = (R.Html5Audio ?? R.Audio) as AnyMedia;

function remotionPatch(): number {
  const m = /^4\.0\.(\d+)/.exec(String(R.VERSION ?? ""));
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

// `startFrom` was renamed `trimBefore` in Remotion 4.0.319; newer versions reject the old name.
const TRIM_PROP = remotionPatch() >= 319 ? "trimBefore" : "startFrom";

function trimProps(frames: number): Record<string, number> {
  return frames > 0 ? { [TRIM_PROP]: frames } : {};
}

function isRendering(): boolean {
  const get = R.getRemotionEnvironment as (() => { isRendering: boolean }) | undefined;
  if (typeof get === "function") return get().isRendering;
  return typeof window !== "undefined" && Boolean((window as { remotion_isRendering?: boolean }).remotion_isRendering);
}

/** Keys every presented frame of a playing <video> (player side; renders use onVideoFrame). */
function useVideoFrames(ref: React.RefObject<HTMLVideoElement | null>, onFrame: ((v: HTMLVideoElement) => void) | null) {
  useEffect(() => {
    const video = ref.current;
    if (!video || !onFrame) return;
    type RVFC = (cb: () => void) => number;
    const withCallback = video as HTMLVideoElement & { requestVideoFrameCallback?: RVFC; cancelVideoFrameCallback?: (id: number) => void };
    let id = 0;
    let stopped = false;
    const draw = () => {
      if (!stopped && video.readyState >= 2) onFrame(video);
    };
    const loop = () => {
      draw();
      if (!stopped && withCallback.requestVideoFrameCallback) id = withCallback.requestVideoFrameCallback(loop);
    };
    if (withCallback.requestVideoFrameCallback) id = withCallback.requestVideoFrameCallback(loop);
    video.addEventListener("seeked", draw);
    video.addEventListener("loadeddata", draw);
    return () => {
      stopped = true;
      if (id && withCallback.cancelVideoFrameCallback) withCallback.cancelVideoFrameCallback(id);
      video.removeEventListener("seeked", draw);
      video.removeEventListener("loadeddata", draw);
    };
  }, [ref, onFrame]);
}

/**
 * Footage: OffthreadVideo when rendering (frame-exact, handles long files and any codec
 * ffmpeg reads), a plain HTML5 video in the player (streams with HTTP Range, seeks fast).
 * The clip's own audio plays with the clip volume × track volume, unless the track is muted.
 */
export const VideoContent: React.FC<{ clip: VideoClip; asset: Asset; trackVolume: number; muted: boolean }> = ({
  clip,
  asset,
  trackVolume,
  muted,
}) => {
  const chroma = findEffect(clip.effects, "chroma-key");
  const { canvasRef, onFrame } = useChromaCanvas(chroma?.color ?? "#00ff00", chroma?.tolerance ?? 0.3);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rendering = isRendering();
  useVideoFrames(videoRef, chroma && !rendering ? onFrame : null);
  const fit = clip.fit ?? "contain";
  const volume = (f: number) => (clip.volume === undefined ? 1 : resolveAnimatable(clip.volume, f)) * trackVolume;
  const common = {
    src: assetUrl(asset),
    ...trimProps(clip.trimStart),
    playbackRate: clip.playbackRate ?? 1,
    volume,
    muted,
    pauseWhenBuffering: true,
    // Chroma key reads pixels; the player page has an opaque origin, so media must be CORS-clean.
    crossOrigin: chroma ? "anonymous" : undefined,
    style: { ...fill, objectFit: fit, opacity: chroma ? 0 : 1 },
  };
  const video = rendering ? (
    <OffthreadVideo {...(common as React.ComponentProps<typeof OffthreadVideo>)} onVideoFrame={chroma ? onFrame : undefined} />
  ) : (
    <HtmlVideo {...common} ref={videoRef} />
  );
  if (!chroma) return video;
  return (
    <>
      {video}
      <canvas ref={canvasRef} style={{ ...fill, objectFit: fit }} />
    </>
  );
};

export const ImageContent: React.FC<{ clip: ImageClip; asset: Asset; frame: number }> = ({ clip, asset, frame }) => {
  const chroma = findEffect(clip.effects, "chroma-key");
  const { canvasRef, onFrame } = useChromaCanvas(chroma?.color ?? "#00ff00", chroma?.tolerance ?? 0.3);
  const fit = clip.fit ?? "cover";
  let kb: React.CSSProperties = {};
  if (clip.kenBurns) {
    const k = clip.kenBurns;
    const p = applyEasing("ease-in-out", clamp01(frame / Math.max(1, clip.durationInFrames - 1)));
    const scale = k.fromScale + (k.toScale - k.fromScale) * p;
    const x = k.fromX + (k.toX - k.fromX) * p;
    const y = k.fromY + (k.toY - k.fromY) * p;
    kb = { transform: `translate(${x}px, ${y}px) scale(${scale})`, transformOrigin: "center" };
  }
  return (
    <div style={{ ...fill, overflow: "hidden" }}>
      <Img
        src={assetUrl(asset)}
        crossOrigin={chroma ? "anonymous" : undefined}
        onLoad={chroma ? (e) => onFrame(e.currentTarget) : undefined}
        style={{ ...fill, objectFit: fit, opacity: chroma ? 0 : 1, ...kb }}
      />
      {chroma ? <canvas ref={canvasRef} style={{ ...fill, objectFit: fit, ...kb }} /> : null}
    </div>
  );
};

export const AudioContent: React.FC<{ clip: AudioClip; asset: Asset; trackVolume: number; muted: boolean }> = ({
  clip,
  asset,
  trackVolume,
  muted,
}) => {
  const fadeIn = clip.fadeIn ?? 0;
  const fadeOut = clip.fadeOut ?? 0;
  const volume = (f: number) => {
    let v = clip.volume === undefined ? 1 : resolveAnimatable(clip.volume, f);
    if (fadeIn > 0) v *= clamp01(f / fadeIn);
    if (fadeOut > 0) v *= clamp01((clip.durationInFrames - f) / fadeOut);
    return v * trackVolume;
  };
  return <HtmlAudio src={assetUrl(asset)} {...trimProps(clip.trimStart)} volume={volume} muted={muted} pauseWhenBuffering />;
};

import React from "react";
import { Sequence, useCurrentFrame } from "remotion";
import { clipEnd, resolveAnimatable, resolveTransform } from "./schema";
import type { Asset, Clip, Composition, ShapeClip, Track, Transform, Transition } from "./schema";
import { cssFilter, findEffect, Vignette } from "./effects";
import { AudioContent, ImageContent, VideoContent } from "./media";
import { TextContent } from "./text";
import { CaptionsContent } from "./captions";
import { SceneContent } from "./sceneClip";
import { isActiveTransition, TransitionWrap } from "./transitions";

/** Attribute the player uses to find clip boxes for hit testing and the selection box. */
export const CLIP_ID_ATTR = "data-nyxs-clip-id";
export const TRACK_ID_ATTR = "data-nyxs-track-id";

/** Where a clip sits when it has no transform. Captions default to the lower part of the frame. */
export function effectiveTransform(clip: Clip, composition: Pick<Composition, "width" | "height">): Transform | undefined {
  if (clip.transform) return clip.transform;
  if (clip.type === "captions") {
    return { x: composition.width / 2, y: Math.round(composition.height * 0.82), scale: 1, rotation: 0, anchor: "center" };
  }
  return undefined;
}

/** Size of the clip box in composition px; null = sized by its content (text). */
export function clipBoxSize(clip: Clip, composition: Pick<Composition, "width" | "height">): { width: number; height?: number } | null {
  switch (clip.type) {
    case "video":
    case "image":
    case "scene":
      return { width: composition.width, height: composition.height };
    case "shape":
      return { width: clip.width, height: clip.shape === "line" ? Math.max(clip.height, clip.strokeWidth ?? 4) : clip.height };
    case "captions":
      return { width: clip.style.maxWidth ?? Math.round(composition.width * 0.9) };
    default:
      return null;
  }
}

const ShapeContent: React.FC<{ clip: ShapeClip }> = ({ clip }) => {
  const stroke = clip.stroke && (clip.strokeWidth ?? 0) > 0 ? `${clip.strokeWidth}px solid ${clip.stroke}` : undefined;
  if (clip.shape === "line") {
    return <div style={{ width: "100%", height: "100%", background: clip.stroke ?? clip.fill, borderRadius: clip.radius }} />;
  }
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: clip.fill,
        border: stroke,
        boxSizing: "border-box",
        borderRadius: clip.shape === "circle" ? "50%" : clip.radius,
      }}
    />
  );
};

type ClipFrameProps = {
  clip: Clip;
  track: Track;
  composition: Composition;
  assets: Map<string, Asset>;
  /** Transition of the NEXT clip when it starts exactly where this one ends. */
  exitTransition?: Transition;
};

const ClipFrame: React.FC<ClipFrameProps> = ({ clip, track, composition, assets, exitTransition }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = composition;
  const trackVolume = track.volume ?? 1;
  const muted = !!track.muted;

  if (clip.type === "audio") {
    const asset = assets.get(clip.assetId);
    return asset ? <AudioContent clip={clip} asset={asset} trackVolume={trackVolume} muted={muted} /> : null;
  }

  const t = resolveTransform(effectiveTransform(clip, composition), frame, composition);
  const opacity = clip.opacity === undefined ? 1 : resolveAnimatable(clip.opacity, frame);
  const size = clipBoxSize(clip, composition);
  const vignette = findEffect(clip.effects, "vignette");
  const center = t.anchor === "center";

  let content: React.ReactNode = null;
  switch (clip.type) {
    case "video": {
      const asset = assets.get(clip.assetId);
      content = asset ? <VideoContent clip={clip} asset={asset} trackVolume={trackVolume} muted={muted} /> : null;
      break;
    }
    case "image": {
      const asset = assets.get(clip.assetId);
      content = asset ? <ImageContent clip={clip} asset={asset} frame={frame} /> : null;
      break;
    }
    case "text":
      content = <TextContent clip={clip} frame={frame} />;
      break;
    case "captions":
      content = <CaptionsContent clip={clip} frame={frame} fps={fps} />;
      break;
    case "shape":
      content = <ShapeContent clip={clip} />;
      break;
    case "scene":
      content = <SceneContent clip={clip} />;
      break;
  }

  let node: React.ReactNode = (
    <div
      {...{ [CLIP_ID_ATTR]: clip.id, [TRACK_ID_ATTR]: track.id }}
      style={{
        position: "absolute",
        left: t.x,
        top: t.y,
        width: size ? size.width : "max-content",
        height: size?.height,
        transform: `${center ? "translate(-50%, -50%) " : ""}rotate(${t.rotation}deg) scale(${t.scale})`,
        transformOrigin: center ? "50% 50%" : "0 0",
        opacity,
        filter: cssFilter(clip.effects, frame),
        overflow: clip.type === "video" || clip.type === "image" || clip.type === "scene" ? "hidden" : undefined,
      }}
    >
      {content}
      {vignette ? <Vignette amount={vignette.amount} /> : null}
    </div>
  );

  if (isActiveTransition(clip.transitionIn)) {
    node = (
      <TransitionWrap transition={clip.transitionIn} direction="entering" frame={frame} width={width} height={height}>
        {node}
      </TransitionWrap>
    );
  }
  if (exitTransition) {
    node = (
      <TransitionWrap transition={exitTransition} direction="exiting" frame={frame - clip.durationInFrames} width={width} height={height}>
        {node}
      </TransitionWrap>
    );
  }
  return <>{node}</>;
};

/** One track: a layer with a Sequence per clip, in track order. */
export const TrackLayer: React.FC<{ track: Track; composition: Composition; assets: Map<string, Asset> }> = ({
  track,
  composition,
  assets,
}) => {
  return (
    <>
      {track.clips.map((clip, i) => {
        const next = track.clips[i + 1];
        const exitTransition =
          next && clip.type !== "audio" && isActiveTransition(next.transitionIn) && next.from === clipEnd(clip)
            ? next.transitionIn
            : undefined;
        const premount = clip.type === "video" || clip.type === "audio" || clip.type === "scene" ? composition.fps : 0;
        return (
          <Sequence
            key={clip.id}
            from={clip.from}
            durationInFrames={clip.durationInFrames + (exitTransition ? exitTransition.durationInFrames : 0)}
            name={clip.name ?? `${clip.type} ${clip.id}`}
            premountFor={premount}
          >
            <ClipFrame clip={clip} track={track} composition={composition} assets={assets} exitTransition={exitTransition} />
          </Sequence>
        );
      })}
    </>
  );
};

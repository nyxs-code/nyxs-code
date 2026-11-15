import React, { useMemo } from "react";
import { AbsoluteFill } from "remotion";
import type { Asset, Timeline } from "./schema";
import { useTimelineFonts } from "./fonts";
import { TrackLayer } from "./Clip";

/** Attribute on the composition root; the player measures it to map canvas coordinates. */
export const ROOT_ATTR = "data-nyxs-root";

export type TimelineCompositionProps = {
  compositionId: string;
  timeline: Timeline;
};

/** Renders one composition of a timeline.json. Used by Root.tsx (render/studio) and the Nyxs player. */
export const TimelineComposition: React.FC<TimelineCompositionProps> = ({ compositionId, timeline }) => {
  const composition = timeline.compositions.find((c) => c.id === compositionId);
  if (!composition) {
    const ids = timeline.compositions.map((c) => `"${c.id}"`).join(", ");
    throw new Error(`Composition "${compositionId}" is not in timeline.json (it has ${ids || "none"}).`);
  }
  useTimelineFonts(timeline, composition);
  const assets = useMemo(() => new Map<string, Asset>(timeline.assets.map((a) => [a.id, a])), [timeline.assets]);

  return (
    <AbsoluteFill {...{ [ROOT_ATTR]: "" }} style={{ background: composition.background, overflow: "hidden" }}>
      {composition.tracks.map((track) =>
        track.hidden ? null : (
          <AbsoluteFill key={track.id}>
            <TrackLayer track={track} composition={composition} assets={assets} />
          </AbsoluteFill>
        ),
      )}
    </AbsoluteFill>
  );
};

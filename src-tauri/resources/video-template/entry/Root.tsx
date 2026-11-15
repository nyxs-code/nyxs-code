import React from "react";
import { Composition, getInputProps } from "remotion";
import timelineJson from "@project/timeline.json";
import { TimelineComposition, validateTimeline } from "../nyxs/engine";

/**
 * One <Composition> per composition of the project's timeline.json. A render passes the document
 * it read from disk as `inputProps.timeline`; it wins over the copy bundled through `@project`,
 * so the list of compositions and the frames always come from the same document.
 */
function currentTimeline() {
  const input = getInputProps() as { timeline?: unknown };
  return validateTimeline(input.timeline ?? timelineJson);
}

export const RemotionRoot: React.FC = () => {
  const result = currentTimeline();
  if (!result.ok) {
    throw new Error(`timeline.json is invalid:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`);
  }
  const timeline = result.timeline;
  return (
    <>
      {timeline.compositions.map((c) => (
        <Composition
          key={c.id}
          id={c.id}
          component={TimelineComposition}
          width={c.width}
          height={c.height}
          fps={c.fps}
          durationInFrames={c.durationInFrames}
          defaultProps={{ compositionId: c.id, timeline }}
        />
      ))}
    </>
  );
};

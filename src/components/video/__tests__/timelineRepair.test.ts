import { describe, expect, it } from "vitest";
import { emptyTimeline, validateTimeline } from "@/lib/video/timelineSchema";
import { repairTimelineJson } from "../timelineRepair";

function withClips(froms: [number, number][]) {
  const tl = emptyTimeline({ width: 1920, height: 1080, fps: 30, durationInFrames: 300 });
  const comp = tl.compositions[0];
  comp.tracks = [
    {
      id: "t1",
      name: "Text",
      kind: "text",
      clips: froms.map(([from, durationInFrames], i) => ({
        id: `c${i}`,
        type: "text" as const,
        from,
        durationInFrames,
        text: `T${i}`,
        style: { fontFamily: "Inter", fontSize: 40, fontWeight: 700, color: "#fff", align: "center" as const },
      })),
    },
  ];
  return tl;
}

describe("repairTimelineJson", () => {
  it("sorts clips that are out of order", () => {
    const tl = withClips([[0, 60], [165, 30], [60, 60]]);
    expect(validateTimeline(tl).ok).toBe(false);
    const r = repairTimelineJson(JSON.stringify(tl));
    expect(r.ok).toBe(true);
    const clips = JSON.parse(r.json).compositions[0].tracks[0].clips.map((c: { from: number }) => c.from);
    expect(clips).toEqual([0, 60, 165]);
  });

  it("moves overlapping clips to a new track of the same kind instead of retiming them", () => {
    const tl = withClips([[0, 100], [50, 100]]);
    const r = repairTimelineJson(JSON.stringify(tl));
    expect(r.ok).toBe(true);
    const tracks = JSON.parse(r.json).compositions[0].tracks;
    expect(tracks.map((t: { kind: string; clips: unknown[] }) => [t.kind, t.clips.length])).toEqual([["text", 1], ["text", 1]]);
    expect(tracks[1].clips[0].from).toBe(50);
  });

  it("reports what it can't fix", () => {
    expect(repairTimelineJson("{ not json").ok).toBe(false);
  });
});

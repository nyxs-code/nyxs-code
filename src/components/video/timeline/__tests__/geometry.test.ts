import { describe, expect, it } from "vitest";
import type { Composition } from "@/lib/video/timelineSchema";
import { layoutRows, rowAt, rulerLabel, rulerStep, visibleClips } from "../geometry";

describe("timeline geometry", () => {
  it("picks ruler steps that keep labels apart at any zoom", () => {
    expect(rulerStep(40, 30).major).toBe(5);
    expect(rulerStep(3, 30).major).toBe(30);
    expect(rulerStep(0.05, 30).major).toBe(60 * 30);
    for (const zoom of [0.02, 0.3, 1, 4, 12, 40]) expect(rulerStep(zoom, 60).major * zoom).toBeGreaterThanOrEqual(90);
  });

  it("formats labels with frames only for sub-second steps", () => {
    expect(rulerLabel(95, 30, false)).toBe("0:03");
    expect(rulerLabel(95, 30, true)).toBe("0:03:05");
    expect(rulerLabel(30 * 3725, 30, false)).toBe("1:02:05");
  });

  it("draws the top layer first and finds rows by y", () => {
    const comp = {
      tracks: [
        { id: "bottom", name: "", kind: "video", clips: [] },
        { id: "top", name: "", kind: "text", clips: [] },
      ],
    } as unknown as Composition;
    const { rows, height } = layoutRows(comp);
    expect(rows.map((r) => r.track.id)).toEqual(["top", "bottom"]);
    expect(height).toBe(rows[0].height + rows[1].height);
    expect(rowAt(rows, 1)?.track.id).toBe("top");
    expect(rowAt(rows, rows[0].height + 1)?.track.id).toBe("bottom");
    expect(rowAt(rows, 9999)?.track.id).toBe("bottom");
  });

  it("returns only the clips in the visible range", () => {
    const clips = Array.from({ length: 500 }, (_, i) => ({ id: i, from: i * 10, durationInFrames: 10 }));
    expect(visibleClips(clips, 1005, 1031).map((c) => c.id)).toEqual([100, 101, 102, 103]);
    expect(visibleClips(clips, 6000, 7000)).toEqual([]);
  });
});

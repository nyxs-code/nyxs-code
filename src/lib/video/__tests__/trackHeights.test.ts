import { afterEach, describe, expect, it } from "vitest";
import { clampTrackHeight, defaultTrackHeight, resolveTrackHeight, sanitizeTrackView } from "../trackHeights";
import { getTimelineState, resetTimelineStoreForTests, takeZoomRestored, timelineActions } from "../timelineStore";
import { layoutRows, rowAt } from "../../../components/video/timeline/geometry";
import type { Composition } from "../timelineSchema";

afterEach(() => resetTimelineStoreForTests());

describe("track heights", () => {
  it("clamps to the allowed range", () => {
    expect(clampTrackHeight(3)).toBe(28);
    expect(clampTrackHeight(999)).toBe(160);
    expect(clampTrackHeight(80.4)).toBe(80);
  });

  it("uses a height set by hand over the S/M/L size", () => {
    const track = { id: "a", kind: "video" as const };
    expect(resolveTrackHeight(track, { trackSize: "l", trackHeights: {} })).toBe(defaultTrackHeight("video", "l"));
    expect(resolveTrackHeight(track, { trackSize: "l", trackHeights: { a: 77 } })).toBe(77);
  });

  it("trusts nothing from storage", () => {
    expect(sanitizeTrackView({ trackSize: "xl", trackHeights: { a: 999, b: "tall", c: 50 } })).toEqual({ trackSize: "m", trackHeights: { a: 160, c: 50 } });
    expect(sanitizeTrackView({ trackHeights: null })).toEqual({ trackSize: "m", trackHeights: {} });
  });

  it("lays rows out with the view's heights, so hit testing follows", () => {
    const comp = {
      tracks: [
        { id: "bottom", name: "", kind: "video", clips: [] },
        { id: "top", name: "", kind: "text", clips: [] },
      ],
    } as unknown as Composition;
    const { rows, height } = layoutRows(comp, { trackSize: "s", trackHeights: { top: 100 } });
    expect(rows.map((r) => [r.track.id, r.top, r.height])).toEqual([["top", 0, 100], ["bottom", 100, 36]]);
    expect(height).toBe(136);
    expect(rowAt(rows, 99)?.track.id).toBe("top");
    expect(rowAt(rows, 101)?.track.id).toBe("bottom");
  });
});

describe("track height actions", () => {
  it("sets, clamps and resets one track", () => {
    timelineActions.setTrackHeight("a", 500);
    expect(getTimelineState().trackHeights).toEqual({ a: 160 });
    timelineActions.setTrackHeight("a", null);
    expect(getTimelineState().trackHeights).toEqual({});
  });

  it("the global size drops heights set by hand", () => {
    timelineActions.setTrackHeight("a", 90);
    timelineActions.setTrackSize("l");
    expect(getTimelineState()).toMatchObject({ trackSize: "l", trackHeights: {} });
  });

  it("restores saved view state and tells the timeline not to fit over a saved zoom", () => {
    timelineActions.restoreView({ zoom: 7, trackSize: "s", trackHeights: { a: 40 } });
    expect(getTimelineState()).toMatchObject({ zoom: 7, trackSize: "s", trackHeights: { a: 40 } });
    expect(takeZoomRestored()).toBe(true);
    expect(takeZoomRestored()).toBe(false);
    timelineActions.restoreView({ trackSize: "l" });
    expect(takeZoomRestored()).toBe(false);
  });
});

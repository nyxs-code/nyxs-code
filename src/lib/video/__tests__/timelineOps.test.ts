import { describe, expect, it } from "vitest";
import type { Clip, Composition, Timeline, Track, TrackKind } from "../timelineSchema";
import {
  addClip,
  addKeyframe,
  addMarker,
  addTrack,
  clipFromAsset,
  computeSnap,
  constrainMove,
  copyClips,
  duplicateClips,
  findFreeSlot,
  getComposition,
  keyframeFrames,
  locateClip,
  moveClips,
  moveKeyframes,
  moveMarker,
  moveTrack,
  nudgeClips,
  pasteClips,
  placeClip,
  removeClips,
  removeKeyframes,
  removeMarker,
  removeTrack,
  renameTrack,
  rippleDelete,
  setInPoint,
  setOutPoint,
  setTrackProps,
  setTransitionIn,
  snapTargets,
  splitAt,
  splitClip,
  trimClip,
  updateClip,
  updateComposition,
} from "../timelineOps";

function text(id: string, from: number, durationInFrames: number): Clip {
  return {
    id,
    type: "text",
    from,
    durationInFrames,
    text: id,
    style: { fontFamily: "Inter", fontSize: 40, fontWeight: 600, color: "#fff", align: "center" },
  };
}

function video(id: string, from: number, durationInFrames: number, trimStart = 0): Clip {
  return { id, type: "video", from, durationInFrames, assetId: "a1", trimStart };
}

function track(id: string, kind: TrackKind, clips: Clip[], extra: Partial<Track> = {}): Track {
  return { id, name: id, kind, clips, ...extra };
}

function make(tracks: Track[], durationInFrames = 300): Timeline {
  const comp: Composition = {
    id: "Main",
    name: "Main",
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames,
    background: "#000",
    tracks,
    markers: [],
  };
  return {
    version: 1,
    compositions: [comp],
    assets: [{ id: "a1", kind: "video", src: "media/a.mp4", name: "a.mp4", durationInFrames: 200, fps: 30 }],
  };
}

const comp = (tl: Timeline) => getComposition(tl, "Main")!;
const clipsOf = (tl: Timeline, trackIndex: number) => comp(tl).tracks[trackIndex].clips.map((c) => [c.id, c.from, c.durationInFrames]);

function assertNoOverlap(tl: Timeline) {
  for (const t of comp(tl).tracks) {
    for (let i = 1; i < t.clips.length; i++) {
      expect(t.clips[i].from).toBeGreaterThanOrEqual(t.clips[i - 1].from + t.clips[i - 1].durationInFrames);
    }
  }
}

describe("adding clips", () => {
  it("finds the next free slot", () => {
    const t = track("t", "text", [text("a", 0, 10), text("b", 15, 10)]);
    expect(findFreeSlot(t, 0, 5)).toBe(10);
    expect(findFreeSlot(t, 0, 6)).toBe(25);
    expect(findFreeSlot(t, 30, 5)).toBe(30);
  });

  it("shifts an added clip past busy frames and extends the duration", () => {
    const tl = make([track("t", "text", [text("a", 0, 100)])], 100);
    const r = addClip(tl, "Main", "t", text("b", 50, 40));
    expect(clipsOf(r.timeline, 0)).toEqual([["a", 0, 100], ["b", 100, 40]]);
    expect(comp(r.timeline).durationInFrames).toBe(140);
  });

  it("refuses incompatible and locked tracks", () => {
    const tl = make([track("v", "video", []), track("l", "text", [], { locked: true })]);
    expect(addClip(tl, "Main", "v", text("x", 0, 10)).timeline).toBe(tl);
    expect(addClip(tl, "Main", "l", text("x", 0, 10)).timeline).toBe(tl);
  });

  it("places a dropped clip on a new track when no compatible one exists", () => {
    const tl = make([track("v", "video", [])]);
    const r = placeClip(tl, "Main", text("x", 10, 10), "v", "Text 1");
    expect(comp(r.timeline).tracks).toHaveLength(2);
    expect(comp(r.timeline).tracks[1]).toMatchObject({ kind: "text", name: "Text 1" });
    expect(r.clipId).toBe("x");
  });

  it("builds a clip from an asset with its duration", () => {
    const tl = make([]);
    const c = clipFromAsset(tl.assets[0], comp(tl), 12)!;
    expect(c).toMatchObject({ type: "video", from: 12, durationInFrames: 200, trimStart: 0 });
    const img = clipFromAsset({ id: "i", kind: "image", src: "media/i.png", name: "i" }, comp(tl), 0)!;
    expect(img.durationInFrames).toBe(90);
  });
});

describe("removing", () => {
  it("deletes clips but not on locked tracks", () => {
    const tl = make([track("t", "text", [text("a", 0, 10)]), track("l", "text", [text("b", 0, 10)], { locked: true })]);
    const next = removeClips(tl, "Main", ["a", "b"]);
    expect(clipsOf(next, 0)).toEqual([]);
    expect(clipsOf(next, 1)).toEqual([["b", 0, 10]]);
    expect(removeClips(tl, "Main", ["zzz"])).toBe(tl);
  });

  it("ripple delete closes the gap on the same track only", () => {
    const tl = make([
      track("t", "text", [text("a", 0, 10), text("b", 10, 20), text("c", 40, 10)]),
      track("u", "text", [text("d", 40, 10)]),
    ]);
    const next = rippleDelete(tl, "Main", ["b"]);
    expect(clipsOf(next, 0)).toEqual([["a", 0, 10], ["c", 20, 10]]);
    expect(clipsOf(next, 1)).toEqual([["d", 40, 10]]);
  });
});

describe("moving", () => {
  const base = () =>
    make([
      track("t", "text", [text("a", 0, 10), text("b", 30, 10)]),
      track("u", "text", [text("c", 0, 50)]),
      track("v", "video", []),
    ]);

  it("moves freely in a gap", () => {
    const next = moveClips(base(), "Main", ["a"], 5);
    expect(clipsOf(next, 0)).toEqual([["a", 5, 10], ["b", 30, 10]]);
  });

  it("stops at a neighbour or jumps over it to the closest gap", () => {
    expect(constrainMove(comp(base()), ["a"], 25).delta).toBe(20);
    expect(constrainMove(comp(base()), ["a"], 36).delta).toBe(40);
  });

  it("never goes before frame 0", () => {
    expect(constrainMove(comp(base()), ["b"], -100).delta).toBe(-20);
    expect(constrainMove(comp(base()), ["a"], -5).delta).toBe(0);
  });

  it("moves a group keeping relative positions", () => {
    const next = moveClips(base(), "Main", ["a", "b"], 7);
    expect(clipsOf(next, 0)).toEqual([["a", 7, 10], ["b", 37, 10]]);
  });

  it("moves across compatible tracks only", () => {
    const tl = base();
    const up = moveClips(tl, "Main", ["b"], 30, 1);
    expect(clipsOf(up, 0)).toEqual([["a", 0, 10]]);
    expect(clipsOf(up, 1)).toEqual([["c", 0, 50], ["b", 60, 10]]);
    // Text clip into a video track: the track change is dropped.
    expect(constrainMove(comp(tl), ["c"], 0, 1)).toEqual({ delta: 0, trackDelta: 0 });
    expect(moveClips(tl, "Main", ["c"], 0, 1)).toBe(tl);
  });

  it("does not move clips on locked tracks", () => {
    const tl = make([track("t", "text", [text("a", 0, 10)], { locked: true })]);
    expect(nudgeClips(tl, "Main", ["a"], 3)).toBe(tl);
  });

  it("nudges by frames", () => {
    const next = nudgeClips(base(), "Main", ["b"], -1);
    expect(clipsOf(next, 0)).toEqual([["a", 0, 10], ["b", 29, 10]]);
    assertNoOverlap(next);
  });
});

describe("trimming", () => {
  it("trims the end up to the next clip and the media length", () => {
    const tl = make([track("v", "video", [video("a", 0, 50), video("b", 80, 10)])]);
    expect(clipsOf(trimClip(tl, "Main", "a", "end", 70), 0)[0]).toEqual(["a", 0, 70]);
    expect(clipsOf(trimClip(tl, "Main", "a", "end", 200), 0)[0]).toEqual(["a", 0, 80]);
    const alone = make([track("v", "video", [video("a", 0, 50, 20)])]);
    // 200-frame asset, 20 already skipped: at most 180 frames.
    expect(clipsOf(trimClip(alone, "Main", "a", "end", 999), 0)[0]).toEqual(["a", 0, 180]);
  });

  it("trims the start moving trimStart and keyframes with the content", () => {
    const clip: Clip = { ...video("a", 10, 50, 5), opacity: { keyframes: [{ frame: 20, value: 0.5 }] } };
    const tl = make([track("v", "video", [clip])]);
    const next = trimClip(tl, "Main", "a", "start", 18);
    const c = comp(next).tracks[0].clips[0];
    expect(c).toMatchObject({ from: 18, durationInFrames: 42, trimStart: 13 });
    expect(c.opacity).toEqual({ keyframes: [{ frame: 12, value: 0.5 }] });
  });

  it("cannot reveal media before its start or make a clip shorter than a frame", () => {
    const tl = make([track("v", "video", [video("a", 10, 50, 5)])]);
    expect(comp(trimClip(tl, "Main", "a", "start", 0)).tracks[0].clips[0]).toMatchObject({ from: 5, trimStart: 0 });
    expect(comp(trimClip(tl, "Main", "a", "start", 100)).tracks[0].clips[0]).toMatchObject({ from: 59, durationInFrames: 1 });
  });

  it("text clips trim freely to the left neighbour", () => {
    const tl = make([track("t", "text", [text("a", 0, 10), text("b", 20, 10)])]);
    expect(clipsOf(trimClip(tl, "Main", "b", "start", 2), 0)[1]).toEqual(["b", 10, 20]);
  });
});

describe("splitting", () => {
  it("splits a video clip with trim and keyframes on the right half", () => {
    const clip: Clip = { ...video("a", 10, 40, 4), opacity: { keyframes: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }] } };
    const tl = make([track("v", "video", [clip])]);
    const r = splitClip(tl, "Main", "a", 25);
    const [left, right] = comp(r.timeline).tracks[0].clips;
    expect(left).toMatchObject({ id: "a", from: 10, durationInFrames: 15, trimStart: 4 });
    expect(right).toMatchObject({ id: r.newClipId, from: 25, durationInFrames: 25, trimStart: 19 });
    // The keyframe before the cut becomes frame 0 with the value at the cut, so the fade looks the same.
    expect(right.opacity).toEqual({ keyframes: [{ frame: 0, value: 0.5 }, { frame: 15, value: 1 }] });
  });

  it("does nothing at the clip's edges", () => {
    const tl = make([track("t", "text", [text("a", 10, 10)])]);
    expect(splitClip(tl, "Main", "a", 10).timeline).toBe(tl);
    expect(splitClip(tl, "Main", "a", 20).timeline).toBe(tl);
  });

  it("splits everything under the playhead when nothing is selected", () => {
    const tl = make([
      track("t", "text", [text("a", 0, 20)]),
      track("u", "text", [text("b", 5, 20)]),
      track("l", "text", [text("c", 0, 20)], { locked: true }),
    ]);
    const r = splitAt(tl, "Main", 10);
    expect(r.newIds).toHaveLength(2);
    expect(clipsOf(r.timeline, 0)).toHaveLength(2);
    expect(clipsOf(r.timeline, 2)).toHaveLength(1);
  });

  it("keeps the transition on the left and in/out text animations apart", () => {
    const clip: Clip = {
      ...text("a", 0, 20),
      transitionIn: { kind: "fade", durationInFrames: 5 },
      animation: { in: { kind: "fade", durationInFrames: 5 }, out: { kind: "scale", durationInFrames: 5 } },
    } as Clip;
    const r = splitClip(make([track("t", "text", [clip])]), "Main", "a", 10);
    const [left, right] = comp(r.timeline).tracks[0].clips;
    expect(left.transitionIn).toBeDefined();
    expect(right.transitionIn).toBeUndefined();
    expect((left as Extract<Clip, { type: "text" }>).animation).toEqual({ in: { kind: "fade", durationInFrames: 5 } });
    expect((right as Extract<Clip, { type: "text" }>).animation).toEqual({ out: { kind: "scale", durationInFrames: 5 } });
  });
});

describe("duplicate, copy and paste", () => {
  it("duplicates right after the original", () => {
    const tl = make([track("t", "text", [text("a", 0, 10), text("b", 10, 5)])]);
    const r = duplicateClips(tl, "Main", ["a"]);
    expect(r.ids).toHaveLength(1);
    expect(clipsOf(r.timeline, 0)).toEqual([["a", 0, 10], ["b", 10, 5], [r.ids[0], 15, 10]]);
  });

  it("pastes at the playhead keeping relative timing and tracks", () => {
    const tl = make([track("t", "text", [text("a", 10, 10)]), track("u", "text", [text("b", 30, 10)])]);
    const clip = copyClips(comp(tl), ["a", "b"])!;
    expect(clip.entries.map((e) => e.clip.from)).toEqual([0, 20]);
    const r = pasteClips(tl, "Main", clip, 100);
    expect(r.ids).toHaveLength(2);
    expect(clipsOf(r.timeline, 0)[1]).toEqual([r.ids[0], 100, 10]);
    expect(clipsOf(r.timeline, 1)[1]).toEqual([r.ids[1], 120, 10]);
    assertNoOverlap(r.timeline);
  });

  it("pastes into a new track when the original is gone", () => {
    const tl = make([track("t", "text", [text("a", 0, 10)])]);
    const clip = copyClips(comp(tl), ["a"])!;
    const r = pasteClips(removeTrack(tl, "Main", "t"), "Main", clip, 0);
    expect(comp(r.timeline).tracks).toHaveLength(1);
    expect(comp(r.timeline).tracks[0].kind).toBe("text");
  });
});

describe("tracks", () => {
  it("adds, renames, reorders, flags and removes", () => {
    let tl = make([track("a", "video", [])]);
    const added = addTrack(tl, "Main", "audio");
    tl = added.timeline;
    expect(comp(tl).tracks[1]).toMatchObject({ kind: "audio", name: "Audio 1", volume: 1 });
    tl = renameTrack(tl, "Main", added.trackId!, "  Music ");
    expect(comp(tl).tracks[1].name).toBe("Music");
    expect(renameTrack(tl, "Main", added.trackId!, "   ")).toBe(tl);
    tl = moveTrack(tl, "Main", added.trackId!, 0);
    expect(comp(tl).tracks.map((t) => t.id)).toEqual([added.trackId, "a"]);
    tl = setTrackProps(tl, "Main", "a", { hidden: true, locked: true, volume: 5 });
    expect(comp(tl).tracks[1]).toMatchObject({ hidden: true, locked: true, volume: 2 });
    tl = setTrackProps(tl, "Main", "a", { hidden: false });
    expect("hidden" in comp(tl).tracks[1]).toBe(false);
    expect(setTrackProps(tl, "Main", "a", { locked: true })).toBe(tl);
    tl = removeTrack(tl, "Main", "a");
    expect(comp(tl).tracks).toHaveLength(1);
  });
});

describe("markers and in/out", () => {
  it("adds one marker per frame, moves and removes it", () => {
    let tl = make([]);
    const m = addMarker(tl, "Main", 30, "Drop");
    tl = m.timeline;
    expect(addMarker(tl, "Main", 30).timeline).toBe(tl);
    tl = moveMarker(tl, "Main", m.markerId!, 10);
    expect(comp(tl).markers).toEqual([{ id: m.markerId, frame: 10, label: "Drop" }]);
    tl = removeMarker(tl, "Main", m.markerId!);
    expect(comp(tl).markers).toEqual([]);
  });

  it("keeps in before out", () => {
    let r = setInPoint({ inPoint: null, outPoint: 50 }, 20);
    expect(r).toEqual({ inPoint: 20, outPoint: 50 });
    r = setInPoint(r, 60);
    expect(r).toEqual({ inPoint: 60, outPoint: null });
    r = setOutPoint(r, 30);
    expect(r).toEqual({ inPoint: null, outPoint: 30 });
  });
});

describe("snapping", () => {
  it("collects targets and finds the closest correction", () => {
    const tl = make([track("t", "text", [text("a", 10, 10), text("b", 50, 10)])]);
    const targets = snapTargets(comp(tl), { playhead: 33, exclude: new Set(["b"]) });
    expect(targets).toEqual([0, 10, 20, 33]);
    expect(computeSnap([31, 41], targets, 3)).toEqual({ offset: 2, target: 33 });
    expect(computeSnap([25], targets, 3)).toBeNull();
  });
});

describe("keyframes", () => {
  it("adds a keyframe with the current value, moves and deletes it", () => {
    let tl = make([track("t", "text", [{ ...text("a", 0, 60), opacity: 0.8 }])]);
    tl = addKeyframe(tl, "Main", "a", "opacity", 10);
    expect(comp(tl).tracks[0].clips[0].opacity).toEqual({ keyframes: [{ frame: 10, value: 0.8 }] });
    tl = addKeyframe(tl, "Main", "a", "transform.x", 10, 100);
    expect(keyframeFrames(comp(tl).tracks[0].clips[0])).toEqual([{ frame: 10, paths: ["transform.x", "opacity"] }]);
    tl = moveKeyframes(tl, "Main", "a", 10, 20);
    expect(keyframeFrames(comp(tl).tracks[0].clips[0])[0].frame).toBe(20);
    tl = removeKeyframes(tl, "Main", "a", 20);
    const c = comp(tl).tracks[0].clips[0];
    expect(c.opacity).toBe(0.8);
    expect(c.transform?.x).toBe(100);
  });
});

describe("transitions and properties", () => {
  it("caps the transition by both clips", () => {
    const tl = make([track("t", "text", [text("a", 0, 8), text("b", 8, 20)])]);
    const next = setTransitionIn(tl, "Main", "b", { kind: "fade", durationInFrames: 30 });
    expect(locateClip(comp(next), "b")!.clip.transitionIn).toEqual({ kind: "fade", durationInFrames: 8 });
    expect(locateClip(comp(setTransitionIn(next, "Main", "b", null)), "b")!.clip.transitionIn).toBeUndefined();
  });

  it("rejects a timing change that overlaps", () => {
    const tl = make([track("t", "text", [text("a", 0, 10), text("b", 10, 10)])]);
    expect(updateClip(tl, "Main", "a", { durationInFrames: 15 })).toBe(tl);
    expect(clipsOf(updateClip(tl, "Main", "a", { durationInFrames: 5, name: "x" }), 0)[0]).toEqual(["a", 0, 5]);
  });

  it("never shortens the composition below its content", () => {
    const tl = make([track("t", "text", [text("a", 0, 100)])], 300);
    expect(comp(updateComposition(tl, "Main", { durationInFrames: 50 })).durationInFrames).toBe(100);
  });
});

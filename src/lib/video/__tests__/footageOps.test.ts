import { describe, expect, it } from "vitest";
import type { Asset, Clip, Composition, Timeline, Track, TrackKind } from "../timelineSchema";
import {
  detachAudio,
  freezeFrame,
  getComposition,
  inSync,
  locateClip,
  rippleDeleteRanges,
  setClipSpeed,
  trimClipsToRange,
  trimCompositionToRange,
} from "../timelineOps";

const style = { fontFamily: "Inter", fontSize: 40, fontWeight: 600, color: "#fff", align: "center" as const };

function video(id: string, from: number, durationInFrames: number, trimStart = 0, extra: Partial<Clip> = {}): Clip {
  return { id, type: "video", from, durationInFrames, assetId: "v", trimStart, ...extra } as Clip;
}
function audio(id: string, from: number, durationInFrames: number, assetId: string, trimStart = 0): Clip {
  return { id, type: "audio", from, durationInFrames, assetId, trimStart };
}
function text(id: string, from: number, durationInFrames: number): Clip {
  return { id, type: "text", from, durationInFrames, text: id, style };
}
function track(id: string, kind: TrackKind, clips: Clip[], extra: Partial<Track> = {}): Track {
  return { id, name: id, kind, clips, ...extra };
}
function make(tracks: Track[], durationInFrames = 600): Timeline {
  const comp: Composition = { id: "Main", name: "Main", width: 1920, height: 1080, fps: 30, durationInFrames, background: "#000", tracks, markers: [] };
  return {
    version: 1,
    compositions: [comp],
    assets: [
      { id: "v", kind: "video", src: "media/talk.mp4", name: "talk.mp4", durationInFrames: 900, fps: 30 },
      { id: "music", kind: "audio", src: "media/music.mp3", name: "music.mp3", durationInFrames: 9000, fps: 30 },
    ],
  };
}
const comp = (tl: Timeline) => getComposition(tl, "Main")!;
const spans = (tl: Timeline, trackId: string) =>
  comp(tl).tracks.find((t) => t.id === trackId)!.clips.map((c) => [c.from, c.durationInFrames, "trimStart" in c ? c.trimStart : null]);

describe("detachAudio", () => {
  it("adds an in-sync audio clip on a new bottom audio track and silences the video", () => {
    const tl = make([track("v1", "video", [video("a", 30, 120, 10, { volume: 0.8 })])]);
    const r = detachAudio(tl, "Main", "a", "Audio 1");
    const c = comp(r.timeline);
    expect(c.tracks[0]).toMatchObject({ kind: "audio", name: "Audio 1" });
    const a = locateClip(c, r.audioClipId!)!.clip;
    expect(a).toMatchObject({ type: "audio", from: 30, durationInFrames: 120, trimStart: 10, volume: 0.8 });
    expect(locateClip(c, "a")!.clip).toMatchObject({ volume: 0 });
    expect(inSync(a, locateClip(c, "a")!.clip)).toBe(true);
  });

  it("reuses a free audio track and refuses sped-up or already silent clips", () => {
    const tl = make([track("au", "audio", []), track("v1", "video", [video("a", 0, 60), video("b", 60, 60, 0, { playbackRate: 2 })])]);
    const r = detachAudio(tl, "Main", "a");
    expect(comp(r.timeline).tracks).toHaveLength(2);
    expect(spans(r.timeline, "au")).toEqual([[0, 60, 0]]);
    expect(detachAudio(r.timeline, "Main", "a").audioClipId).toBeNull();
    expect(detachAudio(tl, "Main", "b").timeline).toBe(tl);
  });
});

describe("rippleDeleteRanges", () => {
  const base = () =>
    make([
      track("music", "audio", [audio("m", 0, 600, "music")]),
      track("dial", "audio", [audio("d", 0, 300, "v")]),
      track("v1", "video", [video("a", 0, 300), video("b", 300, 100, 300)]),
      track("t1", "text", [text("title", 80, 60)]),
      track(
        "cap",
        "text",
        [
          {
            id: "cc",
            type: "captions",
            from: 0,
            durationInFrames: 300,
            style,
            mode: "line",
            captions: [
              { text: "hello", startMs: 0, endMs: 1000 },
              { text: "um", startMs: 1000, endMs: 2000 },
              { text: "world", startMs: 4000, endMs: 5000 },
            ],
          },
        ],
      ),
    ]);

  it("cuts the clip and what is in sync, shifts the rest, keeps music playing", () => {
    // Remove frames 30..60 (1 s..2 s) and 90..120.
    const r = rippleDeleteRanges(base(), "Main", "a", [[90, 120], [30, 60]]);
    expect(r.removedFrames).toBe(60);
    const tl = r.timeline;
    expect(spans(tl, "v1")).toEqual([[0, 30, 0], [30, 30, 60], [60, 180, 120], [240, 100, 300]]);
    expect(spans(tl, "dial")).toEqual([[0, 30, 0], [30, 30, 60], [60, 180, 120]]);
    expect(spans(tl, "music")).toEqual([[0, 540, 0]]);
    // Title 80..140 loses 90..120 → 50..80 and 80..110 after both shifts.
    expect(spans(tl, "t1").map((s) => [s[0], s[1]])).toEqual([[50, 10], [60, 20]]);
    expect(comp(tl).durationInFrames).toBe(540);
  });

  it("keeps caption words aligned with the picture", () => {
    const tl = rippleDeleteRanges(base(), "Main", "a", [[30, 60]]).timeline;
    const caps = comp(tl).tracks.find((t) => t.id === "cap")!.clips;
    const words = caps.flatMap((c) => (c.type === "captions" ? c.captions.map((w) => [w.text, c.from * (1000 / 30) + w.startMs]) : []));
    expect(words).toEqual([["hello", 0], ["world", 3000]]);
  });

  it("clamps ranges to the clip and ignores locked clips", () => {
    expect(rippleDeleteRanges(base(), "Main", "a", [[400, 500]]).removedFrames).toBe(0);
    const locked = make([track("v1", "video", [video("a", 0, 300)], { locked: true })]);
    expect(rippleDeleteRanges(locked, "Main", "a", [[0, 30]]).timeline).toBe(locked);
  });
});

describe("trim to in/out", () => {
  it("trims selected clips to the range and drops the ones outside", () => {
    const tl = make([track("v1", "video", [video("a", 0, 100), video("b", 100, 100, 100), video("c", 300, 50)])]);
    const next = trimClipsToRange(tl, "Main", ["a", "b", "c"], 50, 150);
    expect(spans(next, "v1")).toEqual([[50, 50, 50], [100, 50, 100]]);
  });

  it("crops the whole composition to the range", () => {
    let tl = make([track("v1", "video", [video("a", 0, 200)]), track("t1", "text", [text("x", 150, 100)])]);
    tl = { ...tl, compositions: [{ ...comp(tl), markers: [{ id: "m", frame: 120, label: "" }, { id: "n", frame: 10, label: "" }] }] };
    const next = trimCompositionToRange(tl, "Main", 100, 180);
    expect(spans(next, "v1")).toEqual([[0, 80, 100]]);
    expect(spans(next, "t1").map((s) => [s[0], s[1]])).toEqual([[50, 30]]);
    expect(comp(next).markers).toEqual([{ id: "m", frame: 20, label: "" }]);
    expect(comp(next).durationInFrames).toBe(80);
  });
});

describe("freezeFrame", () => {
  const still: Asset = { id: "still", kind: "image", src: "media/still-60.png", name: "still-60.png" };

  it("splits, inserts the hold and pushes later content (and synced audio) right", () => {
    const tl = make([
      track("dial", "audio", [audio("d", 0, 200, "v")]),
      track("v1", "video", [video("a", 0, 200, 0, { opacity: { keyframes: [{ frame: 0, value: 0 }, { frame: 100, value: 1 }] } }), video("b", 200, 50, 200)]),
      track("t1", "text", [text("x", 40, 40), text("y", 100, 20)]),
    ]);
    const r = freezeFrame(tl, "Main", "a", 60, still, 30);
    const tlr = r.timeline;
    expect(tlr.assets.some((a) => a.id === "still")).toBe(true);
    expect(spans(tlr, "v1")).toEqual([[0, 60, 0], [60, 30, null], [90, 140, 60], [230, 50, 200]]);
    expect(spans(tlr, "dial")).toEqual([[0, 60, 0], [90, 140, 60]]);
    expect(spans(tlr, "t1").map((s) => [s[0], s[1]])).toEqual([[40, 40], [130, 20]]);
    const hold = locateClip(comp(tlr), r.holdClipId!)!.clip;
    expect(hold).toMatchObject({ type: "image", assetId: "still", opacity: 0.6 });
  });

  it("refuses frames outside the clip", () => {
    const tl = make([track("v1", "video", [video("a", 0, 100)])]);
    expect(freezeFrame(tl, "Main", "a", 100, still, 30).timeline).toBe(tl);
  });
});

describe("setClipSpeed", () => {
  it("changes the duration, rescales keyframes and moves later clips", () => {
    const tl = make([
      track("v1", "video", [video("a", 0, 100, 0, { opacity: { keyframes: [{ frame: 50, value: 1 }] } }), video("b", 100, 50, 300)]),
    ]);
    const fast = setClipSpeed(tl, "Main", "a", 2);
    expect(spans(fast, "v1")).toEqual([[0, 50, 0], [50, 50, 300]]);
    const a = locateClip(comp(fast), "a")!.clip;
    expect(a).toMatchObject({ playbackRate: 2, opacity: { keyframes: [{ frame: 25, value: 1 }] } });
    const back = setClipSpeed(fast, "Main", "a", 1);
    expect(spans(back, "v1")).toEqual([[0, 100, 0], [100, 50, 300]]);
    expect("playbackRate" in locateClip(comp(back), "a")!.clip).toBe(false);
  });

  it("caps slow motion at the end of the media", () => {
    // 900-frame asset, 800 skipped: at 0.5× at most 200 frames.
    const tl = make([track("v1", "video", [video("a", 0, 100, 800)])]);
    expect(spans(setClipSpeed(tl, "Main", "a", 0.5), "v1")).toEqual([[0, 200, 800]]);
  });
});

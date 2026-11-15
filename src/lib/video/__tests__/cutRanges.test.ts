import { describe, expect, it } from "vitest";
import { captionRangesToFrames, cutRanges, normalizeRanges, phraseRanges, silencesInClip } from "@/lib/video/cutRanges";
import { emptyTimeline, validateTimeline, type CaptionsClip, type Timeline, type VideoClip } from "@/lib/video/timelineSchema";

function footage(): Timeline {
  const t = emptyTimeline({ width: 1920, height: 1080, fps: 30, durationInFrames: 300 });
  t.assets.push({ id: "a", kind: "video", src: "media/a.mp4", name: "a.mp4", durationInFrames: 600, fps: 30 });
  const comp = t.compositions[0];
  comp.tracks = [
    { id: "v", name: "Video", kind: "video", clips: [{ id: "clip", type: "video", assetId: "a", from: 0, durationInFrames: 300, trimStart: 0 }] },
    {
      id: "t",
      name: "Captions",
      kind: "text",
      clips: [
        {
          id: "caps",
          type: "captions",
          from: 0,
          durationInFrames: 300,
          mode: "line",
          style: { fontFamily: "Inter", fontSize: 60, fontWeight: 800, color: "#fff", align: "center" },
          captions: [
            { text: "So", startMs: 0, endMs: 500 },
            { text: " um", startMs: 500, endMs: 1000 },
            { text: " this", startMs: 1000, endMs: 1500 },
            { text: " is,", startMs: 1500, endMs: 2000 },
            { text: " you", startMs: 2000, endMs: 2500 },
            { text: " know,", startMs: 2500, endMs: 3000 },
            { text: " great", startMs: 3000, endMs: 4000 },
          ],
        },
      ],
    },
    { id: "m", name: "Music", kind: "audio", locked: true, clips: [{ id: "music", type: "audio", assetId: "a", from: 0, durationInFrames: 300, trimStart: 0 }] },
  ];
  comp.markers = [{ id: "mk", frame: 200, label: "end" }];
  return t;
}

describe("normalizeRanges", () => {
  it("sorts, rounds and merges", () => {
    expect(normalizeRanges([[50, 60], [10.4, 20.6], [15, 30], [70, 70]])).toEqual([[10, 30], [50, 60]]);
  });
});

describe("cutRanges", () => {
  it("removes the ranges on every unlocked track and keeps them in sync", () => {
    const { timeline, removedFrames } = cutRanges(footage(), "Main", [[30, 60], [90, 120]]);
    expect(removedFrames).toBe(60);
    const comp = timeline.compositions[0];
    const video = comp.tracks[0].clips as VideoClip[];
    expect(video.map((c) => [c.from, c.durationInFrames, c.trimStart])).toEqual([
      [0, 30, 0],
      [30, 30, 60],
      [60, 180, 120],
    ]);
    // The locked music track is untouched.
    expect(comp.tracks[2].clips).toHaveLength(1);
    expect(comp.markers[0].frame).toBe(140);
    expect(comp.durationInFrames).toBe(300);
    const v = validateTimeline(timeline);
    expect(v.ok ? [] : v.errors).toEqual([]);
  });

  it("shortens the composition when nothing locked holds it", () => {
    const t = footage();
    t.compositions[0].tracks.pop();
    const { timeline } = cutRanges(t, "Main", [[0, 30]]);
    expect(timeline.compositions[0].durationInFrames).toBe(270);
  });
});

describe("silencesInClip", () => {
  it("maps asset frames to clip frames with padding, not at the clip edges", () => {
    const clip: VideoClip = { id: "c", type: "video", assetId: "a", from: 100, durationInFrames: 200, trimStart: 60 };
    // Asset at 60 fps, comp at 30: asset frame 120 = comp-time frame 60 = clip start.
    expect(silencesInClip(clip, 30, 60, [[100, 200], [300, 400], [500, 1000]], 3)).toEqual([
      [100, 137],
      [193, 237],
      [293, 300],
    ]);
  });
});

describe("phraseRanges", () => {
  const caps = (footage().compositions[0].tracks[1].clips[0] as CaptionsClip).captions;

  it("finds words and phrases ignoring case and punctuation", () => {
    expect(phraseRanges(caps, ["um", "You know"])).toEqual([
      { phrase: "um", startMs: 500, endMs: 1000 },
      { phrase: "You know", startMs: 2000, endMs: 3000 },
    ]);
  });

  it("converts to frames and cuts the words out of the captions too", () => {
    const t = footage();
    const clip = t.compositions[0].tracks[1].clips[0] as CaptionsClip;
    const frames = captionRangesToFrames(clip, 30, phraseRanges(caps, ["um"]));
    expect(frames).toEqual([[15, 30]]);
    const { timeline } = cutRanges(t, "Main", frames);
    const text = timeline.compositions[0].tracks[1].clips
      .flatMap((c) => (c.type === "captions" ? c.captions.map((x) => x.text) : []))
      .join("");
    expect(text).toBe("So this is, you know, great");
  });
});

import { describe, expect, it } from "vitest";
import type { Asset, Timeline, VideoClip } from "@/lib/video/timelineSchema";
import { detachAudio, insertHold } from "../inspector/footageOps";

const asset: Asset = { id: "a1", kind: "video", src: "media/a.mp4", name: "a.mp4", durationInFrames: 300, fps: 30 };
const still: Asset = { id: "s1", kind: "image", src: "media/a-f45.png", name: "a-f45.png" };

function timeline(clips: VideoClip[]): Timeline {
  return {
    version: 1,
    assets: [asset, still],
    compositions: [
      {
        id: "main",
        name: "Main",
        width: 1920,
        height: 1080,
        fps: 30,
        durationInFrames: 200,
        background: "#000",
        markers: [],
        tracks: [
          { id: "v", name: "Video", kind: "video", clips },
          { id: "t", name: "Text", kind: "text", clips: [{ id: "x", type: "text", from: 0, durationInFrames: 200, text: "Hi", style: { fontFamily: "Inter", fontSize: 40, fontWeight: 700, color: "#fff", align: "center" } }] },
        ],
      },
    ],
  };
}

const v1: VideoClip = { id: "c1", type: "video", assetId: "a1", from: 0, durationInFrames: 100, trimStart: 10 };
const v2: VideoClip = { id: "c2", type: "video", assetId: "a1", from: 100, durationInFrames: 50, trimStart: 0 };

describe("detachAudio", () => {
  it("adds a matching audio clip on a new audio track and silences the video", () => {
    const r = detachAudio(timeline([v1]), "main", "c1")!;
    const comp = r.timeline.compositions[0];
    const audioTrack = comp.tracks.find((t) => t.kind === "audio")!;
    expect(audioTrack.clips[0]).toMatchObject({ id: r.audioClipId, type: "audio", assetId: "a1", from: 0, durationInFrames: 100, trimStart: 10 });
    expect(comp.tracks[0].clips[0]).toMatchObject({ id: "c1", volume: 0 });
  });

  it("refuses sped-up clips and non-video clips", () => {
    expect(detachAudio(timeline([{ ...v1, playbackRate: 2 }]), "main", "c1")).toBeNull();
    expect(detachAudio(timeline([v1]), "main", "x")).toBeNull();
  });
});

describe("insertHold", () => {
  it("splits, pushes the rest of the track and fills the gap with the still", () => {
    const r = insertHold(timeline([v1, v2]), "main", "c1", 45, still, 60)!;
    const comp = r.timeline.compositions[0];
    const clips = comp.tracks[0].clips.map((c) => [c.type, c.from, c.durationInFrames]);
    expect(clips).toEqual([
      ["video", 0, 45],
      ["image", 45, 60],
      ["video", 105, 55],
      ["video", 160, 50],
    ]);
    // Other tracks stay where they were; the composition grows.
    expect(comp.tracks[1].clips[0].from).toBe(0);
    expect(comp.durationInFrames).toBe(260);
  });

  it("refuses a frame outside the clip", () => {
    expect(insertHold(timeline([v1]), "main", "c1", 150, still, 30)).toBeNull();
  });
});

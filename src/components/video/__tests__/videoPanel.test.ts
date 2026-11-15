import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("@/lib/video/videoApi", () => ({}));

import { formatDuration, formatEta, formatTimecode, parseTimecode } from "../timecode";
import { adjacentKeys, hasKeyAt, setValueAt, toggleKeyAt, valueAt } from "../inspector/animatable";
import { buildRenderOptions } from "../render/renderOptions";
import { withAssets } from "../media";
import { projectOwningFile } from "../editVideoFile";
import { isUsableAsset, markAllHandled, pickSettled, type NewMediaState } from "../useNewMedia";
import type { Asset, Timeline } from "@/lib/video/timelineSchema";
import type { MediaFile } from "@/lib/video/videoApi";

describe("timecode", () => {
  it("formats HH:MM:SS:FF", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00:00");
    expect(formatTimecode(29, 30)).toBe("00:00:00:29");
    expect(formatTimecode(30 * 61 + 5, 30)).toBe("00:01:01:05");
    expect(formatTimecode(60 * 3600, 60)).toBe("01:00:00:00");
  });

  it("parses timecodes, frame numbers and seconds", () => {
    expect(parseTimecode("00:00:01:05", 30)).toBe(35);
    expect(parseTimecode("1:05", 30)).toBe(35);
    expect(parseTimecode("120", 30)).toBe(120);
    expect(parseTimecode("2.5s", 24)).toBe(60);
    expect(parseTimecode("00:00:00:30", 30)).toBeNull();
    expect(parseTimecode("abc", 30)).toBeNull();
    expect(parseTimecode(formatTimecode(12345, 25), 25)).toBe(12345);
  });

  it("formats durations and ETAs", () => {
    expect(formatDuration(30 * 7, 30)).toBe("0:07");
    expect(formatDuration(30 * 3725, 30)).toBe("1:02:05");
    expect(formatEta(12)).toBe("12 s");
    expect(formatEta(185)).toBe("3 min 05 s");
  });
});

describe("keyframe toggles", () => {
  it("turns a fixed value into one keyframe holding it, and back", () => {
    const keyed = toggleKeyAt(0.5, 10, 1);
    expect(keyed).toEqual({ keyframes: [{ frame: 10, value: 0.5, easing: "ease-in-out" }] });
    expect(hasKeyAt(keyed, 10)).toBe(true);
    expect(toggleKeyAt(keyed, 10, 1)).toBe(0.5);
  });

  it("adds a keyframe at the playhead with the interpolated value, sorted", () => {
    const v = { keyframes: [{ frame: 0, value: 0 }, { frame: 20, value: 100 }] };
    const next = toggleKeyAt(v, 10, 0);
    expect(typeof next === "object" && next.keyframes.map((k) => k.frame)).toEqual([0, 10, 20]);
    expect(valueAt(next, 10, 0)).toBeCloseTo(50, 0);
  });

  it("editing a keyframed value writes the keyframe at the playhead", () => {
    const v = { keyframes: [{ frame: 0, value: 0 }, { frame: 20, value: 100 }] };
    expect(setValueAt(v, 20, 80)).toEqual({ keyframes: [{ frame: 0, value: 0 }, { frame: 20, value: 80 }] });
    expect(setValueAt(5, 3, 7)).toBe(7);
  });

  it("finds the neighbouring keyframes", () => {
    const v = { keyframes: [{ frame: 0, value: 0 }, { frame: 20, value: 1 }, { frame: 40, value: 2 }] };
    expect(adjacentKeys(v, 20)).toEqual({ prev: 0, next: 40 });
    expect(adjacentKeys(v, 50)).toEqual({ prev: 40, next: null });
    expect(adjacentKeys(3, 5)).toEqual({ prev: null, next: null });
  });
});

describe("render options", () => {
  const base = { quality: "high" as const, scale: 1, range: null, includeAudio: true, compositionId: "main", outputName: "launch" };

  it("maps formats to codecs and quality to CRF", () => {
    expect(buildRenderOptions({ ...base, format: "h264" })).toEqual({ compositionId: "main", codec: "h264", crf: 16, outputName: "launch" });
    expect(buildRenderOptions({ ...base, format: "webm", quality: "low" })).toMatchObject({ codec: "vp9", crf: 40 });
    expect(buildRenderOptions({ ...base, format: "prores" })).not.toHaveProperty("crf");
  });

  it("passes scale, range, GIF fps and mutes when asked or for GIFs", () => {
    const o = buildRenderOptions({ ...base, format: "gif", scale: 0.5, range: [10, 99], gifFps: 15 });
    expect(o).toMatchObject({ codec: "gif", scale: 0.5, frameRange: [10, 99], fps: 15, muted: true });
    expect(buildRenderOptions({ ...base, format: "h265", includeAudio: false })).toMatchObject({ muted: true });
    expect(buildRenderOptions({ ...base, format: "h264", gifFps: 15 })).not.toHaveProperty("fps");
  });
});

describe("files that belong to a project", () => {
  const projects = [{ slug: "tnp-trailer", path: "C:\\v\\videos\\tnp-trailer" }, { slug: "adopted", path: "C:/v/apps/adopted/" }];

  it("finds the project holding a file, whatever the slashes or case", () => {
    expect(projectOwningFile(projects, "C:\\v\\videos\\tnp-trailer\\out\\Final.mp4")?.slug).toBe("tnp-trailer");
    expect(projectOwningFile(projects, "c:/V/videos/TNP-trailer/media/a.mp4")?.slug).toBe("tnp-trailer");
    expect(projectOwningFile(projects, "C:\\v\\apps\\adopted\\public\\a.mp4")?.slug).toBe("adopted");
  });

  it("doesn't take a file from elsewhere or from a folder with a longer name", () => {
    expect(projectOwningFile(projects, "C:\\v\\clip.mp4")).toBeNull();
    expect(projectOwningFile(projects, "C:\\v\\videos\\tnp-trailer-2\\out\\a.mp4")).toBeNull();
  });
});

describe("new files in the media folder", () => {
  const file = (name: string, size: number): MediaFile => ({ src: `media/${name}`, path: `C:/p/media/${name}`, size });
  const fresh = (): NewMediaState => ({ handled: new Map(), sizes: new Map() });

  it("ignores what was there when the project opened", () => {
    const s = fresh();
    markAllHandled(s, [file("old.mp4", 10)]);
    expect(pickSettled(s, [file("old.mp4", 10)], [])).toEqual({ ready: [], waiting: false });
  });

  it("waits until a new file stops growing, then takes it once", () => {
    const s = fresh();
    expect(pickSettled(s, [file("a.mp4", 10)], [])).toEqual({ ready: [], waiting: true });
    expect(pickSettled(s, [file("a.mp4", 20)], [])).toEqual({ ready: [], waiting: true });
    expect(pickSettled(s, [file("a.mp4", 20)], []).ready.map((f) => f.src)).toEqual(["media/a.mp4"]);
    expect(pickSettled(s, [file("a.mp4", 20)], [])).toEqual({ ready: [], waiting: false });
  });

  it("doesn't take an empty file while it is still empty", () => {
    const s = fresh();
    pickSettled(s, [file("a.mp4", 0)], []);
    expect(pickSettled(s, [file("a.mp4", 0)], [])).toEqual({ ready: [], waiting: true });
  });

  it("leaves a registered asset alone, even after an undo removed it", () => {
    const s = fresh();
    expect(pickSettled(s, [file("A.mp4", 5)], ["media/a.mp4"])).toEqual({ ready: [], waiting: false });
    expect(pickSettled(s, [file("A.mp4", 5)], [])).toEqual({ ready: [], waiting: false });
  });

  it("retries a file ffprobe couldn't read only once its size changes", () => {
    const s = fresh();
    s.handled.set("media/a.mp4", 48);
    expect(pickSettled(s, [file("a.mp4", 48)], [])).toEqual({ ready: [], waiting: false });
    expect(pickSettled(s, [file("a.mp4", 900)], [])).toEqual({ ready: [], waiting: true });
    expect(pickSettled(s, [file("a.mp4", 900)], []).ready).toHaveLength(1);
  });

  it("only needs a length from video and audio", () => {
    const a = (kind: Asset["kind"], durationInFrames?: number): Asset => ({ id: "x", kind, src: "media/x", name: "x", durationInFrames });
    expect(isUsableAsset(a("video"))).toBe(false);
    expect(isUsableAsset(a("audio"))).toBe(false);
    expect(isUsableAsset(a("video", 30))).toBe(true);
    expect(isUsableAsset(a("image"))).toBe(true);
    expect(isUsableAsset(a("font"))).toBe(true);
  });
});

describe("media bin", () => {
  it("adds imported assets, replacing ones with the same id", () => {
    const a = (id: string, name: string): Asset => ({ id, kind: "video", src: `media/${name}`, name });
    const tl: Timeline = { version: 1, compositions: [], assets: [a("x", "old.mp4"), a("y", "keep.mp4")] };
    const next = withAssets(tl, [a("x", "new.mp4"), a("z", "add.mp4")]);
    expect(next.assets.map((x) => `${x.id}:${x.name}`)).toEqual(["y:keep.mp4", "x:new.mp4", "z:add.mp4"]);
  });
});

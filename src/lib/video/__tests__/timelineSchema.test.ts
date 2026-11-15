import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyEasing,
  emptyTimeline,
  newId,
  resolveAnimatable,
  resolveTransform,
  sceneModuleName,
  validateTimeline,
} from "../timelineSchema";
import type { Clip, Timeline } from "../timelineSchema";

const repoRoot = path.resolve(__dirname, "../../../..");
const templateDir = path.join(repoRoot, "src-tauri/resources/video-template");

/** Drops the leading `//` comment lines (the header that differs between the two copies). */
function body(file: string): string {
  const lines = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].startsWith("//")) i++;
  return lines.slice(i).join("\n");
}

function baseTimeline(): Timeline {
  const t = emptyTimeline({ width: 1920, height: 1080, fps: 30, durationInFrames: 300 });
  t.assets.push(
    { id: "a-video", kind: "video", src: "media/intro.mp4", name: "intro.mp4", durationInFrames: 300, fps: 30 },
    { id: "a-img", kind: "image", src: "media/photo.jpg", name: "photo.jpg" },
    { id: "a-song", kind: "audio", src: "media/song.mp3", name: "song.mp3", durationInFrames: 600, fps: 30 },
  );
  return t;
}

const text = (over: Partial<Clip> = {}): Clip =>
  ({
    id: newId("clip"),
    type: "text",
    from: 0,
    durationInFrames: 30,
    text: "Hello",
    style: { fontFamily: "Inter", fontSize: 64, fontWeight: 700, color: "#fff", align: "center" },
    ...over,
  }) as Clip;

describe("schema copies", () => {
  it("template copy is byte-identical below the header", () => {
    const a = body(path.join(repoRoot, "src/lib/video/timelineSchema.ts"));
    const b = body(path.join(templateDir, "nyxs/engine/schema.ts"));
    expect(b).toBe(a);
  });

  it("the runtime's example project timeline.json is valid", () => {
    const json: unknown = JSON.parse(readFileSync(path.join(templateDir, "examples/demo/timeline.json"), "utf8"));
    const result = validateTimeline(json);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });
});

describe("resolveAnimatable", () => {
  it("returns fixed values as is", () => {
    expect(resolveAnimatable(5, 100)).toBe(5);
  });

  it("interpolates linearly by default and holds outside the range", () => {
    const v = { keyframes: [{ frame: 10, value: 0 }, { frame: 20, value: 100 }] };
    expect(resolveAnimatable(v, 0)).toBe(0);
    expect(resolveAnimatable(v, 15)).toBe(50);
    expect(resolveAnimatable(v, 30)).toBe(100);
  });

  it("uses the easing of the keyframe the segment leaves", () => {
    const v = {
      keyframes: [
        { frame: 0, value: 0, easing: "ease-in" as const },
        { frame: 10, value: 100, easing: "linear" as const },
        { frame: 20, value: 200 },
      ],
    };
    expect(resolveAnimatable(v, 5)).toBeLessThan(50);
    expect(resolveAnimatable(v, 15)).toBeCloseTo(150, 5);
  });

  it("sorts unsorted keyframes", () => {
    const v = { keyframes: [{ frame: 20, value: 100 }, { frame: 0, value: 0 }] };
    expect(resolveAnimatable(v, 10)).toBe(50);
  });

  it("holds non-numeric values until the next keyframe", () => {
    const v = { keyframes: [{ frame: 0, value: "a" }, { frame: 10, value: "b" }] };
    expect(resolveAnimatable(v, 9)).toBe("a");
    expect(resolveAnimatable(v, 10)).toBe("b");
  });
});

describe("applyEasing", () => {
  it.each(["linear", "ease-in", "ease-out", "ease-in-out", "spring"] as const)("%s starts at 0 and ends at 1", (e) => {
    expect(applyEasing(e, 0)).toBeCloseTo(0, 6);
    expect(applyEasing(e, 1)).toBeCloseTo(1, 6);
  });

  it("orders the cubic easings as CSS does", () => {
    expect(applyEasing("ease-in", 0.5)).toBeLessThan(0.5);
    expect(applyEasing("ease-out", 0.5)).toBeGreaterThan(0.5);
    expect(applyEasing("ease-in-out", 0.5)).toBeCloseTo(0.5, 3);
    // CSS ease-in at 25% ≈ 0.0934.
    expect(applyEasing("ease-in", 0.25)).toBeCloseTo(0.0934, 2);
  });

  it("spring overshoots and settles", () => {
    const samples = Array.from({ length: 101 }, (_, i) => applyEasing("spring", i / 100));
    expect(Math.max(...samples)).toBeGreaterThan(1.02);
    expect(Math.max(...samples)).toBeLessThan(1.2);
    expect(Math.abs(samples[99] - 1)).toBeLessThan(0.01);
  });

  it("clamps progress outside 0..1", () => {
    expect(applyEasing("linear", -1)).toBe(0);
    expect(applyEasing("linear", 2)).toBe(1);
  });
});

describe("helpers", () => {
  it("newId uses the prefix and a composition-safe alphabet", () => {
    const id = newId("comp");
    expect(id).toMatch(/^comp-[a-z0-9]{10}$/);
    expect(newId("x")).not.toBe(newId("x"));
  });

  it("emptyTimeline is valid", () => {
    const t = emptyTimeline({ width: 1080, height: 1920, fps: 60, durationInFrames: 600, name: "Reel" });
    expect(validateTimeline(t)).toEqual({ ok: true, timeline: t });
    expect(t.compositions[0].tracks.map((tr) => tr.kind)).toEqual(["video", "text", "audio"]);
  });

  it("resolveTransform defaults to the composition center", () => {
    expect(resolveTransform(undefined, 0, { width: 1920, height: 1080 })).toEqual({
      x: 960,
      y: 540,
      scale: 1,
      rotation: 0,
      anchor: "center",
    });
  });

  it("sceneModuleName strips script extensions", () => {
    expect(sceneModuleName("TitleCard.tsx")).toBe("TitleCard");
    expect(sceneModuleName("TitleCard")).toBe("TitleCard");
  });
});

describe("validateTimeline", () => {
  const errorsOf = (t: unknown) => {
    const r = validateTimeline(t);
    return r.ok ? [] : r.errors;
  };

  it("accepts a timeline with every clip type", () => {
    const t = baseTimeline();
    const [video, textTrack, audio] = t.compositions[0].tracks;
    video.clips.push(
      { id: "v1", type: "video", assetId: "a-video", from: 0, durationInFrames: 100, trimStart: 10, playbackRate: 2 },
      {
        id: "i1",
        type: "image",
        assetId: "a-img",
        from: 100,
        durationInFrames: 50,
        kenBurns: { fromScale: 1, toScale: 1.2, fromX: 0, toX: 20, fromY: 0, toY: -10 },
        transitionIn: { kind: "fade", durationInFrames: 10 },
        effects: [{ kind: "chroma-key", color: "#00ff00", tolerance: 0.3 }, { kind: "blur", amount: { keyframes: [{ frame: 0, value: 4 }] } }],
      },
      { id: "s1", type: "scene", file: "TitleCard.tsx", exportName: "TitleCard", from: 150, durationInFrames: 60, props: { title: "x" } },
      { id: "sh1", type: "shape", shape: "rect", fill: "red", width: 100, height: 50, from: 210, durationInFrames: 30 },
    );
    textTrack.clips.push(
      text({ id: "t1", animation: { in: { kind: "typewriter", durationInFrames: 10 } } }),
      {
        id: "c1",
        type: "captions",
        from: 40,
        durationInFrames: 60,
        mode: "karaoke",
        captions: [{ text: "hi", startMs: 0, endMs: 300 }],
        style: { fontFamily: "Inter", fontSize: 40, fontWeight: 600, color: "#fff", align: "center" },
      },
    );
    audio.clips.push({ id: "au1", type: "audio", assetId: "a-song", from: 0, durationInFrames: 300, trimStart: 0, fadeIn: 30, fadeOut: 30 });
    expect(errorsOf(t)).toEqual([]);
  });

  it("rejects non-objects and wrong versions", () => {
    expect(errorsOf(null)).toEqual(["timeline: expected an object, got null"]);
    const t = { ...baseTimeline(), version: 2 };
    expect(errorsOf(t)).toContain("version: expected 1, got 2");
  });

  it("reports overlapping and unsorted clips with their path", () => {
    const t = baseTimeline();
    t.compositions[0].tracks[1].clips.push(text({ id: "a", from: 0, durationInFrames: 30 }), text({ id: "b", from: 20 }), text({ id: "c", from: 10 }));
    const errors = errorsOf(t);
    expect(errors).toContain(
      'compositions[0].tracks[1].clips[1] (id "b"): overlaps clip "a" (frames 0-30); this clip starts at 20',
    );
    expect(errors.some((e) => e.startsWith('compositions[0].tracks[1].clips[2] (id "c"): clips must be sorted'))).toBe(true);
  });

  it("reports missing assets, wrong asset kinds and audio on the wrong track", () => {
    const t = baseTimeline();
    t.compositions[0].tracks[0].clips.push(
      { id: "v1", type: "video", assetId: "nope", from: 0, durationInFrames: 10, trimStart: 0 },
      { id: "i1", type: "image", assetId: "a-song", from: 10, durationInFrames: 10 },
      { id: "au", type: "audio", assetId: "a-song", from: 20, durationInFrames: 10, trimStart: 0 },
    );
    const errors = errorsOf(t);
    expect(errors).toContain('compositions[0].tracks[0].clips[0] (id "v1").assetId: no asset with id "nope" in timeline.assets');
    expect(errors).toContain('compositions[0].tracks[0].clips[1] (id "i1").assetId: asset "a-song" is a audio, expected image');
    expect(errors).toContain('compositions[0].tracks[0].clips[2] (id "au").type: audio clips go on an audio track, this track is "video"');
  });

  it("checks that a trimmed clip fits in its asset", () => {
    const t = baseTimeline();
    t.compositions[0].tracks[0].clips.push({ id: "v1", type: "video", assetId: "a-video", from: 0, durationInFrames: 200, trimStart: 50, playbackRate: 2 });
    expect(errorsOf(t)).toContain(
      'compositions[0].tracks[0].clips[0] (id "v1").durationInFrames: clip needs 450 frames of "intro.mp4" (trimStart 50 + 200 frames at 2x) but the asset has 300',
    );
  });

  it("checks keyframes, ranges and enums", () => {
    const t = baseTimeline();
    t.compositions[0].tracks[1].clips.push(
      text({
        id: "t1",
        from: 1.5,
        opacity: { keyframes: [{ frame: 10, value: 1 }, { frame: 5, value: 2 }] },
        transitionIn: { kind: "zoom" as never, durationInFrames: 60 },
      }),
    );
    const errors = errorsOf(t);
    const p = 'compositions[0].tracks[1].clips[0] (id "t1")';
    expect(errors).toContain(`${p}.from: expected a whole number of frames/pixels, got 1.5`);
    expect(errors).toContain(`${p}.opacity.keyframes[1].frame: keyframes must be in increasing frame order without duplicates (5 after 10)`);
    expect(errors).toContain(`${p}.opacity.keyframes[1].value: must be <= 1, got 2`);
    expect(errors.some((e) => e.startsWith(`${p}.transitionIn.kind: expected one of "fade"`))).toBe(true);
    expect(errors).toContain(`${p}.transitionIn.durationInFrames: 60 is longer than the clip (30 frames)`);
  });

  it("rejects bad composition ids, duplicate ids and unsafe paths", () => {
    const t = baseTimeline();
    t.compositions[0].id = "my comp";
    t.compositions.push({ ...t.compositions[0], tracks: [] });
    t.assets.push({ id: "a-img", kind: "image", src: "../secret.png", name: "x" });
    t.compositions[0].tracks[0].clips.push({ id: "s", type: "scene", file: "../evil.tsx", exportName: "default-x", from: 0, durationInFrames: 5 });
    const errors = errorsOf(t);
    expect(errors).toContain('compositions[0].id: may only contain letters, digits and "-", got "my comp"');
    expect(errors).toContain('compositions[1].id: duplicate composition id "my comp"');
    expect(errors).toContain('assets[3].id: duplicate asset id "a-img"');
    expect(errors.some((e) => e.startsWith("assets[3].src: must be a path relative to public/"))).toBe(true);
    expect(errors.some((e) => e.includes('.file: must be a file name inside scenes/'))).toBe(true);
    expect(errors.some((e) => e.includes('.exportName: must be a JavaScript export name'))).toBe(true);
  });

  it("rejects duplicate clip ids across tracks", () => {
    const t = baseTimeline();
    t.compositions[0].tracks[0].clips.push(text({ id: "dup" }));
    t.compositions[0].tracks[1].clips.push(text({ id: "dup" }));
    expect(errorsOf(t)).toContain('compositions[0].tracks[1].clips[0] (id "dup"): duplicate clip id, also used at compositions[0].tracks[0].clips[0]');
  });
});

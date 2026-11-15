import { describe, expect, it } from "vitest";
import { applyEdits, VideoToolError } from "../agentEdits";
import { emptyTimeline, type Timeline } from "../timelineSchema";

const base = (): Timeline => emptyTimeline({ width: 1000, height: 500, fps: 30, durationInFrames: 100 });
const clipsOf = (tl: Timeline) => tl.compositions[0].tracks.flatMap((t) => t.clips);

function built(): Timeline {
  return applyEdits(base(), "Main", {
    tracks: [
      {
        id: "cards",
        name: "Cards",
        kind: "overlay",
        clips: [
          { id: "a", type: "shape", durationInFrames: 30, transform: { x: 500, y: 250, scale: { keyframes: [{ frame: 0, value: 1 }, { frame: 29, value: 1.2 }] }, rotation: 0 } },
          { id: "b", type: "shape", durationInFrames: 30 },
        ],
      },
      { id: "titles", name: "Titles", kind: "text", clips: [{ id: "t", type: "text", text: "Hello there", from: 10, durationInFrames: 20 }] },
    ],
    markers: [{ frame: 30, label: "cut" }],
  }, 0).timeline;
}

describe("applyEdits", () => {
  it("builds tracks, sequences clips without a from, and adds markers", () => {
    const tl = built();
    const comp = tl.compositions[0];
    const cards = comp.tracks.find((t) => t.id === "cards")!;
    expect(cards.clips.map((c) => [c.id, c.from])).toEqual([["a", 0], ["b", 30]]);
    expect(comp.markers.map((m) => m.frame)).toEqual([30]);
  });

  it("removes every zoom with one change, keeping the position", () => {
    const r = applyEdits(built(), "Main", { changes: [{ where: { animated: "transform.scale" }, unset: ["transform.scale"] }] }, 0);
    expect(r.message).toMatch(/unset transform\.scale on 1 clip \(a\)/);
    const a = clipsOf(r.timeline).find((c) => c.id === "a")!;
    expect(a.transform).toMatchObject({ x: 500, y: 250, scale: 1, rotation: 0 });
  });

  it("restyles by selector, shifts and deletes", () => {
    let tl = applyEdits(built(), "Main", { changes: [{ where: { type: "text" }, set: { style: { color: "#FF0000" } } }] }, 0).timeline;
    expect((clipsOf(tl).find((c) => c.id === "t") as { style: { color: string; fontWeight: number } }).style).toMatchObject({ color: "#FF0000", fontWeight: 700 });
    tl = applyEdits(tl, "Main", { changes: [{ where: { text: "hello" }, shift: 5 }] }, 0).timeline;
    expect(clipsOf(tl).find((c) => c.id === "t")?.from).toBe(15);
    tl = applyEdits(tl, "Main", { changes: [{ where: { ids: ["a"] }, delete: true, ripple: true }] }, 0).timeline;
    expect(clipsOf(tl).find((c) => c.id === "b")?.from).toBe(0);
  });

  it("is all or nothing, and says which part failed", () => {
    const tl = built();
    let err: unknown;
    try {
      applyEdits(tl, "Main", { clips: [{ id: "ok", type: "text", text: "x", from: 60, durationInFrames: 5 }], changes: [{ where: { type: "audio" }, delete: true }] }, 0);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VideoToolError);
    expect(String((err as Error).message)).toMatch(/changes\[0\]: No clips match .*types: shape, text\..*Nothing was applied/);
    expect(clipsOf(tl).map((c) => c.id)).not.toContain("ok");
  });

  it("lets a cleanup with nothing to clean pass among other changes", () => {
    const r = applyEdits(built(), "Main", { changes: [{ where: { animated: "transform.scale" }, unset: ["transform.scale"] }, { where: { has: "kenBurns" }, unset: ["kenBurns"] }] }, 0);
    expect(r.message).toMatch(/unset transform\.scale on 1 clip/);
    expect(r.message).toMatch(/No clips match \{"has":"kenBurns"\}/);
    expect(() => applyEdits(built(), "Main", { changes: [{ where: { has: "kenBurns" }, unset: ["kenBurns"] }, { where: { type: "audio" }, delete: true }] }, 0)).toThrow(/Nothing was applied/);
  });

  it("deletes first, so one call can replace a clip with a new layout", () => {
    const r = applyEdits(built(), "Main", { changes: [{ where: { ids: ["a"] }, delete: true }], tracks: [{ id: "cards", clips: [{ id: "new", type: "shape", from: 0, durationInFrames: 30 }] }] }, 0);
    expect(clipsOf(r.timeline).map((c) => c.id)).toContain("new");
    expect(clipsOf(r.timeline).map((c) => c.id)).not.toContain("a");
  });

  it("names the clip that overlaps inside a track list", () => {
    expect(() => applyEdits(built(), "Main", { tracks: [{ id: "cards", clips: [{ type: "shape", from: 5, durationInFrames: 5 }] }] }, 0)).toThrow(/tracks\[0\]\.clips\[0\]: .*overlap "a"/);
  });

  it("skips locked tracks in a selection, and refuses one named by id", () => {
    const locked = applyEdits(built(), "Main", { tracks: [{ id: "titles", locked: true }] }, 0).timeline;
    const r = applyEdits(locked, "Main", { changes: [{ where: { from: 0 }, set: { name: "n" } }] }, 0);
    expect(r.message).toMatch(/skipped 1 on locked tracks/);
    expect(() => applyEdits(locked, "Main", { changes: [{ where: { ids: ["t"] }, set: { name: "n" } }] }, 0)).toThrow(/is locked/);
  });

  it("rejects an unknown selector and an empty call", () => {
    expect(() => applyEdits(built(), "Main", { changes: [{ where: { kind: "x" } as never, set: {} }] }, 0)).toThrow(/where\.kind isn't a selector/);
    expect(() => applyEdits(base(), "Main", {}, 0)).toThrow(/Nothing to apply/);
  });
});

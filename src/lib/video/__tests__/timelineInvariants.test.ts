import { describe, expect, it } from "vitest";
import type { Asset, Clip, Composition, Timeline, TrackKind } from "../timelineSchema";
import { validateTimeline } from "../timelineSchema";
import * as ops from "../timelineOps";

const style = { fontFamily: "Inter", fontSize: 40, fontWeight: 600, color: "#ffffff", align: "center" as const };

/** Small deterministic PRNG so a failure is reproducible from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T,>(xs: readonly T[]): T | undefined => xs[Math.floor(next() * xs.length)],
  };
}

const ASSETS: Asset[] = [
  { id: "v", kind: "video", src: "media/v.mp4", name: "v.mp4", durationInFrames: 900, fps: 30 },
  { id: "music", kind: "audio", src: "media/m.mp3", name: "m.mp3", durationInFrames: 3000, fps: 30 },
  { id: "img", kind: "image", src: "media/i.png", name: "i.png" },
];

function clipOf(kind: TrackKind, id: string, from: number, d: number, r: ReturnType<typeof rng>): Clip {
  switch (kind) {
    case "video":
      return r.next() < 0.7 ? { id, type: "video", from, durationInFrames: d, assetId: "v", trimStart: r.int(0, 100) } : { id, type: "image", from, durationInFrames: d, assetId: "img" };
    case "audio":
      return { id, type: "audio", from, durationInFrames: d, assetId: r.next() < 0.5 ? "v" : "music", trimStart: 0 };
    case "text":
      return r.next() < 0.7
        ? { id, type: "text", from, durationInFrames: d, text: id, style, opacity: { keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] } }
        : { id, type: "captions", from, durationInFrames: d, style, mode: "line", captions: [{ text: "a", startMs: 0, endMs: 500 }, { text: "b", startMs: 600, endMs: 1200 }] };
    default:
      return { id, type: "shape", from, durationInFrames: d, shape: "rect", fill: "#ffffff", width: 10, height: 10 };
  }
}

function randomTimeline(r: ReturnType<typeof rng>): Timeline {
  const kinds: TrackKind[] = ["video", "audio", "text", "overlay", "video"];
  let n = 0;
  const tracks = kinds.map((kind, i) => {
    const clips: Clip[] = [];
    let at = r.int(0, 20);
    for (let k = r.int(0, 6); k > 0; k--) {
      const d = r.int(5, 120);
      clips.push(clipOf(kind, `c${n++}`, at, d, r));
      at += d + (r.next() < 0.4 ? 0 : r.int(1, 60));
    }
    return { id: `t${i}`, name: `t${i}`, kind, clips };
  });
  const comp: Composition = { id: "Main", name: "Main", width: 1920, height: 1080, fps: 30, durationInFrames: 900, background: "#000000", tracks, markers: [] };
  return { version: 1, compositions: [comp], assets: ASSETS };
}

function assertHealthy(tl: Timeline, step: string) {
  expect(ops.timelineProblems(tl), step).toEqual([]);
  for (const comp of tl.compositions) {
    for (const t of comp.tracks) {
      for (const c of t.clips) {
        expect(c.from, `${step}: ${c.id}.from`).toBeGreaterThanOrEqual(0);
        expect(c.durationInFrames, `${step}: ${c.id}.duration`).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(c.from) && Number.isInteger(c.durationInFrames), `${step}: ${c.id} integer timing`).toBe(true);
        expect(ops.trackAccepts(t.kind, c.type), `${step}: ${c.id} on ${t.kind}`).toBe(true);
      }
    }
    expect(comp.durationInFrames, `${step}: duration`).toBeGreaterThanOrEqual(ops.contentEnd(comp));
  }
}

const allClipIds = (tl: Timeline) => ops.getComposition(tl, "Main")!.tracks.flatMap((t) => t.clips.map((c) => c.id));

describe("every op keeps tracks sorted and overlap-free", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`random edit sequence, seed ${seed}`, () => {
      const r = rng(seed);
      let tl = randomTimeline(r);
      assertHealthy(tl, "start");
      let clipboard: ops.TimelineClipboard | null = null;
      for (let step = 0; step < 120; step++) {
        const comp = ops.getComposition(tl, "Main")!;
        const ids = allClipIds(tl);
        const id = r.pick(ids) ?? "none";
        const some = ids.filter(() => r.next() < 0.3);
        const frame = r.int(0, comp.durationInFrames + 30);
        const trackIds = comp.tracks.map((t) => t.id);
        const actions: [string, () => Timeline][] = [
          ["place", () => ops.placeClip(tl, "Main", clipOf(r.pick(["video", "audio", "text", "overlay"] as const)!, `n${seed}-${step}`, frame, r.int(1, 90), r), r.pick(trackIds) ?? null).timeline],
          ["remove", () => ops.removeClips(tl, "Main", some)],
          ["ripple", () => ops.rippleDelete(tl, "Main", some)],
          ["move", () => ops.moveClips(tl, "Main", some.length ? some : [id], r.int(-200, 200), r.int(-2, 2))],
          ["nudge", () => ops.nudgeClips(tl, "Main", [id], r.int(-10, 10))],
          ["trim", () => ops.trimClip(tl, "Main", id, r.next() < 0.5 ? "start" : "end", frame)],
          ["split", () => ops.splitAt(tl, "Main", frame, r.next() < 0.5 ? [] : some).timeline],
          ["duplicate", () => ops.duplicateClips(tl, "Main", some).timeline],
          [
            "paste",
            () => {
              clipboard = ops.copyClips(comp, some) ?? clipboard;
              return clipboard ? ops.pasteClips(tl, "Main", clipboard, frame).timeline : tl;
            },
          ],
          ["update", () => ops.updateClip(tl, "Main", id, { from: frame, durationInFrames: r.int(1, 100) })],
          ["transition", () => ops.setTransitionIn(tl, "Main", id, { kind: "fade", durationInFrames: r.int(1, 60) })],
          ["addTrack", () => ops.addTrack(tl, "Main", r.pick(["video", "audio", "text", "overlay"] as const)!, { index: r.int(0, 6) }).timeline],
          ["moveTrack", () => ops.moveTrack(tl, "Main", r.pick(trackIds) ?? "", r.int(0, 6))],
          ["lock", () => ops.setTrackProps(tl, "Main", r.pick(trackIds) ?? "", { locked: r.next() < 0.2 })],
          ["detach", () => ops.detachAudio(tl, "Main", id).timeline],
          ["rippleRanges", () => ops.rippleDeleteRanges(tl, "Main", id, [[frame, frame + r.int(1, 40)], [frame + 50, frame + 60]]).timeline],
          ["trimToRange", () => ops.trimClipsToRange(tl, "Main", some, frame, frame + r.int(1, 200))],
          ["freeze", () => ops.freezeFrame(tl, "Main", id, frame, { id: `still${step}`, kind: "image", src: "media/s.png", name: "s.png" }, r.int(1, 60)).timeline],
          ["speed", () => ops.setClipSpeed(tl, "Main", id, r.pick([0.25, 0.5, 1, 1.5, 2, 4])!)],
          ["keyframe", () => ops.moveKeyframes(ops.addKeyframe(tl, "Main", id, "opacity", r.int(0, 30)), "Main", id, 0, r.int(0, 30))],
          ["marker", () => ops.addMarker(tl, "Main", frame).timeline],
        ];
        if (step % 40 === 39) actions.push(["cropComp", () => ops.trimCompositionToRange(tl, "Main", r.int(0, 100), r.int(150, 600))]);
        const [name, run] = r.pick(actions)!;
        tl = run();
        assertHealthy(tl, `seed ${seed} step ${step} ${name}`);
      }
      const v = validateTimeline(JSON.parse(JSON.stringify(tl)));
      expect(v.ok ? [] : v.errors).toEqual([]);
    });
  }
});

describe("repairTimeline", () => {
  // The shape of videos/nyxs-demo-2/timeline.json: footage laid at frame 0 on a track that
  // already held the template's demo clips.
  const broken = (): Timeline => ({
    version: 1,
    assets: [{ ...ASSETS[0], durationInFrames: 1890 }],
    compositions: [
      {
        id: "Main",
        name: "Main",
        width: 1920,
        height: 1080,
        fps: 30,
        durationInFrames: 1890,
        background: "#000000",
        markers: [],
        tracks: [
          {
            id: "track-scenes",
            name: "Scenes",
            kind: "video",
            clips: [
              { id: "clip-logo", type: "scene", from: 0, durationInFrames: 75, file: "Logo.tsx", exportName: "Logo" },
              { id: "clip-title", type: "scene", from: 75, durationInFrames: 90, file: "Title.tsx", exportName: "Title" },
              { id: "clip-outro-bg", type: "shape", from: 165, durationInFrames: 75, shape: "rect", fill: "#000000", width: 10, height: 10 },
              { id: "clip-0aw4ge8v", type: "video", from: 0, durationInFrames: 1890, assetId: "v", trimStart: 0 },
            ],
          },
        ],
      },
    ],
  });

  it("reproduces the invalid file and fixes it without losing a clip", () => {
    const tl = broken();
    expect(validateTimeline(tl).ok).toBe(false);
    expect(ops.timelineProblems(tl).length).toBeGreaterThan(0);
    const fixed = ops.repairTimeline(tl);
    const v = validateTimeline(fixed);
    expect(v.ok ? [] : v.errors).toEqual([]);
    assertHealthy(fixed, "repaired");
    expect(allClipIds(fixed).sort()).toEqual(allClipIds(tl).sort());
    for (const c of ops.getComposition(tl, "Main")!.tracks[0].clips) {
      expect(ops.locateClip(ops.getComposition(fixed, "Main")!, c.id)!.clip.from).toBe(c.from);
    }
    expect(ops.getComposition(fixed, "Main")!.tracks.every((t) => t.kind === "video")).toBe(true);
  });

  it("returns the same reference for a healthy timeline", () => {
    const ok = ops.repairTimeline(broken());
    expect(ops.repairTimeline(ok)).toBe(ok);
  });
});

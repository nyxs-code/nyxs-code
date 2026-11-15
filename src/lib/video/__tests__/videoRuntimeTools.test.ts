import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codeFingerprint } from "../../../../src-tauri/resources/video-template/nyxs/bundle.mjs";
import { timecode } from "../../../../src-tauri/resources/video-template/nyxs/lib/common.mjs";
import {
  MOODS,
  arrange,
  beatGrid,
  chordNotes,
  duckingCurve,
} from "../../../../src-tauri/resources/video-template/nyxs/lib/musicScore.mjs";
import { decideRequest, urlMatcher } from "../../../../src-tauri/resources/video-template/nyxs/record.mjs";
import { evenFrames, pickFrames, seekSeconds, sheetColumns } from "../../../../src-tauri/resources/video-template/nyxs/review.mjs";

type Part = { bars: number; startBar: number; energy: number };

describe("the seek time of a frame", () => {
  it("never lands past the frame, so a clip's last frame is found", () => {
    // 899 / 30 is 29.96666…: "29.967" is after that frame, and ffmpeg writes nothing.
    expect(seekSeconds(899, 30)).toBe("29.966");
    expect(seekSeconds(0, 30)).toBe("0.000");
    expect(seekSeconds(30, 30)).toBe("1.000");
    for (let f = 0; f < 2000; f++) expect(Number(seekSeconds(f, 30))).toBeLessThanOrEqual(f / 30);
  });
});

describe("contact sheet frames", () => {
  it("spreads frames over the source, both ends included", () => {
    expect(evenFrames(0, 90, 4)).toEqual([0, 30, 60, 90]);
    expect(evenFrames(10, 12, 9)).toEqual([10, 11, 12]);
    expect(evenFrames(5, 50, 1)).toEqual([5]);
  });

  it("prefers explicit frames, clamped, sorted and unique", () => {
    expect(pickFrames({ frames: [500, 3, 3, -2] }, 100)).toEqual([0, 3, 99]);
    expect(pickFrames({ frameRange: [80, 500], count: 3 }, 100)).toEqual([80, 90, 99]);
    expect(pickFrames({}, 100)).toHaveLength(12);
    expect(pickFrames({ count: 9999 }, 1000)).toHaveLength(100);
  });

  it("lays the sheet out about 16:9", () => {
    expect(sheetColumns(12, 16 / 9)).toBe(3);
    expect(sheetColumns(12, 9 / 16)).toBe(6);
    expect(sheetColumns(4, 16 / 9, 9)).toBe(4);
    expect(sheetColumns(1, 16 / 9)).toBe(1);
  });

  it("formats timecodes like the editor", () => {
    expect(timecode(0, 60)).toBe("00:00:00:00");
    expect(timecode(4992, 60)).toBe("00:01:23:12");
  });
});

describe("bundle reuse", () => {
  const project = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nyxs-fingerprint-"));
    fs.mkdirSync(path.join(dir, "scenes"));
    fs.mkdirSync(path.join(dir, "media"));
    fs.writeFileSync(path.join(dir, "timeline.json"), "{}");
    fs.writeFileSync(path.join(dir, "scenes", "A.tsx"), "export default 1;");
    return dir;
  };

  it("ignores data and follows code", () => {
    const dir = project();
    const first = codeFingerprint(dir);
    fs.writeFileSync(path.join(dir, "timeline.json"), '{"edited":true}');
    fs.writeFileSync(path.join(dir, "media", "clip.mp4"), "x");
    expect(codeFingerprint(dir)).toBe(first);
    fs.writeFileSync(path.join(dir, "scenes", "A.tsx"), "export default 22;");
    const edited = codeFingerprint(dir);
    expect(edited).not.toBe(first);
    fs.writeFileSync(path.join(dir, "scenes", "B.tsx"), "export default 2;");
    expect(codeFingerprint(dir)).not.toBe(edited);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("recording safety", () => {
  const decide = (method: string, url: string, routes: { url: string; method?: string; json?: unknown }[] = [], allow: string[] = []) =>
    decideRequest(
      { method, url },
      routes.map((r) => ({ ...r, match: urlMatcher(r.url) })),
      allow.map(urlMatcher),
    ).action;

  it("blocks writes by default and lets reads through", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(decide(m, "http://a/x")).toBe("block");
    for (const m of ["GET", "HEAD", "OPTIONS"]) expect(decide(m, "http://a/x")).toBe("continue");
  });

  it("allows only the writes it was told to", () => {
    expect(decide("POST", "http://a/auth/refresh", [], ["*/auth/*"])).toBe("continue");
    expect(decide("POST", "http://a/cases/1", [], ["*/auth/*"])).toBe("block");
    expect(decide("POST", "http://a/v2/x", [], ["/\\/v\\d\\//"])).toBe("continue");
  });

  it("answers mocks first, even for a write, and respects their method", () => {
    const routes = [{ url: "*/api/save", method: "POST", json: {} }];
    expect(decide("POST", "http://a/api/save", routes)).toBe("mock");
    expect(decide("PUT", "http://a/api/save", routes)).toBe("block");
    expect(decide("GET", "http://a/api/save", routes)).toBe("continue");
  });

  it("treats URL special characters literally in globs", () => {
    const m = urlMatcher("http://a.b/x?y=1");
    expect(m("http://a.b/x?y=1")).toBe(true);
    expect(m("http://aXb/x?y=1")).toBe(false);
  });
});

describe("music score", () => {
  const gaps = (beats: number[]) => beats.slice(1).map((t, i) => t - beats[i]);

  it("lands a nearby cut exactly on a beat, within the tempo limit", () => {
    const { beats, markers } = beatGrid(120, 30, [8.1]);
    expect(markers[0].t).toBe(8.1);
    expect(markers[0].offsetSecs).toBe(0);
    for (const g of gaps(beats)) expect(Math.abs(g / 0.5 - 1)).toBeLessThanOrEqual(0.03);
  });

  it("snaps a cut when landing it exactly would be heard, and says by how much", () => {
    const { beats, markers } = beatGrid(120, 30, [2.25]);
    expect(Math.abs(markers[0].offsetSecs)).toBeGreaterThan(0);
    expect(Math.abs(markers[0].offsetSecs)).toBeLessThanOrEqual(0.25);
    for (const g of gaps(beats)) expect(g).toBeCloseTo(0.5, 6);
  });

  it("keeps the grid going past the end, and ignores cuts outside the piece", () => {
    const { beats, markers } = beatGrid(100, 10, [-1, 0, 50]);
    expect(markers).toEqual([]);
    expect(beats.at(-1)).toBeGreaterThan(10);
  });

  it("arranges every bar exactly once, with a quiet start and a peak", () => {
    for (const total of [1, 3, 8, 16, 33, 64, 200]) {
      const parts = arrange(total);
      expect(parts.reduce((n: number, s: Part) => n + s.bars, 0)).toBe(total);
      parts.forEach((s: Part, i: number) => expect(s.startBar).toBe(i ? parts[i - 1].startBar + parts[i - 1].bars : 0));
    }
    const long = arrange(64);
    expect(long[0].energy).toBeLessThan(0.3);
    expect(Math.max(...long.map((s: Part) => s.energy))).toBe(1);
  });

  it("builds every mood's chords from valid qualities", () => {
    for (const mood of Object.values(MOODS) as { root: number; chords: unknown[] }[]) {
      for (const c of mood.chords) expect(chordNotes(mood.root, c).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("ducks under a voice with a lead-in and a release", () => {
    expect(duckingCurve([[5, 8]])).toEqual([
      { t: 4.75, value: 1 },
      { t: 5, value: 0.25 },
      { t: 8, value: 0.25 },
      { t: 8.6, value: 1 },
    ]);
  });

  it("stays down between close phrases, and clamps to the piece", () => {
    const curve = duckingCurve([[5, 8], [8.5, 10]]);
    expect(curve.map((k: { t: number }) => k.t)).toEqual([4.75, 5, 10, 10.6]);
    const edge = duckingCurve([[0, 2], [29, 40]], { durationSecs: 30 });
    expect(edge[0]).toEqual({ t: 0, value: 0.25 });
    expect(edge.at(-1).t).toBe(30);
    expect(duckingCurve([])).toEqual([]);
    expect(duckingCurve(undefined)).toEqual([]);
  });
});

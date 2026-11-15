import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../..");
const moduleUrl = pathToFileURL(path.join(repoRoot, "src-tauri/resources/video-template/nyxs/encoder.mjs")).href;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a plain .mjs of the video runtime, without types.
let encoder: any;
const dirs: string[] = [];
const fakeRenderer = { RenderInternals: { callFf: () => {}, getExecutablePath: () => "/rt/ffmpeg" } };

beforeAll(async () => {
  encoder = await import(/* @vite-ignore */ moduleUrl);
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runtimeDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "nyxs-encoder-"));
  dirs.push(d);
  return d;
}

describe("render encoder", () => {
  it("picks the hardware encoder per codec and platform", () => {
    expect(encoder.hardwareEncoder("h264", "win32")).toBe("h264_nvenc");
    expect(encoder.hardwareEncoder("h265", "linux")).toBe("hevc_nvenc");
    expect(encoder.hardwareEncoder("h264", "darwin")).toBe("h264_videotoolbox");
    expect(encoder.hardwareEncoder("vp9", "win32")).toBeNull();
    expect(encoder.hardwareEncoder("prores", "darwin")).toBeNull();
  });

  it("maps the quality presets to the measured CQ, and anything else between and past them", () => {
    expect([16, 20, 28].map((c) => encoder.crfToCq("h264", c))).toEqual([18, 24, 34]);
    expect([20, 25, 31].map((c) => encoder.crfToCq("h265", c))).toEqual([26, 32, 38]);
    expect(encoder.crfToCq("h264", 18)).toBe(21);
    expect(encoder.crfToCq("h264", undefined)).toBe(21);
    expect(encoder.crfToCq("h264", 1)).toBe(3);
    expect(encoder.crfToCq("h264", 51)).toBe(51);
  });

  it("gives VideoToolbox a bitrate Remotion accepts", () => {
    expect(encoder.bitrateFor("h264", 16, 1920 * 1080 * 60)).toBe("22395k");
    expect(encoder.bitrateFor("h264", 51, 320 * 180 * 30)).toBe("500k");
  });

  it("adds the encoder's arguments before the output", () => {
    const args = ["-c:v", "h264_nvenc", "-pix_fmt", "yuv420p", "-y", "out.mp4"];
    expect(encoder.encoderIn(args)).toBe("h264_nvenc");
    expect(encoder.encoderIn(["-c:v", "copy", "-y", "o"])).toBeNull();
    expect(encoder.encoderIn(["-y", "o"])).toBeNull();
    expect(encoder.withEncoderArgs(args, ["-cq", "18"])).toEqual(["-c:v", "h264_nvenc", "-pix_fmt", "yuv420p", "-cq", "18", "-y", "out.mp4"]);
  });

  it("caps the concurrency", () => {
    expect([1, 4, 8, 16, 32].map(encoder.renderConcurrency)).toEqual([1, 2, 3, 5, 6]);
  });

  const pick = (dir: string, probe: () => Promise<void>, now = 1000, extra = {}) =>
    encoder.pickEncoder({ renderer: fakeRenderer, runtimeDir: dir, codec: "h264", crf: 16, pixelsPerSecond: 1, platform: "win32", probe, now, ...extra });

  it("caches a good probe until an encode fails", async () => {
    const dir = runtimeDir();
    let calls = 0;
    const plan = await pick(dir, async () => { calls++; });
    expect(plan.encoder).toBe("h264_nvenc");
    expect(plan.args).toContain("-b_ref_mode");
    expect(plan.videoBitrate).toBeUndefined();
    await pick(dir, async () => { calls++; }, 1e12);
    expect(calls).toBe(1);
    encoder.forgetEncoder(fakeRenderer, dir, "h264_nvenc");
    await pick(dir, async () => { calls++; });
    expect(calls).toBe(2);
  });

  it("falls back to simpler arguments for older GPUs", async () => {
    let calls = 0;
    const plan = await pick(runtimeDir(), async () => {
      if (++calls === 1) throw new Error("B frames as references not supported");
    });
    expect(plan.args).not.toContain("-b_ref_mode");
    expect(plan.args).toContain("-cq");
  });

  it("uses the CPU without a GPU, and tries again after a while", async () => {
    const dir = runtimeDir();
    let calls = 0;
    const fail = async () => { calls++; throw new Error("No capable devices found"); };
    expect(await pick(dir, fail)).toBeNull();
    expect(calls).toBe(2);
    expect(await pick(dir, fail, 2000)).toBeNull();
    expect(calls).toBe(2);
    expect(await pick(dir, fail, 2000 + 2 * 3600 * 1000)).toBeNull();
    expect(calls).toBe(4);
  });

  it("skips codecs and Remotion versions without a hardware path", async () => {
    const dir = runtimeDir();
    const never = async () => { throw new Error("must not probe"); };
    expect(await pick(dir, never, 1000, { codec: "vp9" })).toBeNull();
    expect(await pick(dir, never, 1000, { renderer: {} })).toBeNull();
  });

  it("gives VideoToolbox its bitrate", async () => {
    const plan = await pick(runtimeDir(), async () => {}, 1000, { platform: "darwin", pixelsPerSecond: 1920 * 1080 * 60 });
    expect(plan.encoder).toBe("h264_videotoolbox");
    expect(plan.args).toEqual([]);
    expect(plan.videoBitrate).toBe("22395k");
  });
});

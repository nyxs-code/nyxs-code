// How a render uses the machine: the hardware encoder when a real one answers, a concurrency that
// keeps the PC usable. render.mjs falls back to the CPU encoder if a hardware encode still fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A 256x256 black PNG: this ffmpeg build has no lavfi decoder, so the probe pipes a real image. */
const PROBE_FRAME = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAA1UlEQVR42u3BMQEAAADCoPVP7WULoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAGwEtAAGey8LtAAAAAElFTkSuQmCC",
  "base64",
);
const PROBE_TIMEOUT_MS = 20_000;
/** A failed probe may be passing (all NVENC sessions busy) or stale (a GPU just installed). */
const FAILED_PROBE_TTL_MS = 60 * 60 * 1000;
const CACHE_FILE = "encoder-probe.json";

/** Remotion's defaults when no CRF is asked for. */
const DEFAULT_CRF = { h264: 18, h265: 23 };
/**
 * CRF to the CQ with the same SSIM, measured on a 1080p60 trailer (the quality presets are the
 * anchors). NVENC's scale is not x264's: the same number looks worse and weighs more.
 */
const CQ_FOR_CRF = {
  h264: [[16, 18], [20, 24], [28, 34]],
  h265: [[20, 26], [25, 32], [31, 38]],
};

export function hardwareEncoder(codec, platform = process.platform) {
  const base = { h264: "h264", h265: "hevc" }[codec];
  if (!base) return null;
  if (platform === "darwin") return `${base}_videotoolbox`;
  return platform === "win32" || platform === "linux" ? `${base}_nvenc` : null;
}

export function crfToCq(codec, crf) {
  const points = CQ_FOR_CRF[codec];
  const x = crf ?? DEFAULT_CRF[codec];
  const [first, last] = [points[0], points[points.length - 1]];
  let cq = x <= first[0] ? first[1] + (x - first[0]) : last[1] + (x - last[0]);
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    if (x >= a[0] && x <= b[0]) cq = a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);
  }
  return Math.min(51, Math.max(1, Math.round(cq)));
}

/**
 * VideoToolbox has no quality mode on Intel Macs, so it gets a bitrate: what x264 and x265 spent
 * per pixel at the same CRF on demanding footage.
 */
export function bitrateFor(codec, crf, pixelsPerSecond) {
  const x = crf ?? DEFAULT_CRF[codec];
  const bitsPerPixel = codec === "h265" ? 0.11 * 2 ** ((20 - x) / 5) : 0.18 * 2 ** ((16 - x) / 5);
  return `${Math.max(500, Math.round((bitsPerPixel * pixelsPerSecond) / 1000))}k`;
}

/**
 * The arguments to try, best first. The second set is for GPUs that reject B-frame references or
 * lookahead (older than Turing). Slower presets and multipass didn't change the size at equal
 * quality, so the preset stays at p5. The arguments are passed through ffmpegOverride because
 * Remotion turns hardware encoding off whenever a CRF is set.
 */
export function encoderProfiles(encoder, cq) {
  if (!encoder.endsWith("_nvenc")) return [[]];
  const quality = ["-rc", "vbr", "-cq", String(cq), "-b:v", "0", "-preset", "p5", "-spatial-aq", "1"];
  return [[...quality, "-tune", "hq", "-rc-lookahead", "20", "-bf", "3", "-b_ref_mode", "middle"], quality];
}

/** The encoder an ffmpeg command line uses; `copy` is the stitching step, which encodes nothing. */
export function encoderIn(args) {
  const name = args[args.indexOf("-c:v") + 1];
  return args.includes("-c:v") && name !== "copy" ? String(name) : null;
}

/** `extra` before the `-y <output>` that ends the command. */
export function withEncoderArgs(args, extra) {
  const at = args.lastIndexOf("-y");
  return at < 0 ? args : [...args.slice(0, at), ...extra, ...args.slice(at)];
}

/**
 * Remotion's default (half the threads, up to 8) leaves the machine at its limit for little gain:
 * on 16 threads, 5 kept 94-96% of the speed. The knee is capture and video
 * decoding, which don't scale past that.
 */
export function renderConcurrency(cpus) {
  return Math.min(6, Math.max(1, Math.ceil(cpus * 0.3)));
}

/** Below normal for this process; Chrome, ffmpeg and the compositor inherit it, so the rest of the PC goes first. */
export function lowerPriority() {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Rendering at normal priority still works.
  }
}

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(file, cache) {
  try {
    fs.writeFileSync(file, JSON.stringify(cache));
  } catch {
    // Only costs probing again next time.
  }
}

/** One real frame through the encoder: listing it in `ffmpeg -encoders` says nothing of the GPU. */
function ffmpegProbe(renderer, encoder, args) {
  return renderer.RenderInternals.callFf({
    bin: "ffmpeg",
    args: [
      "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-vcodec", "png", "-i", "-",
      "-frames:v", "1", "-pix_fmt", "yuv420p", "-c:v", encoder, ...args, "-f", "null", "-",
    ],
    indent: false,
    logLevel: "error",
    binariesDirectory: null,
    cancelSignal: undefined,
    options: { input: PROBE_FRAME, timeout: PROBE_TIMEOUT_MS },
  });
}

function cacheKey(renderer, encoder) {
  const ffmpeg = renderer.RenderInternals.getExecutablePath({ type: "ffmpeg", indent: false, logLevel: "error", binariesDirectory: null });
  return `${ffmpeg}|${encoder}`;
}

/**
 * The hardware plan for a render, or null for the CPU encoder. `probe` is replaceable for tests.
 * An adopted project's older Remotion may lack these internals, which simply means no plan.
 */
export async function pickEncoder({ renderer, runtimeDir, codec, crf, pixelsPerSecond, platform = process.platform, probe = ffmpegProbe, now = Date.now() }) {
  const encoder = hardwareEncoder(codec, platform);
  if (!encoder || typeof renderer.RenderInternals?.callFf !== "function") return null;
  const cq = crfToCq(codec, crf);
  const profiles = encoderProfiles(encoder, cq);
  const file = path.join(runtimeDir, CACHE_FILE);
  const cache = readCache(file);
  const key = cacheKey(renderer, encoder);
  const known = cache[key];
  let profile = null;
  if (known && (known.profile !== null || now - known.at < FAILED_PROBE_TTL_MS)) {
    profile = known.profile;
  } else {
    for (let i = 0; i < profiles.length && profile === null; i++) {
      try {
        await probe(renderer, encoder, [...profiles[i], ...(encoder.endsWith("_nvenc") ? [] : ["-b:v", "2000k"])]);
        profile = i;
      } catch {
        // The next set of arguments, or the CPU.
      }
    }
    cache[key] = { profile, at: now };
    writeCache(file, cache);
  }
  if (profile === null || !profiles[profile]) return null;
  return {
    encoder,
    args: profiles[profile],
    videoBitrate: encoder.endsWith("_nvenc") ? undefined : bitrateFor(codec, crf, pixelsPerSecond),
  };
}

/** A hardware encode failed although the probe passed: the next render probes again. */
export function forgetEncoder(renderer, runtimeDir, encoder) {
  const file = path.join(runtimeDir, CACHE_FILE);
  const cache = readCache(file);
  delete cache[cacheKey(renderer, encoder)];
  writeCache(file, cache);
}

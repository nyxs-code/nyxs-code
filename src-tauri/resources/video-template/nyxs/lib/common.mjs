// What the runtime's task scripts (review, record, music) share: the protocol with the app, one
// JSON line per event on stdout, and the ffmpeg and Chrome that Remotion already installed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

/** `<script> --project <dir> <options.json>`: the same call render.mjs takes. */
export function readRequest(argv = process.argv.slice(2)) {
  let projectDir = null;
  let optionsFile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") projectDir = path.resolve(argv[++i]);
    else optionsFile = argv[i];
  }
  if (!optionsFile) throw new Error("Missing the options file");
  return { projectDir, opts: JSON.parse(fs.readFileSync(optionsFile, "utf8")) };
}

/** Runs a task to its end: a thrown error becomes one `error` event and exit 1. */
export function runTask(main) {
  main().then(
    () => process.exit(0),
    (e) => {
      emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
      process.exit(1);
    },
  );
}

/** Runs the ffmpeg or ffprobe that ships with Remotion, whatever the platform. */
export async function ff(renderer, bin, args) {
  const res = await renderer.RenderInternals.callFf({
    bin,
    args,
    indent: false,
    logLevel: "error",
    binariesDirectory: null,
    cancelSignal: undefined,
    options: { reject: false, maxBuffer: 64 * 1024 * 1024 },
  });
  if (res.exitCode !== 0) {
    throw new Error(`${bin} failed: ${String(res.stderr).trim().split("\n").slice(-6).join("\n")}`);
  }
  return res;
}

/** The path of Remotion's Chrome Headless Shell, downloaded on the spot when it's missing. */
export async function chromeExecutable(renderer) {
  const status = await renderer.ensureBrowser();
  if (!status.path) throw new Error(`No headless browser is available (${status.type}).`);
  return status.path;
}

/** Runs `work` over `items` with at most `limit` running at once; keeps the order of results. */
export async function pool(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/** `HH:MM:SS:FF`, the editor's timecode. */
export function timecode(frame, fps) {
  const rate = Math.max(1, Math.round(fps));
  const f = Math.max(0, Math.round(frame));
  const secs = Math.floor(f / rate);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(f % rate)}`;
}

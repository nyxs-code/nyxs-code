// Renders a composition or a single still of a video project for Nyxs, or lists its
// compositions. Prints one JSON line per event on stdout so the app can show progress:
// {"type":"progress"|"done"|"error"|"compositions", ...}.
//
//   node <runtime>/nyxs/render.mjs --project <dir> <options.json>
//
// The options file is written by the app (src-tauri/src/video/render.rs). A Nyxs project (data
// only: timeline.json, scenes/, media/) renders through this runtime's entry/ with its
// node_modules and an `@project` alias; an adopted Remotion project through its own entry and,
// when it has them, its own @remotion/bundler and @remotion/renderer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle, loadPackage } from "./bundle.mjs";
import { encoderIn, forgetEncoder, lowerPriority, pickEncoder, renderConcurrency, withEncoderArgs } from "./encoder.mjs";

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIND_DOWN_MS = 10_000;

function parseArgs(argv) {
  let project = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") project = argv[++i];
    else if (argv[i].startsWith("--project=")) project = argv[i].slice("--project=".length);
    else rest.push(argv[i]);
  }
  if (!project) throw new Error("Missing --project <dir>");
  if (!rest[0]) throw new Error("Missing the options file");
  return { projectDir: path.resolve(project), optionsFile: rest[0] };
}

async function main() {
  lowerPriority();
  const { projectDir, optionsFile } = parseArgs(process.argv.slice(2));
  const opts = JSON.parse(fs.readFileSync(optionsFile, "utf8"));
  const light = opts.light ?? !fs.existsSync(path.join(projectDir, "package.json"));
  const { bundle } = await loadPackage("@remotion/bundler", projectDir, light);
  const renderer = await loadPackage("@remotion/renderer", projectDir, light);

  let inputProps = {};
  if (light) {
    const file = path.join(projectDir, "timeline.json");
    try {
      // calculateMetadata sees the very document that was on disk when the render started.
      inputProps = { timeline: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch (e) {
      // Not left to the bundle's copy: a reused bundle would silently render an older timeline.
      throw new Error(`Couldn't read ${file}: ${e.message}`);
    }
  }

  emit({ type: "progress", stage: "bundling", progress: 0 });
  if (typeof renderer.ensureBrowser === "function") {
    await renderer.ensureBrowser({
      onBrowserDownload: () => ({
        version: null,
        onProgress: ({ percent }) => emit({ type: "progress", stage: "bundling", progress: percent * 0.5 }),
      }),
    });
  }

  const entryPoint = light
    ? path.join(runtimeDir, "entry", "index.ts")
    : path.resolve(projectDir, opts.entryPoint ?? "src/index.ts");
  if (!fs.existsSync(entryPoint)) throw new Error(`The Remotion entry point is missing: ${entryPoint}`);
  // bundleDir is `<cache>/render/bundle-<job>`: the bundle itself is shared across renders.
  const { serveUrl } = await ensureBundle({
    bundle,
    projectDir,
    light,
    entryPoint,
    cacheRoot: path.dirname(path.dirname(opts.bundleDir)),
    onProgress: (percent) => emit({ type: "progress", stage: "bundling", progress: percent / 100 }),
  });

  if (opts.list) {
    const all = await renderer.getCompositions(serveUrl, { inputProps });
    emit({
      type: "compositions",
      compositions: all.map(({ id, width, height, fps, durationInFrames }) => ({ id, width, height, fps, durationInFrames })),
    });
    return;
  }
  const composition = await renderer.selectComposition({ serveUrl, id: opts.compositionId, inputProps });

  if (opts.still) {
    await renderer.renderStill({
      serveUrl,
      composition,
      inputProps,
      output: opts.output,
      frame: Math.min(Math.max(0, opts.frame ?? 0), composition.durationInFrames - 1),
      imageFormat: "png",
      scale: opts.scale ?? 1,
    });
    emit({ type: "done", output: opts.output });
    return;
  }

  const range = opts.frameRange ?? null;
  const totalFrames = range ? range[1] - range[0] + 1 : composition.durationInFrames;
  const scale = opts.scale ?? 1;
  const encode = (plan, cancelSignal) =>
    renderer.renderMedia({
      cancelSignal,
      serveUrl,
      composition,
      inputProps,
      codec: opts.codec,
      outputLocation: opts.output,
      crf: plan ? undefined : (opts.crf ?? undefined),
      videoBitrate: plan?.videoBitrate,
      hardwareAcceleration: plan ? "required" : "disable",
      concurrency: renderConcurrency(os.cpus().length),
      // The command Remotion really runs, so the label can't claim a GPU it didn't use.
      ffmpegOverride: ({ args }) => {
        const used = encoderIn(args);
        if (used) emit({ type: "encoder", encoder: used });
        return plan && used === plan.encoder ? withEncoderArgs(args, plan.args) : args;
      },
      scale,
      frameRange: range,
      everyNthFrame: opts.everyNthFrame ?? 1,
      muted: Boolean(opts.muted),
      audioCodec: opts.audioCodec ?? undefined,
      overwrite: true,
      onProgress: ({ progress, renderedFrames, stitchStage }) =>
        emit({
          type: "progress",
          stage: renderedFrames >= totalFrames || stitchStage === "muxing" ? "encoding" : "rendering",
          progress,
          renderedFrames,
          totalFrames,
        }),
    });
  const plan = await pickEncoder({
    renderer,
    runtimeDir,
    codec: opts.codec,
    crf: opts.crf,
    pixelsPerSecond: composition.width * composition.height * scale * scale * composition.fps,
  });
  // When ffmpeg dies, Remotion's write to its stdin rejects with nobody listening (`write EOF`) and
  // Node would exit on the spot, before any catch: that rejection counts as the encode failing.
  const guardedEncode = async (plan) => {
    const { cancelSignal, cancel } = renderer.makeCancelSignal?.() ?? { cancel: () => {} };
    let onStray;
    const stray = new Promise((_, reject) => {
      onStray = (e) => {
        reject(e);
        cancel();
      };
    });
    process.on("unhandledRejection", onStray);
    const run = encode(plan, cancelSignal);
    try {
      await Promise.race([run, stray]);
    } catch (e) {
      // More of the same keep landing in onStray while the failed attempt winds down.
      await Promise.race([run.catch(() => {}), new Promise((r) => setTimeout(r, WIND_DOWN_MS))]);
      throw e;
    } finally {
      process.off("unhandledRejection", onStray);
    }
  };
  try {
    await guardedEncode(plan);
  } catch (e) {
    if (!plan) throw e;
    // Whatever it was, the CPU encoder either finishes the job or reports the real error.
    console.error(`${plan.encoder} failed, rendering on the CPU: ${e instanceof Error ? e.message : e}`);
    forgetEncoder(renderer, runtimeDir, plan.encoder);
    await guardedEncode(null);
  }
  emit({ type: "done", output: opts.output });
}

main().then(
  () => process.exit(0),
  (e) => {
    emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  },
);

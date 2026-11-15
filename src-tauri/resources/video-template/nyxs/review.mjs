// Fast looks at a project for review, without a full render: a contact sheet (N frames of a
// composition or a media asset as one labeled image) and a proxy (a small, low-fps clip of a frame
// range). Both reuse the project's bundle, so a timeline edit costs no webpack run.
//
//   node <runtime>/nyxs/review.mjs --project <dir> <options.json>
//
// Options are written by the app (src-tauri/src/video/tools.rs). Events as in render.mjs:
// {"type":"progress"|"done"|"error", ...}.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureBundle, loadPackage } from "./bundle.mjs";
import { renderConcurrency } from "./encoder.mjs";
import { chromeExecutable, emit, ff, pool, readRequest, runTask, runtimeDir, timecode } from "./lib/common.mjs";
import { launchChrome, navigate, openPlainPage } from "./lib/cdp.mjs";

const MAX_SHEET_WIDTH = 1920;
const MAX_FRAMES = 100;

/** `count` frames spread evenly over [first, last], both ends included. */
export function evenFrames(first, last, count) {
  const n = Math.max(1, Math.min(count, last - first + 1));
  if (n === 1) return [first];
  return Array.from({ length: n }, (_, i) => first + Math.round((i * (last - first)) / (n - 1)));
}

/** The frames a request asks for, inside the source: explicit ones win over a count. */
export function pickFrames({ frames, frameRange, count }, durationInFrames) {
  const end = durationInFrames - 1;
  const clamp = (f) => Math.min(Math.max(0, Math.round(f)), end);
  if (frames?.length) return [...new Set(frames.map(clamp))].sort((a, b) => a - b).slice(0, MAX_FRAMES);
  const [a, b] = frameRange ? [clamp(frameRange[0]), clamp(frameRange[1])] : [0, end];
  return evenFrames(Math.min(a, b), Math.max(a, b), Math.min(count ?? 12, MAX_FRAMES));
}

/** A frame's start for ffmpeg's `-ss`, rounded down: rounded up, the last frame of a clip lands
 *  just past its own timestamp, and ffmpeg finds nothing to write. */
export function seekSeconds(frame, fps) {
  return (Math.floor((frame / fps) * 1000) / 1000).toFixed(3);
}

/** Columns that make the whole sheet about 16:9, whatever the shape of the tiles. */
export function sheetColumns(n, aspect, requested) {
  if (requested) return Math.max(1, Math.min(requested, n));
  return Math.max(1, Math.min(n, Math.round(Math.sqrt((n * (16 / 9)) / aspect))));
}

/** A readable timeline document for the page, or an error: never a stale bundled copy. */
function readTimeline(projectDir, light) {
  if (!light) return {};
  const file = path.join(projectDir, "timeline.json");
  try {
    return { timeline: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    throw new Error(`Couldn't read ${file}: ${e.message}`);
  }
}

/** The names of the visible clips at `frame`, top track first, to label a tile. */
function clipsAt(timeline, compositionId, frame) {
  const comp = timeline?.compositions?.find((c) => c.id === compositionId);
  const names = new Set();
  for (const track of comp?.tracks ?? []) {
    if (track.hidden || track.kind === "audio") continue;
    for (const clip of track.clips ?? []) {
      if (frame >= clip.from && frame < clip.from + clip.durationInFrames) names.add(clip.name ?? clip.id);
    }
  }
  return [...names];
}

async function openComposition(renderer, bundler, projectDir, opts) {
  const light = opts.light ?? !fs.existsSync(path.join(projectDir, "package.json"));
  const inputProps = readTimeline(projectDir, light);
  emit({ type: "progress", stage: "bundling", progress: 0 });
  const entryPoint = light
    ? path.join(runtimeDir, "entry", "index.ts")
    : path.resolve(projectDir, opts.entryPoint ?? "src/index.ts");
  const { serveUrl, reused } = await ensureBundle({
    bundle: bundler.bundle,
    projectDir,
    light,
    entryPoint,
    cacheRoot: opts.cacheRoot,
    onProgress: (p) => emit({ type: "progress", stage: "bundling", progress: p / 100 }),
  });
  const composition = await renderer.selectComposition({ serveUrl, id: opts.compositionId, inputProps });
  return { serveUrl, inputProps, composition, reused };
}

/** Draws the tiles into one image with Chrome: it has the fonts ffmpeg's stripped build lacks. */
async function composeSheet(renderer, tiles, { columns, tileWidth, tileHeight, output }) {
  const rows = Math.ceil(tiles.length / columns);
  const gap = 4;
  const width = columns * tileWidth + (columns + 1) * gap;
  // The label sits under the frame, so it never hides what's at the frame's bottom edge.
  const label = tileWidth < 300 ? 18 : 22;
  const height = rows * (tileHeight + label) + (rows + 1) * gap;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const cells = tiles
    .map(
      (t) => `<figure><img src="${t.url}"><figcaption><b>${esc(t.timecode)}</b> f${t.frame}${
        t.note ? ` · ${esc(t.note)}` : ""
      }</figcaption></figure>`,
    )
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:#16161a}
    main{display:grid;grid-template-columns:repeat(${columns},${tileWidth}px);gap:${gap}px;padding:${gap}px}
    figure{margin:0;width:${tileWidth}px;overflow:hidden;background:#000}
    img{display:block;width:${tileWidth}px;height:${tileHeight}px;object-fit:contain}
    figcaption{height:${label}px;box-sizing:border-box;padding:0 6px;color:#fff;
      font:${tileWidth < 300 ? 11 : 13}px/${label}px Consolas,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    b{font-weight:600;color:#ffd24a}
  </style><main>${cells}</main>`;
  const pagePath = `${output}.html`;
  fs.writeFileSync(pagePath, html);
  const chrome = await launchChrome(await chromeExecutable(renderer));
  try {
    const page = await openPlainPage(chrome, { width, height });
    await navigate(chrome, page, `file:///${pagePath.replace(/\\/g, "/")}`);
    const { data } = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 84 });
    fs.writeFileSync(output, Buffer.from(data, "base64"));
  } finally {
    await chrome.close();
    fs.rmSync(pagePath, { force: true });
  }
  return { width, height };
}

async function contactSheet(renderer, bundler, projectDir, opts) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nyxs-sheet-"));
  const started = Date.now();
  try {
    let tiles;
    let aspect;
    let reused = null;
    const layout = (n) => {
      const columns = sheetColumns(n, aspect, opts.columns);
      const fit = Math.floor(MAX_SHEET_WIDTH / columns);
      const tileWidth = Math.max(120, Math.min(opts.thumbWidth ?? 480, fit));
      return { columns, tileWidth, tileHeight: Math.round(tileWidth / aspect) };
    };
    let geometry;
    if (opts.asset) {
      const { file, fps, durationSecs, width, height } = opts.asset;
      aspect = width && height ? width / height : 16 / 9;
      const frames = pickFrames(opts, Math.max(1, Math.round(durationSecs * fps)));
      geometry = layout(frames.length);
      const done = { n: 0 };
      tiles = await pool(frames, Math.max(2, Math.min(6, os.cpus().length >> 1)), async (frame, i) => {
        const out = path.join(work, `t${i}.jpg`);
        // `-ss` before `-i` seeks fast and, re-encoding, still lands on the exact frame.
        await ff(renderer, "ffmpeg", [
          "-v", "error", "-ss", seekSeconds(frame, fps), "-i", file, "-frames:v", "1",
          "-vf", `scale=${geometry.tileWidth}:-2`, "-q:v", "3", "-y", out,
        ]);
        emit({ type: "progress", stage: "rendering", progress: ++done.n / frames.length, renderedFrames: done.n, totalFrames: frames.length });
        return { frame, timecode: timecode(frame, fps), timeSecs: frame / fps, url: `t${i}.jpg`, file: out };
      });
    } else {
      const { serveUrl, inputProps, composition, reused: r } = await openComposition(renderer, bundler, projectDir, opts);
      reused = r;
      aspect = composition.width / composition.height;
      const frames = pickFrames(opts, composition.durationInFrames);
      geometry = layout(frames.length);
      const scale = Math.min(1, geometry.tileWidth / composition.width);
      const browser = await renderer.openBrowser("chrome");
      const done = { n: 0 };
      try {
        tiles = await pool(frames, Math.max(2, Math.min(4, os.cpus().length >> 2)), async (frame, i) => {
          const out = path.join(work, `t${i}.jpg`);
          await renderer.renderStill({
            serveUrl, composition, inputProps, output: out, frame, imageFormat: "jpeg", jpegQuality: 82, scale,
            overwrite: true, puppeteerInstance: browser,
          });
          emit({ type: "progress", stage: "rendering", progress: ++done.n / frames.length, renderedFrames: done.n, totalFrames: frames.length });
          const note = clipsAt(inputProps.timeline, opts.compositionId, frame).join(", ");
          return { frame, timecode: timecode(frame, composition.fps), timeSecs: frame / composition.fps, url: `t${i}.jpg`, file: out, note, clips: note };
        });
      } finally {
        await browser.close({ silent: true }).catch(() => {});
      }
    }
    fs.mkdirSync(path.dirname(opts.output), { recursive: true });
    // The sheet's page sits next to its tiles, so relative URLs reach them.
    const staged = path.join(work, "sheet.jpg");
    const { width, height } = await composeSheet(renderer, tiles, { ...geometry, output: staged });
    fs.copyFileSync(staged, opts.output);
    emit({
      type: "done",
      output: opts.output,
      width,
      height,
      columns: geometry.columns,
      bundleReused: reused,
      elapsedMs: Date.now() - started,
      frames: tiles.map(({ frame, timecode: tc, timeSecs, clips }) => ({
        frame,
        timecode: tc,
        timeSecs: Math.round(timeSecs * 1000) / 1000,
        ...(clips ? { clips } : {}),
      })),
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function proxy(renderer, bundler, projectDir, opts) {
  const started = Date.now();
  const { serveUrl, inputProps, composition, reused } = await openComposition(renderer, bundler, projectDir, opts);
  const bundledAt = Date.now();
  const end = composition.durationInFrames - 1;
  const range = opts.frameRange
    ? [Math.min(Math.max(0, opts.frameRange[0]), end), Math.min(Math.max(0, opts.frameRange[1]), end)]
    : [0, end];
  if (range[1] < range[0]) throw new Error(`Empty frame range: ${range[0]}..${range[1]}.`);
  const nth = Math.max(1, Math.round(composition.fps / (opts.fps ?? 12)));
  const fps = composition.fps / nth;
  const scale = Math.min(1, (opts.height ?? 360) / composition.height);
  const total = Math.floor((range[1] - range[0]) / nth) + 1;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nyxs-proxy-"));
  try {
    const frames = path.join(work, "frames");
    fs.mkdirSync(frames);
    await renderer.renderFrames({
      serveUrl,
      composition,
      inputProps,
      outputDir: frames,
      imageFormat: "jpeg",
      jpegQuality: 70,
      scale,
      frameRange: range,
      everyNthFrame: nth,
      concurrency: renderConcurrency(os.cpus().length),
      onStart: () => {},
      onFrameUpdate: (n) =>
        emit({ type: "progress", stage: "rendering", progress: n / total, renderedFrames: n, totalFrames: total }),
    });
    const stills = fs.readdirSync(frames).filter((f) => f.endsWith(".jpeg")).sort();
    if (!stills.length) throw new Error("The proxy rendered no frames.");
    const list = path.join(work, "list.txt");
    const entry = (f) => `file '${path.join(frames, f).replace(/\\/g, "/")}'\nduration ${(1 / fps).toFixed(6)}`;
    fs.writeFileSync(list, stills.map(entry).join("\n"));
    emit({ type: "progress", stage: "encoding", progress: 1, renderedFrames: total, totalFrames: total });
    let audio = null;
    if (opts.audio) {
      audio = path.join(work, "audio.m4a");
      await renderer.renderMedia({ serveUrl, composition, inputProps, codec: "aac", outputLocation: audio, frameRange: range, overwrite: true });
    }
    fs.mkdirSync(path.dirname(opts.output), { recursive: true });
    await ff(renderer, "ffmpeg", [
      "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
      ...(audio ? ["-i", audio, "-c:a", "copy", "-shortest"] : []),
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-r", String(fps), "-movflags", "+faststart", opts.output,
    ]);
    const roundEven = (n) => Math.trunc(n / 2) * 2;
    emit({
      type: "done",
      output: opts.output,
      width: roundEven(Math.round(composition.width * scale)),
      height: roundEven(Math.round(composition.height * scale)),
      fps: Math.round(fps * 1000) / 1000,
      frames: stills.length,
      frameRange: range,
      bundleReused: reused,
      bundleMs: bundledAt - started,
      elapsedMs: Date.now() - started,
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runTask(async () => {
    const { projectDir, opts } = readRequest();
    if (!opts.cacheRoot || !opts.output) throw new Error("Missing cacheRoot or output.");
    const light = opts.light ?? !fs.existsSync(path.join(projectDir, "package.json"));
    const [renderer, bundler] = await Promise.all([
      loadPackage("@remotion/renderer", projectDir, light),
      loadPackage("@remotion/bundler", projectDir, light),
    ]);
    if (opts.task === "contactSheet") await contactSheet(renderer, bundler, projectDir, opts);
    else if (opts.task === "proxy") await proxy(renderer, bundler, projectDir, opts);
    else throw new Error(`Unknown review task: ${opts.task}`);
  });
}

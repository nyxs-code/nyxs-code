#!/usr/bin/env node
// Server of the Nyxs in-app player, on 127.0.0.1: the player page, the project's scenes (and an
// adopted project's own entry), its media and timeline.json. It listens and prints its port
// before doing anything else, and builds only what is out of date:
// - The player, engine, React and Remotion come prebuilt from <runtime>/prebuilt (prebuild.mjs).
// - A project's scenes are bundled on their own, with React and Remotion left to the page's import
//   map; no scene files = no build, and an unchanged project reuses last session's bundle.
// - An adopted project with its own matching Remotion packages gets a full build of everything
//   with those versions, also reused while nothing changed.
//
//   node <runtime>/nyxs/serve.mjs --project <dir> [--port 0] [--outdir <dir>] [--host 127.0.0.1]
//        [--watch-stdin] [--entry <file>] [--public-dir <dir>] [--node-path <dir>]...
//   node <runtime>/nyxs/serve.mjs --prebuild
//
// --project is the video project. A light project (no package.json: timeline.json, scenes/,
// media/) uses this runtime's node_modules; an adopted Remotion project its own node_modules
// first. Without --project, the folder that contains nyxs/ is the project.
// --port 0 picks a free port; the chosen one is printed as `NYXS_PLAYER_PORT=<n>` on stdout.
// --outdir is where the bundle goes. Nyxs passes its cache folder so nothing is written inside
// the project; the default is a folder in the OS temp dir.
// --watch-stdin exits when stdin closes, so the server dies with the process that spawned it.
// --entry overrides the Remotion entry point (default: remotion.config's setEntryPoint, then
// the usual src/index.ts(x) places). --public-dir overrides public/ (default: setPublicDir).
// --node-path adds more folders to resolve packages from.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMMON_OPTIONS, PREBUILT_DIR, readPrebuilt, runPrebuild } from "./prebuild.mjs";

const nyxsDir = path.dirname(fileURLToPath(import.meta.url));
const phases = [];
/** Startup timing since the process started, printed once on stderr. */
const phase = (name) => phases.push(`${name} ${Math.round(performance.now())}ms`);
phase("node");
const runtimeDir = path.resolve(nyxsDir, "..");

function parseArgs(argv) {
  const args = { port: 0, host: "127.0.0.1", outdir: null, watchStdin: false, project: null, entry: null, publicDir: null, nodePaths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${flag}`);
      return v;
    };
    if (flag === "--port") args.port = Number(value());
    else if (flag === "--outdir") args.outdir = value();
    else if (flag === "--host") args.host = value();
    else if (flag === "--project") args.project = value();
    else if (flag === "--entry") args.entry = value();
    else if (flag === "--public-dir") args.publicDir = value();
    else if (flag === "--node-path") args.nodePaths.push(path.resolve(value()));
    else if (flag === "--watch-stdin") args.watchStdin = true;
    else if (flag === "--prebuild") args.prebuild = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error(`Invalid --port: ${args.port}`);
  return args;
}

const args = parseArgs(process.argv.slice(2));
// The runtime install's step (same as running prebuild.mjs): builds the core and exits.
if (args.prebuild) {
  await runPrebuild(runtimeDir);
  process.exit(0);
}
const projectDir = path.resolve(args.project ?? runtimeDir);
if (!existsSync(projectDir)) throw new Error(`The project folder does not exist: ${projectDir}`);
// Light projects hold only data; adopted Remotion projects have their own package.json.
const light = !existsSync(path.join(projectDir, "package.json"));
const runtimeModules = path.join(runtimeDir, "node_modules");
const nodePaths = [
  ...(light ? [] : [path.join(projectDir, "node_modules")]),
  ...args.nodePaths,
  ...(existsSync(runtimeModules) ? [runtimeModules] : []),
];

function packageVersion(dir, name) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "node_modules", name, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

// Remotion packages only work with the `remotion` of the same version. An adopted project that
// has the whole family the player needs keeps its own versions; otherwise (and for light
// projects) remotion, react and every @remotion/* come from the runtime, also for the project's
// code: Remotion 4 stays compatible within the major, so the preview works without installing.
const PLAYER_FAMILY = ["@remotion/player", "@remotion/transitions", "@remotion/captions", "@remotion/google-fonts"];
const projectRemotion = light ? null : packageVersion(projectDir, "remotion");
const projectHasFamily =
  !!projectRemotion &&
  !!packageVersion(projectDir, "react-dom") &&
  PLAYER_FAMILY.every((name) => packageVersion(projectDir, name) === projectRemotion);
const coreDir = projectHasFamily ? projectDir : runtimeDir;
const coreRemotion = packageVersion(coreDir, "remotion");
const usePrebuilt = !projectHasFamily;

/** Imports a package from the project, or from the --node-path folders when it lacks it. */
async function importPackage(name) {
  try {
    return await import(name);
  } catch (err) {
    for (const dir of nodePaths) {
      try {
        const resolved = createRequire(path.join(dir, "noop.js")).resolve(name);
        return await import(pathToFileURL(resolved).href);
      } catch {
        // Try the next folder.
      }
    }
    throw new Error(`Cannot find package "${name}". Install it in the project or pass --node-path. (${err?.message ?? err})`);
  }
}

function readRemotionConfig() {
  for (const name of ["remotion.config.ts", "remotion.config.mts", "remotion.config.js", "remotion.config.mjs", "remotion.config.cjs"]) {
    const file = path.join(projectDir, name);
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  return "";
}

const remotionConfig = readRemotionConfig();
const configString = (method) => {
  const m = new RegExp(`${method}\\(\\s*["'\`]([^"'\`]+)["'\`]`).exec(remotionConfig);
  return m ? m[1] : null;
};

function findEntry() {
  if (args.entry) return path.resolve(projectDir, args.entry);
  // A light project's compositions are its timeline's, which the player renders directly.
  if (light) return null;
  const configured = configString("setEntryPoint");
  if (configured && existsSync(path.resolve(projectDir, configured))) return path.resolve(projectDir, configured);
  const candidates = ["src/index", "src/remotion/index", "remotion/index", "app/remotion/index", "src/video/index", "video/index", "index"];
  for (const base of candidates) {
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs"]) {
      const file = path.join(projectDir, base + ext);
      if (existsSync(file) && /registerRoot\s*\(/.test(readFileSync(file, "utf8"))) return file;
    }
  }
  return null;
}

const entryFile = findEntry();
// Light projects: assets are "media/..." relative to the project, served as /media/... (renders
// link the same folder as public/media). Adopted projects: their Remotion public dir.
const publicDir = light ? path.join(projectDir, "media") : path.resolve(projectDir, args.publicDir ?? configString("setPublicDir") ?? "public");
const publicPrefix = light ? "/media/" : "/";
const projectScenesDir = path.join(projectDir, "scenes");
const builtinScenesDir = path.join(nyxsDir, "engine", "scenes");
const timelineFile = path.join(projectDir, "timeline.json");
const shimFile = path.join(nyxsDir, "remotionShim.tsx");

const projectHash = createHash("sha1").update(projectDir).digest("hex").slice(0, 12);
const outRoot = path.resolve(args.outdir ?? path.join(tmpdir(), "nyxs-video-player", projectHash));
// A subfolder we fully own, so clearing stale chunks never touches anything else in --outdir.
const bundleDir = path.join(outRoot, "player-bundle");
const manifestFile = path.join(bundleDir, "manifest.json");
const portFile = path.join(outRoot, "last-port");
mkdirSync(bundleDir, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".lottie": "application/zip",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
};

const sseClients = new Set();
let buildState = { ok: true, error: null, builds: 0 };
// Settled when the bundle on disk is usable; requests for it wait on this.
let settleBuild = () => undefined;
let buildSettled = Promise.resolve();
function buildStarted() {
  buildSettled = new Promise((r) => (settleBuild = r));
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function formatErrors(errors) {
  return errors
    .map((e) => {
      const loc = e.location ? `${path.relative(projectDir, path.resolve(projectDir, e.location.file))}:${e.location.line}:${e.location.column + 1}` : "";
      const line = e.location?.lineText ? `\n    ${e.location.lineText}` : "";
      return `${loc ? `${loc}: ` : ""}${e.text}${line}`;
    })
    .join("\n\n");
}

let announceRebuild = false;
let hadBundle = false;

const notifyPlugin = {
  name: "nyxs-notify",
  setup(build) {
    build.onEnd((result) => {
      buildState.builds++;
      if (result.errors.length > 0) {
        buildState = { ...buildState, ok: false, error: formatErrors(result.errors) };
        rmSync(manifestFile, { force: true });
        process.stderr.write(`[nyxs-player] build failed:\n${buildState.error}\n`);
        broadcast("build-error", { message: buildState.error });
      } else {
        buildState = { ...buildState, ok: true, error: null };
        writeManifest(result.metafile);
        if (announceRebuild) {
          process.stderr.write("[nyxs-player] rebuilt\n");
          broadcast("rebuilt", {});
        }
      }
      settleBuild();
    });
  },
};

const isInside = (dir, file) => {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * Wires the project into the bundle without touching its code:
 * - `nyxs:project` is an adopted project's own Remotion entry; inside the project's code,
 *   imports of "remotion" go to nyxs/remotionShim.tsx so <Composition> records its props.
 * - One copy of react/remotion/@remotion/* for the whole bundle (from coreDir).
 * - `@project/...` resolves into the project folder.
 * - The engine's scene loader is generated from the files in scenes/ (project + built-in):
 *   esbuild can't glob through an alias and fails on a missing folder.
 * - timeline.json is read but not watched: Nyxs sends live timelines over postMessage, and a
 *   rebuild (page reload) on every save would interrupt editing.
 */
function sceneFiles(dir) {
  return (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".tsx")).sort();
}

function sceneTable(dir) {
  return sceneFiles(dir)
    .map((f) => `  ${JSON.stringify(f.replace(/\.tsx$/, ""))}: () => import(${JSON.stringify(path.join(dir, f))}),`)
    .join("\n");
}

const projectPlugin = {
  name: "nyxs-project",
  setup(build) {
    // With the prebuilt core, one instance of these lives in the page (see prebuild.mjs).
    const shared = new Set(usePrebuilt ? Object.keys(prebuilt?.imports ?? {}) : []);

    build.onResolve({ filter: /^nyxs:project$/ }, () => ({ path: "project", namespace: "nyxs" }));
    build.onResolve({ filter: /^nyxs:scenes$/ }, () => ({ path: "scenes", namespace: "nyxs" }));
    build.onLoad({ filter: /^scenes$/, namespace: "nyxs" }, () => ({
      contents: `export const scenes = {\n${sceneTable(projectScenesDir)}\n};\n`,
      resolveDir: projectDir,
      loader: "js",
    }));
    build.onLoad({ filter: /^project$/, namespace: "nyxs" }, () => ({
      contents: entryFile
        ? `import { collectCompositions } from ${JSON.stringify(shimFile)};\nimport ${JSON.stringify(entryFile)};\nexport { collectCompositions };\nexport const entry = ${JSON.stringify(path.relative(projectDir, entryFile).split(path.sep).join("/"))};\n`
        : `export const collectCompositions = null;\nexport const entry = null;\n`,
      resolveDir: projectDir,
      loader: "js",
    }));

    build.onResolve({ filter: /^remotion$/ }, (a) => {
      const importer = a.importer;
      if (!importer || importer.includes(`${path.sep}node_modules${path.sep}`) || importer.includes("/node_modules/")) return undefined;
      // The engine, the player and the shim itself use the real module; everything else in the
      // project (its Root, scenes, and nyxs/TimelineRoot.tsx) registers through the shim.
      if (isInside(runtimeDir, importer) && !isInside(projectDir, importer)) return undefined;
      if (isInside(path.join(nyxsDir, "engine"), importer) || importer === shimFile || importer === path.join(nyxsDir, "player.tsx")) {
        return undefined;
      }
      if (!isInside(projectDir, importer)) return undefined;
      return { path: shimFile };
    });

    // One copy of React and of the Remotion family for the whole bundle (see coreDir): two copies
    // would split their contexts, and mixed versions don't even build. Packages coreDir lacks
    // (e.g. a @remotion/* only the project uses) resolve normally.
    build.onResolve({ filter: /^(react|react-dom|scheduler|remotion|@remotion\/[^/]+)(\/.*)?$/ }, async (a) => {
      if (shared.has(a.path)) return { path: a.path, external: true };
      if (a.pluginData?.nyxsCore || !a.importer) return undefined;
      const core = await build.resolve(a.path, { kind: a.kind, resolveDir: coreDir, pluginData: { nyxsCore: true } });
      return core.errors.length === 0 ? { path: core.path, sideEffects: core.sideEffects } : undefined;
    });

    build.onResolve({ filter: /^@project(\/.*)?$/ }, (a) => ({ path: path.join(projectDir, a.path.slice("@project".length)) }));

    // esbuild can't glob through an alias and fails on a missing folder, so the player gets a
    // loader that lists the scene files explicitly (regenerated on every rebuild).
    build.onResolve({ filter: /^\.\/sceneLoader$/ }, (a) => {
      if (!isInside(path.join(nyxsDir, "engine"), a.importer)) return undefined;
      return { path: "sceneLoader", namespace: "nyxs" };
    });
    build.onLoad({ filter: /^sceneLoader$/, namespace: "nyxs" }, () => {
      return {
        contents: `const project = {\n${sceneTable(projectScenesDir)}\n};\nconst builtin = {\n${sceneTable(builtinScenesDir)}\n};\nexport function importScene(name) {\n  const load = project[name] || builtin[name];\n  if (load) return load();\n  return Promise.reject(new Error("No scenes/" + name + ".tsx in the project (or among the built-in scenes)"));\n}\n`,
        loader: "js",
        resolveDir: projectDir,
        watchDirs: [projectScenesDir, builtinScenesDir].filter((d) => existsSync(d)),
      };
    });

    build.onLoad({ filter: /timeline\.json$/ }, (a) => {
      if (path.resolve(a.path) !== timelineFile) return undefined;
      return { contents: readFileSync(timelineFile, "utf8"), loader: "json", watchFiles: [] };
    });
  },
};

/** What the bundle on disk was made from; `inputs` comes from esbuild's metafile. */
function currentKey() {
  return { mode: usePrebuilt ? "prebuilt" : "full", core: prebuilt?.id ?? null, entry: entryFile, scenes: sceneFiles(projectScenesDir) };
}

function writeManifest(metafile) {
  if (!metafile) return;
  const inputs = Object.keys(metafile.inputs)
    .filter((f) => !/^[a-z-]+:/.test(f))
    .map((f) => {
      const file = path.resolve(projectDir, f);
      const st = statSync(file, { throwIfNoEntry: false });
      return st ? [file, st.mtimeMs, st.size] : null;
    })
    .filter(Boolean);
  writeFileSync(manifestFile, JSON.stringify({ key: currentKey(), inputs }));
  knownInputs = new Set(inputs.map(([file]) => file));
}

/** True when last session's bundle still matches every file it was built from. */
function bundleIsFresh() {
  try {
    const m = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (JSON.stringify(m.key) !== JSON.stringify(currentKey())) return false;
    const fresh = m.inputs.every(([file, mtimeMs, size]) => {
      const st = statSync(file, { throwIfNoEntry: false });
      return st && st.mtimeMs === mtimeMs && st.size === size;
    });
    if (fresh) knownInputs = new Set(m.inputs.map(([file]) => file));
    return fresh;
  } catch {
    return false;
  }
}

/** With the prebuilt core, a light project without scene files needs no bundle at all. */
const needsBundle = () => !usePrebuilt || !!entryFile || sceneFiles(projectScenesDir).length > 0;

let ctx = null;
async function buildContext() {
  if (ctx) return ctx;
  const esbuild = await importPackage("esbuild");
  phase("esbuild-loaded");
  const entryPoints = usePrebuilt
    ? { scenes: "nyxs:scenes", ...(entryFile ? { project: "nyxs:project" } : {}) }
    : { player: path.join(nyxsDir, "player.tsx"), project: "nyxs:project" };
  ctx = await esbuild.context({
  ...COMMON_OPTIONS,
  absWorkingDir: projectDir,
  entryPoints,
  outdir: bundleDir,
  minify: false,
  metafile: true,
  nodePaths,
  publicPath: "/__nyxs/bundle/",
  loader: {
    ".png": "file",
    ".jpg": "file",
    ".jpeg": "file",
    ".gif": "file",
    ".webp": "file",
    ".avif": "file",
    ".svg": "file",
    ".woff": "file",
    ".woff2": "file",
    ".ttf": "file",
    ".otf": "file",
    ".mp3": "file",
    ".wav": "file",
    ".m4a": "file",
    ".mp4": "file",
    ".webm": "file",
    ".mov": "file",
    ".lottie": "file",
    ".glb": "file",
    ".gltf": "file",
    ".txt": "text",
    ".md": "text",
  },
  plugins: [projectPlugin, notifyPlugin],
  });
  return ctx;
}

let building = false;
let rebuildAgain = false;
async function rebuild() {
  if (building) {
    rebuildAgain = true;
    return;
  }
  building = true;
  buildStarted();
  try {
    const context = await buildContext();
    await context.rebuild();
  } catch (err) {
    // Build errors are reported by notifyPlugin; this is for a missing esbuild and the like.
    if (!err?.errors) {
      buildState = { ...buildState, ok: false, error: String(err?.message ?? err) };
      broadcast("build-error", { message: buildState.error });
    }
    settleBuild();
  } finally {
    building = false;
    if (rebuildAgain) {
      rebuildAgain = false;
      rebuild();
    }
  }
}

// Nyxs keeps closed projects' servers warm for minutes. With no page connected nothing is built
// (the next page triggers it) and esbuild's context, the only heavy thing here, is released.
const IDLE_RELEASE_MS = 30_000;
let dirty = false;
let idleTimer = null;

function flushDirty(announce) {
  if (!dirty) return;
  dirty = false;
  applyChange(announce);
}

function clientConnected(res) {
  sseClients.add(res);
  clearTimeout(idleTimer);
  flushDirty(true);
}

function clientGone(res) {
  sseClients.delete(res);
  if (sseClients.size > 0) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (sseClients.size > 0 || building || !ctx) return;
    const old = ctx;
    ctx = null;
    await old.dispose().catch(() => undefined);
  }, IDLE_RELEASE_MS);
}

/** A source changed while the server runs. */
function onProjectChanged() {
  if (sseClients.size === 0) dirty = true;
  else applyChange(true);
}

/** Brings the bundle up to date; `announce` makes connected pages reload with the new code. */
function applyChange(announce) {
  announceRebuild = announce;
  const needed = needsBundle();
  if (needed) {
    rebuild();
  } else if (hadBundle) {
    // The last scene file went away: no bundle now, and the page still has the old scenes.
    rmSync(bundleDir, { recursive: true, force: true });
    mkdirSync(bundleDir, { recursive: true });
    knownInputs = new Set();
    broadcast("rebuilt", {});
  }
  hadBundle = needed;
}

// esbuild's own watch mode polls random samples of every file in the graph; with the ~1,850
// Google Fonts modules a scene edit could take 30 s to show up. A native recursive watcher on
// the project's sources rebuilds right away.
const IGNORED_DIRS = new Set(["node_modules", ".git", "out", "build", "dist", ".nyxs", ".cache"]);
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs|mts|cts|css|json|svg|png|jpe?g|gif|webp|avif|woff2?|ttf|otf|txt|md|glb|gltf|lottie)$/i;
let rebuildTimer = null;
// Files the last successful build read; null = unknown, so any source change counts.
let knownInputs = null;
function onSourceChange(filename) {
  if (filename) {
    const rel = filename.toString();
    const abs = path.resolve(projectDir, rel);
    if (rel.split(/[\\/]/).some((part) => IGNORED_DIRS.has(part))) return;
    if (abs === timelineFile || abs === publicDir || isInside(publicDir, abs) || isInside(outRoot, abs) || !SOURCE_EXT.test(rel)) return;
    // A file nothing imports can't change the bundle (Nyxs rewrites tsconfig.json on open, say).
    if (knownInputs && !knownInputs.has(abs) && !isInside(projectScenesDir, abs) && abs !== projectScenesDir) return;
  }
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(onProjectChanged, 60);
}

// The prebuilt core: normally already on disk. Without it (an install that skipped the step, or
// sources that changed) the first open builds it; the page waits for it, the port doesn't.
let prebuilt = usePrebuilt ? readPrebuilt(runtimeDir) : null;
let prebuiltReady = Promise.resolve(prebuilt);
if (usePrebuilt && !prebuilt) {
  process.stderr.write("[nyxs-player] the prebuilt core is missing or stale: building it\n");
  prebuiltReady = runPrebuild(runtimeDir).then((m) => {
    prebuilt = m;
    return m;
  });
}
phase("core-checked");

/** Starts the build the bundle on disk needs, if any. Never awaited by the server's startup. */
async function prepareBundle() {
  await prebuiltReady;
  hadBundle = needsBundle();
  if (!hadBundle) {
    knownInputs = new Set();
    return;
  }
  if (bundleIsFresh()) {
    phase("bundle-reused");
    return;
  }
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  await rebuild();
  phase("first-build");
}
buildStarted();
const bundlePrepared = prepareBundle()
  .catch((err) => {
    buildState = { ...buildState, ok: false, error: String(err?.message ?? err) };
    process.stderr.write(`[nyxs-player] ${buildState.error}\n`);
    broadcast("build-error", { message: buildState.error });
  })
  .finally(() => settleBuild());

try {
  watch(projectDir, { recursive: true }, (_event, filename) => onSourceChange(filename));
} catch {
  process.stderr.write("[nyxs-player] no recursive file watcher here: changes need a reopen\n");
}

function pageHtml() {
  const core = usePrebuilt && prebuilt ? `/__nyxs/core/${prebuilt.id}/` : null;
  const importMap = core
    ? `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(Object.entries(prebuilt.imports).map(([name, file]) => [name, core + file])) })}</script>\n`
    : "";
  const preload = core ? prebuilt.preload.map((f) => `<link rel="modulepreload" crossorigin="anonymous" href="${core}${f}" />\n`).join("") : "";
  const playerJs = core ? `${core}player.js` : "/__nyxs/bundle/player.js";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nyxs Video player</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #0e0e11; color: #e8e8ec;
    font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  #root { position: fixed; inset: 0; }
  #nyxs-boot-error { position: fixed; inset: 0; padding: 20px; overflow: auto; background: rgba(20, 8, 10, 0.94); display: none; }
  #nyxs-boot-error h1 { margin: 0 0 10px; font-size: 14px; font-weight: 600; color: #ff8a8a; }
  #nyxs-boot-error pre { margin: 0; white-space: pre-wrap; font: 12px/1.5 ui-monospace, Consolas, monospace; }
</style>
${importMap}${preload}<script>
(function () {
  // The panel embeds this page in a sandbox without allow-same-origin: the origin is opaque, so
  // sessionStorage/localStorage throw. window.name survives the reload after a rebuild instead.
  var PREFIX = "nyxs-player:";
  // Opaque origin: window.origin is "null", and Remotion resolves media with
  // new URL(src, window.origin). It is a [Replaceable] attribute, so point it at this server.
  try {
    if (window.origin === "null") window.origin = location.origin;
  } catch (e) {}
  // Remotion (volume preference, studio helpers) and user code may touch web storage; give them
  // in-memory stand-ins instead of SecurityErrors.
  ["localStorage", "sessionStorage"].forEach(function (name) {
    try {
      window[name].getItem("nyxs");
    } catch (e) {
      var data = {};
      var mem = {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
        setItem: function (k, v) { data[k] = String(v); },
        removeItem: function (k) { delete data[k]; },
        clear: function () { data = {}; },
        key: function (i) { return Object.keys(data)[i] || null; },
        get length() { return Object.keys(data).length; }
      };
      try { Object.defineProperty(window, name, { value: mem, configurable: true }); } catch (e2) {}
    }
  });
  var boot = (window.__nyxsBoot = { buildError: null, rebuilt: false, saved: null, onBuildError: null, beforeReload: null });
  if (typeof window.name === "string" && window.name.indexOf(PREFIX) === 0) {
    try {
      var data = JSON.parse(window.name.slice(PREFIX.length));
      boot.rebuilt = !!data.rebuilt;
      boot.saved = data.state || null;
    } catch (e) {}
    window.name = "";
  }
  boot.persist = function (state, rebuilt) {
    try { window.name = PREFIX + JSON.stringify({ rebuilt: !!rebuilt, state: state || null }); } catch (e) {}
  };
  boot.post = function (msg) {
    msg.source = "nyxs-video";
    (window.__nyxsMessages = window.__nyxsMessages || []).push(msg);
    if (window.parent !== window) window.parent.postMessage(msg, "*");
  };
  function showStatic(message) {
    var el = document.getElementById("nyxs-boot-error");
    if (!el) return;
    el.style.display = message ? "block" : "none";
    el.querySelector("pre").textContent = message || "";
  }
  var es = new EventSource("/__nyxs/events");
  es.addEventListener("build-error", function (e) {
    var message = JSON.parse(e.data).message;
    boot.buildError = message;
    if (boot.onBuildError) boot.onBuildError(message);
    else {
      showStatic(message);
      boot.post({ type: "error", message: "Build failed:\\n" + message });
    }
  });
  es.addEventListener("rebuilt", function () {
    boot.buildError = null;
    if (boot.beforeReload) boot.beforeReload();
    else boot.persist(null, true);
    location.reload();
  });
})();
</script>
</head>
<body>
<div id="root"></div>
<div id="nyxs-boot-error"><h1>Build error</h1><pre></pre></div>
<script type="module" src="${playerJs}" crossorigin="anonymous"></script>
</body>
</html>`;
}

// The page runs with an opaque origin (sandboxed iframe), so every response it fetches —
// module scripts, chunks, CSS, EventSource, fetch(), fonts, media read by canvas — is a CORS
// request and needs this header.
const CORS = { "Access-Control-Allow-Origin": "*", "Timing-Allow-Origin": "*" };

function send(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...CORS, ...extra });
  res.end(body);
}

/** Resolves a URL path inside `root`, or null when it escapes it or does not exist. */
function safeFile(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const file = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** Streams a file with HTTP Range support (video seeking needs it). */
function serveFile(req, res, file, cacheControl) {
  const size = statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const headers = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    ...CORS,
  };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === "" && m[2] === "")) {
      res.writeHead(416, { "Content-Range": `bytes */${size}`, ...CORS });
      res.end();
      return;
    }
    let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
    let end = m[1] === "" || m[2] === "" ? size - 1 : Number(m[2]);
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}`, ...CORS });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": size });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...CORS, "Access-Control-Allow-Methods": "GET, HEAD", "Access-Control-Allow-Headers": "Range", "Access-Control-Max-Age": "600" });
      return res.end();
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    if (p === "/" || p === "/index.html") {
      // Only the very first open of a runtime without its prebuilt core can wait here.
      await prebuiltReady.catch(() => null);
      flushDirty(false);
      return send(res, 200, pageHtml(), MIME[".html"]);
    }

    if (p === "/__nyxs/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", ...CORS });
      res.write("retry: 1000\n\n");
      if (!buildState.ok && buildState.error) res.write(`event: build-error\ndata: ${JSON.stringify({ message: buildState.error })}\n\n`);
      clientConnected(res);
      req.on("close", () => clientGone(res));
      return;
    }

    if (p === "/__nyxs/timeline.json") {
      if (!existsSync(timelineFile)) return send(res, 404, "timeline.json not found");
      return send(res, 200, readFileSync(timelineFile), MIME[".json"]);
    }

    if (p === "/__nyxs/status") {
      await bundlePrepared;
      await buildSettled;
      const entry = entryFile ? path.relative(projectDir, entryFile).split(path.sep).join("/") : null;
      const remotion = { version: coreRemotion, from: projectHasFamily ? "project" : "runtime", project: projectRemotion };
      return send(res, 200, JSON.stringify({ ok: buildState.ok, error: buildState.error, builds: buildState.builds, entry, light, remotion, core: usePrebuilt ? (prebuilt?.id ?? null) : null, timing: phases, contextLoaded: !!ctx, clients: sseClients.size, dirty }), MIME[".json"]);
    }

    if (p.startsWith("/__nyxs/core/")) {
      await prebuiltReady.catch(() => null);
      const rest = p.slice("/__nyxs/core/".length);
      const slash = rest.indexOf("/");
      // The id changes with the content, so the browser may keep these for good.
      const file = slash > 0 ? safeFile(path.join(runtimeDir, PREBUILT_DIR), rest.slice(slash + 1)) : null;
      if (!file) return send(res, 404, "Not found");
      return serveFile(req, res, file, "public, max-age=31536000, immutable");
    }

    if (p.startsWith("/__nyxs/bundle/")) {
      const name = p.slice("/__nyxs/bundle/".length);
      await bundlePrepared;
      flushDirty(false);
      await buildSettled;
      const file = safeFile(bundleDir, name);
      if (!file) {
        if (p.endsWith(".css")) return send(res, 200, "", MIME[".css"]);
        // Nothing to bundle, or the build failed (the page shows that error): empty modules.
        if (name === "scenes.js") return send(res, 200, "export const scenes = {};\n", MIME[".js"]);
        if (name === "project.js") return send(res, 200, "export const collectCompositions = null;\nexport const entry = null;\n", MIME[".js"]);
        return send(res, 404, "Not found");
      }
      return serveFile(req, res, file, "no-store");
    }

    if (!p.startsWith(publicPrefix)) return send(res, 404, "Not found");
    const file = safeFile(publicDir, p.slice(publicPrefix.length - 1));
    if (!file) return send(res, 404, "Not found");
    return serveFile(req, res, file, "no-cache");
  } catch (err) {
    if (!res.headersSent) send(res, 500, String(err?.stack ?? err));
    else res.end();
  }
});

// With --port 0, the last session's port if it is free: the same URL lets the browser reuse the
// prebuilt core from its HTTP cache (and its compiled code), which a new port would lose.
function preferredPort() {
  if (args.port !== 0) return args.port;
  try {
    const last = Number(readFileSync(portFile, "utf8"));
    return Number.isInteger(last) && last > 0 && last <= 65535 ? last : 0;
  } catch {
    return 0;
  }
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && args.port === 0) server.listen(0, args.host);
  else throw err;
});

server.on("listening", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : args.port;
  process.stdout.write(`NYXS_PLAYER_PORT=${port}\n`);
  try {
    writeFileSync(portFile, String(port));
  } catch {
    // Only an optimization.
  }
  phase("port");
  process.stderr.write(`[nyxs-player] timing ${phases.join(", ")}\n`);
  bundlePrepared.then(() => process.stderr.write(`[nyxs-player] timing ${phases.join(", ")}\n`));
  const entry = entryFile ? path.relative(projectDir, entryFile) : "none";
  process.stderr.write(`[nyxs-player] http://${args.host}:${port}/ (${light ? "light" : "adopted"} project ${projectDir}, entry: ${entry}, bundle: ${bundleDir})\n`);
  if (projectRemotion && !projectHasFamily) {
    process.stderr.write(`[nyxs-player] the project has remotion ${projectRemotion} without a matching @remotion/player; previewing with the runtime's remotion ${coreRemotion}\n`);
  }
});
server.listen(preferredPort(), args.host);

let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const res of sseClients) res.end();
  server.close();
  try {
    await ctx?.dispose();
  } catch {
    // Already disposed.
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
if (args.watchStdin) {
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("close", () => shutdown(0));
  process.stdin.resume();
}

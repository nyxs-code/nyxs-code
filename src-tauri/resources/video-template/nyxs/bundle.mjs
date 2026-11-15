// The Remotion bundle of a project, reused across renders: webpack is the slow part of a render
// and a timeline edit doesn't need it, since timeline.json reaches the page as `inputProps`. A
// bundle is keyed by the runtime and by the project's code (scenes and anything else that isn't
// data), and lives in `<cache>/bundles/<key>/`.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeModules = path.join(runtimeDir, "node_modules");
/** Never bundled, or passed to the page instead. */
const DATA = new Set(["media", "out", "node_modules", "timeline.json", "nyxs.json", "build", "dist"]);
const KEEP_BUNDLES = 3;
const KEEP_MS = 24 * 60 * 60 * 1000;

/** A package from an adopted project's own install (same version as its `remotion`), else from
 *  the runtime. */
export async function loadPackage(name, projectDir, light) {
  if (!light) {
    try {
      const req = createRequire(path.join(projectDir, "package.json"));
      return await import(pathToFileURL(req.resolve(name)).href);
    } catch {
      // Not installed there: the runtime's copy below.
    }
  }
  return import(name);
}

/** Lets project code (scenes) resolve packages from the runtime and `@project/...` imports. */
export function withProject(config, projectDir, cacheDir, light) {
  const resolve = config.resolve ?? {};
  // An adopted project has no `@project/scenes`: if its code pulls in the engine, the scene
  // loader that only knows the built-in scenes stands in (webpack matches absolute alias keys
  // against resolved paths).
  const engine = path.join(runtimeDir, "nyxs", "engine");
  const noScenes = path.join(engine, "sceneLoader.none.ts");
  const adoptedAlias =
    !light && fs.existsSync(noScenes) ? { [path.join(engine, "sceneLoader.ts")]: noScenes } : {};
  return {
    ...config,
    // One webpack cache per project: a shared one could hand a project another's modules.
    cache: config.cache ? { ...config.cache, cacheDirectory: cacheDir } : config.cache,
    resolve: {
      ...resolve,
      alias: light
        ? { ...(resolve.alias ?? {}), "@project": projectDir }
        : { ...(resolve.alias ?? {}), ...adoptedAlias },
      modules: [...(resolve.modules ?? ["node_modules"]), runtimeModules],
    },
  };
}

/** `media/` is reached through a junction in the bundle instead of being copied into it, so a
 *  render doesn't duplicate gigabytes of footage. Junctions need no special rights on Windows.
 *  Checked on every use: the folder may have appeared, or moved with a renamed project. */
export function linkMedia(serveUrl, projectDir) {
  const media = path.join(projectDir, "media");
  if (!fs.existsSync(media)) return;
  const publicDir = path.join(serveUrl, "public");
  const link = path.join(publicDir, "media");
  try {
    if (fs.realpathSync(link) === fs.realpathSync(media)) return;
  } catch {
    // No link yet, or one whose target is gone: made below.
  }
  fs.mkdirSync(publicDir, { recursive: true });
  fs.rmSync(link, { recursive: true, force: true });
  try {
    fs.symlinkSync(media, link, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    // Another process using this bundle made it first.
    if (e.code !== "EEXIST") throw e;
  }
}

/** Identifies a project's code by paths, sizes and modification times: fast even with big trees,
 *  and a false "changed" only costs one rebuild. */
export function codeFingerprint(projectDir) {
  const h = crypto.createHash("sha256");
  h.update(path.basename(runtimeDir));
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (e.name.startsWith(".") || (rel === "" && DATA.has(e.name))) continue;
      const full = path.join(dir, e.name);
      const relPath = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        walk(full, relPath);
      } else {
        const stat = fs.statSync(full, { throwIfNoEntry: false });
        if (stat) h.update(`${relPath}\0${stat.size}\0${Math.round(stat.mtimeMs)}\0`);
      }
    }
  };
  walk(projectDir, "");
  return h.digest("hex").slice(0, 16);
}

/** Drops bundles beyond the newest few, and what killed builds left. Anything recent stays: a render,
 *  or a cancelled attempt winding down, may be using it right now. */
function prune(root, keep) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return;
  }
  const dated = entries
    .map((e) => ({ dir: path.join(root, e.name), name: e.name, t: fs.statSync(path.join(root, e.name)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  dated.forEach((b, i) => {
    const beyond = i >= KEEP_BUNDLES || b.name.startsWith(".staging-");
    if (b.name !== keep && beyond && Date.now() - b.t > KEEP_MS) {
      fs.rmSync(b.dir, { recursive: true, force: true });
    }
  });
}

/**
 * The bundle for the project's current code, built only if it isn't there.
 * @returns {Promise<{ serveUrl: string, reused: boolean, key: string }>}
 */
export async function ensureBundle({ bundle, projectDir, light, entryPoint, cacheRoot, onProgress }) {
  const root = path.join(cacheRoot, "bundles");
  const key = codeFingerprint(projectDir);
  const finalDir = path.join(root, key);
  if (fs.existsSync(path.join(finalDir, "index.html"))) {
    const now = new Date();
    fs.utimesSync(finalDir, now, now);
    if (light) linkMedia(finalDir, projectDir);
    return { serveUrl: finalDir, reused: true, key };
  }
  // Built aside and renamed, so a killed build or a parallel render never sees half a bundle. The
  // link goes in first for the same reason: a junction's target survives the rename.
  const staging = path.join(root, `.staging-${key}-${process.pid}`);
  const emptyPublic = `${staging}-public`;
  fs.mkdirSync(root, { recursive: true });
  if (light) fs.mkdirSync(emptyPublic, { recursive: true });
  const webpackCache = path.join(cacheRoot, "render", "webpack-cache");
  try {
    await bundle({
      entryPoint,
      rootDir: light ? runtimeDir : projectDir,
      outDir: staging,
      publicDir: light ? emptyPublic : undefined,
      webpackOverride: (config) => withProject(config, projectDir, webpackCache, light),
      onProgress,
    });
    if (light) linkMedia(staging, projectDir);
    try {
      fs.renameSync(staging, finalDir);
    } catch (e) {
      // Another render built the same code meanwhile: its bundle is as good as ours.
      if (!fs.existsSync(path.join(finalDir, "index.html"))) throw e;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(emptyPublic, { recursive: true, force: true });
  }
  // The folder may have appeared since a bundle that had none was built.
  if (light) linkMedia(finalDir, projectDir);
  prune(root, key);
  return { serveUrl: finalDir, reused: false, key };
}

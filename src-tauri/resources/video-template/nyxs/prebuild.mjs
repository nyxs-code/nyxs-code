#!/usr/bin/env node
// Builds the player, the engine, React and Remotion ONCE into <runtime>/prebuilt/, so opening a
// project only has to compile that project's own scenes (usually nothing).
//
//   node <runtime>/nyxs/prebuild.mjs
//
// Run by the runtime install after `npm install`. nyxs/serve.mjs also runs it when the output is
// missing or doesn't match the sources, so a failed step here only costs a slower first open.
//
// Project scenes are bundled separately (see serve.mjs) with the packages in SHARED left as bare
// imports, which an import map in the page sends to prebuilt/vendor/*: one instance of each, as
// React and Remotion contexts need.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const nyxsDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.resolve(nyxsDir, "..");

/** Packages that must exist once in the page, and their file under prebuilt/vendor/. */
const SHARED = {
  react: "react",
  "react/jsx-runtime": "react-jsx-runtime",
  "react/jsx-dev-runtime": "react-jsx-dev-runtime",
  "react-dom": "react-dom",
  "react-dom/client": "react-dom-client",
  remotion: "remotion",
  "remotion/no-react": "remotion-no-react",
};

export const PREBUILT_DIR = "prebuilt";

/** Options every player bundle shares (prebuilt core, project scenes, full builds). */
export const COMMON_OPTIONS = {
  bundle: true,
  format: "esm",
  splitting: true,
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  sourcemap: "linked",
  logLevel: "silent",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  define: { "process.env.NODE_ENV": '"production"' },
  // Some dependencies (and user code written for webpack) read other process.env keys.
  banner: { js: "var process = globalThis.process || { env: {} };" },
};

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(file));
    // The server scripts don't end up in the bundle: editing them keeps the core.
    else if (/\.tsx?$/.test(entry.name) || entry.name === "prebuild.mjs") out.push(file);
  }
  return out.sort();
}

/** Identifies the sources and installed versions a prebuilt core was made from. */
export function sourceStamp(runtime = runtimeDir) {
  const hash = createHash("sha1");
  for (const file of sourceFiles(path.join(runtime, "nyxs"))) {
    hash.update(path.relative(runtime, file).split(path.sep).join("/"));
    hash.update(readFileSync(file));
  }
  for (const name of ["remotion", "react", "react-dom", "@remotion/player"]) {
    try {
      hash.update(`${name}@${JSON.parse(readFileSync(path.join(runtime, "node_modules", name, "package.json"), "utf8")).version}`);
    } catch {
      hash.update(`${name}@none`);
    }
  }
  return hash.digest("hex").slice(0, 16);
}

/** The prebuilt core's manifest when it exists and matches the current sources, else null. */
export function readPrebuilt(runtime = runtimeDir) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(runtime, PREBUILT_DIR, "manifest.json"), "utf8"));
    return manifest.stamp === sourceStamp(runtime) ? manifest : null;
  } catch {
    return null;
  }
}

/** A wrapper module with real named exports: esbuild can't re-export CommonJS names to ESM. */
function vendorModule(name, runtime) {
  if (name.startsWith("remotion")) return `export * from ${JSON.stringify(name)};\n`;
  const require = createRequire(path.join(runtime, "noop.js"));
  const keys = Object.keys(require(name)).filter((k) => k !== "default" && k !== "__esModule");
  const lines = keys.map((k, i) => `const e${i} = mod[${JSON.stringify(k)}];\nexport { e${i} as ${JSON.stringify(k)} };`);
  return `import * as ns from ${JSON.stringify(name)};\nconst mod = ns.default ?? ns;\nexport default mod;\n${lines.join("\n")}\n`;
}

function sceneLoaderModule(scenesDir) {
  const builtin = (existsSync(scenesDir) ? readdirSync(scenesDir) : [])
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => `  ${JSON.stringify(f.replace(/\.tsx$/, ""))}: () => import(${JSON.stringify(path.join(scenesDir, f))}),`)
    .join("\n");
  // The project's scenes are a separate bundle, fetched by URL only when a scene clip mounts, so
  // a stale or slow project build never delays the player.
  return `const builtin = {\n${builtin}\n};
const url = "/__nyxs/bundle/scenes.js";
let project;
function projectScenes() {
  if (!project) {
    project = import(url);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.crossOrigin = "anonymous";
    link.href = "/__nyxs/bundle/scenes.css";
    document.head.appendChild(link);
  }
  return project;
}
export async function importScene(name) {
  const { scenes } = await projectScenes();
  const load = scenes[name] || builtin[name];
  if (load) return load();
  throw new Error("No scenes/" + name + ".tsx in the project (or among the built-in scenes)");
}
`;
}

/** Builds prebuilt/ into a temp folder and swaps it in, so a reader never sees half of it. */
export async function runPrebuild(runtime = runtimeDir) {
  const current = readPrebuilt(runtime);
  if (current) return current;
  const require = createRequire(path.join(runtime, "noop.js"));
  const esbuild = await import(pathToFileURL(require.resolve("esbuild")).href);
  const engineDir = path.join(runtime, "nyxs", "engine");
  const tmp = path.join(runtime, `${PREBUILT_DIR}.tmp-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const entries = { player: path.join(runtime, "nyxs", "player.tsx") };
  const vendorFiles = {};
  for (const [name, file] of Object.entries(SHARED)) {
    entries[`vendor/${file}`] = `nyxs-vendor:${name}`;
    vendorFiles[name] = `vendor/${file}.js`;
  }

  const plugin = {
    name: "nyxs-prebuild",
    setup(build) {
      build.onResolve({ filter: /^nyxs-vendor:/ }, (a) => ({ path: a.path.slice("nyxs-vendor:".length), namespace: "nyxs-vendor" }));
      build.onLoad({ filter: /.*/, namespace: "nyxs-vendor" }, (a) => ({ contents: vendorModule(a.path, runtime), resolveDir: runtime, loader: "js" }));
      build.onResolve({ filter: /^\.\/sceneLoader$/ }, () => ({ path: "sceneLoader", namespace: "nyxs-core" }));
      build.onLoad({ filter: /^sceneLoader$/, namespace: "nyxs-core" }, () => ({
        contents: sceneLoaderModule(path.join(engineDir, "scenes")),
        resolveDir: runtime,
        loader: "js",
      }));
    },
  };

  const started = Date.now();
  const result = await esbuild.build({
    ...COMMON_OPTIONS,
    absWorkingDir: runtime,
    entryPoints: entries,
    outdir: tmp,
    minify: true,
    metafile: true,
    legalComments: "none",
    plugins: [plugin],
  });

  // The modules player.js needs right away, so the page can preload them in one go.
  const outputs = result.metafile.outputs;
  const key = (file) => path.relative(tmp, path.resolve(runtime, file)).split(path.sep).join("/");
  const playerOutput = Object.keys(outputs).find((o) => key(o) === "player.js");
  const preload = (outputs[playerOutput]?.imports ?? []).filter((i) => i.kind === "import-statement").map((i) => key(i.path));

  const id = createHash("sha1")
    .update(Object.keys(outputs).map(key).sort().join("\n"))
    .update(readFileSync(path.join(tmp, "player.js")))
    .digest("hex")
    .slice(0, 12);
  const manifest = { id, stamp: sourceStamp(runtime), imports: vendorFiles, preload };
  writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2));

  const finalDir = path.join(runtime, PREBUILT_DIR);
  // Another build (the install's, a server's) may have finished first, and a page may be reading
  // its files: keep a good one in place.
  if (readPrebuilt(runtime)) {
    rmSync(tmp, { recursive: true, force: true });
    return readPrebuilt(runtime);
  }
  rmSync(finalDir, { recursive: true, force: true });
  try {
    renameSync(tmp, finalDir);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    if (!readPrebuilt(runtime)) throw err;
  }
  const size = readdirSync(finalDir, { recursive: true })
    .map((f) => path.join(finalDir, String(f)))
    .filter((f) => statSync(f).isFile() && f.endsWith(".js"))
    .reduce((a, f) => a + statSync(f).size, 0);
  process.stderr.write(`[nyxs-prebuild] ${Object.keys(outputs).length} files, ${Math.round(size / 1024)} KB of JS in ${Date.now() - started} ms\n`);
  return readPrebuilt(runtime);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPrebuild().then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`[nyxs-prebuild] failed: ${err?.stack ?? err}\n`);
      process.exit(1);
    },
  );
}

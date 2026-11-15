import runtimeSource from "./runtime.js?raw";

/** One mod as the engine loads it: a plugin whose `hooks/hooks.json` names a hooks module. */
export interface ModRef {
  /** The plugin's name, as its manifest gives it: what `e.props.plugin` and the state refs say. */
  plugin: string;
  /** The plugin's folder. */
  root: string;
  /** The hooks module, relative to the plugin's folder with `/` between folders. */
  entry: string;
  /** The values of the manifest's `userConfig`, handed to `register` as `options`. */
  options: Record<string, unknown>;
  /** An installed plugin, or one the agent wrote in this session (`dev-mods`). */
  source: "installed" | "dev";
}

export interface CompiledMod {
  script: string;
  /** Changes when any file of the mod changes: a reload is only needed then. */
  hash: string;
}

const MODULE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const CANDIDATE_SUFFIXES = ["", ...MODULE_EXTS, "/index.ts", "/index.tsx", "/index.js"];
/** A mod is a handful of files; past this something is wrong (an import loop through generated code). */
const MAX_FILES = 200;

export type ReadFile = (path: string) => Promise<string | null>;

function joinRel(fromId: string, spec: string): string | null {
  const parts = fromId.split("/");
  parts.pop();
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      // Out of the plugin's folder: never read.
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

function hasModuleExt(id: string): boolean {
  return MODULE_EXTS.some((e) => id.toLowerCase().endsWith(e));
}

/** FNV-1a over the text: enough to tell two versions of a mod apart. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

async function transformModule(id: string, source: string): Promise<string> {
  const { transform } = await import("sucrase");
  const lower = id.toLowerCase();
  const isTs = /\.(ts|tsx|mts|cts)$/.test(lower);
  const hasJsx = /\.(tsx|jsx|js|mjs|cjs)$/.test(lower);
  const transforms: ("typescript" | "jsx" | "imports")[] = [];
  if (isTs) transforms.push("typescript");
  if (hasJsx) transforms.push("jsx");
  transforms.push("imports");
  return transform(source, {
    transforms,
    filePath: id,
    jsxPragma: "h",
    jsxFragmentPragma: "Fragment",
    production: true,
    disableESTransforms: true,
  }).code;
}

const REQUIRE_RE = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;

/**
 * Compiles a mod's hooks module and every file of the plugin it imports into the one script its
 * Worker runs. `read` answers a file's text, or null when there is none.
 */
export async function compileMod(ref: ModRef, read: ReadFile): Promise<CompiledMod> {
  const defines: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  const findFile = async (base: string): Promise<{ id: string; text: string } | null> => {
    const candidates = hasModuleExt(base) ? [base] : CANDIDATE_SUFFIXES.map((s) => base + s);
    // `./x.js` written for `x.ts`, as TypeScript lets an import name the emitted file.
    const m = /\.(m|c)?js$/i.exec(base);
    if (m) candidates.push(...[".ts", ".tsx", ".mts", ".cts"].map((e) => base.slice(0, -m[0].length) + e));
    for (const id of candidates) {
      if (!hasModuleExt(id)) continue;
      const text = await read(`${ref.root.replace(/[\\/]+$/, "")}/${id}`);
      if (text !== null) return { id, text };
    }
    return null;
  };
  const entry = await findFile(ref.entry.replace(/^\.\//, ""));
  if (!entry) throw new Error(`hooks module not found: ${ref.entry}`);
  const files: { id: string; text: string }[] = [entry];
  seen.add(entry.id);
  queue.push(entry.id);
  const texts = new Map([[entry.id, entry.text]]);
  while (queue.length) {
    const id = queue.shift()!;
    let code: string;
    try {
      code = await transformModule(id, texts.get(id)!);
    } catch (e) {
      throw new Error(`${id}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    defines.push(`__define(${JSON.stringify(id)}, function (require, module, exports) {\n${code}\n});`);
    for (const match of code.matchAll(REQUIRE_RE)) {
      const spec = match[2];
      if (!spec.startsWith(".")) continue;
      const base = joinRel(id, spec);
      if (base === null) throw new Error(`${id}: ${spec} is outside the plugin's folder`);
      const found = await findFile(base);
      if (!found) throw new Error(`${id}: cannot find ${spec}`);
      if (seen.has(found.id)) continue;
      if (seen.size >= MAX_FILES) throw new Error(`more than ${MAX_FILES} files`);
      seen.add(found.id);
      texts.set(found.id, found.text);
      files.push(found);
      queue.push(found.id);
    }
  }
  const boot = `__boot(${JSON.stringify(`./${entry.id}`)}, ${JSON.stringify(ref.plugin)}, ${JSON.stringify(ref.root)}, ${JSON.stringify(ref.options)});`;
  const script = `${runtimeSource}\n${defines.join("\n")}\n${boot}\n`;
  const hash = hashText(files.map((f) => `${f.id}\n${f.text}`).join("\0") + JSON.stringify(ref.options));
  return { script, hash };
}

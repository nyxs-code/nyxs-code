import type React from "react";
import { cn } from "@/lib/utils";
import seti from "@/assets/seti/vs-seti-icon-theme.json";

// VS Code's default file icon theme (Seti), copied from microsoft/vscode
// extensions/theme-seti/icons. Glyphs live in one font (@font-face in index.css);
// the JSON maps names to glyph + colour.
type Defs = Record<string, { fontCharacter: string; fontColor?: string }>;
type Assoc = { file?: string; fileNames?: Record<string, string>; fileExtensions?: Record<string, string>; languageIds?: Record<string, string> };

const defs = seti.iconDefinitions as Defs;
const dark = seti as Assoc;
const light = seti.light as Assoc;

// VS Code resolves most common files through their language, not their extension,
// so the extensions that language contributions claim are mapped here.
const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact",
  json: "json", jsonc: "jsonc", jsonl: "jsonl", md: "markdown", mdx: "markdown", markdown: "markdown",
  html: "html", htm: "html", xhtml: "html", css: "css", scss: "scss", sass: "sass", less: "less",
  styl: "stylus", pcss: "postcss", vue: "vue", py: "python", pyw: "python", pyi: "python",
  rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", cu: "cuda-cpp",
  m: "objective-c", mm: "objective-cpp", cs: "csharp", fs: "fsharp", fsx: "fsharp",
  rb: "ruby", erb: "erb", php: "php", pl: "perl", pm: "perl", lua: "lua", r: "r", dart: "dart",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "shellscript",
  ps1: "powershell", psm1: "powershell", psd1: "powershell", bat: "bat", cmd: "bat",
  yml: "yaml", yaml: "yaml", xml: "xml", xsd: "xml", xsl: "xml", svg: "xml", plist: "xml",
  sql: "sql", properties: "properties", ini: "properties", conf: "properties", cfg: "properties",
  env: "dotenv", tex: "latex", clj: "clojure", cljs: "clojure", coffee: "coffeescript",
  groovy: "groovy", gradle: "groovy", hbs: "handlebars", handlebars: "handlebars", pug: "jade",
  jade: "jade", jl: "julia", ex: "elixir", exs: "elixir", elm: "elm", hs: "haskell", ml: "ocaml",
  tf: "terraform", bicep: "bicep", haml: "haml", cshtml: "razor", razor: "razor", vala: "vala",
  mustache: "mustache", njk: "nunjucks", j2: "jinja", jinja: "jinja", res: "rescript",
};

const NAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
  ".gitignore": "ignore", ".dockerignore": "ignore", ".npmignore": "ignore", ".eslintignore": "ignore",
  ".prettierignore": "ignore", ".gitattributes": "properties", ".gitmodules": "properties",
  ".editorconfig": "properties", ".env": "dotenv", "compose.yml": "dockercompose",
  "compose.yaml": "dockercompose", "docker-compose.yml": "dockercompose", "docker-compose.yaml": "dockercompose",
  "commit_editmsg": "git-commit",
};

function lookup(a: Assoc, name: string, lang: string | undefined): string | undefined {
  const byName = a.fileNames?.[name];
  if (byName) return byName;
  // Longest compound extension first, as VS Code does: "d.ts" wins over "ts".
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const id = a.fileExtensions?.[parts.slice(i).join(".")];
    if (id) return id;
  }
  return lang ? a.languageIds?.[lang] : undefined;
}

const cache = new Map<string, { char: string; dark?: string; light?: string }>();

// The light variant only recolours: every light override points at the same glyph as its dark one.
function iconFor(name: string) {
  const lower = name.toLowerCase();
  const hit = cache.get(lower);
  if (hit) return hit;
  const dot = lower.lastIndexOf(".");
  const lang = NAME_LANG[lower] ?? (lower.startsWith(".env.") ? "dotenv" : undefined)
    ?? (dot > 0 ? EXT_LANG[lower.slice(dot + 1)] : undefined);
  const darkDef = defs[lookup(dark, lower, lang) ?? dark.file!];
  const lightDef = defs[lookup(light, lower, lang) ?? lookup(dark, lower, lang) ?? light.file ?? dark.file!];
  const icon = {
    char: String.fromCodePoint(parseInt(darkDef.fontCharacter.slice(1), 16)),
    dark: darkDef.fontColor,
    light: lightDef?.fontColor ?? darkDef.fontColor,
  };
  cache.set(lower, icon);
  return icon;
}

/** File icon from VS Code's Seti theme, picked from the file's name, extension or language. */
export function FileIcon({ name, className }: { name: string; className?: string }) {
  const icon = iconFor(name);
  return (
    <span
      aria-hidden
      className={cn(
        "w-4 h-4 shrink-0 inline-flex items-center justify-center overflow-visible leading-none select-none",
        "text-(--seti-light) dark:text-(--seti-dark)",
        className,
      )}
      // 150% of the row's text, the size VS Code declares for this font.
      style={{ fontFamily: "seti", fontSize: "150%", "--seti-dark": icon.dark, "--seti-light": icon.light } as React.CSSProperties}
    >
      {icon.char}
    </span>
  );
}

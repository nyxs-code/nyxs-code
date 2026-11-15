/** What the text typed in the address bar means: a website to open, a search, or a path (a
 *  project file, an absolute path or another kind of address the tab opens as is). */
export type AddressTarget =
  | { kind: "web"; url: string }
  | { kind: "search"; query: string }
  | { kind: "path"; path: string };

const SCHEME = /^[a-z]+:\/\//i;
const DRIVE = /^[a-zA-Z]:[\\/]/;
const LOCAL_HOST = /^(localhost|[\w-]+\.localhost|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$|\?|#)/i;
const DOMAIN = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?|#)/;

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const stem = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name);

/** The project file a single word names: its path, its file name, or its file name without the
 *  extension (`README` for `README.md`). The one nearest the project's root wins. `files` are
 *  relative to the project, with `/`. */
export function findProjectFile(word: string, files: readonly string[]): string | undefined {
  const w = norm(word.trim());
  if (!w || /\s/.test(w) || w.endsWith("/")) return undefined;
  const nearest = (hits: string[]) =>
    hits.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0];
  const exact = files.find((f) => norm(f) === w);
  if (exact) return exact;
  if (w.includes("/")) return undefined;
  const byName = files.filter((f) => baseName(norm(f)) === w);
  if (byName.length) return nearest(byName);
  if (w.includes(".")) return undefined;
  const byStem = files.filter((f) => stem(baseName(norm(f))) === w);
  return byStem.length ? nearest(byStem) : undefined;
}

/** How the address bar reads what was typed, the way a browser's does: a web address opens, a
 *  bare word or a phrase is searched, a path opens as a file. A single word that names a file of
 *  the project (`README`, `package.json`, `src/app.ts`) opens that file instead. */
export function classifyAddress(value: string, files: readonly string[] = []): AddressTarget {
  const v = value.trim();
  if (SCHEME.test(v)) return /^https?:\/\//i.test(v) ? { kind: "web", url: v } : { kind: "path", path: v };
  if (DRIVE.test(v) || v.startsWith("/")) return { kind: "path", path: v };
  if (LOCAL_HOST.test(v)) return { kind: "web", url: `http://${v}` };
  if (!/\s/.test(v) && !/^[.\\]/.test(v)) {
    const file = findProjectFile(v, files);
    if (file) return { kind: "path", path: file };
  }
  if (!v.includes("\\") && !/\.html?($|[?#])/i.test(v) && DOMAIN.test(v)) return { kind: "web", url: `https://${v}` };
  // Words with spaces are a search unless they end like a file path; a bare word is one unless
  // it has a dot or a slash.
  const search = /\s/.test(v) ? !/[/\\][^/\\]*\.\w{1,5}$/.test(v) : !/[./\\]/.test(v);
  if (search && !/^[./\\]/.test(v)) return { kind: "search", query: v };
  return { kind: "path", path: v };
}

type Pos = { line: number; character: number };
type Range = { start: Pos; end: Pos };
type Obj = Record<string, unknown>;

const SYMBOL_KIND = [
  "", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor",
  "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array",
  "object", "key", "null", "enum member", "struct", "event", "operator", "type parameter",
];

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isRange = (v: unknown): v is Range =>
  isObj(v) && isObj(v.start) && typeof v.start.line === "number" && typeof v.start.character === "number";

export function uriToDisplayPath(uri: string, workspace: string): string {
  let path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  try {
    path = decodeURIComponent(path);
  } catch {
    return uri;
  }
  if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
  path = path.replace(/\\/g, "/");
  const root = workspace.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const windows = /^[a-zA-Z]:\//.test(root);
  const inside = windows ? path.toLowerCase().startsWith(root.toLowerCase()) : path.startsWith(root);
  return inside ? path.slice(root.length) : path;
}

const at = (file: string, r: Range) => `${file}:${r.start.line + 1}:${r.start.character + 1}`;

function hoverText(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n\n");
  if (isObj(contents) && typeof contents.value === "string") {
    return typeof contents.language === "string" ? "```" + contents.language + "\n" + contents.value + "\n```" : contents.value;
  }
  return "";
}

function location(v: unknown, workspace: string): string | null {
  if (!isObj(v)) return null;
  if (typeof v.uri === "string" && isRange(v.range)) return at(uriToDisplayPath(v.uri, workspace), v.range);
  if (typeof v.targetUri === "string") {
    const r = isRange(v.targetSelectionRange) ? v.targetSelectionRange : v.targetRange;
    if (isRange(r)) return at(uriToDisplayPath(v.targetUri, workspace), r);
  }
  return null;
}

function symbolLines(items: unknown[], workspace: string, depth: number, out: string[]): void {
  for (const s of items) {
    if (!isObj(s) || typeof s.name !== "string") continue;
    const kind = SYMBOL_KIND[typeof s.kind === "number" ? s.kind : 0] || "symbol";
    const detail = typeof s.detail === "string" && s.detail ? ` ${s.detail}` : "";
    const where = isRange(s.selectionRange)
      ? `line ${s.selectionRange.start.line + 1}`
      : isRange(s.range)
        ? `line ${s.range.start.line + 1}`
        : location(s.location, workspace) ?? "";
    out.push(`${"  ".repeat(depth)}${s.name} (${kind}${detail}) ${where}`.trimEnd());
    if (Array.isArray(s.children)) symbolLines(s.children, workspace, depth + 1, out);
  }
}

export function formatLspResult(action: string, result: unknown, workspace: string): string | null {
  const list = Array.isArray(result) ? result : [result];
  switch (action) {
    case "hover": {
      const text = isObj(result) ? hoverText(result.contents).trim() : "";
      return text || null;
    }
    case "definition":
    case "references": {
      const locs = list.map((l) => location(l, workspace));
      if (locs.some((l) => l === null)) return null;
      const label = action === "definition" ? "definition(s)" : "reference(s)";
      return `${locs.length} ${label}:\n${locs.join("\n")}`;
    }
    case "symbols": {
      const out: string[] = [];
      symbolLines(list, workspace, 0, out);
      return out.length ? out.join("\n") : null;
    }
    default:
      return null;
  }
}

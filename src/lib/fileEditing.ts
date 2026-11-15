/** Rules for editing files in the Files panel, like Claude Code Desktop's file pane. */
import type { Token } from "@/lib/highlight";

/** Splits highlighted tokens on newlines so each source line renders as its own row. */
export function toLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const t of tokens) {
    const parts = t.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, cls: t.cls });
    });
  }
  return lines;
}

/** Project configuration stays view-only there (Desktop keeps `.mcp.json` and
 *  `.claude/settings.json` read-only): permissions and servers change through Settings. */
export function isViewOnlyConfig(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  return (
    /(^|\/)\.mcp\.json$/.test(p) ||
    /(^|\/)\.(claude|nyxs)\/settings(\.local)?\.json$/.test(p)
  );
}

/** Whether `path` is inside `workspace`: Desktop edits files in the working directory only. */
export function insideWorkspace(path: string, workspace: string | null): boolean {
  if (!workspace) return false;
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(path).startsWith(`${norm(workspace)}/`);
}

/** What Tab inserts: the file's own indentation, guessed from its indented lines. */
export function indentUnit(text: string): string {
  let tabs = 0;
  const widths: number[] = [];
  for (const line of text.split("\n").slice(0, 2000)) {
    const m = /^([ \t]+)\S/.exec(line);
    if (!m) continue;
    if (m[1].startsWith("\t")) tabs++;
    else widths.push(m[1].length);
  }
  if (tabs > widths.length) return "\t";
  if (!widths.length) return "  ";
  // The smallest step that most indents are a multiple of.
  for (const step of [2, 4, 8]) {
    if (widths.filter((w) => w % step === 0).length >= widths.length * 0.9 && widths.some((w) => w === step)) return " ".repeat(step);
  }
  return " ".repeat(Math.min(...widths));
}

/** Tab / Shift+Tab on a selection: indents or outdents every line it touches. Returns the new
 *  text and selection. */
export function indentLines(text: string, start: number, end: number, unit: string, outdent: boolean): { text: string; start: number; end: number } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  let firstDelta = 0;
  let total = 0;
  const out = lines.map((l, i) => {
    let next: string;
    if (outdent) {
      const strip = l.startsWith("\t") ? 1 : Math.min(unit === "\t" ? 0 : unit.length, /^ */.exec(l)![0].length);
      next = l.slice(strip);
    } else next = unit + l;
    const delta = next.length - l.length;
    if (i === 0) firstDelta = delta;
    total += delta;
    return next;
  });
  return {
    text: text.slice(0, lineStart) + out.join("\n") + text.slice(lineEnd),
    start: Math.max(lineStart, start + firstDelta),
    end: end + total,
  };
}

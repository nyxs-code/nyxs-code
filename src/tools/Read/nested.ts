import { invoke } from "@/lib/ipc";

const INSTRUCTION_FILES = ["NYXS.md", "AGENTS.md", "CLAUDE.md"];
const MAX_CHARS = 6000;
export const NESTED_TAG_RE = /<nested-instructions path="([^"]+)">/g;

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function parentDir(p: string): string | null {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : null;
}

export function nestedInstructionDirs(filePath: string, workspace: string): string[] {
  const root = norm(workspace);
  const dirs: string[] = [];
  let dir = parentDir(filePath);
  while (dir) {
    const n = norm(dir);
    if (n === root || !n.startsWith(`${root}/`)) break;
    dirs.push(dir);
    dir = parentDir(dir);
  }
  return dirs;
}

export async function nestedInstructionsFor(
  filePath: string,
  workspace: string,
  seen: Set<string>,
  scope: string,
): Promise<string> {
  const blocks: string[] = [];
  for (const dir of nestedInstructionDirs(filePath, workspace)) {
    const key = norm(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const name of INSTRUCTION_FILES) {
      const sep = dir.includes("\\") ? "\\" : "/";
      const path = `${dir}${sep}${name}`;
      let text: string | null;
      try {
        text = await invoke<string | null>("agent_read_text", { path, scope });
      } catch {
        text = null;
      }
      if (!text?.trim()) continue;
      const body = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[… truncated]` : text;
      blocks.unshift(
        `<nested-instructions path="${key}">\nInstructions for files under ${dir} (from ${name}). Follow them when working there.\n\n${body.trim()}\n</nested-instructions>`,
      );
      break;
    }
  }
  return blocks.join("\n\n");
}

export function seenNestedDirs(texts: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(NESTED_TAG_RE)) seen.add(m[1]);
  return seen;
}

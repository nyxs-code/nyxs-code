import { invoke } from "@/lib/ipc";
import { homeDir } from "@tauri-apps/api/path";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface FileAgentDef {
  name: string;
  description: string;
  whenToUse: string;
  tools?: string[];
  model?: string;
  color?: string;
  body: string;
  source: "project" | "user";
  dir: string;
}

function parseFrontmatter(content: string): { fm: Record<string, string>; body: string } {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { fm: {}, body: normalized };
  const fm: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fm[m[1].toLowerCase()] = value;
  }
  return { fm, body: match[2] };
}

function parseToolList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/^\[|\]$/g, "").trim();
  if (!cleaned || /^(all|\*|inherit)$/i.test(cleaned)) return undefined;
  const list = cleaned.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

function firstParagraph(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) return t;
  }
  return "Custom sub-agent.";
}

async function dirExists(path: string): Promise<string[]> {
  if (!isTauri) return [];
  try {
    return await invoke<string[]>("agent_list_dir", { path });
  } catch {
    return [];
  }
}

async function loadFromDir(dir: string, source: "project" | "user"): Promise<FileAgentDef[]> {
  const entries = await dirExists(dir);
  const out: FileAgentDef[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const path = `${dir}/${entry}`;
    let content: string;
    try {
      content = await invoke<string>("nyxs_read_text", { path });
    } catch {
      continue;
    }
    if (!content.trim()) continue;
    const { fm, body } = parseFrontmatter(content);
    const name = (fm.name || entry.replace(/\.md$/i, "")).trim();
    if (!name) continue;
    out.push({
      name,
      description: fm.description || firstParagraph(body),
      whenToUse: fm.when_to_use || fm["when-to-use"] || fm.whentouse || fm.description || firstParagraph(body),
      tools: parseToolList(fm.tools),
      model: fm.model?.trim() || undefined,
      color: fm.color?.trim() || undefined,
      body: body.trim(),
      source,
      dir,
    });
  }
  return out;
}

export async function loadAgentFiles(workspace: string | null): Promise<FileAgentDef[]> {
  if (!isTauri) return [];
  const dirs: Promise<FileAgentDef[]>[] = [];
  if (workspace) {
    dirs.push(loadFromDir(`${workspace.replace(/[\\/]+$/, "")}/.nyxs/agents`, "project"));
  }
  try {
    const home = (await homeDir()).replace(/[\\/]+$/, "");
    dirs.push(loadFromDir(`${home}/.nyxs/agents`, "user"));
  } catch {
    /* no home dir available */
  }
  const groups = await Promise.all(dirs);
  const seen = new Set<string>();
  const merged: FileAgentDef[] = [];
  for (const group of groups) {
    for (const a of group) {
      if (seen.has(a.name)) continue;
      seen.add(a.name);
      merged.push(a);
    }
  }
  return merged;
}

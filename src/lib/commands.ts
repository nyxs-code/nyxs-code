import { invoke } from "@/lib/ipc";
import { userCommandsDir, projectCommandsDir } from "@/lib/paths";
import { loadPluginComponents } from "@/lib/plugins/pluginLoader";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface CommandDef {
  name: string;
  source: "project" | "user" | "plugin";
  description: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  body: string;
  path: string;
}

function parseFrontmatter(content: string): { fm: Record<string, string>; body: string } {
  const normalized = content.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { fm: {}, body: normalized };
  const fm: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fm[m[1].toLowerCase()] = value;
  }
  return { fm, body: match[2] };
}

function fallbackDescription(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) return t.length > 120 ? t.slice(0, 119) + "…" : t;
  }
  return "Custom command.";
}

function splitList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    return await invoke<string[]>("agent_glob", { pattern: "*.md", cwd: dir });
  } catch {
    return [];
  }
}

function commandName(dir: string, filePath: string): string {
  const base = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const norm = filePath.replace(/\\/g, "/");
  const rel = norm.startsWith(base + "/") ? norm.slice(base.length + 1) : norm.split("/").pop() || norm;
  return rel.replace(/\.md$/i, "").replace(/\//g, ":");
}

export async function loadCommands(workspace: string | null): Promise<CommandDef[]> {
  if (!isTauri) return [];
  const dirs: { dir: string; source: "project" | "user" }[] = [];
  if (workspace) {
    dirs.push({ dir: projectCommandsDir(workspace), source: "project" });
  }
  try {
    dirs.push({ dir: await userCommandsDir(), source: "user" });
  } catch {
    /* sin home: solo comandos de proyecto */
  }

  const byName = new Map<string, CommandDef>();
  for (const { dir, source } of dirs) {
    const files = await listMarkdown(dir);
    for (const path of files) {
      const name = commandName(dir, path);
      if (byName.has(name)) continue;
      let content: string;
      try {
        content = await invoke<string>("nyxs_read_text", { path });
      } catch {
        continue;
      }
      if (!content.trim()) continue;
      const { fm, body } = parseFrontmatter(content);
      byName.set(name, {
        name,
        source,
        description: fm.description || fallbackDescription(body),
        argumentHint: fm["argument-hint"] || undefined,
        allowedTools: fm["allowed-tools"] ? splitList(fm["allowed-tools"]) : undefined,
        model: fm.model || undefined,
        body: body.trim(),
        path,
      });
    }
  }

  try {
    const { commands: pluginCommands } = await loadPluginComponents();
    for (const c of pluginCommands) {
      if (byName.has(c.name)) continue;
      byName.set(c.name, {
        name: c.name,
        source: "plugin",
        description: c.description || fallbackDescription(c.content),
        argumentHint: c.argumentHint,
        allowedTools: c.allowedTools,
        model: c.model,
        body: c.content.trim(),
        path: "",
      });
    }
  } catch {
    /* plugins unavailable: file commands still work */
  }

  return [...byName.values()];
}

export function resolveCommandContent(cmd: CommandDef, args: string): string {
  const argList = args.trim() ? args.trim().split(/\s+/) : [];
  return cmd.body
    .replace(/\$ARGUMENTS\b/g, args.trim())
    .replace(/\$(\d+)/g, (_, n) => argList[Number(n) - 1] ?? "");
}

export function matchCommand(
  message: string,
  commands: CommandDef[],
): { cmd: CommandDef; args: string } | null {
  const m = /^\/([A-Za-z0-9_:-]+)\s*([\s\S]*)$/.exec(message.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const cmd = commands.find((c) => c.name.toLowerCase() === name);
  if (!cmd) return null;
  return { cmd, args: m[2].trim() };
}

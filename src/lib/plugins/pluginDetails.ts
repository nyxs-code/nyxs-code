import { invoke } from "@/lib/ipc";
import { joinPath } from "./catalog";
import { listDir } from "./paths";
import { emptyComponents, loadOne } from "./pluginLoader";
import type { InstalledPlugin, KnownMarketplace, PluginManifest } from "./schema";

/** One thing a plugin adds, as its page lists it. */
export interface PluginPart {
  name: string;
  detail?: string;
}

export interface PluginParts {
  /** Hook commands by event, and hooks modules (mods) by file: both run code. */
  hooks: PluginPart[];
  commands: PluginPart[];
  agents: PluginPart[];
  skills: PluginPart[];
  /** `host` for a server it reaches over the network; none for one that runs on the computer. */
  mcpServers: (PluginPart & { host?: string })[];
  outputStyles: PluginPart[];
}

export type PartKind = "hook" | "command" | "agent" | "skill" | "localMcp" | "mcp" | "outputStyle";

const NO_PARTS: PluginParts = { hooks: [], commands: [], agents: [], skills: [], mcpServers: [], outputStyles: [] };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function frontmatter(content: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content.replace(/^﻿/, ""));
  const out: Record<string, string> = {};
  for (const line of m?.[1].split(/\r?\n/) ?? []) {
    const mm = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (mm) out[mm[1].toLowerCase()] = mm[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

async function readText(path: string): Promise<string> {
  return invoke<string>("nyxs_read_text", { path }).catch(() => "");
}

/** Everything a plugin adds, whether or not it's turned on: what Nyxs loads from it when it is. */
export async function describePlugin(p: InstalledPlugin): Promise<PluginParts> {
  const out = emptyComponents();
  try {
    await loadOne(p, out);
  } catch {
    return NO_PARTS;
  }
  const hooks: PluginPart[] = [
    ...out.mods.map((m) => ({ name: `./${m.entry}` })),
    ...Object.entries(out.hooks).flatMap(([event, matchers]) =>
      (matchers ?? []).map((m) => ({ name: m.matcher ? `${event} · ${m.matcher}` : event, detail: m.hooks[0]?.command })),
    ),
  ];
  const skillsRoot = joinPath(p.installLocation, "skills");
  const skills = (
    await Promise.all(
      (await listDir(skillsRoot)).map(async (name): Promise<PluginPart | null> => {
        const content = await readText(joinPath(skillsRoot, name, "SKILL.md"));
        if (!content.trim()) return null;
        const fm = frontmatter(content);
        return { name: fm.name || name, detail: fm.description || undefined };
      }),
    )
  ).filter((s): s is PluginPart => s !== null);
  const strip = (name: string) => name.slice(name.indexOf(":") + 1);
  return {
    hooks,
    commands: out.commands.map((c) => ({ name: `/${c.name}`, detail: c.description })),
    agents: out.agents.map((a) => ({ name: strip(a.name), detail: a.description })),
    skills,
    mcpServers: Object.entries(out.mcpServers).map(([name, s]) =>
      "url" in s ? { name: strip(name), host: hostOf(s.url) } : { name: strip(name) },
    ),
    outputStyles: out.outputStyles.map((s) => ({ name: s.name, detail: s.description || undefined })),
  };
}

/** What kinds of things a plugin adds, each with how many, in the order its list line names them. */
export function partKinds(parts: PluginParts): { kind: PartKind; count: number }[] {
  const local = parts.mcpServers.filter((s) => !s.host).length;
  const remote = parts.mcpServers.length - local;
  const all: { kind: PartKind; count: number }[] = [
    { kind: "hook", count: parts.hooks.length },
    { kind: "agent", count: parts.agents.length },
    { kind: "command", count: parts.commands.length },
    { kind: "localMcp", count: local },
    { kind: "mcp", count: remote },
    { kind: "skill", count: parts.skills.length },
    { kind: "outputStyle", count: parts.outputStyles.length },
  ];
  return all.filter((k) => k.count > 0);
}

/** It runs code on the computer without asking: hooks, or an MCP server it starts itself. */
export function runsCode(parts: PluginParts): boolean {
  return parts.hooks.length > 0 || parts.mcpServers.some((s) => !s.host);
}

/** The hosts its MCP servers send data to. */
export function networkHosts(parts: PluginParts): string[] {
  return [...new Set(parts.mcpServers.flatMap((s) => (s.host ? [s.host] : [])))];
}

/** Where its code lives, for "Source code" and the list line: the plugin's own repository or
 *  site, or else the GitHub repository of its marketplace. */
export function sourceOf(
  manifest: PluginManifest | null | undefined,
  homepage: string | undefined,
  marketplace: KnownMarketplace | null | undefined,
): { label: string; url: string | null } | null {
  const own = manifest?.repository || manifest?.homepage || homepage;
  if (own && /^https?:\/\//i.test(own)) return { label: own.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, ""), url: own };
  const src = marketplace?.source;
  if (src?.source === "github") return { label: src.repo, url: `https://github.com/${src.repo}` };
  if (src?.source === "git" || src?.source === "url") return { label: src.url.replace(/^https?:\/\//i, "").replace(/\.git$/, ""), url: /^https?:\/\//i.test(src.url) ? src.url : null };
  return null;
}

/** The version to show: the installed copy's own manifest says it best; most catalogs give none
 *  and the install then records "0.0.0", so that one only counts when it's real, and the commit
 *  stands in when nothing else does. */
export function shownVersion(
  manifest: PluginManifest | null | undefined,
  recorded: string | undefined,
  sha?: string,
): string | null {
  const real = (v: string | undefined) => (v && v.trim() && v.trim() !== "0.0.0" ? v.trim().replace(/^v/i, "") : null);
  const version = real(manifest?.version) ?? real(recorded);
  if (version) return `v${version}`;
  return sha ? sha.slice(0, 7) : null;
}

const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_FILES = 2000;

/** The plugin's files, as paths relative to its folder with "/", folders first at each level. */
export async function listPluginFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    const raw = await invoke<string[]>("agent_list_dir", { path: rel ? joinPath(root, rel) : root }).catch(() => [] as string[]);
    const dirs = raw.filter((e) => e.endsWith("/")).map((e) => e.slice(0, -1));
    const files = raw.filter((e) => !e.endsWith("/")).map((e) => e.replace(/ {2}\([^)]*\)$/, ""));
    for (const d of dirs) if (!SKIP_DIRS.has(d)) await walk(rel ? `${rel}/${d}` : d);
    for (const f of files) if (out.length < MAX_FILES) out.push(rel ? `${rel}/${f}` : f);
  };
  await walk("");
  return out;
}

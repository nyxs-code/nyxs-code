import { invoke } from "@/lib/ipc";
import { isTauri, listDir } from "./paths";
import { joinPath } from "./catalog";
import { listInstalled } from "./install";
import { getEnabledPlugins } from "./pluginSettings";
import { safeRelativePath } from "./sourceSafety";
import {
  parsePluginManifest,
  salvageHooksMap,
  type CommandMetadata,
  type LoadedPlugin,
  type PluginManifest,
} from "./schema";
import { getPluginConfig, substituteDeep, substituteUserConfig } from "./userConfig";
import type { InstalledPlugin } from "./schema";
import type { HooksConfig, HookEvent, HookMatcher } from "@/lib/hooks";
import type { McpServerConfig, ConfigError } from "@/lib/configSchema";
import type { ModRef } from "@/lib/mods/compile";

export interface PluginCommand {
  name: string;
  content: string;
  plugin: string;
  description?: string;
  argumentHint?: string;
  model?: string;
  allowedTools?: string[];
}

export interface PluginAgent {
  name: string;
  content: string;
  plugin: string;
  description?: string;
  whenToUse?: string;
  tools?: string[];
  model?: string;
}

export interface PluginOutputStyle {
  id: string;
  name: string;
  description: string;
  prompt: string;
  plugin: string;
}

export interface LoadedPluginComponents {
  plugins: LoadedPlugin[];
  commands: PluginCommand[];
  agents: PluginAgent[];
  outputStyles: PluginOutputStyle[];
  hooks: HooksConfig;
  mcpServers: Record<string, McpServerConfig>;
  /** Plugins with a hooks module (Claude Code's mods), which `src/lib/mods/` runs. */
  mods: ModRef[];
  errors: ConfigError[];
}

const EMPTY: LoadedPluginComponents = {
  plugins: [],
  commands: [],
  agents: [],
  outputStyles: [],
  hooks: {},
  mcpServers: {},
  mods: [],
  errors: [],
};

let cache: { sig: string; data: LoadedPluginComponents } | null = null;

export function clearPluginLoaderCache(): void {
  cache = null;
  // Mods (src/lib/mods/useMods.ts) reload what changed.
  if (typeof window !== "undefined") window.dispatchEvent?.(new Event("nyxs:plugins-changed"));
}

export function getCachedPluginComponents(): LoadedPluginComponents {
  return cache?.data ?? EMPTY;
}

async function readText(path: string): Promise<string> {
  try {
    return await invoke<string>("nyxs_read_text", { path });
  } catch {
    return "";
  }
}

function ns(plugin: string, name: string): string {
  return `${plugin}:${name}`;
}

function toList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function baseName(rel: string): string {
  const last = rel.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? rel;
  return last.replace(/\.md$/i, "");
}

function parseFrontmatter(content: string): { fm: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content.replace(/^﻿/, ""));
  if (!m) return { fm: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[mm[1].toLowerCase()] = v;
  }
  return { fm, body: m[2] };
}

async function mdFiles(root: string, folder: string): Promise<string[]> {
  const names = await listDir(joinPath(root, folder));
  return names.filter((n) => n.toLowerCase().endsWith(".md"));
}

async function readManifest(
  root: string,
  fallbackName: string,
  label: string,
  errors: ConfigError[],
): Promise<PluginManifest> {
  const raw =
    (await readText(joinPath(root, ".nyxs-plugin/plugin.json"))) ||
    (await readText(joinPath(root, ".claude-plugin/plugin.json"))) ||
    (await readText(joinPath(root, "plugin.json")));
  if (!raw.trim()) return { name: fallbackName };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    errors.push({ file: label, path: "", message: "plugin.json is not valid JSON." });
    return { name: fallbackName };
  }
  const { manifest, errors: errs } = parsePluginManifest(parsedJson, label);
  errors.push(...errs);
  return manifest ?? { name: fallbackName };
}

type Subst = (text: string) => string;

function pushStyle(
  out: LoadedPluginComponents,
  pname: string,
  pluginId: string,
  fallbackName: string,
  content: string,
  sub: Subst,
): void {
  if (!content.trim()) return;
  const { fm, body } = parseFrontmatter(content);
  out.outputStyles.push({
    id: ns(pname, fallbackName),
    name: fm.name || fallbackName,
    description: fm.description || "",
    prompt: sub(body.trim()),
    plugin: pluginId,
  });
}

async function loadManifestCommands(
  root: string,
  pname: string,
  pluginId: string,
  manifest: PluginManifest,
  sub: Subst,
  out: LoadedPluginComponents,
): Promise<void> {
  const c = manifest.commands;
  if (!c) return;
  if (typeof c === "string" || Array.isArray(c)) {
    for (const rel of toList(c)) {
      const content = await readText(joinPath(root, rel));
      if (content.trim()) {
        out.commands.push({
          name: ns(pname, baseName(rel)),
          content: sub(content),
          plugin: pluginId,
        });
      }
    }
    return;
  }
  for (const [cname, meta] of Object.entries(c as Record<string, CommandMetadata>)) {
    let content = meta.content ?? "";
    if (!content && meta.source) content = await readText(joinPath(root, meta.source));
    if (!content.trim()) continue;
    out.commands.push({
      name: ns(pname, cname),
      content: sub(content),
      plugin: pluginId,
      description: meta.description,
      argumentHint: meta.argumentHint,
      model: meta.model,
      allowedTools: meta.allowedTools,
    });
  }
}

/** Where Claude-format plugins keep these when the manifest doesn't say. */
const DEFAULT_HOOKS_FILE = "hooks/hooks.json";
const DEFAULT_MCP_FILE = ".mcp.json";

function listOf<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

interface ConfigSource {
  value: unknown;
  file: string;
  /** From plugin.json itself, already validated with it. */
  inline: boolean;
}

/**
 * The inline configs and the files a manifest field points to, plus the default file when it
 * exists, each file read once. A path that leaves the plugin's folder is reported and skipped.
 */
async function configSources(
  root: string,
  field: (string | object)[],
  defaultFile: string,
  pluginId: string,
  errors: ConfigError[],
): Promise<ConfigSource[]> {
  const out: ConfigSource[] = [];
  const seen = new Set<string>();
  const readFile = async (rel: string, required: boolean) => {
    const safe = safeRelativePath(rel);
    if (safe === null || !safe) {
      errors.push({ file: `${pluginId}/plugin.json`, path: "", message: `Path outside the plugin's folder: ${rel}` });
      return;
    }
    if (seen.has(safe)) return;
    seen.add(safe);
    const raw = await readText(joinPath(root, safe));
    const file = `${pluginId}/${safe}`;
    if (!raw.trim()) {
      if (required) errors.push({ file, path: "", message: "File not found or empty." });
      return;
    }
    try {
      out.push({ value: JSON.parse(raw), file, inline: false });
    } catch {
      errors.push({ file, path: "", message: "Not valid JSON." });
    }
  };
  await readFile(defaultFile, false);
  for (const item of field) {
    if (typeof item === "string") await readFile(item, true);
    else out.push({ value: item, file: `${pluginId}/plugin.json`, inline: true });
  }
  return out;
}

/** A hooks file's `modules`: the one hooks module of a mod, relative to that file. */
export function modEntryOf(value: unknown, file: string, pluginId: string, inline: boolean): string | null {
  const modules = (value as { modules?: unknown } | null)?.modules;
  if (!Array.isArray(modules) || typeof modules[0] !== "string") return null;
  const rel = inline ? "" : file.slice(pluginId.length + 1);
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
  return safeRelativePath(`${dir}${modules[0].replace(/^\.\//, "")}`) || null;
}

async function loadHooks(
  root: string,
  pluginId: string,
  pname: string,
  manifest: PluginManifest,
  sub: <T>(v: T) => T,
  options: Record<string, unknown>,
  out: LoadedPluginComponents,
): Promise<void> {
  for (const { value, file, inline } of await configSources(root, listOf(manifest.hooks), DEFAULT_HOOKS_FILE, pluginId, out.errors)) {
    const v = value as Record<string, unknown>;
    // A mod: its hooks are functions in a module, not commands.
    if ("modules" in v) {
      const entry = modEntryOf(v, file, pluginId, inline);
      if (entry) out.mods.push({ plugin: pname, root, entry, options, source: "installed" });
      else out.errors.push({ file, path: "modules", message: "Expected one path to a hooks module inside the plugin." });
      continue;
    }
    // Inline hooks were already checked when the manifest was parsed.
    const map = inline ? (v as Record<string, HookMatcher[]>) : salvageHooksMap(v.hooks ?? v, file, out.errors);
    for (const [event, matchers] of Object.entries(map ?? {})) {
      (out.hooks[event as HookEvent] ??= []).push(...matchers.map((m) => sub(m) as HookMatcher));
    }
  }
}

/** Stdio servers also get the folder as an environment variable, as Claude Code does. */
function withPluginRoot(server: McpServerConfig, root: string): McpServerConfig {
  if (!("command" in server)) return server;
  return { ...server, env: { CLAUDE_PLUGIN_ROOT: root, ...server.env } };
}

async function loadMcpServers(
  root: string,
  pname: string,
  pluginId: string,
  manifest: PluginManifest,
  sub: <T>(v: T) => T,
  out: LoadedPluginComponents,
): Promise<void> {
  for (const { value, file, inline } of await configSources(root, listOf(manifest.mcpServers), DEFAULT_MCP_FILE, pluginId, out.errors)) {
    const v = value as Record<string, unknown>;
    // `.mcp.json` comes both as { mcpServers: {...} } and as the bare map.
    const map = inline ? (v as Record<string, McpServerConfig>) : parseMcpMap(v.mcpServers ?? v, file, out.errors);
    for (const [name, server] of Object.entries(map ?? {})) {
      out.mcpServers[ns(pname, name)] = withPluginRoot(sub(server), root);
    }
  }
}

function parseMcpMap(value: unknown, file: string, errors: ConfigError[]): Record<string, McpServerConfig> {
  const parsed = parsePluginManifest({ mcpServers: value }, file);
  errors.push(...parsed.errors);
  const map = parsed.manifest?.mcpServers;
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
}

/** An empty set of components, to load one plugin into (its page lists what it adds). */
export function emptyComponents(): LoadedPluginComponents {
  return { plugins: [], commands: [], agents: [], outputStyles: [], hooks: {}, mcpServers: {}, mods: [], errors: [] };
}

export async function loadOne(p: InstalledPlugin, out: LoadedPluginComponents): Promise<void> {
  const root = p.installLocation;
  const manifest = await readManifest(root, p.plugin, `${p.id}/plugin.json`, out.errors);
  const pname = manifest.name || p.plugin;
  const cfg = await getPluginConfig(p.id, manifest);
  const sub: Subst = (text) => substituteUserConfig(text, cfg, root);
  const subDeep = <T,>(value: T): T => substituteDeep(value, cfg, root);

  out.plugins.push({
    name: pname,
    id: p.id,
    marketplace: p.marketplace,
    manifest,
    path: root,
    source: "marketplace",
    enabled: true,
    sha: p.sha,
  });

  for (const f of await mdFiles(root, "commands")) {
    const content = await readText(joinPath(root, "commands", f));
    if (content.trim()) {
      out.commands.push({
        name: ns(pname, baseName(f)),
        content: sub(content),
        plugin: p.id,
      });
    }
  }
  await loadManifestCommands(root, pname, p.id, manifest, sub, out);

  const agentRels = [
    ...(await mdFiles(root, "agents")).map((f) => `agents/${f}`),
    ...toList(manifest.agents),
  ];
  for (const rel of agentRels) {
    const content = await readText(joinPath(root, rel));
    if (!content.trim()) continue;
    const { fm, body } = parseFrontmatter(sub(content));
    out.agents.push({
      name: ns(pname, fm.name || baseName(rel)),
      content: body.trim() || content,
      plugin: p.id,
      description: fm.description || undefined,
      whenToUse: fm.when_to_use || fm["when-to-use"] || fm.whentouse || undefined,
      tools: fm.tools ? fm.tools.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : undefined,
      model: fm.model || undefined,
    });
  }

  const styleRels = [
    ...(await mdFiles(root, "output-styles")).map((f) => `output-styles/${f}`),
    ...toList(manifest.outputStyles),
  ];
  for (const rel of styleRels) {
    const content = await readText(joinPath(root, rel));
    pushStyle(out, pname, p.id, baseName(rel), content, sub);
  }

  await loadHooks(root, p.id, pname, manifest, subDeep, cfg as Record<string, unknown>, out);
  await loadMcpServers(root, pname, p.id, manifest, subDeep, out);
}

export async function loadPluginComponents(): Promise<LoadedPluginComponents> {
  if (!isTauri) return EMPTY;

  const [installed, enabledIds] = await Promise.all([listInstalled(), getEnabledPlugins()]);
  const enabledSet = new Set(enabledIds);
  const enabled = installed.filter((p) => enabledSet.has(p.id));

  const sig = enabled.map((p) => `${p.id}@${p.installLocation}`).sort().join("|");
  if (cache && cache.sig === sig) return cache.data;

  const out = emptyComponents();

  for (const p of enabled) {
    try {
      await loadOne(p, out);
    } catch (e) {
      out.errors.push({
        file: p.id,
        path: "",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  cache = { sig, data: out };
  return out;
}

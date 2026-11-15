import { invoke } from "@/lib/ipc";
import { userSettingsFile, projectSettingsFile, projectLocalSettingsFile } from "@/lib/paths";
import { getProjectConfig, loadGlobalConfig, trustWorkspace } from "@/lib/globalConfig";
import { isWriteBlocked, readJsonFile, writeJsonFile } from "@/lib/safeJsonFile";
import type { PermissionMode } from "@/components/ui/claude-style-chat-input";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type SettingsSource = "user" | "project" | "local";

export const SOURCE_PRECEDENCE: SettingsSource[] = ["user", "project", "local"];

export interface NyxsSettings {
  permissionMode?: PermissionMode;
  outputStyle?: string;
  model?: string;
  env?: Record<string, string>;
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    skipByDefault?: boolean;
  };
  memory?: {
    paths?: string[];
  };
  [key: string]: unknown;
}

export const PROJECT_FORBIDDEN_KEYS: readonly string[] = [
  "permissions.skipByDefault",
  "memory.paths",
];

export const PROJECT_TRUST_GATED_KEYS: readonly string[] = [
  "permissions.allow",
  // The mode a new chat starts in (workspace.ts settingsDefaultMode).
  "permissions.defaultMode",
  "allowPermissionBypass",
  "allowComputerUse",
  // Its commands run after every Edit/Write (formatters.ts).
  "format",
  "hooks",
  "diagnostics.rules",
  "mcpServers",
  "env",
  "enabledPlugins",
  "marketplaces",
  "cleanupPeriodDays",
  // Loads the user's claude.ai connectors into a Claude Code run (claudeCode.ts).
  "claudeAiConnectors",
  // Turn on the built-in browser and the video editor for the agent when the user turned them off.
  "allowPreview",
  "allowVideoTools",
];

const UNTRUSTED_SOURCES: readonly SettingsSource[] = ["project", "local"];

/**
 * A project's own Claude Code config, which the `claude` CLI loads by itself when a chat runs on
 * Claude Code (hooks, statusLine and the helpers run shell commands; env can point it at another
 * server with the user's token). It only counts for trust: nothing of it is merged into Nyxs'
 * settings, and an untrusted folder's runs start without it (`untrustedProject` in claudeCode.ts).
 */
export type ClaudeConfigSource = "claudeProject" | "claudeLocal" | "mcpJson";

const CLAUDE_CONFIG_FILES: Record<ClaudeConfigSource, string> = {
  claudeProject: ".claude/settings.json",
  claudeLocal: ".claude/settings.local.json",
  mcpJson: ".mcp.json",
};

const CLAUDE_CONFIG_SOURCES = Object.keys(CLAUDE_CONFIG_FILES) as ClaudeConfigSource[];

const isClaudeSource = (source: string): source is ClaudeConfigSource => Object.hasOwn(CLAUDE_CONFIG_FILES, source);

export const CLAUDE_TRUST_GATED_KEYS: readonly string[] = [
  "hooks",
  "permissions.allow",
  "permissions.defaultMode",
  "env",
  "apiKeyHelper",
  "statusLine",
  "otelHeadersHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "enabledPlugins",
  "extraKnownMarketplaces",
];

const MCP_JSON_GATED_KEYS: readonly string[] = ["mcpServers"];

export type ProjectLayers = Partial<Record<SettingsSource, NyxsSettings>>;

/** A folder's files as read: Nyxs' layers and the Claude Code config that only counts for trust. */
export type TrustLayers = Partial<Record<SettingsSource | ClaudeConfigSource, NyxsSettings>>;

export interface TrustFinding {
  key: string;
  detail: string;
}

export interface ProjectTrustState {
  workspace: string;
  digest: string;
  status: "trusted" | "untrusted" | "changed";
  findings: TrustFinding[];
}

let rawPerSource: TrustLayers = {};
let perSource: ProjectLayers = {};
let mergedCache: NyxsSettings | null = null;
let loaded = false;
let workspace: string | null = null;
let trustState: ProjectTrustState | null = null;
let projectTrusted = true;
const mtimes = new Map<string, number | null>();
let generation = 0;

const listeners = new Set<() => void>();

/** Every file a folder's settings and trust are read from. */
const READ_SOURCES: readonly (SettingsSource | ClaudeConfigSource)[] = [...SOURCE_PRECEDENCE, ...CLAUDE_CONFIG_SOURCES];
const PROJECT_READ_SOURCES: readonly (SettingsSource | ClaudeConfigSource)[] = [...UNTRUSTED_SOURCES, ...CLAUDE_CONFIG_SOURCES];

async function pathForSource(source: SettingsSource | ClaudeConfigSource, ws: string | null = workspace): Promise<string | null> {
  if (source === "user") return userSettingsFile();
  if (!ws) return null;
  if (source === "local") return projectLocalSettingsFile(ws);
  if (source === "project") return projectSettingsFile(ws);
  return `${ws.replace(/[\\/]+$/, "")}/${CLAUDE_CONFIG_FILES[source]}`;
}

/** A settings layer as read: `null` when there's none, `"unreadable"` when the file is there but
 *  couldn't be read or parsed (it's then blocked from being saved over; see safeJsonFile). */
async function readSettingsFile(path: string, source: SettingsSource | ClaudeConfigSource): Promise<NyxsSettings | null | "unreadable"> {
  // The user's file lives in ~/.nyxs, so a copy of it there is fine; a project's isn't.
  const read = await readJsonFile<NyxsSettings>(path, { backup: source === "user" });
  if (read.status === "unreadable") return "unreadable";
  if (read.status === "missing") return null;
  return isPlainObject(read.value) ? read.value : {};
}

async function fileMtime(path: string): Promise<number | null> {
  try {
    const ms = await invoke<number | null>("agent_file_mtime", { path });
    return ms ?? null;
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T extends Record<string, unknown>>(a: T, b: T): T {
  const out: Record<string, unknown> = { ...a };
  for (const key of Object.keys(b)) {
    const bv = b[key];
    const av = out[key];
    if (isPlainObject(av) && isPlainObject(bv)) {
      out[key] = deepMerge(av, bv);
    } else {
      out[key] = bv;
    }
  }
  return out as T;
}

function dedupe(arr: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of arr) {
    const key =
      item !== null && typeof item === "object"
        ? `o:${JSON.stringify(item)}`
        : `${typeof item}:${String(item)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function mergeLayers(a: unknown, b: unknown): unknown {
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) delete out[k];
      else if (k in out) out[k] = mergeLayers(out[k], v);
      else out[k] = v;
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) return dedupe([...a, ...b]);
  return b === undefined ? a : b;
}

function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function stripPath(obj: Record<string, unknown>, dotted: string): void {
  const parts = dotted.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (!isPlainObject(next)) return;
    cur = next;
  }
  delete cur[parts[parts.length - 1]];
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

export function sanitizeUntrustedLayer(layer: NyxsSettings, trusted: boolean): NyxsSettings {
  const clone = structuredClone(layer);
  for (const key of PROJECT_FORBIDDEN_KEYS) stripPath(clone, key);
  if (!trusted) for (const key of PROJECT_TRUST_GATED_KEYS) stripPath(clone, key);
  return clone;
}

export function pickGatedSettings(
  layer: NyxsSettings | undefined,
  keys: readonly string[] = PROJECT_TRUST_GATED_KEYS,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!layer) return out;
  for (const key of keys) {
    const v = getPath(layer, key);
    if (!isEmptyValue(v)) out[key] = v;
  }
  return out;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Each untrusted file's gated values, by source; files with none are left out, so a folder
 *  without Claude Code config digests exactly as it did before that config counted. */
function gatedBySource(layers: TrustLayers): [SettingsSource | ClaudeConfigSource, Record<string, unknown>][] {
  const out: [SettingsSource | ClaudeConfigSource, Record<string, unknown>][] = [];
  for (const source of PROJECT_READ_SOURCES) {
    const keys = source === "mcpJson" ? MCP_JSON_GATED_KEYS : isClaudeSource(source) ? CLAUDE_TRUST_GATED_KEYS : PROJECT_TRUST_GATED_KEYS;
    const picked = pickGatedSettings(layers[source], keys);
    if (Object.keys(picked).length) out.push([source, picked]);
  }
  return out;
}

export async function digestGatedSettings(layers: TrustLayers): Promise<string> {
  const gated = Object.fromEntries(gatedBySource(layers));
  if (!Object.keys(gated).length) return "";
  return sha256Hex(stableStringify(gated));
}

function short(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function describeGatedValue(key: string, value: unknown): string[] {
  if (key === "hooks" && isPlainObject(value)) {
    const out: string[] = [];
    for (const [event, matchers] of Object.entries(value)) {
      for (const m of Array.isArray(matchers) ? matchers : []) {
        const hooks = isPlainObject(m) && Array.isArray(m.hooks) ? m.hooks : [];
        for (const h of hooks) {
          if (isPlainObject(h) && typeof h.command === "string") out.push(`${event}: ${short(h.command)}`);
          // Claude Code's hooks can also post to a URL.
          else if (isPlainObject(h) && typeof h.url === "string") out.push(`${event}: ${short(h.url)}`);
        }
      }
    }
    return out.length ? out : [short(JSON.stringify(value))];
  }
  const describeRules = (rules: unknown[]) =>
    rules.map((r) =>
      isPlainObject(r) && typeof r.command === "string" ? `${String(r.match ?? "*")} → ${short(r.command)}` : short(JSON.stringify(r)),
    );
  if (key === "diagnostics.rules" && Array.isArray(value)) return describeRules(value);
  // One row per formatter rule; turned on with only the built-in ones, it reads "true".
  if (key === "format" && isPlainObject(value)) {
    if (Array.isArray(value.rules) && value.rules.length) return describeRules(value.rules);
    if (value.enabled === true) return ["true"];
  }
  if (key === "mcpServers" && isPlainObject(value)) {
    return Object.entries(value).map(([name, cfg]) => {
      const target = isPlainObject(cfg) ? (cfg.url ?? [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].filter(Boolean).join(" ")) : "";
      return target ? `${name}: ${short(String(target))}` : name;
    });
  }
  if (key === "env" && isPlainObject(value)) return Object.keys(value).map((k) => `${k}=…`);
  if (key === "statusLine" && isPlainObject(value) && typeof value.command === "string") return [short(value.command)];
  if (Array.isArray(value)) return value.map((v) => short(typeof v === "string" ? v : JSON.stringify(v)));
  return [short(typeof value === "string" ? value : JSON.stringify(value))];
}

export function describeGatedSettings(layers: TrustLayers): TrustFinding[] {
  const findings: TrustFinding[] = [];
  const seen = new Set<string>();
  for (const [source, picked] of gatedBySource(layers)) {
    // Claude Code's files are named, so they aren't taken for Nyxs' own settings.
    const file = isClaudeSource(source) ? CLAUDE_CONFIG_FILES[source] : null;
    for (const [name, value] of Object.entries(picked)) {
      const key = file ? `${file} · ${name}` : name;
      for (const detail of describeGatedValue(name, value)) {
        const id = `${key}\u0000${detail}`;
        if (seen.has(id)) continue;
        seen.add(id);
        findings.push({ key, detail });
      }
    }
  }
  return findings;
}

async function evaluateTrust(
  ws: string | null,
  layers: TrustLayers,
): Promise<{ trusted: boolean; state: ProjectTrustState | null }> {
  if (!ws) return { trusted: true, state: null };
  const digest = await digestGatedSettings(layers);
  if (!digest) return { trusted: true, state: null };
  const findings = describeGatedSettings(layers);
  const cfg: { trusted?: boolean; trustedSettingsHash?: string } = await getProjectConfig(ws).catch(() => ({}));
  if (cfg.trusted === true && cfg.trustedSettingsHash === digest) {
    return { trusted: true, state: { workspace: ws, digest, status: "trusted", findings } };
  }
  const status = cfg.trusted === true && typeof cfg.trustedSettingsHash === "string" ? "changed" : "untrusted";
  return { trusted: false, state: { workspace: ws, digest, status, findings } };
}

/** The settings one folder's turns run with: the merged value and each layer as applied (a
 *  project's untrusted keys stripped). */
export interface FolderSettings {
  merged: NyxsSettings;
  perSource: ProjectLayers;
  /** Whether the folder's project config, Nyxs' and Claude Code's, may apply: false while it
   *  has gated values the user hasn't trusted, or while it isn't known yet. */
  projectTrusted: boolean;
}

function effectiveSettings(raw: TrustLayers, trusted: boolean): FolderSettings {
  const effective: ProjectLayers = {};
  let merged: NyxsSettings = {};
  for (const source of SOURCE_PRECEDENCE) {
    const layer = raw[source];
    if (!layer) continue;
    const safe = UNTRUSTED_SOURCES.includes(source) ? sanitizeUntrustedLayer(layer, trusted) : layer;
    effective[source] = safe;
    merged = mergeLayers(merged, safe) as NyxsSettings;
  }
  return { merged, perSource: effective, projectTrusted: trusted };
}

function recomputeMerged(): NyxsSettings {
  const { merged, perSource: effective } = effectiveSettings(rawPerSource, projectTrusted);
  perSource = effective;
  mergedCache = merged;
  return merged;
}

async function allowUiAccess(ws: string | null): Promise<void> {
  if (!ws) return;
  try {
    await invoke("agent_allow_ui_path", { path: ws });
  } catch {
    return;
  }
}

async function readProjectLayers(ws: string): Promise<TrustLayers> {
  const layers: TrustLayers = {};
  if (!isTauri) return layers;
  await allowUiAccess(ws);
  await Promise.all(
    PROJECT_READ_SOURCES.map(async (source) => {
      const path = await pathForSource(source, ws);
      const data = path ? await readSettingsFile(path, source) : null;
      if (data && data !== "unreadable") layers[source] = data;
    }),
  );
  return layers;
}

export async function inspectProjectSettings(ws: string): Promise<{ digest: string; findings: TrustFinding[] }> {
  const layers = await readProjectLayers(ws);
  return { digest: await digestGatedSettings(layers), findings: describeGatedSettings(layers) };
}

async function loadAllSources(): Promise<void> {
  if (!isTauri) {
    rawPerSource = {};
    trustState = null;
    projectTrusted = true;
    loaded = true;
    recomputeMerged();
    return;
  }
  const gen = generation;
  const ws = workspace;
  const next: TrustLayers = {};
  const nextMtimes = new Map<string, number | null>();
  await allowUiAccess(ws);
  await Promise.all(
    READ_SOURCES.map(async (source) => {
      const path = await pathForSource(source, ws);
      if (!path) return;
      const data = await readSettingsFile(path, source);
      if (data && data !== "unreadable") next[source] = data;
      nextMtimes.set(path, await fileMtime(path));
    }),
  );
  const trust = await evaluateTrust(ws, next);
  if (gen !== generation) return;
  rawPerSource = next;
  trustState = trust.state;
  projectTrusted = trust.trusted;
  mtimes.clear();
  for (const [k, v] of nextMtimes) mtimes.set(k, v);
  loaded = true;
  recomputeMerged();
}

let loadingPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadingPromise) {
    loadingPromise = loadAllSources().finally(() => {
      loadingPromise = null;
    });
  }
  await loadingPromise;
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

export function resetSettingsCache(): void {
  generation++;
  rawPerSource = {};
  perSource = {};
  mergedCache = null;
  trustState = null;
  projectTrusted = true;
  loaded = false;
  mtimes.clear();
  folderCache.clear();
  const load: Promise<void> = loadAllSources().finally(() => {
    if (loadingPromise === load) loadingPromise = null;
  });
  // Shared with ensureLoaded, which used to start a second read of every file meanwhile.
  loadingPromise = load;
  void load.then(notify);
}

export function setSettingsWorkspace(next: string | null): void {
  if (next === workspace) return;
  // A turn still running in the folder being left keeps its settings without reading them again.
  const leaving = loaded ? { key: folderKey(workspace), settings: openFolderSettings() } : null;
  const user = rawPerSource.user;
  workspace = next;
  resetSettingsCache();
  if (leaving) folderCache.set(leaving.key, { settings: leaving.settings, at: Date.now() });
  // The user's layer is the same in every folder: its deny rules stay on while the new folder's
  // layers load (seconds on an ssh:// project), instead of no settings at all.
  if (user) {
    rawPerSource = { user };
    recomputeMerged();
  }
}

/** One spelling per folder: `\` as `/`, no trailing slash, and case-insensitive for a Windows
 *  path (an ssh:// one keeps its case). */
function folderKey(ws: string | null): string {
  if (!ws) return "";
  const k = ws.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(k) ? k.toLowerCase() : k;
}

const sameFolder = (a: string | null, b: string | null) => folderKey(a) === folderKey(b);

function openFolderSettings(): FolderSettings {
  // Until the folder's files are read its trust isn't known, so it doesn't count as trusted.
  return { merged: mergedCache ?? recomputeMerged(), perSource, projectTrusted: loaded ? projectTrusted : workspace === null };
}

// Other folders' settings, for turns running outside the open folder. As fresh as the open
// folder's poll; cleared when the user's layer or a trust decision changes.
const folderCache = new Map<string, { settings: FolderSettings; at: number }>();
const folderLoads = new Map<string, Promise<FolderSettings>>();
/** The project a folder's settings come from: itself, or the main checkout of a git worktree. */
const folderProjects = new Map<string, Promise<string>>();

/**
 * The settings a turn working in `ws` runs with: the user's layer and that folder's project
 * layers, trusted or not as that project is. `undefined` means the open folder. A git worktree
 * (a session's own) gets its project's settings and trust.
 */
export async function settingsFor(ws: string | null | undefined): Promise<FolderSettings> {
  await ensureLoaded();
  if (ws === undefined || sameFolder(ws, workspace)) return openFolderSettings();
  const key = folderKey(ws);
  const hit = folderCache.get(key);
  if (hit && Date.now() - hit.at < POLL_MS) return hit.settings;
  let load = folderLoads.get(key);
  if (!load) {
    load = loadFolderSettings(ws).finally(() => folderLoads.delete(key));
    folderLoads.set(key, load);
  }
  return load;
}

/** {@link settingsFor} without waiting: what's known now (never nothing: the user's layer at
 *  least), refreshed in the background when it's old. */
export function settingsSnapshotFor(ws: string | null | undefined): FolderSettings {
  if (ws === undefined || sameFolder(ws, workspace)) {
    if (!loaded) void ensureLoaded().then(notify);
    return openFolderSettings();
  }
  const hit = folderCache.get(folderKey(ws));
  if (!hit || Date.now() - hit.at >= POLL_MS) void settingsFor(ws).catch(() => undefined);
  return hit?.settings ?? { ...effectiveSettings(rawPerSource.user ? { user: rawPerSource.user } : {}, true), projectTrusted: ws === null };
}

/** Whether {@link settingsSnapshotFor} already has that folder's own settings, not a stand-in. */
export function settingsKnownFor(ws: string | null | undefined): boolean {
  if (ws === undefined || sameFolder(ws, workspace)) return loaded;
  return folderCache.has(folderKey(ws));
}

async function loadFolderSettings(ws: string | null): Promise<FolderSettings> {
  const project = ws ? await projectOfFolder(ws) : null;
  if (project !== null && sameFolder(project, workspace)) return openFolderSettings();
  const layers: TrustLayers = {
    ...(rawPerSource.user ? { user: rawPerSource.user } : {}),
    ...(project ? await readProjectLayers(project) : {}),
  };
  const trust = await evaluateTrust(project, layers);
  const settings = effectiveSettings(layers, trust.trusted);
  if (ws !== null) folderCache.set(folderKey(ws), { settings, at: Date.now() });
  return settings;
}

function projectOfFolder(ws: string): Promise<string> {
  const key = folderKey(ws);
  let found = folderProjects.get(key);
  if (!found) {
    found = findProject(ws);
    folderProjects.set(key, found);
  }
  return found;
}

/** A git worktree's `.git` is a file pointing into its main checkout's `.git/worktrees/`: its
 *  project is that checkout, spelled as the trust decisions in nyxs.json spell it. */
async function findProject(ws: string): Promise<string> {
  await allowUiAccess(ws);
  const dotGit = await invoke<string | null>("agent_read_text", { path: `${ws.replace(/[\\/]+$/, "")}/.git` }).catch(() => null);
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(dotGit ?? "")?.[1];
  const main = gitdir ? /^(.*?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdir)?.[1] : undefined;
  if (!main) return ws;
  // On a remote machine the pointer is a path there: keep the ssh://host in front.
  const host = /^ssh:\/\/[^/]+/.exec(ws)?.[0];
  const project = host && !main.startsWith("ssh://") ? `${host}${main.startsWith("/") ? "" : "/"}${main}` : main;
  const known = [workspace, ...Object.keys((await loadGlobalConfig().catch(() => null))?.projects ?? {})];
  return known.find((k) => k !== null && sameFolder(k, project)) ?? project;
}

export async function getMergedSettings(): Promise<NyxsSettings> {
  await ensureLoaded();
  return mergedCache ?? recomputeMerged();
}

export async function getSettingsForSource(
  source: SettingsSource,
): Promise<NyxsSettings> {
  await ensureLoaded();
  return rawPerSource[source] ?? {};
}

/** Whether that layer's file is there but couldn't be read, so it can't be saved this run. */
export async function isSettingsSourceUnreadable(source: SettingsSource): Promise<boolean> {
  await ensureLoaded();
  const path = await pathForSource(source);
  return path !== null && isWriteBlocked(path);
}

export function getPerSourceSnapshot(): ProjectLayers {
  return perSource;
}

/** The open folder's settings now. While a folder loads, the user's layer (kept from the folder
 *  before) rather than none. */
export function getMergedSnapshot(): NyxsSettings {
  if (!loaded) void ensureLoaded().then(notify);
  return mergedCache ?? EMPTY;
}

export function getProjectTrustSnapshot(): ProjectTrustState | null {
  return trustState;
}

export async function trustProjectSettings(ws: string, digest: string): Promise<void> {
  await trustWorkspace(ws, digest);
  folderCache.clear();
  if (ws !== workspace) return;
  const gen = generation;
  const trust = await evaluateTrust(ws, rawPerSource);
  if (gen !== generation) return;
  trustState = trust.state;
  projectTrusted = trust.trusted;
  recomputeMerged();
  notify();
}

const EMPTY: NyxsSettings = {};

export async function updateSettingsForSource(
  source: SettingsSource,
  partial: Partial<NyxsSettings>,
): Promise<NyxsSettings> {
  await ensureLoaded();
  const path = await pathForSource(source);
  if (!path) {
    throw new Error(
      `No se puede escribir settings de '${source}': no hay carpeta de trabajo abierta.`,
    );
  }
  const current = rawPerSource[source] ?? {};
  const updated = deepMerge(current as NyxsSettings, partial as NyxsSettings);
  const wasTrusted = projectTrusted;
  if (isTauri) {
    // Throws, before anything changes in memory, when the file couldn't be read.
    await writeJsonFile(path, updated);
    mtimes.set(path, await fileMtime(path));
  }
  rawPerSource = { ...rawPerSource, [source]: updated };
  folderCache.clear();
  if (UNTRUSTED_SOURCES.includes(source) && workspace) {
    const digest = await digestGatedSettings(rawPerSource);
    if (wasTrusted && digest) await trustWorkspace(workspace, digest);
    const trust = await evaluateTrust(workspace, rawPerSource);
    trustState = trust.state;
    projectTrusted = trust.trusted;
  }
  recomputeMerged();
  notify();
  return updated;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollPaused = false;
const POLL_MS = 10_000;

export function setSettingsPollPaused(paused: boolean): void {
  pollPaused = paused;
}

export async function pollForChanges(): Promise<void> {
  if (!isTauri || !loaded || pollPaused) return;
  const gen = generation;
  const ws = workspace;
  const next: TrustLayers = { ...rawPerSource };
  let changed = false;
  // Claude Code's files too: a hook added to .claude/settings.json asks for trust again.
  for (const source of READ_SOURCES) {
    const path = await pathForSource(source, ws);
    if (!path) continue;
    const now = await fileMtime(path);
    const prev = mtimes.get(path);
    if (prev !== now) {
      mtimes.set(path, now);
      const data = await readSettingsFile(path, source);
      // A file saved mid-edit with a typo keeps its last good layer (its deny rules, hooks)
      // instead of dropping it until it's fixed.
      if (data === "unreadable") continue;
      if (data) next[source] = data;
      else delete next[source];
      changed = true;
    }
  }
  if (!changed) return;
  const trust = await evaluateTrust(ws, next);
  if (gen !== generation) return;
  rawPerSource = next;
  folderCache.clear();
  trustState = trust.state;
  projectTrusted = trust.trusted;
  recomputeMerged();
  notify();
}

function startWatcher(): void {
  if (pollTimer || !isTauri) return;
  pollTimer = setInterval(() => void pollForChanges(), POLL_MS);
}

function stopWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  startWatcher();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopWatcher();
  };
}

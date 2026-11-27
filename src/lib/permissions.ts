import type { PermissionMode } from "@/components/ui/claude-style-chat-input";
import { getMergedSnapshot } from "./settingsRuntime";
import { classifyCommand, analyzeCommand, commandName, isAutoApprovableReadOnly, isCommandWrapper, normalizeCommandSegment } from "./bashSafety";
import { browserToolFor } from "./browserTools";
import { matchGlob } from "./diagnostics";
import { COMPUTER_LOOK_ACTIONS, isComputerTool } from "@/tools/Computer/actions";
import { autoApproveReadOnly } from "./featureSettings";
import { isProjectTool, sessionToolFor } from "./sessionTools";
import { videoCallReadOnly, videoToolFor } from "./videoTools";

export type PermissionBehavior = "allow" | "deny" | "ask";

export interface PermissionRule {
  toolName: string;
  ruleContent?: string;
  behavior: PermissionBehavior;
}

/** The Music tool under either name, built in or through MCP (tools/Music/tool.ts). Named here
 *  because that module pulls in the player, which this one has no need to load. */
function isMusicToolName(toolName: string): boolean {
  return toolName === "Music" || toolName === "mcp__nyxs-music__music";
}

/** How far each mode lets the agent go on its own, from plan (nothing changes) to skip. */
const MODE_REACH: Record<string, number> = { plan: 0, ask: 1, acceptEdits: 2, auto: 3, skip: 4 };

export const READ_ONLY_TOOLS =new Set(["Read", "Glob", "Grep", "ListDir", "BashOutput"]);
export const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
export const EXTERNAL_TOOLS = new Set(["WebFetch", "Skill"]);
const FILE_WRITE_TOOLS = new Set([...EDIT_TOOLS, "WritePdf"]);

const PROTECTED_CONFIG_RE = /(^|[\\/])\.nyxs[\\/]+settings(\.local)?\.json$/i;

export function isDangerousCommand(cmd: string): boolean {
  return classifyCommand(cmd).risk !== "safe";
}

export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

export function isProtectedConfigPath(path: string): boolean {
  return PROTECTED_CONFIG_RE.test(path.trim().replace(/[\\/]+$/, ""));
}

export function isProtectedConfigTarget(toolName: string, input: unknown): boolean {
  const key = permissionKey(toolName, input);
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const resolved = (input as { resolved_path?: unknown } | null)?.resolved_path;
    return isProtectedConfigPath(key) || (typeof resolved === "string" && isProtectedConfigPath(resolved));
  }
  if (toolName === "Bash") return /\.nyxs/i.test(key) && /settings(\.local)?\.json/i.test(key);
  return false;
}

/** A URL to fetch, with a scheme: http stays only for this computer and the local network (a
 *  dev server on http://localhost:5173 has no https), and turns into https everywhere else. */
export function normalizeFetchUrl(url: string): string {
  const target = url.trim();
  const local = isPrivateNetworkUrl(target);
  if (/^http:\/\//i.test(target)) return local ? target : "https://" + target.slice("http://".length);
  if (!/^https?:\/\//i.test(target)) return (local ? "http://" : "https://") + target;
  return target;
}

function canonicalFetchKey(url: string): string {
  const normalized = normalizeFetchUrl(url);
  try {
    return new URL(normalized).href;
  } catch {
    return normalized;
  }
}

export function isPrivateNetworkUrl(url: string): boolean {
  let host: string;
  try {
    const target = url.trim();
    host = new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return true;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "::" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return !host.includes(".");
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function permissionKey(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "Bash":
    case "Monitor":
      return String(i.command ?? "");
    case "KillShell":
    case "BashOutput":
      return String(i.shell_id ?? "");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "WritePdf":
      return String(i.file_path ?? "");
    case "ListDir":
      return String(i.path ?? "");
    case "Glob":
    case "Grep":
      return String(i.pattern ?? "");
    case "Skill":
      return String(i.skill ?? "").trim().replace(/^\//, "");
    case "WebFetch":
      return i.url ? canonicalFetchKey(String(i.url)) : "";
    case "RequestPermission":
      return String(i.summary ?? "");
    default:
      return isComputerTool(toolName) ? String(i.action ?? "") : "";
  }
}

function contentMatches(pattern: string, key: string, rejectChaining: boolean): boolean {
  const wordPrefix = pattern.endsWith(":*");
  const prefix = wordPrefix ? pattern.slice(0, -2) : pattern.endsWith("*") ? pattern.slice(0, -1) : null;
  if (prefix === null) return key === pattern;
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  if (wordPrefix && rest && !/^\s/.test(rest)) return false;
  return !rejectChaining || !CHAINING.test(rest);
}

function bashSegments(command: string): string[] {
  return command
    .split(/;|&&|\|\||\||\r?\n|`|\$\(/)
    .map((s) => s.replace(/^[\s()]+|[\s()]+$/g, ""))
    .filter(Boolean);
}

function toolNameMatches(pattern: string, toolName: string): boolean {
  if (pattern === "*" || pattern === toolName) return true;
  return pattern.length > 1 && pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1));
}

/** Tools whose rule content is a file path (Glob and Grep check their folder as `Read`). */
const PATH_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "WritePdf", "ListDir"]);

const DOTDOT = /(^|[\\/])\.\.([\\/]|$)/;

/** A path with `/` separators and no `.` or `..` segments. */
function cleanPath(p: string): string {
  const s = p.trim().replace(/\\/g, "/");
  const root = /^[a-z]:\//i.exec(s)?.[0] ?? (s.startsWith("//") ? "//" : s.startsWith("/") ? "/" : "");
  const out: string[] = [];
  for (const seg of s.slice(root.length).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg !== "..") out.push(seg);
    else if (out.length && out[out.length - 1] !== "..") out.pop();
    else if (!root) out.push("..");
  }
  return root + out.join("/");
}

const isAbsolutePath = (p: string) => /^[a-z]:\//i.test(p) || p.startsWith("/");

/** Whether a path rule covers the file a tool works on. The tools pass the path as the model
 *  wrote it, where it resolves and where that is in the project (resolved_path, project_path),
 *  so `./src/x.ts`, `E:\ws\src\x.ts` and `src/x.ts` are one file; letter case doesn't count on
 *  Windows. A pattern is a glob with `**`; one without `/` matches a name at any depth, as in
 *  .gitignore. For a folder (`directory`), a rule covering what is inside it covers it too. */
function pathRuleMatches(pattern: string, input: unknown): boolean {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const raw = str(i.file_path) || str(i.path);
  const resolved = str(i.resolved_path);
  const fold = /^[a-z]:[\\/]|^\\\\/i.test(resolved || raw);
  const norm = (p: string) => (fold ? cleanPath(p).toLowerCase() : cleanPath(p));
  const pat = norm(pattern);
  const candidates = [raw, resolved, str(i.project_path)]
    .filter(Boolean)
    .map(norm)
    .filter((c) => isAbsolutePath(c) === isAbsolutePath(pat));
  return candidates.some((c) => matchGlob(pat, c) || (i.directory === true && matchGlob(pat, `${c}/\u0000`)));
}

function ruleMatches(rule: PermissionRule, toolName: string, key: string, input?: unknown): boolean {
  if (!toolNameMatches(rule.toolName, toolName)) return false;
  if (!rule.ruleContent) return true;
  if (PATH_TOOLS.has(toolName)) {
    if (pathRuleMatches(rule.ruleContent, input)) return true;
    // As written, `src/../x` would pass for something under src/.
    return !DOTDOT.test(key) && contentMatches(rule.ruleContent, key, false);
  }
  if (toolName !== "Bash") return contentMatches(rule.ruleContent, key, false);
  if (rule.behavior !== "allow") {
    // A rule that holds a command back covers it in any segment, and by its bare name too:
    // `curl:*` also stops `curl.exe`, `/usr/bin/curl`, `env A=1 curl` and `sudo -n curl`.
    const content = rule.ruleContent;
    const segments = bashSegments(key);
    return [key.trim(), ...segments, ...segments.map(normalizeCommandSegment)].some((seg) => contentMatches(content, seg, false));
  }
  return contentMatches(rule.ruleContent, key.trim(), true);
}

/** Whether a deny rule of the settings keeps the model from reading a file (input as the read
 *  tools give it to the gate). For what a search found, which goes back without asking anyone. */
export function isReadDenied(input: unknown, rules: PermissionRule[] = loadFileRules()): boolean {
  const key = permissionKey("Read", input);
  return rules.some((r) => r.behavior === "deny" && ruleMatches(r, "Read", key, input));
}

export function checkPermission(
  toolName: string,
  input: unknown,
  mode: PermissionMode,
  rules: PermissionRule[],
): PermissionBehavior {
  const key = permissionKey(toolName, input);

  for (const rule of rules) {
    if (rule.behavior === "deny" && ruleMatches(rule, toolName, key, input)) return "deny";
  }

  if (isProtectedConfigTarget(toolName, input)) return mode === "plan" && toolName !== "Bash" ? "deny" : "ask";

  if (toolName === "Bash" && mode !== "skip") {
    if (analyzeCommand(key).risk === "destructive") return "ask";
  }

  if (mode !== "skip") {
    for (const rule of rules) {
      if (rule.behavior === "ask" && ruleMatches(rule, toolName, key, input)) return mode === "plan" ? "deny" : "ask";
    }
  }

  for (const rule of rules) {
    if (rule.behavior === "allow" && ruleMatches(rule, toolName, key, input)) return "allow";
  }

  if (READ_ONLY_TOOLS.has(toolName)) return "allow";

  // Playing a song touches nothing, and asking first would defeat "put on some music".
  if (isMusicToolName(toolName)) return "allow";

  // The user's sessions, by either name: reading them is free, archiving one always asks, as in
  // Claude Code Desktop (an explicit "always allow" above still counts).
  const sessionTool = sessionToolFor(toolName);
  if (sessionTool?.readOnly) return "allow";
  // A project's coordination (threads, decisions, memory) never asks: each thread then works
  // under its own permission mode.
  if (isProjectTool(toolName)) return "allow";
  if (sessionTool?.name === "ArchiveSession") return mode === "plan" ? "deny" : "ask";
  // A message is a request the other session's agent carries out with that session's permissions:
  // when they reach further than this one's, the user decides.
  if (sessionTool?.name === "SendToSession" && mode !== "plan") {
    const target = (input as { target_mode?: unknown } | null)?.target_mode;
    if (typeof target === "string" && (MODE_REACH[target] ?? 0) > (MODE_REACH[mode] ?? 0)) return "ask";
  }

  // The built-in browser: looking at the page is free; acting on it follows the mode.
  const browser = browserToolFor(toolName);
  if (browser) {
    if (browser.readOnly) return "allow";
    return mode === "ask" || mode === "plan" ? "ask" : "allow";
  }

  // The video editor: reading it and moving around it is free; changing the project follows the
  // mode, and plan mode refuses it.
  const video = videoToolFor(toolName);
  if (video) {
    if (videoCallReadOnly(video, input)) return "allow";
    if (mode === "plan") return "deny";
    return mode === "ask" ? "ask" : "allow";
  }

  // The desktop: looking is free; moving the user's real mouse and keyboard asks unless the mode
  // already lets the agent act on its own.
  if (isComputerTool(toolName)) {
    if (COMPUTER_LOOK_ACTIONS.has(key)) return "allow";
    if (mode === "plan") return "deny";
    return mode === "skip" || mode === "auto" ? "allow" : "ask";
  }

  if (toolName === "RequestPermission") return mode === "ask" ? "ask" : "allow";

  if (EXTERNAL_TOOLS.has(toolName) || isMcpTool(toolName)) {
    if (mode === "skip") return "allow";
    if (mode !== "auto") return "ask";
    return toolName === "WebFetch" && isPrivateNetworkUrl(key) ? "ask" : "allow";
  }

  switch (mode) {
    case "skip":
      return "allow";
    case "plan":
      return toolName === "Bash" && isAutoApprovableReadOnly(key) ? "allow" : "deny";
    case "auto":
      if (EDIT_TOOLS.has(toolName)) return "allow";
      if (toolName === "Bash") return isDangerousCommand(key) ? "ask" : "allow";
      return "allow";
    case "acceptEdits":
      if (EDIT_TOOLS.has(toolName)) return "allow";
      if (toolName === "Bash" && autoApproveReadOnly() && isAutoApprovableReadOnly(key)) return "allow";
      return "ask";
    case "ask":
    default:
      return "ask";
  }
}

export function parseRuleString(value: string, behavior: PermissionBehavior): PermissionRule {
  const match = /^([^(]+)\((.*)\)$/.exec(value.trim());
  if (match) return { toolName: match[1].trim(), ruleContent: match[2], behavior };
  return { toolName: value.trim(), behavior };
}

/** The allow/ask/deny rules of `settings` (the open folder's by default), deny first. */
export function loadFileRules(settings: { permissions?: unknown } = getMergedSnapshot()): PermissionRule[] {
  const p = settings.permissions as { allow?: unknown; deny?: unknown; ask?: unknown } | undefined;
  const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  const [deny, allow, ask] = [list(p?.deny), list(p?.allow), list(p?.ask)];
  return [
    ...deny.map((s) => parseRuleString(s, "deny")),
    ...ask.map((s) => parseRuleString(s, "ask")),
    ...allow.map((s) => parseRuleString(s, "allow")),
  ];
}

export function describePermission(toolName: string, input: unknown): string {
  const key = permissionKey(toolName, input);
  if (toolName === "RequestPermission") return key || "El agente solicita permiso para continuar";
  if (toolName === "Bash") {
    const { risk, reason } = analyzeCommand(key);
    if (risk === "destructive") return `⚠ Comando destructivo${reason ? ` (${reason})` : ""} — ${key}`;
  }
  if (isMcpTool(toolName)) {
    const [, server, ...rest] = toolName.split("__");
    const args = JSON.stringify(input ?? {});
    return `${server} › ${rest.join("__")} (MCP): ${args.length > 300 ? `${args.slice(0, 300)}…` : args}`;
  }
  return key ? `${toolName}: ${key}` : toolName;
}

const CHAINING = /[;&|`<>\r\n]|\$\(/;
const SUBCOMMAND_BASES = new Set([
  "npm", "pnpm", "yarn", "bun", "cargo", "git", "go", "dotnet", "docker", "kubectl", "pip", "pip3", "uv", "deno", "gh",
]);
const NO_PREFIX_BASES = new Set([
  "python", "python3", "node", "deno", "tsx", "ts-node", "ruby", "perl", "php", "lua", "rscript",
  "bash", "sh", "zsh", "fish", "pwsh", "powershell", "cmd",
  "eval", "exec", "source", ".", "sudo", "doas", "runas", "iex", "invoke-expression", "npx", "bunx", "pnpx",
]);

export function formatRule(rule: PermissionRule): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}

export function suggestPrefixRule(toolName: string, input: unknown): PermissionRule | null {
  const key = permissionKey(toolName, input).trim();
  if (!key || isProtectedConfigTarget(toolName, input)) return null;
  if (toolName === "Skill") return { toolName, ruleContent: key, behavior: "allow" };
  if (toolName === "WebFetch") {
    try {
      return { toolName, ruleContent: `${new URL(key).origin}/*`, behavior: "allow" };
    } catch {
      return null;
    }
  }
  if (toolName === "Bash") {
    if (CHAINING.test(key)) return null;
    if (analyzeCommand(key).risk === "destructive") return null;
    const tokens = key.split(/\s+/);
    // A quoted or assigned first word makes no clean prefix, and a wrapper (`env`, `nohup`,
    // `time`…) would allow whatever runs after it.
    if (/["']/.test(tokens[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return null;
    const base = commandName(tokens[0]);
    if (NO_PREFIX_BASES.has(base) || isCommandWrapper(base)) return null;
    const second = tokens[1];
    const prefix = SUBCOMMAND_BASES.has(base) && second && !second.startsWith("-") ? `${tokens[0]} ${second}` : tokens[0];
    return { toolName, ruleContent: `${prefix}:*`, behavior: "allow" };
  }
  if (EDIT_TOOLS.has(toolName)) {
    const cut = Math.max(key.lastIndexOf("/"), key.lastIndexOf("\\"));
    if (cut <= 0) return null;
    return { toolName, ruleContent: `${key.slice(0, cut + 1)}*`, behavior: "allow" };
  }
  return null;
}

export function commandAnalysisFor(toolName: string, input: unknown) {
  if (toolName !== "Bash") return null;
  const key = permissionKey(toolName, input);
  return key ? analyzeCommand(key) : null;
}

import { invoke } from "@/lib/ipc";
import { parseRemote, remoteHostOf, remoteUri } from "@/lib/remote";
import { hostPlatform } from "@/tools/env";

/** One dev server from `.claude/launch.json`, the same file Claude Code uses:
 *  `{ "configurations": [{ name, runtimeExecutable, runtimeArgs | program, args, port, cwd, env,
 *  autoPort, url }] }`. `${workspaceFolder}` stands for the project folder in any string. */
export interface LaunchEntry {
  name: string;
  /** Shell command that starts it; null for an entry that only attaches to a running URL. */
  command: string | null;
  url: string;
  port: number | null;
  /** Folder to start it in, relative to the project (launch.json's `cwd`); null = the project. */
  cwd: string | null;
  /** The executable and its arguments, kept apart so a moved server's `--port` can be rewritten. */
  exe: string | null;
  args: string[];
  /** Runs on Windows, so its command line is written for PowerShell. */
  windows: boolean;
  /** Extra environment variables for the server. */
  env: Record<string, string>;
  /** What to do when its port is taken: true moves it, false fails, null decides (see devServerPort). */
  autoPort: boolean | null;
}

/** Desktop's default when an entry starts a server and names no port. */
const DEFAULT_PORT = 3000;

export const LAUNCH_FILE = ".claude/launch.json";

/** Drops // and /* *\/ comments outside strings, so a JSONC launch file still parses. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") { out += text[++i] ?? ""; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out;
}

const quote = (arg: string) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
const quotePosix = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);

/** The command line for the shell of the system it runs on. In PowerShell a quoted executable
 *  ("C:\Program Files\…") needs the call operator, or it reads as a string instead of running. */
function commandLine(exe: string, args: string[], windows: boolean): string {
  if (!windows) return [exe, ...args].map(quotePosix).join(" ");
  const first = quote(exe);
  return [first.startsWith('"') ? `& ${first}` : first, ...args.map(quote)].join(" ");
}

/** launch.json is often committed with this PC's path to a program. On a system that can't have
 *  that path, the same program by name: found on that machine's PATH. */
function exeFor(exe: string, windows: boolean): string {
  if (windows || !/^([a-zA-Z]:[\\/]|\\\\)/.test(exe)) return exe;
  return (exe.split(/[\\/]/).pop() ?? exe).replace(/\.(exe|cmd|bat)$/i, "");
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((a): a is string => typeof a === "string") : []);

/** `${workspaceFolder}` (VS Code's name, which launch.json uses) as the project folder. */
const expand = (s: string, workspace: string) =>
  workspace ? s.replace(/\$\{workspaceFolder\}/g, workspace.replace(/[\\/]+$/, "")) : s;

/** `windows`: whether it runs on Windows; by default, what the project's machine is known to be. */
export function parseLaunchConfig(text: string, workspace = "", windows = hostPlatform(workspace).os === "Windows"): LaunchEntry[] {
  // What runs on a remote machine gets its path there, not the app's `ssh://` name for it.
  const onMachine = parseRemote(workspace)?.path ?? workspace;
  let data: unknown;
  try {
    data = JSON.parse(stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return [];
  }
  const list = (data as { configurations?: unknown })?.configurations;
  if (!Array.isArray(list)) return [];
  const entries: LaunchEntry[] = [];
  for (const raw of list) {
    const c = raw as {
      name?: unknown; runtimeExecutable?: unknown; runtimeArgs?: unknown; program?: unknown; args?: unknown;
      port?: unknown; url?: unknown; cwd?: unknown; env?: unknown; autoPort?: unknown;
    };
    const runtime = typeof c.runtimeExecutable === "string" && c.runtimeExecutable.trim() ? c.runtimeExecutable.trim() : null;
    // `program` runs a script with node; its flags go in `args`.
    const program = !runtime && typeof c.program === "string" && c.program.trim() ? c.program.trim() : null;
    const exe = runtime ? exeFor(expand(runtime, onMachine), windows) : program ? "node" : null;
    const args = (runtime ? strings(c.runtimeArgs) : program ? [program, ...strings(c.args)] : []).map((a) => expand(a, onMachine));
    const port = typeof c.port === "number" && c.port > 0 ? c.port : exe && typeof c.url !== "string" ? DEFAULT_PORT : null;
    const url = typeof c.url === "string" && /^https?:\/\//i.test(c.url) ? c.url : port ? `http://localhost:${port}` : null;
    if (!url) continue;
    const env: Record<string, string> = {};
    if (c.env && typeof c.env === "object" && !Array.isArray(c.env)) {
      for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) env[k] = expand(String(v), onMachine);
      }
    }
    entries.push({
      name: typeof c.name === "string" && c.name.trim() ? c.name.trim() : runtime ?? program ?? url,
      command: exe ? commandLine(exe, args, windows) : null,
      url,
      port,
      cwd: typeof c.cwd === "string" && c.cwd.trim() ? expand(c.cwd.trim(), onMachine) : null,
      exe,
      args,
      windows,
      env,
      autoPort: typeof c.autoPort === "boolean" ? c.autoPort : null,
    });
  }
  return entries;
}

/** The entry started on another port: `--port`/`-p` in its arguments rewritten, PORT set, and
 *  the address moved. */
export function withPort(entry: LaunchEntry, port: number): { command: string; url: string; env: Record<string, string> } {
  const args = [...entry.args];
  for (let i = 0; i < args.length; i++) {
    const m = /^(--port|-p)(=\d+)?$/.exec(args[i]);
    if (!m) continue;
    if (m[2]) args[i] = `${m[1]}=${port}`;
    else if (/^\d+$/.test(args[i + 1] ?? "")) args[i + 1] = String(port);
  }
  let url = entry.url;
  try {
    const u = new URL(entry.url);
    u.port = String(port);
    url = u.toString().replace(/\/$/, entry.url.endsWith("/") ? "/" : "");
  } catch { /* keep the address as it was */ }
  return { command: entry.exe ? commandLine(entry.exe, args, entry.windows) : entry.command ?? "", url, env: { ...entry.env, PORT: String(port) } };
}

const PACKAGE_MANAGERS = /^(npm|yarn|pnpm|bun)(\.cmd|\.exe)?$/i;

/** Like Desktop: a server started through an npm/yarn/pnpm/bun script with its port written in
 *  the script (or a script that can't be read), and no port in `runtimeArgs`, can't be moved:
 *  PORT and a rewritten flag wouldn't reach it. */
export function scriptPinsPort(entry: LaunchEntry, packageJson: string | null): boolean {
  if (!entry.exe || !PACKAGE_MANAGERS.test(entry.exe.split(/[\\/]/).pop() ?? "")) return false;
  if (entry.args.some((a) => /^(--port|-p)(=\d+)?$/.test(a))) return false;
  const name = entry.args[0] === "run" || entry.args[0] === "run-script" ? entry.args[1] : entry.args[0];
  let script: unknown;
  try {
    script = (JSON.parse(packageJson ?? "") as { scripts?: Record<string, unknown> }).scripts?.[name ?? ""];
  } catch {
    return true;
  }
  if (typeof script !== "string") return true;
  return /(--port|-p)[=\s]+\d+|\bPORT=\d+/.test(script) || (entry.port !== null && new RegExp(`\\b${entry.port}\\b`).test(script));
}

/** The absolute folder an entry starts in. */
export function launchCwd(workspace: string, entry: LaunchEntry): string {
  if (!entry.cwd) return workspace;
  // An absolute folder of a remote project is on its machine, which the app names by `ssh://`.
  const host = remoteHostOf(workspace);
  if (host && (entry.cwd.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(entry.cwd))) return remoteUri(host, entry.cwd);
  if (/^[a-zA-Z]:[\\/]/.test(entry.cwd) || entry.cwd.startsWith("/")) return entry.cwd;
  const sep = workspace.includes("\\") ? "\\" : "/";
  return `${workspace.replace(/[\\/]+$/, "")}${sep}${entry.cwd.replace(/^\.[\\/]/, "").replace(/[\\/]/g, sep)}`;
}

export async function readLaunchConfig(workspace: string): Promise<LaunchEntry[]> {
  const sep = workspace.includes("\\") ? "\\" : "/";
  const path = `${workspace.replace(/[\\/]+$/, "")}${sep}${LAUNCH_FILE.replace(/\//g, sep)}`;
  try {
    const text = await invoke<string | null>("agent_read_text", { path });
    return text ? parseLaunchConfig(text, workspace) : [];
  } catch {
    return [];
  }
}

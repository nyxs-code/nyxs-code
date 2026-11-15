import { invoke } from "@/lib/ipc";
import { homeDir } from "@tauri-apps/api/path";
import { runGit } from "@/lib/gitErrors";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function pluginsRoot(): Promise<string> {
  if (!isTauri) {
    throw new Error("Plugins require the Nyxs desktop app.");
  }
  const home = await homeDir();
  if (!home) throw new Error("Could not resolve home directory.");
  return `${home.replace(/[\\/]+$/, "")}/.nyxs/plugins`;
}

export async function knownMarketplacesPath(): Promise<string> {
  return `${await pluginsRoot()}/known_marketplaces.json`;
}

export async function installedPluginsPath(): Promise<string> {
  return `${await pluginsRoot()}/installed_plugins.json`;
}

export async function marketplaceCacheDir(name: string): Promise<string> {
  return `${await pluginsRoot()}/marketplaces/${safeSegment(name)}`;
}

export async function pluginInstallDir(
  marketplace: string,
  plugin: string,
  version: string,
): Promise<string> {
  return `${await pluginsRoot()}/cache/${safeSegment(marketplace)}/${safeSegment(plugin)}/${safeSegment(version)}`;
}

export function safeSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_") || "_";
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  if (!isTauri) return null;
  try {
    const raw = await invoke<string>("nyxs_read_text", { path });
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  if (!isTauri) return;
  await invoke("agent_write_file", {
    path,
    content: JSON.stringify(value, null, 2) + "\n",
  });
}

export async function fetchText(url: string): Promise<string> {
  if (!isTauri) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.text();
  }
  return invoke<string>("agent_fetch_html", { url });
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timed_out: boolean;
}

export async function run(command: string, cwd?: string, timeoutMs = 120_000): Promise<RunResult> {
  const res = await invoke<RunResult>("agent_run", {
    command,
    cwd: cwd ?? null,
    timeoutMs,
  });
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `Command failed (exit ${res.code})`);
  }
  return res;
}

/**
 * The names in a folder. `agent_list_dir` writes them for the agent to read (`skills/`,
 * `hello.md  (1.2 KB)`); this strips that so callers can match names and join paths.
 */
export async function listDir(path: string): Promise<string[]> {
  if (!isTauri) return [];
  try {
    const entries = await invoke<string[]>("agent_list_dir", { path });
    return entries.map((e) => (e.endsWith("/") ? e.slice(0, -1) : e.replace(/ {2}\([^)]*\)$/, "")));
  } catch {
    return [];
  }
}

export function isWindows(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

/**
 * Quotes one argument for the shell `agent_run` uses (PowerShell on Windows, sh elsewhere).
 * Only for the few commands that can't go through `git`/`copyDir`; prefer those.
 */
export function shellQuote(value: string): string {
  if (isWindows()) return `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Runs git with an argument list (no shell) and throws with its output when it fails. */
export async function git(args: string[], cwd = "", timeoutMs = 120_000): Promise<RunResult> {
  const res = await runGit(cwd, args, timeoutMs);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `git ${args[0]} failed (exit ${res.code})`);
  }
  return res;
}

/** Replaces `dst` with a copy of `src`'s contents. `dst` must be in the plugin or skill folders. */
export async function copyDir(src: string, dst: string): Promise<void> {
  await invoke("nyxs_copy_managed_dir", { src, dst });
}

export async function removeDir(path: string): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke("nyxs_remove_managed_dir", { path });
  } catch {
    /* ignore */
  }
}

export async function gitHeadSha(dir: string): Promise<string | undefined> {
  try {
    // The full id, so it can be compared with the sha a catalog entry pins.
    const res = await runGit(dir, ["rev-parse", "HEAD"]);
    return (res.code === 0 && res.stdout.trim()) || undefined;
  } catch {
    return undefined;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    return await invoke<boolean>("agent_path_exists", { path });
  } catch {
    return false;
  }
}

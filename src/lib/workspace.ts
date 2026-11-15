import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@/lib/ipc";
import type { PermissionMode } from "@/components/ui/claude-style-chat-input";
import { accountKey } from "@/lib/accountScope";
import { getMergedSnapshot } from "@/lib/settingsRuntime";
import { rememberModePerFolder } from "@/lib/featureSettings";

const STORAGE_KEY = "optimicer.workspace.v1";

const MODE_KEY = "optimicer.permissionMode.v1";
const LAST_MODE_KEY = "optimicer.permissionMode.last.v1";
const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";

function readModeMap(): Record<string, PermissionMode> {
  try {
    return JSON.parse(localStorage.getItem(accountKey(MODE_KEY)) || "{}");
  } catch {
    return {};
  }
}

const KNOWN_MODES: readonly string[] = ["auto", "ask", "acceptEdits", "plan", "skip"];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && KNOWN_MODES.includes(value);
}

/** One key per folder, whatever slashes or case it was opened with. */
const folderKey = (workspace: string) => {
  const p = workspace.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p;
};

/** `permissions.defaultMode` from settings.json, in Nyxs' names or Claude Code's. */
function settingsDefaultMode(): PermissionMode | null {
  const raw = (getMergedSnapshot().permissions as { defaultMode?: string } | undefined)?.defaultMode;
  if (raw === "default") return "ask";
  if (raw === "bypassPermissions") return "skip";
  return isPermissionMode(raw) ? raw : null;
}

/** The mode a new chat in `workspace` starts in. Like Claude Code Desktop: the one last chosen in
 *  that folder, else settings' `defaultMode`, else the last one chosen anywhere (what this used
 *  to remember for every folder), else Manual. */
export function loadPermissionMode(workspace: string | null): PermissionMode {
  const map = readModeMap();
  const own = workspace && rememberModePerFolder() ? map[folderKey(workspace)] ?? map[workspace] : undefined;
  if (isPermissionMode(own)) return own;
  const fromSettings = settingsDefaultMode();
  if (fromSettings) return fromSettings;
  let last: string | null;
  try {
    last = localStorage.getItem(accountKey(LAST_MODE_KEY));
  } catch {
    last = null;
  }
  return isPermissionMode(last) ? last : DEFAULT_PERMISSION_MODE;
}

/** Remembers the mode chosen in a folder. Plan isn't remembered: like in Desktop it lasts the
 *  session it was picked in, and a new chat goes back to the folder's mode. */
export function savePermissionMode(mode: PermissionMode, workspace: string | null): void {
  if (mode === "plan") return;
  try {
    localStorage.setItem(accountKey(LAST_MODE_KEY), mode);
    if (!workspace) return;
    const map = readModeMap();
    map[folderKey(workspace)] = mode;
    localStorage.setItem(accountKey(MODE_KEY), JSON.stringify(map));
  } catch {
    return;
  }
}

export function loadWorkspace(): string | null {
  try {
    return localStorage.getItem(accountKey(STORAGE_KEY));
  } catch {
    return null;
  }
}

export async function allowWorkspaceAccess(path: string | null): Promise<void> {
  if (!path || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    await invoke("agent_allow_ui_path", { path });
  } catch {
    return;
  }
}

export function saveWorkspace(path: string | null): void {
  if (path) localStorage.setItem(accountKey(STORAGE_KEY), path);
  else localStorage.removeItem(accountKey(STORAGE_KEY));
}

const RECENTS_KEY = "optimicer.recentWorkspaces.v1";
const MAX_RECENTS = 12;

export function loadRecentWorkspaces(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(accountKey(RECENTS_KEY)) || "[]");
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function saveRecentWorkspaces(list: string[]): void {
  try {
    localStorage.setItem(accountKey(RECENTS_KEY), JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch {
    /* almacenamiento no disponible */
  }
}

export function addRecentWorkspace(path: string): string[] {
  const next = [path, ...loadRecentWorkspaces().filter((p) => p !== path)].slice(0, MAX_RECENTS);
  saveRecentWorkspaces(next);
  return next;
}

export function removeRecentWorkspace(path: string): string[] {
  const next = loadRecentWorkspaces().filter((p) => p !== path);
  saveRecentWorkspaces(next);
  return next;
}

export async function workspaceExists(path: string | null): Promise<boolean> {
  if (!path) return false;
  try {
    return await invoke<boolean>("path_is_dir", { path });
  } catch {
    return true;
  }
}

export async function pickWorkspace(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Elige la carpeta de trabajo",
  });
  if (typeof selected === "string") return selected;
  return null;
}

export function workspaceName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

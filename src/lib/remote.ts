import { useSyncExternalStore } from "react";
import { invoke } from "@/lib/ipc";
import { accountKey } from "@/lib/accountScope";

/** A project on another computer is named `ssh://<host>/<path>`: `<host>` is what `ssh` takes
 *  (an alias from ~/.ssh/config, `user@server`, `user@server:2222`) and `<path>` the absolute
 *  path there with forward slashes (`ssh://casa/C:/code/app` for a Windows machine). The
 *  backend (src-tauri/src/remote) runs every file, search and command call for such a path on
 *  that machine. */
export const REMOTE_SCHEME = "ssh://";

export const isRemotePath = (p: string | null | undefined): boolean => !!p && p.startsWith(REMOTE_SCHEME);

export interface RemoteLocation {
  host: string;
  /** `/home/me/app` or `C:/code/app`. */
  path: string;
}

/** Folds `.` and `..` and repeated slashes; keeps a Windows drive (`C:/`) as the root. */
function normalizePosix(path: string): string {
  const p = path.replace(/\\/g, "/");
  const drive = /^\/?([A-Za-z]:)(\/|$)/.exec(p);
  const root = drive ? `${drive[1]}/` : "/";
  const rest = drive ? p.slice(drive[0].length) : p;
  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return root + out.join("/");
}

export function parseRemote(p: string): RemoteLocation | null {
  if (!isRemotePath(p)) return null;
  const rest = p.slice(REMOTE_SCHEME.length).replace(/\\/g, "/");
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  if (!host) return null;
  return { host, path: normalizePosix(slash < 0 ? "/" : rest.slice(slash)) };
}

export function remoteUri(host: string, path: string): string {
  const p = normalizePosix(path);
  return `${REMOTE_SCHEME}${host}${p.startsWith("/") ? p : `/${p}`}`;
}

export const remoteHostOf = (p: string | null | undefined): string | null =>
  p && isRemotePath(p) ? parseRemote(p)?.host ?? null : null;

/** `child` is `parent` or inside it (same machine). Windows machines compare without case. */
export function isInsideRemote(child: string, parent: string): boolean {
  const c = parseRemote(child);
  const r = parseRemote(parent);
  if (!c || !r || c.host !== r.host) return false;
  const win = /^[A-Za-z]:/.test(r.path);
  const a = win ? c.path.toLowerCase() : c.path;
  const b = (win ? r.path.toLowerCase() : r.path).replace(/\/+$/, "");
  return a === b || a === `${b}/` || a.startsWith(`${b}/`) || (b === "" && a.startsWith("/"));
}

/** Resolves a path the agent gave for a remote project: relative to the project, absolute on
 *  that machine (`/etc/x`, `C:/x`) or already `ssh://`. Refuses anything outside the allowed
 *  roots, like the local `resolvePath`. */
export function resolveRemotePath(p: string, workspace: string, extraRoots: string[] = []): string {
  const ws = parseRemote(workspace);
  if (!ws) throw new Error(`Not a remote folder: ${workspace}`);
  let full: string;
  if (isRemotePath(p)) full = p;
  else if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/")) full = remoteUri(ws.host, p);
  else full = remoteUri(ws.host, `${ws.path.replace(/\/+$/, "")}/${p}`);
  const loc = parseRemote(full);
  if (!loc) throw new Error(`Invalid path: ${p}`);
  const resolved = remoteUri(loc.host, loc.path);
  const allowed = isInsideRemote(resolved, workspace) || extraRoots.some((r) => isRemotePath(r) && isInsideRemote(resolved, r));
  if (!allowed) {
    throw new Error(
      `Acceso denegado: "${p}" está fuera de la carpeta del proyecto (${workspace}) en la máquina ${ws.host}. ` +
        `Solo puedes leer o escribir dentro del proyecto actual.`,
    );
  }
  return resolved;
}

/** What the backend reports about a connected machine. */
export interface RemoteHostInfo {
  version: string;
  protocol: number;
  os: "linux" | "macos" | "windows" | string;
  arch: string;
  home: string;
  shell: string;
  hostname: string;
  user: string;
}

export type RemoteState = "idle" | "connecting" | "installing" | "connected" | "disconnected" | "error";

export interface RemoteStatus {
  state: RemoteState;
  message?: string;
  info?: RemoteHostInfo;
}

export interface SavedMachine {
  host: string;
  /** Shown instead of the host when set. */
  name?: string;
}

const KEY = "nyxs.remoteMachines.v1";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

let machinesCache: SavedMachine[] | null = null;

export function savedMachines(): SavedMachine[] {
  if (machinesCache) return machinesCache;
  try {
    const v = JSON.parse(localStorage.getItem(accountKey(KEY)) || "[]") as SavedMachine[];
    machinesCache = Array.isArray(v) ? v.filter((m) => m && typeof m.host === "string" && m.host) : [];
  } catch {
    machinesCache = [];
  }
  return machinesCache;
}

function writeMachines(list: SavedMachine[]): void {
  machinesCache = list;
  try {
    localStorage.setItem(accountKey(KEY), JSON.stringify(list));
  } catch {
    // Kept for this run.
  }
  emit();
}

export function saveMachine(m: SavedMachine): void {
  const host = m.host.trim();
  const next: SavedMachine = { host, ...(m.name?.trim() ? { name: m.name.trim() } : {}) };
  const list = savedMachines();
  writeMachines(list.some((x) => x.host === host) ? list.map((x) => (x.host === host ? next : x)) : [...list, next]);
}

export function removeMachine(host: string): void {
  writeMachines(savedMachines().filter((m) => m.host !== host));
  void invoke("remote_disconnect", { host }).catch(() => {});
}

export const useSavedMachines = () => useSyncExternalStore(subscribe, savedMachines);

export function machineLabel(host: string): string {
  return savedMachines().find((m) => m.host === host)?.name || host;
}

const statuses = new Map<string, RemoteStatus>();
let statusVersion = 0;

function setStatus(host: string, status: RemoteStatus): void {
  const prev = statuses.get(host);
  // The details stay known after a drop: the machine is still the same one.
  statuses.set(host, { ...status, info: status.info ?? prev?.info });
  statusVersion++;
  emit();
}

export function machineStatus(host: string): RemoteStatus {
  return statuses.get(host) ?? { state: "idle" };
}

export function useMachineStatus(host: string | null): RemoteStatus {
  useSyncExternalStore(subscribe, () => statusVersion);
  return host ? machineStatus(host) : { state: "idle" };
}

/** The machine's details once it has connected in this run, for prompts that must be built
 *  synchronously (its OS and shell). */
export function cachedRemoteInfo(host: string): RemoteHostInfo | undefined {
  return statuses.get(host)?.info;
}

let listening = false;
async function listenStatus(): Promise<void> {
  if (listening || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  listening = true;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<{ host: string; state: RemoteState; message?: string; info?: RemoteHostInfo }>("remote-status", (e) => {
    const { host, ...rest } = e.payload;
    setStatus(host, rest);
  });
}
void listenStatus();

const inflight = new Map<string, Promise<RemoteHostInfo>>();

/** Opens the connection (installing Nyxs' helper there the first time). Reuses a live one. */
export function connectMachine(host: string): Promise<RemoteHostInfo> {
  const running = inflight.get(host);
  if (running) return running;
  if (machineStatus(host).state !== "connected") setStatus(host, { state: "connecting" });
  const p = invoke<RemoteHostInfo>("remote_connect", { host })
    .then((info) => {
      setStatus(host, { state: "connected", info });
      return info;
    })
    .catch((e: unknown) => {
      setStatus(host, { state: "error", message: e instanceof Error ? e.message : String(e) });
      throw e;
    })
    .finally(() => inflight.delete(host));
  inflight.set(host, p);
  return p;
}

export const remoteHome = (host: string) => invoke<string>("remote_home", { host });

export const listRemoteFolders = (uri: string) => invoke<string[]>("remote_list_folders", { path: uri });

export const sshConfigHosts = () => invoke<string[]>("remote_config_hosts").catch(() => [] as string[]);

/** The local port that reaches `port` on the machine (a tunnel), for the browser. */
export const forwardRemotePort = (host: string, port: number) => invoke<number>("remote_forward", { host, port });

/** "Linux", "macOS" or "Windows" for a machine's `os`. */
export function remoteOsName(os: string | undefined): "Linux" | "macOS" | "Windows" {
  if (os === "windows") return "Windows";
  if (os === "macos") return "macOS";
  return "Linux";
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i;

/** For a remote project, a `localhost` address means its machine: the same address on this
 *  PC's end of a tunnel to it. Anything else comes back unchanged. */
export async function tunnelUrl(url: string, workspace: string | null | undefined): Promise<string> {
  const host = remoteHostOf(workspace);
  if (!host) return url;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
  } catch {
    return url;
  }
  if (!/^https?:$/.test(u.protocol) || !LOOPBACK.test(u.hostname)) return url;
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  const local = await forwardRemotePort(host, port);
  u.hostname = "localhost";
  u.port = String(local);
  return u.toString();
}

/** Makes a folder inside a remote folder and returns its `ssh://` path. */
export const createRemoteFolder = (parent: string, name: string) =>
  invoke<string>("remote_create_folder", { parent, name });

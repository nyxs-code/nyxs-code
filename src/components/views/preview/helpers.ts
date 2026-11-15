import { invoke } from "@/lib/ipc";
import type { PickedElement } from "@/lib/pickedElement";
import { classifyAddress } from "./addressInput";

/** Toggles the element picker of the active tab. */
export const PICK_SHORTCUT = "Ctrl+Shift+S";

/** How long a server just started gets to begin listening before the preview gives up. */
const SERVER_START_TIMEOUT_MS = 120_000;

/** Resolves to the address to open once the server listens. Nothing is started when the
 *  address already answers (the agent, another tab or a terminal started it), and a shell
 *  that is already running it is waited for instead of starting a second copy that would
 *  find its port taken. Rejects as soon as the server exits, with its last output.
 *  `onShell` hears which shell it waits for, and whether this call started it. */
export async function bootServer(opts: {
  command: string;
  cwd: string;
  description: string;
  url: string;
  shellId?: string;
  env?: Record<string, string>;
  onShell?: (id: string, started: boolean) => void;
}): Promise<string> {
  // `cwd` lets a server of a remote project be found there and opened through a tunnel.
  const up = await invoke<string>("agent_wait_for_server", { url: opts.url, cwd: opts.cwd }).catch(() => "");
  if (up) return up;
  const started = !opts.shellId;
  const shellId =
    opts.shellId ??
    (await invoke<{ id: string }>("agent_run_background", { command: opts.command, cwd: opts.cwd, description: opts.description, env: opts.env ?? null })).id;
  opts.onShell?.(shellId, started);
  return invoke<string>("agent_wait_for_server", { url: opts.url, shellId, timeoutMs: SERVER_START_TIMEOUT_MS, cwd: opts.cwd });
}

export function isLocalHost(host: string): boolean {
  return (
    /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\])$/i.test(host) ||
    host.toLowerCase().endsWith(".localhost")
  );
}

/** Whether an address belongs to the project being worked on: a local server, a page the preview
 *  serves, or a file in its folder. */
export function isProjectTarget(target: string, workspace?: string | null): boolean {
  const address = classifyAddress(target);
  if (address.kind === "search") return false;
  if (address.kind === "web") {
    try {
      return isLocalHost(new URL(address.url).hostname);
    } catch {
      return false;
    }
  }
  const path = address.path.replace(/\\/g, "/");
  if (path.startsWith("nyxspreview://")) return true;
  // A remote project's files are `ssh://host/...`; any other scheme is no file of a project.
  if (/^[a-z]+:\/\//i.test(path) && !path.startsWith("ssh://")) return false;
  const absolute = /^[a-zA-Z]:\//.test(path) || path.startsWith("/") || path.startsWith("ssh://");
  const root = workspace?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!absolute || !root) return true;
  const fold = (p: string) => (/^[a-zA-Z]:\//.test(root) ? p.toLowerCase() : p);
  return fold(path) === fold(root) || fold(path).startsWith(`${fold(root)}/`);
}

export function decodeImage(src: string): Promise<void> {
  const img = new Image();
  img.src = src;
  return img.decode().catch(() => undefined);
}

/** Resolves once the frame after the current render has been painted. */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/** Windows can cut holes in the native webview (see preview_set_holes), so the app's menus show
 *  through the page at once instead of hiding it behind a snapshot. */
export const NATIVE_HOLES = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/** Whether two addresses point at the same server; any local host name counts as the same. */
export function sameServer(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const port = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");
    if (isLocalHost(x.hostname) && isLocalHost(y.hostname)) return port(x) === port(y);
    return x.origin === y.origin;
  } catch {
    return false;
  }
}

/** Commands that start a server. `vite build` and `vite optimize` don't. */
const SERVER_COMMAND =
  /\b(next\s+(dev|start)|vite(?!\s+(build|optimize)\b)|astro\s+dev|remix\s+(dev|vite:dev)|ng\s+serve|react-scripts\s+start|webpack(-dev-server|\s+serve)|nuxt\s+dev|gatsby\s+develop|http-server|live-server|python\s+-m\s+http\.server|php\s+-S|rails\s+s(erver)?|(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview))\b/i;
/** `serve` as the program run (`serve -s build`, `npx serve dist`), not a word of another
 *  command (`serve-docs`, `--grep=serve`). */
const SERVE_PROGRAM = /(?:^|[;&|]\s*|\b(?:npx|bunx|dlx|exec)\s+)serve(?=\s|$)/i;

export function isDevServerCommand(cmd: string): boolean {
  return SERVER_COMMAND.test(cmd) || SERVE_PROGRAM.test(cmd);
}

export function devServerUrl(cmd: string): string {
  const m =

    cmd.match(/(?:--port|--listen|-p|-l)[ =]?\s*(?:[a-z]+:\/\/[^\s:]*:)?(\d{2,5})/i) ||
    cmd.match(/\bhttp\.server\s+(\d{2,5})/i) ||
    cmd.match(/-S\s+\S*:(\d{2,5})/);
  let port = m ? parseInt(m[1], 10) : NaN;
  if (!port || Number.isNaN(port)) {
    if (/\b(vite|astro)\b/i.test(cmd)) port = 5173;
    else if (/\bng\s+serve\b/i.test(cmd)) port = 4200;
    else if (/python\s+-m\s+http\.server|\bgatsby\b/i.test(cmd)) port = 8000;
    else port = 3000;
  }
  return `http://localhost:${port}`;
}

/** A tab's address and history, kept across a reload of the app's page. */
export interface PageSnapshot {
  input: string;
  hist: { list: string[]; i: number };
  manual: boolean;
}

export interface PreviewProps {
  workspace: string | null;
  requestedFile?: string;
  onRequestDevServer?: () => void;
  /** Asks the agent to add an entry to .claude/launch.json. */
  onAddServer?: () => void;
  onClose?: () => void;
  onToggleMaximize?: () => void;
  /** The panel covers the chat; the maximize button brings it back. */
  maximized?: boolean;
  onPickElement?: (element: PickedElement) => void;
  /** Attaches the annotated screenshot to the chat's message box. */
  onAttachImage?: (file: File) => void;
  /** False while the preview is kept alive behind another view. */
  visible?: boolean;
}

/** What a tab shows as its title: host[:port] for a URL, the file name for a file. */
export function pageLabel(input: string): string {
  const v = input.trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) {
    try { return new URL(v).host || v; } catch { return v; }
  }
  return v.split(/[\\/]/).pop() || v;
}

import { invoke } from "@/lib/ipc";
import { OPEN_IN_BROWSER_EVENT } from "@/lib/openExternal";
import { loadWorkspace } from "@/lib/workspace";

/** Asks the Files panel to open a file (detail: its absolute path). */
export const OPEN_FILE_EVENT = "nyxs:open-file";
/** Asks the composer to insert text at the caret (detail: the text). */
export const COMPOSER_INSERT_EVENT = "nyxs:composer-insert";

export interface PathRef {
  /** As written in the chat, without the line. */
  raw: string;
  /** Absolute, with the platform's separators. */
  abs: string;
  /** Relative to the project folder, with "/" (the absolute path when it's outside). */
  rel: string;
  name: string;
  line?: number;
}

const isAbs = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");

/** Inline code that could name a file: no spaces, not a URL, with a folder separator or a file
 *  extension, maybe ending in ":line" or ":line:col". Whether it exists is checked afterwards. */
export function parsePathRef(text: string, workspace: string | null): PathRef | null {
  const t = text.trim();
  if (!t || t.length > 260 || /\s/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null;
  const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(t);
  const raw = (m?.[1] ?? t).replace(/^\.[\\/]/, "");
  if (!raw || !(/[\\/]/.test(raw) || /\.[A-Za-z0-9]{1,10}$/.test(raw)) || /[<>"|?*]/.test(raw)) return null;
  // A network path (\\server\share) is never looked up: checking it would make Windows connect
  // to that server and hand it the user's NTLM hash, just by rendering a reply.
  if (/^[\\/]{2}/.test(raw)) return null;
  // A dotted identifier (e.key, foo.bar()) isn't a file: a file name has a letter before the dot.
  if (!/[\\/]/.test(raw) && !/^[\w.-]{2,}\.[A-Za-z0-9]{1,10}$/.test(raw)) return null;
  if (!isAbs(raw) && !workspace) return null;
  const winSep = (workspace ?? raw).includes("\\") || /^[A-Za-z]:/.test(raw);
  const native = (p: string) => (winSep ? p.replace(/\//g, "\\") : p.replace(/\\/g, "/"));
  const abs = native(isAbs(raw) ? raw : `${workspace!.replace(/[\\/]+$/, "")}/${raw}`);
  const root = workspace ? native(workspace.replace(/[\\/]+$/, "")) : "";
  const inside = root && abs.toLowerCase().startsWith(`${root.toLowerCase()}${winSep ? "\\" : "/"}`);
  const rel = (inside ? abs.slice(root.length + 1) : abs).replace(/\\/g, "/");
  const line = m?.[2] ? Number(m[2]) : undefined;
  return { raw, abs, rel, name: abs.split(/[\\/]/).pop() ?? abs, line };
}

/** What a path is on disk: a file, a folder, or nothing (cached: the chat re-renders a lot). */
export type PathKind = "file" | "dir" | "none";
const kinds = new Map<string, Promise<PathKind>>();

export function pathKind(abs: string): Promise<PathKind> {
  let p = kinds.get(abs);
  if (!p) {
    p = invoke<boolean>("agent_path_exists", { path: abs })
      .then(async (exists) => (!exists ? "none" : (await invoke<boolean>("path_is_dir", { path: abs })) ? "dir" : "file"))
      .catch((): PathKind => "none");
    kinds.set(abs, p);
    // Files come and go while the agent works: check again after a while.
    setTimeout(() => kinds.delete(abs), 30_000);
  }
  return p;
}

export const currentWorkspace = () => loadWorkspace();

/** The file asked for while the Files panel was closed: it opens it once it mounts. */
let pendingFile: string | null = null;
export const takePendingFile = () => {
  const p = pendingFile;
  pendingFile = null;
  return p;
};

/** Pages and media open in the built-in browser; everything else in the Files panel; a folder
 *  in the system's file manager. */
const IN_BROWSER = /\.(html?|pdf|mp4|webm|mov|png|jpe?g|gif|svg|webp)$/i;

export function openPathRef(ref: PathRef, kind: PathKind): void {
  if (kind === "dir") {
    void invoke("agent_open_path", { path: ref.abs }).catch(() => undefined);
  } else if (IN_BROWSER.test(ref.abs)) {
    window.dispatchEvent(new CustomEvent<string>(OPEN_IN_BROWSER_EVENT, { detail: ref.abs }));
  } else {
    pendingFile = ref.abs;
    window.dispatchEvent(new CustomEvent<string>(OPEN_FILE_EVENT, { detail: ref.abs }));
  }
}

/** Mentions the file in the composer (`@path`), which attaches it to the next message. */
export function attachPathRef(ref: PathRef): void {
  const mention = /\s/.test(ref.rel) ? `@"${ref.rel}"` : `@${ref.rel}`;
  window.dispatchEvent(new CustomEvent<string>(COMPOSER_INSERT_EVENT, { detail: `${mention} ` }));
}

export interface EditorInfo {
  id: string;
  name: string;
}
let editors: Promise<EditorInfo[]> | null = null;
export function installedEditors(): Promise<EditorInfo[]> {
  editors ??= invoke<EditorInfo[]>("agent_editors").catch(() => []);
  return editors;
}

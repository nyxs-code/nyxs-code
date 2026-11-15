import { invoke } from "@/lib/ipc";
import { folderOf, showFileNotice } from "@/lib/fileNotices";

/**
 * What reading a JSON data file found. `missing` (no file, or an empty one) is safe to start
 * over from; `unreadable` (I/O error, not text, invalid JSON) is not: whatever the file holds
 * would be lost by writing a fresh value over it.
 */
export type JsonFileRead<T> =
  | { status: "missing" }
  | { status: "ok"; value: T }
  | { status: "unreadable"; error: string };

export interface ReadJsonOptions {
  /**
   * Keep a copy of an unparseable file next to it as `<path>.bak`. Only for files in the app's
   * own data folder: a project's `.nyxs/` must not get machine-made files.
   */
  backup?: boolean;
}

/** Thrown by {@link writeJsonFile} instead of overwriting a file that couldn't be read. */
export class UnreadableFileError extends Error {
  readonly path: string;
  readonly reason: string;
  constructor(path: string, reason: string) {
    super(`Not saving ${path}: it couldn't be read (${reason}), and saving would replace what it holds. Fix or remove the file and restart Nyxs.`);
    this.name = "UnreadableFileError";
    this.path = path;
    this.reason = reason;
  }
}

const blocked = new Map<string, string>();
/** The `.bak` copy made of each blocked file, when one could be. */
const backups = new Map<string, string>();

const key = (path: string) => path.replace(/\\/g, "/").toLowerCase();

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/**
 * Reads and parses a JSON file, telling "not there" apart from "there but unreadable". An
 * unreadable file is logged and blocked for {@link writeJsonFile} until a later read succeeds.
 */
export async function readJsonFile<T>(path: string, opts: ReadJsonOptions = {}): Promise<JsonFileRead<T>> {
  let raw: string | null | undefined;
  try {
    raw = await invoke<string | null>("agent_read_text", { path });
  } catch (e) {
    return markUnreadable(path, describe(e));
  }
  if (raw == null) {
    // `null` is also what a binary or oversized file reads as: it exists, so it isn't "missing".
    const mtime = await invoke<number | null>("agent_file_mtime", { path }).catch(() => null);
    if (mtime != null) return markUnreadable(path, "not a text file");
    unblock(path);
    return { status: "missing" };
  }
  if (!raw.trim()) {
    unblock(path);
    return { status: "missing" };
  }
  try {
    const value = JSON.parse(raw) as T;
    unblock(path);
    return { status: "ok", value };
  } catch (e) {
    let backup: string | null = null;
    if (opts.backup) {
      backup = `${path}.bak`;
      await invoke("agent_write_file", { path: backup, content: raw }).catch((err: unknown) => {
        backup = null;
        console.warn(`[safeJsonFile] couldn't back up ${path}:`, describe(err));
      });
    }
    return markUnreadable(path, `invalid JSON: ${describe(e)}`, backup);
  }
}

function markUnreadable<T>(path: string, error: string, backup: string | null = null): JsonFileRead<T> {
  blocked.set(key(path), error);
  if (backup) backups.set(key(path), backup);
  else backups.delete(key(path));
  console.warn(`[safeJsonFile] ${path} couldn't be read (${error}); it won't be overwritten.`);
  return { status: "unreadable", error };
}

function unblock(path: string): void {
  blocked.delete(key(path));
  backups.delete(key(path));
}

/** Whether the last read of `path` failed, so writing it would lose its content. */
export function isWriteBlocked(path: string): boolean {
  return blocked.has(key(path));
}

export interface WriteJsonOptions {
  /** Tell the user about a refused save only the first time this run, for a file the app saves
   *  on its own often (nyxs.json): otherwise the notice came back after every dismissal. */
  noticeOnce?: boolean;
}

/** Files whose refused save was already told this run (see `noticeOnce`). */
const noticed = new Set<string>();

/**
 * Writes `data` as pretty JSON, unless the last read of `path` failed: then it throws
 * {@link UnreadableFileError} and leaves the file as it is.
 */
export async function writeJsonFile(path: string, data: unknown, opts: WriteJsonOptions = {}): Promise<void> {
  const reason = blocked.get(key(path));
  if (reason !== undefined) {
    if (!opts.noticeOnce || !noticed.has(key(path))) {
      noticed.add(key(path));
      showFileNotice({ kind: "unreadableFile", file: path, folder: folderOf(path), backup: backups.get(key(path)) ?? null });
    }
    throw new UnreadableFileError(path, reason);
  }
  await invoke("agent_write_file", {
    path,
    content: JSON.stringify(data, null, 2) + "\n",
  });
}

/** Test hook: forget which files were unreadable. */
export function resetWriteBlocks(): void {
  blocked.clear();
  backups.clear();
  noticed.clear();
}

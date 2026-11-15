import { invoke } from "@/lib/ipc";

/** A data file Nyxs couldn't read and left alone, shown to the user (FileNoticeBanner). */
export type FileNotice =
  /** A JSON file (settings.json, nyxs.json, routines.json) wasn't saved over. `backup`: the
   *  `.bak` copy made of it, when there is one. */
  | { kind: "unreadableFile"; file: string; folder: string; backup: string | null }
  /** A session's files couldn't be read, so it wasn't opened. */
  | { kind: "unreadableSession"; folder: string | null }
  /** The chat index was corrupt and was moved to `file`. */
  | { kind: "chatIndexSetAside"; file: string; folder: string }
  /** A rewind couldn't put these files back (relative to the chat's working folder); they were
   *  left as they were. */
  | { kind: "rewindFailed"; files: string[] };

// One at a time: a new notice replaces the one showing.
let current: FileNotice | null = null;
const listeners = new Set<() => void>();

const same = (a: FileNotice | null, b: FileNotice) => JSON.stringify(a) === JSON.stringify(b);

export function showFileNotice(notice: FileNotice): void {
  if (same(current, notice)) return;
  current = notice;
  for (const fn of [...listeners]) fn();
}

export function dismissFileNotice(): void {
  if (!current) return;
  current = null;
  for (const fn of [...listeners]) fn();
}

export function currentFileNotice(): FileNotice | null {
  return current;
}

export function subscribeFileNotices(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The folder holding `path`, written as given. */
export function folderOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

/** The last part of `path`. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Opens the notice's folder in the system's file manager. A remote one can't be. */
export async function openNoticeFolder(folder: string): Promise<void> {
  await invoke("agent_open_path", { path: folder });
}

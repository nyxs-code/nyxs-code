/** "Edit in Video" on a video file (Files panel): the panel switches to the Video view, which
 *  makes a project from the file. Same pattern as videoOpen.ts: an event for a mounted view,
 *  and a pending request for a view that mounts afterwards. */
export const EDIT_VIDEO_FILE_EVENT = "nyxs:edit-video-file";

export const VIDEO_FILE_RE = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;

let pending: string | null = null;

export function requestEditVideoFile(path: string): void {
  pending = path;
  window.dispatchEvent(new CustomEvent<string>(EDIT_VIDEO_FILE_EVENT, { detail: path }));
}

/** The project whose folder holds this file (its render in out/, its media): editing it means
 *  that project, not a new one holding another copy. */
export function projectOwningFile<T extends { path: string }>(projects: T[], file: string): T | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const f = norm(file);
  return projects.find((p) => f.startsWith(`${norm(p.path)}/`)) ?? null;
}

export function takePendingEditVideoFile(): string | null {
  const p = pending;
  pending = null;
  return p;
}

/** Asks the Video view to show a project (and optionally a frame). The VideoOpen agent tool
 *  sends it; the panel listens for `OPEN_VIDEO_EVENT` on `window`. */
export const OPEN_VIDEO_EVENT = "nyxs:open-video";

export interface VideoOpenRequest {
  /** The chat whose right panel should switch to the Video view; the one on screen when unset. */
  chat?: string;
  slug: string;
  compositionId?: string;
  frame?: number;
}

// The last request per chat ("" = no chat), for a Video view that mounts after the event fired.
const pending = new Map<string, VideoOpenRequest>();

export function requestVideoOpen(detail: VideoOpenRequest): void {
  pending.set(detail.chat ?? "", detail);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<VideoOpenRequest>(OPEN_VIDEO_EVENT, { detail }));
}

/** The request a just-mounted Video view should honor, removed once taken. */
export function takePendingVideoOpen(chat?: string): VideoOpenRequest | null {
  const key = chat ?? "";
  const req = pending.get(key) ?? (key ? pending.get("") : undefined) ?? null;
  if (req) pending.delete(req.chat ?? "");
  return req;
}

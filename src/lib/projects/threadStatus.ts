import type { ThreadStatus } from "./types";

/** The overview panel's groups, in the order they show: Te esperan · Trabajando · Para revisar ·
 *  Resueltos · Fallidos. */
export type ThreadGroup = "waiting" | "working" | "review" | "resolved" | "failed";

export const THREAD_GROUPS: readonly ThreadGroup[] = ["waiting", "working", "review", "resolved", "failed"];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A stored `working` with no turn running: the turn is about to start (a thread just created, a
 *  message queued) for this long; after it, the app was closed mid-turn and it waits for review. */
const STARTING_MS = 5 * MINUTE;
/** As in Claude's projects: a thread nobody looked at is quiet after 3 days and counts as
 *  resolved after 7. */
export const QUIET_MS = 3 * DAY;
export const AUTO_RESOLVE_MS = 7 * DAY;

export interface ThreadLive {
  status: ThreadStatus | undefined;
  /** A turn is running on it now. */
  streaming: boolean;
  /** A permission or a question waits on the user there. */
  blocked: boolean;
  updatedAt: number;
}

/** Which group a thread shows in now: what runs and waits live wins over what was stored. */
export function threadGroup(t: ThreadLive, now: number): ThreadGroup {
  if (t.blocked || (!t.streaming && t.status === "needs_input")) return "waiting";
  if (t.streaming) return "working";
  switch (t.status) {
    case "working":
      return now - t.updatedAt < STARTING_MS ? "working" : "review";
    case "failed":
      return "failed";
    case "resolved":
    case "idle":
      return "resolved";
    default:
      return now - t.updatedAt > AUTO_RESOLVE_MS ? "resolved" : "review";
  }
}

/** The dot of a thread (and of a project in the sidebar): blue working, amber waiting on the
 *  user, green to review, gray resolved, red failed. */
export const GROUP_DOT: Record<ThreadGroup, string> = {
  waiting: "bg-amber-500",
  working: "bg-accent",
  review: "bg-emerald-500",
  resolved: "bg-text-500",
  failed: "bg-red-500",
};

/** A project's dot in the sidebar: amber when something waits on the user, blue while something
 *  works, none otherwise. */
export function projectDot(groups: ThreadGroup[], coordinator: { streaming: boolean; blocked: boolean }): "waiting" | "working" | null {
  if (coordinator.blocked || groups.includes("waiting")) return "waiting";
  if (coordinator.streaming || groups.includes("working")) return "working";
  return null;
}

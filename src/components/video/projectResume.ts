import { accountKey } from "@/lib/accountScope";
import type { TrackSize } from "@/lib/video/trackHeights";
import { getPlayhead, getTimelineState, subscribePlayhead, subscribeTimeline } from "@/lib/video/timelineStore";

const KEY = "nyxs.video.resume";

/** Where a project was left: it reopens there. */
export interface ProjectResume {
  compositionId?: string;
  frame?: number;
  zoom?: number;
  trackSize?: TrackSize;
  /** Track heights set by hand, by track id. */
  trackHeights?: Record<string, number>;
}

function readAll(): Record<string, ProjectResume> {
  try {
    return JSON.parse(localStorage.getItem(accountKey(KEY)) ?? "{}") as Record<string, ProjectResume>;
  } catch {
    return {};
  }
}

export function loadResume(workspace: string, slug: string): ProjectResume | null {
  return readAll()[`${workspace}|${slug}`] ?? null;
}

function save(workspace: string, slug: string, r: ProjectResume) {
  try {
    const all = readAll();
    all[`${workspace}|${slug}`] = r;
    localStorage.setItem(accountKey(KEY), JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

/** Saves the open project's composition, playhead and zoom while it is edited (at most once a
 *  second) and when it closes. Returns the stop function. */
export function trackResume(workspace: string, slug: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const snapshot = () => {
    const s = getTimelineState();
    if (s.status !== "ready" || s.project?.slug !== slug || s.project.workspace !== workspace) return;
    // Heights of tracks that no longer exist are not worth keeping.
    const ids = new Set(s.timeline?.compositions.flatMap((c) => c.tracks.map((t) => t.id)));
    const trackHeights = Object.fromEntries(Object.entries(s.trackHeights).filter(([id]) => ids.has(id)));
    save(workspace, slug, { compositionId: s.compositionId ?? undefined, frame: getPlayhead(), zoom: s.zoom, trackSize: s.trackSize, trackHeights });
  };
  const schedule = () => {
    timer ??= setTimeout(() => {
      timer = null;
      snapshot();
    }, 1000);
  };
  const offState = subscribeTimeline(schedule);
  const offPlayhead = subscribePlayhead(schedule);
  return () => {
    offState();
    offPlayhead();
    if (timer) clearTimeout(timer);
    snapshot();
  };
}

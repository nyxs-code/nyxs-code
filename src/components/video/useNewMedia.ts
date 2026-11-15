import { useEffect } from "react";
import { subscribeFsChange } from "@/lib/fsWatch";
import type { Asset } from "@/lib/video/timelineSchema";
import { getTimelineState, isGestureActive, timelineActions } from "@/lib/video/timelineStore";
import { importMedia, listMedia, type MediaFile } from "@/lib/video/videoApi";
import { withAssets } from "./media";

/** Long enough for a copy or an encoder that is still writing to show a new size. */
const SETTLE_MS = 2000;

/** What the open editor already decided about the media folder, by lowercase `src`. */
export interface NewMediaState {
  /** `null`: never look at it again. A size: unusable at that size (retried if it changes). */
  handled: Map<string, number | null>;
  /** The size of each new file at the last look: it is ready once that stops changing. */
  sizes: Map<string, number>;
}

const key = (src: string) => src.toLowerCase();

/** Everything in the folder when the project opens counts as known, so opening one never writes
 *  to its timeline. */
export function markAllHandled(state: NewMediaState, files: MediaFile[]): void {
  for (const f of files) state.handled.set(key(f.src), null);
}

/** The files added since the project opened whose size has settled. Assets already in the timeline
 *  stay handled for good, so undoing an import doesn't bring the asset straight back. */
export function pickSettled(state: NewMediaState, files: MediaFile[], registered: string[]): { ready: MediaFile[]; waiting: boolean } {
  for (const src of registered) state.handled.set(key(src), null);
  const ready: MediaFile[] = [];
  let waiting = false;
  for (const f of files) {
    const k = key(f.src);
    const seen = state.handled.get(k);
    if (seen === null || seen === f.size) continue;
    if (f.size > 0 && state.sizes.get(k) === f.size) {
      state.sizes.delete(k);
      state.handled.set(k, null);
      ready.push(f);
    } else {
      state.sizes.set(k, f.size);
      waiting = true;
    }
  }
  return { ready, waiting };
}

/** A video or audio file ffprobe can't read yet has no length, and a clip can't be cut from it. */
export function isUsableAsset(a: Asset): boolean {
  return (a.kind !== "video" && a.kind !== "audio") || !!a.durationInFrames;
}

/** Adds files that appear in the open project's media folder to its assets, as when an agent
 *  copies footage in without touching timeline.json. */
export function useNewMedia(workspace: string, slug: string, ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const state: NewMediaState = { handled: new Map(), sizes: new Map() };
    let alive = true;
    let baseline = true;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void scan(), SETTLE_MS);
    };

    const pass = async () => {
      const files = await listMedia(workspace, slug);
      const timeline = getTimelineState().timeline;
      if (!alive || !timeline) return;
      if (baseline) {
        baseline = false;
        markAllHandled(state, files);
        return;
      }
      // A drag recomputes the document from where it began, which would lose the new assets.
      if (isGestureActive()) return later();
      const { ready: settled, waiting } = pickSettled(state, files, timeline.assets.map((a) => a.src));
      if (waiting) later();
      if (!settled.length) return;
      const added = await importMedia(workspace, slug, settled.map((f) => f.path));
      if (!alive) return;
      for (const a of added.filter((x) => !isUsableAsset(x))) {
        const file = settled.find((f) => key(f.src) === key(a.src));
        if (file) state.handled.set(key(a.src), file.size);
      }
      const usable = added.filter(isUsableAsset);
      if (!usable.length) return;
      timelineActions.apply((tl) => {
        const known = new Set(tl.assets.map((a) => key(a.src)));
        return withAssets(tl, usable.filter((a) => !known.has(key(a.src))));
      });
    };

    const scan = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        await pass();
      } catch {
        // The next change on disk looks again.
      } finally {
        running = false;
        if (again && alive) {
          again = false;
          void scan();
        }
      }
    };

    void scan();
    const off = subscribeFsChange(workspace, () => void scan());
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [workspace, slug, ready]);
}

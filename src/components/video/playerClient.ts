import { playerKill, playerStart, playerStop, type PlayerInfo } from "@/lib/video/videoApi";

/**
 * One player server per project, shared by whoever shows it, stopped a moment after the last
 * user lets go.
 *
 * Why: `video_player_start` returns the running server when there is one, and
 * `video_player_stop` marks it idle (the backend keeps it warm, then stops it). Starting and
 * stopping straight from a React effect raced: StrictMode (and closing then reopening a project)
 * runs start → stop → start, and a stop landing after the second start would mark a server in
 * use as idle, so it could be stopped under the player.
 */
interface Entry {
  refs: number;
  info: Promise<PlayerInfo>;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

/** Long enough that going back to the list and reopening doesn't start the server again. */
const STOP_DELAY_MS = 30_000;
const entries = new Map<string, Entry>();
const keyOf = (workspace: string, slug: string) => `${workspace}\n${slug}`;

/** The project's player server, started if needed. Pair every call with `releasePlayer`. */
export function acquirePlayer(workspace: string, slug: string): Promise<PlayerInfo> {
  const key = keyOf(workspace, slug);
  // A failed start isn't kept: the next acquire (Retry) tries again.
  const start = () => {
    const info = playerStart(workspace, slug);
    info.catch(() => {
      if (entries.get(key)?.info === info) entries.delete(key);
    });
    return info;
  };
  const e = entries.get(key);
  if (e) {
    if (e.stopTimer) clearTimeout(e.stopTimer);
    e.stopTimer = null;
    // Nobody held it during the grace period: the backend may have stopped it (a rename, a
    // delete). It answers at once with the running server when there is one.
    if (e.refs === 0) e.info = start();
    e.refs++;
    return e.info;
  }
  const info = start();
  entries.set(key, { refs: 1, info, stopTimer: null });
  return info;
}

export function releasePlayer(workspace: string, slug: string): void {
  const key = keyOf(workspace, slug);
  const e = entries.get(key);
  if (!e) return;
  e.refs = Math.max(0, e.refs - 1);
  if (e.refs > 0 || e.stopTimer) return;
  e.stopTimer = setTimeout(() => {
    if (entries.get(key) !== e || e.refs > 0) return;
    entries.delete(key);
    void e.info.then(() => playerStop(workspace, slug), () => {}).catch(() => {});
  }, STOP_DELAY_MS);
}

/** Asks the backend again for a project whose server may have been stopped behind our back
 *  (a rename that couldn't move the folder, a conversion): the same server if it is alive, a
 *  new one otherwise. The next acquire gets the answer. */
export async function revalidatePlayer(workspace: string, slug: string): Promise<void> {
  const e = entries.get(keyOf(workspace, slug));
  if (!e) return;
  e.info = playerStart(workspace, slug);
  await e.info.catch(() => {});
}

/** Retry: stops the project's server (whatever state it is in) so the next acquire starts a
 *  fresh one. */
export async function resetPlayer(workspace: string, slug: string): Promise<void> {
  const key = keyOf(workspace, slug);
  const e = entries.get(key);
  if (e?.stopTimer) clearTimeout(e.stopTimer);
  entries.delete(key);
  await e?.info.catch(() => {});
  await playerKill(workspace, slug).catch(() => {});
}

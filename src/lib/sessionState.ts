import { useMemo } from "react";
import { useNow } from "@/lib/useNow";

export type SessionState = "blocked" | "review" | "completed";

const RECENT_MS = 24 * 60 * 60 * 1000;

export function classifySession(opts: {
  blocked: boolean;
  streaming: boolean;
  modifiedAt: number;
  messageCount: number;
  now: number;
}): SessionState | null {
  if (opts.blocked) return "blocked";
  if (opts.streaming) return null;
  if (opts.messageCount === 0) return null;
  return opts.now - opts.modifiedAt < RECENT_MS ? "review" : "completed";
}

export const SESSION_STATE_META: Record<SessionState, { label: string; cls: string; tip: string }> = {
  blocked: { label: "Blocked", cls: "bg-amber-500/15 text-amber-400", tip: "Waiting for your input (permission or question)" },
  review: { label: "Review", cls: "bg-blue-500/15 text-blue-400", tip: "A turn finished — ready for you to review" },
  completed: { label: "Done", cls: "bg-emerald-500/15 text-emerald-400", tip: "Idle for a while — likely completed" },
};

/** The sidebar's state badge of each session (off unless `classifySessionStates` is set): blocked
 *  while it waits on the user, else review or done by how recently it changed. */
export function useSessionStates(
  enabled: boolean,
  sessions: { id: string; modifiedAt: number; messageCount: number }[],
  blockedIds: string[],
  streamingIds: ReadonlySet<string>,
): Record<string, SessionState> {
  const now = useNow();
  // The ids arrive as a new array each render; the memo keys on their content (word slugs, no spaces).
  const blockedKey = blockedIds.join(" ");
  return useMemo(() => {
    if (!enabled) return {};
    const blocked = new Set(blockedKey.split(" "));
    const out: Record<string, SessionState> = {};
    for (const s of sessions) {
      const state = classifySession({ blocked: blocked.has(s.id), streaming: streamingIds.has(s.id), modifiedAt: s.modifiedAt, messageCount: s.messageCount, now });
      if (state) out[s.id] = state;
    }
    return out;
  }, [enabled, sessions, blockedKey, streamingIds, now]);
}

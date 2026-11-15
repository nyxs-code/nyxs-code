import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { ragConfig, ragIndex, ragServiceAllowed } from "@/lib/rag";

/** Keeps the semantic index of the open folder current when auto-indexing is on: shortly after
 *  the folder opens, and whenever `reindexRag` is called (after a turn that edited files). It
 *  never runs during a reply: a request made then waits until every reply has ended. Nothing is
 *  indexed for a project whose text may not go to the Nyxs service (ragServiceAllowed). With
 *  `explicit` (the user just said "Index"), it runs with auto-indexing off too. */
export function useRagAutoIndex(workspace: string | null, idle: boolean) {
  const inFlightRef = useRef(false);
  const pendingRef = useRef<{ ws: string; explicit: boolean } | null>(null);
  const idleRef = useRef(idle);
  useLayoutEffect(() => { idleRef.current = idle; }, [idle]);

  const reindexRag = useCallback((ws: string | null, explicit = false) => {
    if (!ws || inFlightRef.current) return;
    const cfg = ragConfig();
    if (!cfg.enabled || (!cfg.autoIndex && !explicit)) return;
    if (!idleRef.current) {
      pendingRef.current = { ws, explicit };
      return;
    }
    inFlightRef.current = true;
    void ragServiceAllowed(ws)
      .then((allowed) => (allowed ? ragIndex(ws) : undefined))
      .catch(() => { /* tried again on the next change */ })
      .finally(() => { inFlightRef.current = false; });
  }, []);

  useEffect(() => {
    if (!idle || !pendingRef.current) return;
    const { ws, explicit } = pendingRef.current;
    pendingRef.current = null;
    reindexRag(ws, explicit);
  }, [idle, reindexRag]);

  useEffect(() => {
    if (!workspace) return;
    const id = setTimeout(() => reindexRag(workspace), 2000);
    return () => clearTimeout(id);
  }, [workspace, reindexRag]);

  return reindexRag;
}

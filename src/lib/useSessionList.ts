import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@/lib/ipc";
import { DEFAULT_CLEANUP_PERIOD_DAYS } from "@/lib/configSchema";
import { autoArchiveMergedSessions, onPrLinked } from "@/lib/prArchive";
import { readSessionPrs } from "@/lib/sessionPrs";
import { archiveInactiveSessions, inactiveDaysOf } from "@/lib/inactiveArchive";
import { sessionsWithBackgroundWork, setSessionInUseCheck } from "@/lib/sessionsInUse";
import { listSessionsByState, type SessionSummary } from "@/lib/sessionStorage";
import { getMergedSettings } from "@/lib/settingsRuntime";
import { loadRecentWorkspaces } from "@/lib/workspace";

function reconcileRecentOrder(prev: string[], sessions: Array<{ id: string }>): string[] {
  const ids = sessions.map((s) => s.id);
  const present = new Set(ids);
  const kept = prev.filter((id) => present.has(id));
  const keptSet = new Set(kept);
  const next = [...kept, ...ids.filter((id) => !keptSet.has(id))];
  return next.length === prev.length && next.every((v, i) => v === prev[i]) ? prev : next;
}

/** The saved sessions of the open folder and the recent ones, for the sidebar: read again when
 *  the folder changes and when every reply has ended, sorted with the latest used first, plus
 *  the archived ones. Also archives sessions whose PR was merged (except those `keepOpen`
 *  names: the one on screen and those with a turn running) and deletes old ones. */
export function useSessionList(workspace: string | null, idle: boolean, keepOpen?: (id: string) => boolean) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<SessionSummary[]>([]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  /** The first listing has arrived: before it, an empty project isn't known to be empty. */
  const [sessionsLoaded, setSessionsLoaded] = useState(false);

  // Stable, so timers and effects can call it without depending on the folder.
  const workspaceRef = useRef(workspace);
  useLayoutEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  // Refreshes overlap (every save asks for one): only the latest one started may set the list,
  // or a listing read before a delete lands after it and shows the session again.
  const refreshSeqRef = useRef(0);
  const refreshSessions = useCallback(() => {
    const seq = ++refreshSeqRef.current;
    void listSessionsByState([workspaceRef.current, ...loadRecentWorkspaces()]).then(({ active, archived }) => {
      if (seq !== refreshSeqRef.current) return;
      setSessions(active);
      setArchivedSessions(archived);
      setSessionsLoaded(true);
    });
  }, []);
  /** Takes deleted sessions off both lists right away, moving the children of `parentId` that
   *  stay to `newParent`, without waiting for every folder to be listed again. */
  const dropSessions = useCallback((ids: string[], parentId: string, newParent: string | undefined) => {
    const gone = new Set(ids);
    const drop = (list: SessionSummary[]) =>
      list.filter((s) => !gone.has(s.id)).map((s) => (s.parentId === parentId ? { ...s, parentId: newParent } : s));
    setSessions(drop);
    setArchivedSessions(drop);
  }, []);
  useEffect(() => { refreshSessions(); }, [workspace, refreshSessions]);
  useEffect(() => {
    if (idle) refreshSessions();
  }, [idle, refreshSessions]);
  // The link is written after the turn's own refresh, and mid-turn when the agent opened the PR.
  useEffect(() => onPrLinked(() => refreshSessions()), [refreshSessions]);

  const sessionsRef = useRef<SessionSummary[]>(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  const keepOpenRef = useRef(keepOpen);
  useLayoutEffect(() => { keepOpenRef.current = keepOpen; }, [keepOpen]);
  // Settings' worktree cleanup and the archiving below leave these sessions alone.
  useEffect(() => {
    setSessionInUseCheck((id) => keepOpenRef.current?.(id) ?? false);
    return () => setSessionInUseCheck(() => false);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const inUse = (id: string) => keepOpenRef.current?.(id) ?? false;
    const tick = async () => {
      try {
        const cfg = await getMergedSettings();
        let changed = false;
        if ((cfg as { pullRequests?: { autoArchive?: boolean } }).pullRequests?.autoArchive) {
          const archived = await autoArchiveMergedSessions(sessionsRef.current, (s) => readSessionPrs(s), { skip: inUse });
          changed ||= archived.length > 0;
        }
        const days = inactiveDaysOf(cfg);
        if (days > 0) {
          const busy = await sessionsWithBackgroundWork();
          const archived = await archiveInactiveSessions(sessionsRef.current, { days, inUse, busy });
          changed ||= archived.length > 0;
        }
        if (!cancelled && changed) refreshSessions();
      } catch {
        // Retried on the next tick.
      }
    };
    void tick();
    const h = setInterval(tick, 5 * 60_000);
    return () => { cancelled = true; clearInterval(h); };
  }, [refreshSessions]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cfg = await getMergedSettings();
        const periodDays = (cfg.cleanupPeriodDays as number | undefined) ?? DEFAULT_CLEANUP_PERIOD_DAYS;
        const report = await invoke<{ sessionsDeleted: number }>("nyxs_cleanup_old_sessions", { periodDays });
        if (alive && report.sessionsDeleted > 0) refreshSessions();
      } catch {
        // Tried again on the next start.
      }
    })();
    return () => { alive = false; };
  }, [refreshSessions]);

  const [recentOrder, setRecentOrder] = useState<string[]>([]);
  const bumpRecent = useCallback((id: string) => {
    setRecentOrder((prev) => [id, ...prev.filter((x) => x !== id)]);
  }, []);
  const reconciledOrder = reconcileRecentOrder(recentOrder, sessions);
  if (reconciledOrder !== recentOrder) setRecentOrder(reconciledOrder);
  const orderedSessions = useMemo(() => {
    const rank = new Map(reconciledOrder.map((id, i) => [id, i] as const));
    return [...sessions].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  }, [sessions, reconciledOrder]);

  return {
    sessions,
    sessionsLoaded,
    setSessions,
    orderedSessions,
    archivedSessions,
    archivedOpen,
    setArchivedOpen,
    refreshSessions,
    dropSessions,
    bumpRecent,
  };
}

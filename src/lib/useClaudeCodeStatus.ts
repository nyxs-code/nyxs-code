import { useCallback, useEffect, useRef, useState } from "react";
import { localizedError } from "@/lib/i18n";
import {
  cachedClaudePlanUsage,
  fetchClaudePlanUsage,
  getClaudeCodeStatus,
  onClaudePlanUsage,
  openClaudeCodeTerminal,
  type ClaudeCodeStatus,
  type PlanUsage,
} from "@/lib/claudeCode";
import { persistedCache } from "@/lib/swrCache";
import { cancelCliInstall, installCli } from "@/lib/agentCli";
import { planUsageView, type UsageReading } from "@/lib/useAgentCliStatus";

export type ClaudeCodePhase = "checking" | "missing" | "loggedOut" | "ready" | "error";
export type ClaudeCodeWaiting = "install" | "login" | null;

const POLL_MS = 3000;
const POLL_LIMIT_MS = 10 * 60 * 1000;

function phaseOf(status: ClaudeCodeStatus): ClaudeCodePhase {
  if (!status.installed) return "missing";
  return status.loggedIn ? "ready" : "loggedOut";
}

/** The last status is shown at once, even after a restart, and `claude` runs again quietly when
 *  it's older than this. Only a ready one counts as fresh: it may have been installed or signed
 *  in from a terminal since. The refresh button always checks. */
const STATUS_TTL_MS = 10 * 60 * 1000;
const lastStatus = persistedCache<ClaudeCodeStatus>("nyxs.claudeCodeStatus.v1");
const isFresh = () => {
  const last = lastStatus.get("claude");
  return !!last && phaseOf(last.value) === "ready" && Date.now() - last.at < STATUS_TTL_MS;
};

/** `reuse` starts from the last status, checking again only when it's stale (the settings);
 *  the connect dialog always checks, since its `onReady` connects. */
export function useClaudeCodeStatus(onReady?: (status: ClaudeCodeStatus) => void, reuse = false) {
  const [initial] = useState(() => (reuse ? (lastStatus.get("claude")?.value ?? null) : null));
  const [stale] = useState(() => !reuse || !isFresh());
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(initial);
  const [phase, setPhase] = useState<ClaudeCodePhase>(initial ? phaseOf(initial) : "checking");
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState<ClaudeCodeWaiting>(null);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  });

  const check = useCallback(
    (): Promise<ClaudeCodePhase> =>
      getClaudeCodeStatus().then(
        (next) => {
          lastStatus.set("claude", next);
          setStatus(next);
          setError("");
          const p = phaseOf(next);
          setPhase(p);
          if (p === "ready") {
            setWaiting(null);
            onReadyRef.current?.(next);
          }
          return p;
        },
        (err: unknown) => {
          setError(localizedError(err));
          // A quiet check that fails keeps showing the last status it had.
          setPhase((prev) => (prev === "checking" ? "error" : prev));
          return "error";
        },
      ),
    [],
  );

  useEffect(() => {
    if (stale) void check();
  }, [check, stale]);

  useEffect(() => {
    if (waiting !== "login") return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > POLL_LIMIT_MS) {
        setWaiting(null);
        return;
      }
      void check();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, check]);

  const open = useCallback(
    async (action: "install" | "login") => {
      setError("");
      if (action === "install") {
        // Installed quietly, the way zeron does; the status is read again once it's done.
        setWaiting("install");
        try {
          await installCli("claude-code");
          await check();
        } catch (err) {
          setError(localizedError(err));
        } finally {
          setWaiting(null);
        }
        return;
      }
      try {
        await openClaudeCodeTerminal(action);
        setWaiting(action);
      } catch (err) {
        setError(localizedError(err));
      }
    },
    [check],
  );

  const cancelInstall = useCallback(() => void cancelCliInstall("claude-code").catch(() => undefined), []);

  return { status, phase, error, waiting, check, open, cancelInstall };
}

/** The plan limits of the signed-in Claude account, the last reading shown while a new one loads. */
export function useClaudePlanUsage(ready: boolean) {
  const [usage, setUsage] = useState<PlanUsage | null>(() => cachedClaudePlanUsage());
  const [reading, setReading] = useState<UsageReading>(null);
  const load = useCallback((force: boolean) => {
    setReading(force ? "forced" : "quiet");
    fetchClaudePlanUsage(force)
      .then((value) => {
        if (value) setUsage(value);
      })
      .finally(() => setReading(null));
  }, []);
  useEffect(() => {
    if (ready) void Promise.resolve().then(() => load(false));
  }, [ready, load]);
  // Each turn's own report keeps the bars moving while the panel is open.
  useEffect(() => onClaudePlanUsage(setUsage), []);
  return { ...planUsageView(usage, reading), load };
}

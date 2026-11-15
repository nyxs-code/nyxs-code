import { useCallback, useEffect, useRef, useState } from "react";
import { localizedError } from "@/lib/i18n";
import type { ProviderId } from "@/lib/models";
import {
  agentCliOf,
  cachedAgentCliPlanUsage,
  fetchAgentCliPlanUsage,
  cancelCliInstall,
  getAgentCliStatus,
  installCli,
  openAgentCliTerminal,
  reportsPlanUsage,
  type AgentCliId,
  type AgentCliStatus,
} from "@/lib/agentCli";
import type { PlanUsage } from "@/lib/claudeCode";
import { persistedCache } from "@/lib/swrCache";

const POLL_MS = 3000;
const POLL_LIMIT_MS = 10 * 60 * 1000;
/** For a CLI that can't tell whether it's signed in, how long "waiting" shows after opening its login. */
const BLIND_LOGIN_WAIT_MS = 8000;

export type CliWaiting = "install" | "login" | null;

/** A CLI's last status is shown at once, even after a restart, and checked again quietly when
 *  it's older than this. Only a ready CLI's status counts as fresh: a missing or signed-out one
 *  may have been installed or signed in from a terminal since, so it's always checked again. The
 *  refresh button always checks. */
const STATUS_TTL_MS = 10 * 60 * 1000;
const lastStatus = persistedCache<AgentCliStatus>("nyxs.agentCliStatus.v1");
function isFresh(cli: AgentCliId): boolean {
  const last = lastStatus.get(cli);
  return !!last && last.value.installed && last.value.loggedIn !== false && Date.now() - last.at < STATUS_TTL_MS;
}

/** Whether the provider's CLI is installed and signed in: checked again after installing it
 *  (quietly, see `cli_install`) and while a terminal signing in is open. `onSignedIn` runs when a sign-in is seen to finish.
 *  `revalidate` checks even with a fresh status, which is shown meanwhile (the connect dialog). */
export function useAgentCliStatus(provider: ProviderId, onSignedIn?: () => void, revalidate = false) {
  const cli = agentCliOf(provider) as AgentCliId;
  const [stale] = useState(() => !isFresh(cli));
  const [status, setStatus] = useState<AgentCliStatus | null>(() => lastStatus.get(cli)?.value ?? null);
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState<CliWaiting>(null);
  const onSignedInRef = useRef(onSignedIn);
  useEffect(() => {
    onSignedInRef.current = onSignedIn;
  });

  const check = useCallback(
    (): Promise<AgentCliStatus | null> =>
      getAgentCliStatus(cli).then(
        (next) => {
          lastStatus.set(cli, next);
          setStatus(next);
          setError("");
          return next;
        },
        (err: unknown) => {
          setError(localizedError(err));
          return null;
        },
      ),
    [cli],
  );

  useEffect(() => {
    if (stale || revalidate) void check();
  }, [check, stale, revalidate]);

  useEffect(() => {
    if (waiting !== "login") return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > POLL_LIMIT_MS) {
        setWaiting(null);
        return;
      }
      void check().then((s) => {
        if (s?.loggedIn) {
          setWaiting(null);
          onSignedInRef.current?.();
        }
      });
    }, POLL_MS);
    // A CLI that can't report its sign-in leaves nothing to wait for: the terminal is the user's.
    const stopBlind =
      waiting === "login" && status?.loggedIn == null ? setTimeout(() => setWaiting(null), BLIND_LOGIN_WAIT_MS) : null;
    return () => {
      clearInterval(timer);
      if (stopBlind) clearTimeout(stopBlind);
    };
  }, [waiting, check, status?.loggedIn]);

  const open = useCallback(
    async (action: "install" | "login") => {
      setError("");
      if (action === "install") {
        // Installed quietly, the way zeron does; the status is read again once it's done.
        setWaiting("install");
        try {
          await installCli(cli);
          await check();
        } catch (err) {
          setError(localizedError(err));
        } finally {
          setWaiting(null);
        }
        return;
      }
      try {
        await openAgentCliTerminal(cli, action);
        setWaiting(action);
      } catch (err) {
        setError(localizedError(err));
      }
    },
    [cli, check],
  );

  const cancelInstall = useCallback(() => void cancelCliInstall(cli).catch(() => undefined), [cli]);

  return { status, error, waiting, check, open, cancelInstall };
}

/** A plan-usage reading under way: one the page started quietly, or one the user asked for. */
export type UsageReading = "quiet" | "forced" | null;

/** What a plan-usage hook gives the page: the last reading at once, `loading` only while there
 *  is none yet to show, `refreshing` only for a reading the user asked for. */
export function planUsageView(usage: PlanUsage | null, reading: UsageReading) {
  return { usage, loading: reading !== null && !usage, refreshing: reading === "forced" };
}

/** The CLI's plan limits where it reports them, the last reading shown while a new one loads. */
export function useAgentCliPlanUsage(provider: ProviderId, ready: boolean) {
  const cli = agentCliOf(provider);
  const [usage, setUsage] = useState<PlanUsage | null>(() => (cli ? cachedAgentCliPlanUsage(cli) : null));
  const [reading, setReading] = useState<UsageReading>(null);
  const load = useCallback(
    (force: boolean) => {
      if (!reportsPlanUsage(cli)) return;
      setReading(force ? "forced" : "quiet");
      fetchAgentCliPlanUsage(cli, force)
        .then((value) => {
          if (value) setUsage(value);
        })
        .finally(() => setReading(null));
    },
    [cli],
  );
  useEffect(() => {
    if (ready) void Promise.resolve().then(() => load(false));
  }, [ready, load]);
  return { ...planUsageView(usage, reading), load };
}

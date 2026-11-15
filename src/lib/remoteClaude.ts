import { useCallback, useSyncExternalStore } from "react";
import { invoke } from "@/lib/ipc";
import { claudeCodeNeedsUpdate } from "./claudeCodeCli";
import { openExternalUrl } from "./openExternal";

// Getting Claude Code ready on a remote machine, so a turn there only needs the user to sign in.
// One run per machine: every chat waiting on that machine shares it.

/** The oldest version with every flag `run_args` passes (args.rs): an older CLI exits on start. */
const MIN_REMOTE_VERSION = "2.1.316";

export type RemoteClaudeFailure = "download" | "noDownloader" | "other";

export type RemoteClaudeStep =
  | { kind: "checking" }
  | { kind: "installing" }
  | { kind: "updating" }
  /** `error`: the last attempt failed; what it said, when it said anything. */
  | { kind: "login"; error?: string }
  /** `manualUrl` is missing until the machine has printed its links. */
  | { kind: "signingIn"; manualUrl?: string; automatic: boolean; askCode: boolean }
  | { kind: "failed"; reason: RemoteClaudeFailure; detail: string };

interface RemoteStatus {
  installed: boolean;
  version?: string | null;
  loggedIn?: boolean | null;
}

interface RemoteOutcome {
  ok: boolean;
  reason?: RemoteClaudeFailure | null;
  detail: string;
}

interface Run {
  waiters: number;
  cancelled: boolean;
  /** Set while the run waits on the user. */
  wake: (() => void) | null;
  done: Promise<void>;
}

const ready = new Set<string>();
const runs = new Map<string, Run>();
const steps = new Map<string, RemoteClaudeStep>();
const listeners = new Set<() => void>();

function setStep(host: string, step: RemoteClaudeStep | null): void {
  if (step) steps.set(host, step);
  else steps.delete(host);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the machine's run is doing now, for its card in the chat. */
export function useRemoteClaudeStep(host: string): RemoteClaudeStep | null {
  const read = useCallback(() => steps.get(host) ?? null, [host]);
  return useSyncExternalStore(subscribe, read);
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Resolves when the user acts on the card (or everyone waiting left). */
const untilWoken = (run: Run) => new Promise<void>((resolve) => { run.wake = resolve; });

function wake(run: Run): void {
  const resume = run.wake;
  run.wake = null;
  resume?.();
}

async function drive(host: string, run: Run): Promise<void> {
  let installTried = false;
  let updateTried = false;
  const fail = async (reason: RemoteClaudeFailure, detail: string) => {
    setStep(host, { kind: "failed", reason, detail });
    await untilWoken(run);
    installTried = false;
  };
  while (!run.cancelled) {
    if (steps.get(host)?.kind !== "login") setStep(host, { kind: "checking" });
    let status: RemoteStatus;
    try {
      status = await invoke<RemoteStatus>("claude_code_remote_status", { host });
    } catch (err) {
      await fail("other", message(err));
      continue;
    }
    if (run.cancelled) return;
    if (!status.installed) {
      if (installTried) {
        await fail("other", "");
        continue;
      }
      installTried = true;
      setStep(host, { kind: "installing" });
      const outcome = await invoke<RemoteOutcome>("claude_code_remote_install", { host }).catch(
        (err): RemoteOutcome => ({ ok: false, reason: "other", detail: message(err) }),
      );
      if (!outcome.ok && !run.cancelled) await fail(outcome.reason ?? "other", outcome.detail);
      continue;
    }
    if (!updateTried && claudeCodeNeedsUpdate(status.version, MIN_REMOTE_VERSION)) {
      updateTried = true;
      setStep(host, { kind: "updating" });
      // If it can't update, the turn goes on and reports what the old version says.
      await invoke("claude_code_remote_update", { host }).catch(() => undefined);
      continue;
    }
    if (status.loggedIn === false) {
      if (steps.get(host)?.kind !== "login") setStep(host, { kind: "login" });
      await untilWoken(run);
      continue;
    }
    ready.add(host);
    return;
  }
}

function leave(host: string, run: Run): void {
  run.waiters -= 1;
  if (run.waiters > 0) return;
  // An install under way finishes on its own; a sign-in has nobody left to come back to.
  run.cancelled = true;
  void invoke("claude_code_remote_login_cancel", { host }).catch(() => undefined);
  wake(run);
}

const aborted = () => new DOMException("Aborted", "AbortError");

/** Resolves once Claude Code on `host` is installed, current and signed in, doing whatever is
 *  missing. Rejects with an AbortError when `signal` fires; the user sees the rest on the card. */
export async function ensureRemoteClaude(host: string, signal?: AbortSignal): Promise<void> {
  if (ready.has(host)) return;
  let run = runs.get(host);
  // Everyone left this one: it may still be finishing an install the next run shouldn't repeat.
  if (run?.cancelled) {
    await run.done;
    if (ready.has(host)) return;
    run = runs.get(host);
  }
  if (signal?.aborted) throw aborted();
  if (!run) {
    const created: Run = { waiters: 0, cancelled: false, wake: null, done: Promise.resolve() };
    created.done = drive(host, created).finally(() => {
      runs.delete(host);
      setStep(host, null);
    });
    runs.set(host, created);
    run = created;
  }
  const current = run;
  current.waiters += 1;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      leave(host, current);
      reject(aborted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void current.done.then(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/** The same for a turn nobody is watching (headless, an orchestrator's workers), which has no card
 *  to ask from: what can be done alone is done, and it answers false if only signing in is left
 *  rather than wait for someone who won't come. */
export async function ensureRemoteClaudeUnattended(host: string): Promise<boolean> {
  if (ready.has(host)) return true;
  let status = await invoke<RemoteStatus>("claude_code_remote_status", { host });
  if (!status.installed) {
    const outcome = await invoke<RemoteOutcome>("claude_code_remote_install", { host });
    if (!outcome.ok) throw new Error(`No se pudo instalar Claude Code en ${host}${outcome.detail ? `: ${outcome.detail}` : ""}`);
    status = await invoke<RemoteStatus>("claude_code_remote_status", { host });
  }
  if (status.loggedIn === false) return false;
  ready.add(host);
  return true;
}

/** What's known about `host` no longer holds (Claude Code exited or says it isn't signed in):
 *  the machine's next turn checks it again. */
export function forgetRemoteClaude(host: string | null): void {
  if (host) ready.delete(host);
}

/** The card's "Sign in": starts it on the machine, opens the browser here, and carries the turn
 *  on when it's done. */
export async function signInRemoteClaude(host: string): Promise<void> {
  const run = runs.get(host);
  if (!run) return;
  setStep(host, { kind: "signingIn", automatic: false, askCode: false });
  let links: { url: string; manualUrl: string; automatic: boolean };
  try {
    links = await invoke("claude_code_remote_login_start", { host });
  } catch (err) {
    setStep(host, { kind: "login", error: message(err) });
    return;
  }
  if (run.cancelled) {
    void invoke("claude_code_remote_login_cancel", { host }).catch(() => undefined);
    return;
  }
  openExternalUrl(links.url);
  setStep(host, { kind: "signingIn", manualUrl: links.manualUrl, automatic: links.automatic, askCode: !links.automatic });
  const end = await invoke<{ ok: boolean; cancelled: boolean; detail: string }>("claude_code_remote_login_wait", { host }).catch(
    (err) => ({ ok: false, cancelled: false, detail: message(err) }),
  );
  if (end.cancelled || run.cancelled) return;
  if (end.ok) wake(run);
  else setStep(host, { kind: "login", error: end.detail });
}

/** The way back from a browser that couldn't reach the machine: the link that ends in a code. */
export function askRemoteSignInCode(host: string): void {
  const step = steps.get(host);
  if (step?.kind !== "signingIn" || !step.manualUrl) return;
  openExternalUrl(step.manualUrl);
  setStep(host, { ...step, askCode: true });
}

export async function sendRemoteSignInCode(host: string, code: string): Promise<void> {
  await invoke("claude_code_remote_login_code", { host, code }).catch((err) => {
    setStep(host, { kind: "login", error: message(err) });
  });
}

/** The card's "Retry" after a failure. */
export function retryRemoteClaude(host: string): void {
  const run = runs.get(host);
  if (run) wake(run);
}

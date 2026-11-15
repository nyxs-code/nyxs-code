import { invoke } from "@/lib/ipc";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { runningClaudeCodeTasks } from "./claudeCodeTasks";
import { live, procs, retire } from "./claudeCodeProcesses";

// The Claude Code CLI itself: whether it is installed and signed in, and keeping it current.

export interface ClaudeCodeStatus {
  installed: boolean;
  path?: string | null;
  version?: string | null;
  loggedIn: boolean;
  auth?: Record<string, unknown> | null;
}

export function getClaudeCodeStatus(): Promise<ClaudeCodeStatus> {
  return invoke<ClaudeCodeStatus>("claude_code_status");
}

export function openClaudeCodeTerminal(action: "login"): Promise<void> {
  return invoke<void>("claude_code_open_terminal", { action });
}

export async function updateClaudeCode(): Promise<string> {
  const output = await invoke<string>("claude_code_update");
  retireIdleProcesses();
  for (const listener of updateListeners) listener();
  return output;
}

const CLI_REGISTRY_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
// Looked up on each call, not at load: a test's stubbed fetch must be the one used, or the test
// asked npm for real and broke as soon as a newer Claude Code came out.
const httpFetch: typeof fetch = (input, init) => (isTauri ? (tauriFetch as unknown as typeof fetch) : fetch)(input, init);

export async function fetchClaudeCodeLatestVersion(): Promise<string> {
  const res = await httpFetch(CLI_REGISTRY_URL);
  if (!res.ok) throw new Error(`npm respondió ${res.status}`);
  const body = (await res.json()) as { version?: string };
  if (!body.version) throw new Error("npm no devolvió una versión");
  return body.version;
}

function versionParts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
}

/** True when `latest` is newer than `current`. Unreadable versions never trigger a prompt. */
export function claudeCodeNeedsUpdate(current: string | null | undefined, latest: string | null | undefined): boolean {
  if (!current || !latest) return false;
  const a = versionParts(current);
  const b = versionParts(latest);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return right > left;
  }
  return false;
}

const updateListeners = new Set<() => void>();

/** Called after the CLI was updated in the background, so open panels re-read its version. */
export function onClaudeCodeUpdated(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
  };
}

/** Parked processes still run the old binary after an update: let the idle ones go, the next
 *  turn resumes their session with the new one. Ones with background work are left alone. */
function retireIdleProcesses(): void {
  for (const proc of new Set(live.values())) {
    if (!proc.sink && !proc.backlog && !proc.expectsWake && runningClaudeCodeTasks(proc.runId) === 0) retire(proc);
  }
}

/** Whether any process is in a turn, ours or one Claude Code started on its own. Checked on
 *  `procs`, not `live`: a process leaves `live` while it runs a turn and only goes back when
 *  it is parked. */
function turnRunning(): boolean {
  return [...procs.values()].some((p) => p.sink || p.backlog);
}

let updateRun: Promise<boolean> | null = null;
/** The last check found an update but held it back for a running turn. */
let updateDeferred = false;

/** Updates the CLI on its own when a newer version is out. Skipped while a turn is running,
 *  since the update replaces the binary that turn is using; it is tried again later. */
export function autoUpdateClaudeCode(): Promise<boolean> {
  updateRun ??= (async () => {
    updateDeferred = false;
    try {
      const status = await getClaudeCodeStatus();
      if (!status.installed) return false;
      const latest = await fetchClaudeCodeLatestVersion();
      if (!claudeCodeNeedsUpdate(status.version, latest)) return false;
      if (turnRunning()) {
        updateDeferred = true;
        return false;
      }
      await updateClaudeCode();
      return true;
    } catch {
      return false;
    } finally {
      updateRun = null;
    }
  })();
  return updateRun;
}

/** Renews the Claude login shortly before it expires, from a single process, so chats never
 *  race each other to refresh it (a lost race used to force a new sign-in). */
export function keepClaudeLoginFresh(): Promise<void> {
  return invoke<void>("claude_code_keep_login_fresh").catch(() => undefined);
}

const KEEP_LOGIN_FRESH_MS = 5 * 60 * 1000;
const UPDATE_CHECK_MS = 3 * 60 * 60 * 1000;
const RETRY_UPDATE_MS = 10 * 60 * 1000;

/** While the app runs with Claude Code connected: keeps the login fresh and the CLI current. */
export function startClaudeCodeMaintenance(): () => void {
  let stopped = false;
  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleUpdate = (ms: number) => {
    updateTimer = setTimeout(() => {
      void autoUpdateClaudeCode().then(() => {
        if (stopped) return;
        scheduleUpdate(updateDeferred ? RETRY_UPDATE_MS : UPDATE_CHECK_MS);
      });
    }, ms);
  };
  void keepClaudeLoginFresh();
  const loginTimer = setInterval(() => void keepClaudeLoginFresh(), KEEP_LOGIN_FRESH_MS);
  scheduleUpdate(15_000);
  return () => {
    stopped = true;
    clearInterval(loginTimer);
    if (updateTimer) clearTimeout(updateTimer);
  };
}

/** Who is signed in to Claude Code (email, or the organization) and their plan ("Max"). */
export function claudeCodeAccount(status: ClaudeCodeStatus): { who: string; plan: string } {
  const auth = status.auth ?? {};
  const pick = (k: string) => (typeof auth[k] === "string" ? (auth[k] as string) : "");
  const plan = pick("subscriptionType");
  return { who: pick("email") || pick("emailAddress") || pick("orgName"), plan: plan && plan.charAt(0).toUpperCase() + plan.slice(1) };
}

export function claudeCodeAccountLabel(status: ClaudeCodeStatus): string {
  const { who, plan } = claudeCodeAccount(status);
  return [who, plan].filter(Boolean).join(" · ");
}

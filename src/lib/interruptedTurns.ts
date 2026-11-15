import { loadReloadState, saveReloadState } from "@/lib/reloadState";

// Turns of API models run in this page, so anything that ends the page cuts them: a reload, the
// app restarting (`tauri dev` rebuilding, an update), the user closing it, or a crash. The running
// ones are kept in localStorage, which outlives all of those, so the app can deal with them when
// it's back: a reload or a cut from a few minutes ago carries on by itself; a window the user
// closed, or a cut from long ago, waits for the user to say so (see resumeInterruptedTurns).
//
// localStorage is shared by every window of the same build and profile, so a second window must
// not take a turn the first one is still running: each running turn holds a Web Lock, which the
// browser drops when the page dies, and a turn whose lock is held is left alone.

/** A turn running in this page, as remembered in case the page dies. */
interface RunningTurn {
  modelId: string;
  thinking: boolean;
  /** The last time the page that ran it was alive. */
  at: number;
  /** The page was unloaded on purpose (a reload, or the window closed), not killed. */
  unloaded?: boolean;
}

/** A turn the page ended, as the app finds it when it's back. */
export interface InterruptedTurn {
  modelId: string;
  thinking: boolean;
  /** Carry it on without asking: the page reloaded, or died a short while ago without the user
   *  closing it. Otherwise the reply is marked as cut, with a button to continue. */
  auto: boolean;
}

const KEY = "nyxs.apiTurns";
/** Marks a page that unloaded, in sessionStorage: the next page only finds it after a reload. */
const RELOAD_MARK = "unloaded";
export const HEARTBEAT_MS = 15_000;
/** How recent a cut must be for its turn to carry on by itself after the app starts again. */
export const AUTO_RESUME_MS = 10 * 60_000;
/** How many times in a row a cut turn carries on by itself. A turn that takes the page down
 *  would otherwise run again, tools and all, on every start. */
export const MAX_AUTO_RESUMES = 3;
/** How many times each chat's turn has carried on by itself lately, in localStorage. */
const RESUMES_KEY = "nyxs.apiTurnResumes";
const LOCK_PREFIX = "nyxs.apiTurn:";

type TurnInfo = Pick<RunningTurn, "modelId" | "thinking">;

/** The chats with a turn running in this page: only those are kept alive and marked on unload. */
const owned = new Map<string, TurnInfo>();
/** Ends the Web Lock each owned turn holds. */
const releases = new Map<string, () => void>();
let heartbeat: ReturnType<typeof setInterval> | null = null;
let unloadHooked = false;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function loadKey<T>(key: string): Record<string, T> {
  try {
    const raw = storage()?.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function saveKey(key: string, value: Record<string, unknown>): void {
  try {
    const store = storage();
    if (!store) return;
    if (Object.keys(value).length) store.setItem(key, JSON.stringify(value));
    else store.removeItem(key);
  } catch {
    /* storage full or unavailable: a cut turn just stays cut */
  }
}

const load = () => loadKey<RunningTurn>(KEY);
const save = (turns: Record<string, RunningTurn>) => saveKey(KEY, turns);
const loadResumes = () => loadKey<{ n: number; at: number }>(RESUMES_KEY);

function touchOwned(patch: Partial<RunningTurn> = {}): void {
  const turns = load();
  const now = Date.now();
  // An entry another window dropped (a build from before the locks) is put back.
  for (const [id, info] of owned) turns[id] = { ...info, ...turns[id], at: now, ...patch };
  save(turns);
}

function lockManager(): LockManager | null {
  try {
    return typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null;
  } catch {
    return null;
  }
}

/** Holds the turn's lock until `forgetApiTurn`, or until the page dies. Shared: it only says the
 *  turn is alive somewhere, so it never waits for another holder. */
function holdLock(chatId: string): void {
  const locks = lockManager();
  if (!locks || releases.has(chatId)) return;
  let release = () => {};
  const done = new Promise<void>((resolve) => (release = resolve));
  releases.set(chatId, release);
  locks.request(LOCK_PREFIX + chatId, { mode: "shared" }, () => done).catch(() => {});
}

/** The chats whose turn a live page (this one or another window) is running. */
async function liveTurns(): Promise<Set<string>> {
  try {
    const state = await lockManager()?.query();
    const names = (state?.held ?? []).map((l) => l.name ?? "").filter((n) => n.startsWith(LOCK_PREFIX));
    return new Set(names.map((n) => n.slice(LOCK_PREFIX.length)));
  } catch {
    return new Set();
  }
}

/** The page is going away on purpose: its turns were cut by a reload or by the user closing the
 *  window, not by a crash. Only a reload leaves the mark for the next page to find. */
export function markPageUnloading(): void {
  if (!owned.size) return;
  touchOwned({ unloaded: true });
  saveReloadState(RELOAD_MARK, true);
}

export function rememberApiTurn(chatId: string, modelId: string, thinking: boolean): void {
  owned.set(chatId, { modelId, thinking });
  holdLock(chatId);
  const turns = load();
  turns[chatId] = { modelId, thinking, at: Date.now() };
  save(turns);
  heartbeat ??= setInterval(() => touchOwned(), HEARTBEAT_MS);
  if (!unloadHooked && typeof window !== "undefined") {
    unloadHooked = true;
    window.addEventListener("beforeunload", markPageUnloading);
  }
}

/** The turn ended in this page (done, failed or stopped by the user): nothing to carry on. */
export function forgetApiTurn(chatId: string): void {
  owned.delete(chatId);
  releases.get(chatId)?.();
  releases.delete(chatId);
  if (!owned.size && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  const resumes = loadResumes();
  if (resumes[chatId]) {
    delete resumes[chatId];
    saveKey(RESUMES_KEY, resumes);
  }
  const turns = load();
  if (!turns[chatId]) return;
  delete turns[chatId];
  save(turns);
}

/** The API turns an earlier page left running, by chat. Reading them clears them from the list,
 *  so each is dealt with once; a turn another open window is running stays on it. */
export async function takeInterruptedApiTurns(now = Date.now()): Promise<Record<string, InterruptedTurn>> {
  const reloaded = !!loadReloadState<boolean>(RELOAD_MARK);
  saveReloadState(RELOAD_MARK, null);
  const live = await liveTurns();
  // Read after the wait and written back with no wait in between, so another window's change
  // made meanwhile isn't undone.
  const turns = load();
  const resumes = loadResumes();
  const out: Record<string, InterruptedTurn> = {};
  const kept: Record<string, RunningTurn> = {};
  for (const [chatId, t] of Object.entries(turns)) {
    // A turn this page started meanwhile, or one another window is running, isn't a dead page's.
    if (owned.has(chatId) || live.has(chatId)) {
      kept[chatId] = t;
      continue;
    }
    if (!t || typeof t.modelId !== "string") continue;
    const recent = now - (t.at ?? 0) <= AUTO_RESUME_MS;
    const prev = resumes[chatId];
    const tries = prev && now - prev.at <= AUTO_RESUME_MS ? prev.n : 0;
    const auto = (reloaded || (recent && !t.unloaded)) && tries < MAX_AUTO_RESUMES;
    // A turn left for the user starts its count over: continuing it is their call.
    if (auto) resumes[chatId] = { n: tries + 1, at: now };
    else delete resumes[chatId];
    out[chatId] = { modelId: t.modelId, thinking: !!t.thinking, auto };
  }
  for (const [chatId, r] of Object.entries(resumes)) if (now - r.at > AUTO_RESUME_MS) delete resumes[chatId];
  save(kept);
  saveKey(RESUMES_KEY, resumes);
  return out;
}

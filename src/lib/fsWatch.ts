import { invoke } from "@/lib/ipc";
import { listen } from "@tauri-apps/api/event";

type ChangeCallback = () => void;

/** "fs-change": files in the project. "git-change": the repository's state (HEAD, refs, index),
 *  also after a commit, checkout or pull made in an outside terminal. Each project folder has one
 *  native watcher that serves both, running while anyone is subscribed to either; the backend
 *  names the folder in every event, so a chat in the background watching another project never
 *  takes the events away from the one on screen. */
type ChangeEvent = "fs-change" | "git-change";

interface Root {
  /** The folder as the first subscriber gave it: what the watcher is started with. */
  path: string;
  subscribers: Record<ChangeEvent, Set<ChangeCallback>>;
  count: number;
}

/** The folders someone is subscribed to, by `keyOf`. */
const roots = new Map<string, Root>();
/** The folders the backend is watching now, by `keyOf`, with the path it was started with. */
const applied = new Map<string, string>();
const retries = new Map<string, ReturnType<typeof setTimeout>>();
const listening = new Set<ChangeEvent>();
const dispatchTimers = new Map<string, ReturnType<typeof setTimeout>>();
let reconciling: Promise<void> = Promise.resolve();

const FS_CHANGE_DEBOUNCE_MS = 200;
/** A watcher that failed to start (Linux out of inotify watches, a machine not reachable) is
 *  tried again this long after, while someone still wants it. */
const RETRY_MS = 30_000;

/** The same folder however it is written: `/` separators, no trailing slash, and a Windows
 *  drive path case-insensitive. */
function keyOf(path: string): string {
  const key = path.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
  return /^[a-z]:/i.test(key) ? key.toLowerCase() : key;
}

function dispatchChange(event: ChangeEvent, key: string): void {
  const root = roots.get(key);
  if (!root) return;
  for (const cb of [...root.subscribers[event]]) {
    try {
      cb();
    } catch {
      // A misbehaving subscriber must not break the others.
    }
  }
}

function attachListener(event: ChangeEvent): void {
  if (listening.has(event)) return;
  listening.add(event);
  void listen<string>(event, (e) => {
    if (typeof e.payload !== "string") return;
    const key = keyOf(e.payload);
    const timer = `${event}\n${key}`;
    const pending = dispatchTimers.get(timer);
    if (pending !== undefined) clearTimeout(pending);
    dispatchTimers.set(
      timer,
      setTimeout(() => {
        dispatchTimers.delete(timer);
        dispatchChange(event, key);
      }, FS_CHANGE_DEBOUNCE_MS),
    );
  });
}

function retryLater(key: string): void {
  if (retries.has(key)) return;
  retries.set(
    key,
    setTimeout(() => {
      retries.delete(key);
      reconcile(key);
    }, RETRY_MS),
  );
}

/** Starts or stops the folder's watcher to match its subscribers. Calls go one after another, and
 *  every change of subscribers queues one, so the last one always sees the final state. */
function reconcile(key: string): void {
  reconciling = reconciling.then(async () => {
    const wanted = roots.get(key);
    const watching = applied.get(key);
    if (wanted && watching === undefined) {
      const started = await invoke("fs_watch_start", { path: wanted.path }).then(
        () => true,
        () => false,
      );
      if (started) applied.set(key, wanted.path);
      else retryLater(key);
    } else if (!wanted && watching !== undefined) {
      applied.delete(key);
      await invoke("fs_watch_stop", { path: watching }).catch(() => {});
    }
  });
}

function subscribe(event: ChangeEvent, workspace: string, cb: ChangeCallback): () => void {
  attachListener(event);
  const key = keyOf(workspace);
  let root = roots.get(key);
  if (!root) {
    root = { path: workspace, subscribers: { "fs-change": new Set(), "git-change": new Set() }, count: 0 };
    roots.set(key, root);
  }
  root.subscribers[event].add(cb);
  root.count++;
  reconcile(key);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const r = roots.get(key);
    if (!r) return;
    r.subscribers[event].delete(cb);
    if (--r.count === 0) roots.delete(key);
    reconcile(key);
  };
}

export function subscribeFsChange(workspace: string, cb: ChangeCallback): () => void {
  return subscribe("fs-change", workspace, cb);
}

export function subscribeGitChange(workspace: string, cb: ChangeCallback): () => void {
  return subscribe("git-change", workspace, cb);
}

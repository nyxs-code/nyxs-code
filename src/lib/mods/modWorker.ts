/** A hook a mod registered, as its Worker reported it: the event and its plain matcher. */
export interface HookInfo {
  event: string;
  matcher?: Record<string, unknown>;
}

export interface ModCallError {
  name?: string;
  message: string;
}

/** What `$` calls from a mod are answered with; a thrown error reaches the mod as its own. */
export type CallHandler = (path: string, args: unknown) => Promise<unknown>;

type Below = (e: unknown) => Promise<unknown>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  below: Below;
  timer?: ReturnType<typeof setTimeout>;
}

export function matchesMatcher(matcher: Record<string, unknown> | undefined, e: unknown): boolean {
  if (!matcher) return true;
  const obj = (e ?? {}) as Record<string, unknown>;
  for (const [k, want] of Object.entries(matcher)) {
    const have = obj[k];
    if (want && typeof want === "object" && !Array.isArray(want)) {
      if (!have || typeof have !== "object" || !matchesMatcher(want as Record<string, unknown>, have)) return false;
    } else if (Array.isArray(want)) {
      if (!want.includes(have)) return false;
    } else if (have !== want) return false;
  }
  return true;
}

export function eventMatches(pattern: string, event: string): boolean {
  return pattern === event || pattern === "*" || (pattern.endsWith(".*") && event.startsWith(pattern.slice(0, -1)));
}

/** One loaded mod: its Worker and the messages to and from it. */
export class ModWorker {
  hooks: HookInfo[] = [];
  readonly ready: Promise<void>;
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private dead = false;

  readonly plugin: string;
  private onCall: CallHandler;

  constructor(plugin: string, script: string, onCall: CallHandler) {
    this.plugin = plugin;
    this.onCall = onCall;
    const url = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
    this.worker = new Worker(url, { name: `mod:${plugin}` });
    let settle!: { resolve: () => void; reject: (e: Error) => void };
    this.ready = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    // The script is fetched after the constructor returns: the URL stays until it has loaded.
    void this.ready.then(() => URL.revokeObjectURL(url), () => URL.revokeObjectURL(url));
    // A mod that never answers keeps nothing waiting.
    const bootTimer = setTimeout(() => settle.reject(new Error("the hooks module did not finish loading in 10 s")), 10_000);
    this.worker.onerror = (ev) => {
      clearTimeout(bootTimer);
      settle.reject(new Error(ev.message || "the hooks module failed to load"));
    };
    this.worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data as Record<string, unknown> & { t: string; id: number };
      switch (m.t) {
        case "ready":
          clearTimeout(bootTimer);
          this.hooks = (m.hooks as HookInfo[]) ?? [];
          settle.resolve();
          return;
        case "failed":
          clearTimeout(bootTimer);
          settle.reject(new Error(String(m.error)));
          return;
        case "call":
          void this.answerCall(m.id, String(m.path), m.args);
          return;
        case "next":
          void this.answerNext(m.id, m.dispatch as unknown as number, m.e);
          return;
        case "done": {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (p.timer) clearTimeout(p.timer);
          if (m.ok) p.resolve(m.value);
          else p.reject(Object.assign(new Error((m.error as ModCallError)?.message ?? "hook failed"), { name: (m.error as ModCallError)?.name ?? "Error" }));
        }
      }
    };
  }

  private post(msg: unknown): void {
    if (!this.dead) this.worker.postMessage(msg);
  }

  private async answerCall(id: number, path: string, args: unknown): Promise<void> {
    try {
      const value = await this.onCall(path, args);
      if (id) this.post({ t: "result", id, ok: true, value });
    } catch (e) {
      if (id) this.post({ t: "result", id, ok: false, error: { name: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) } });
    }
  }

  private async answerNext(id: number, dispatchId: number, e: unknown): Promise<void> {
    const p = this.pending.get(dispatchId);
    if (!p) {
      this.post({ t: "result", id, ok: false, error: { message: "the event is over" } });
      return;
    }
    try {
      this.post({ t: "result", id, ok: true, value: await p.below(e) });
    } catch (err) {
      this.post({ t: "result", id, ok: false, error: { message: err instanceof Error ? err.message : String(err) } });
    }
  }

  /** Whether one of the mod's hooks hears this event: the rest are skipped without a message. */
  hears(event: string, e: unknown): boolean {
    return this.hooks.some((h) => eventMatches(h.event, event) && matchesMatcher(h.matcher, e));
  }

  /**
   * Runs the mod's hooks for an event. `below` is what `next` reaches past this mod: the other
   * mods, then the app's own behaviour. A hook that outlasts `timeoutMs` is passed by: its event
   * goes on as if it had called `next(e)`.
   */
  dispatch(event: string, e: unknown, below: Below, opts: { site?: string; timeoutMs?: number } = {}): Promise<unknown> {
    if (this.dead) return below(e);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject, below };
      if (opts.timeoutMs) {
        p.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          console.warn(`[mod ${this.plugin}] ${event} hook took over ${opts.timeoutMs} ms; passed by`);
          below(e).then(resolve, reject);
        }, opts.timeoutMs);
      }
      this.pending.set(id, p);
      this.post({ t: "dispatch", id, event, e, site: opts.site });
    });
  }

  /** A press on a Button (or any handler prop) of a tree the mod drew. */
  invoke(fn: number, args: unknown[] = []): void {
    this.post({ t: "invoke", fn, args });
  }

  terminate(): void {
    this.dead = true;
    this.worker.terminate();
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("the mod was unloaded"));
    }
    this.pending.clear();
  }
}

import { compileMod, type ModRef, type ReadFile } from "./compile";
import type { HookInfo } from "./modWorker";
import type { ModToast, RenderNode, StandingTheme, ThemeArgs } from "./types";

/**
 * Nyxs' engine for Claude Code's mods: plugins whose `hooks/hooks.json` names a hooks module
 * (`{ "modules": ["./register.tsx"] }`). Each mod runs in a Worker of its own per session, as each
 * Claude Code session runs its mods in its own process, and reaches the app through `$`. This
 * host keeps what outlives a Worker (the session's `$.state`, its theme, its commands) and runs
 * each event through the mods in order, then through the app's own behaviour.
 *
 * What Nyxs answers is the part of Claude Code's API a look needs: `$.theme`, the `Backdrop`,
 * `AbovePrompt` and `Placed` drawings, `$.command`, `$.store`, `$.state`, `$.clock`, toasts,
 * status, `$.session`, `$.fs` reads and `prompt.submit` / `session.append` / `command.run`.
 * Any other noun is absent, so a mod that reaches for it gets the TypeError Claude Code's mods
 * already expect from an engine without it.
 */

/** The Worker side as the host uses it: a ModWorker, or a fake in tests. */
export interface ModWorkerLike {
  readonly ready: Promise<void>;
  hooks: HookInfo[];
  hears(event: string, e: unknown): boolean;
  dispatch(event: string, e: unknown, below: (e: unknown) => Promise<unknown>, opts?: { site?: string; timeoutMs?: number }): Promise<unknown>;
  invoke(fn: number, args?: unknown[]): void;
  terminate(): void;
}

/** What the host needs from the app and the disk; the app's own in `io.ts`, a fake in tests. */
export interface ModIo {
  readText: ReadFile;
  stat(path: string, resolve: boolean): Promise<unknown>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
  installedMods(): Promise<ModRef[]>;
  /** The mods the agent wrote for one session: Nyxs' `dev-mods` folder for the chat, and Claude
   *  Code's for its own session when the chat runs on Claude Code. */
  devMods(chatId: string, cliSessionId: string | null): Promise<ModRef[]>;
  makeWorker(plugin: string, script: string, onCall: (path: string, args: unknown) => Promise<unknown>): ModWorkerLike;
  loadStore(plugin: string): Record<string, unknown>;
  saveStore(plugin: string, data: Record<string, unknown>): void;
  /** A command name the app already has (`/clear`, a skill…): a mod can't take it. */
  isReservedCommand(name: string): boolean;
  loadConsent(): Record<string, "on" | "off">;
  saveConsent(data: Record<string, "on" | "off">): void;
}

/** What a session is to its mods, read whenever a mod asks. */
export interface SessionInfo {
  /** The chat's id; null for a new session not yet sent. */
  chatId: string | null;
  workspace: string | null;
  cwd: string | null;
  model: string | null;
  turns: number;
  /** The Claude Code session the chat runs in, when it runs on Claude Code. */
  cliSessionId?: string | null;
}

interface LoadedMod {
  ref: ModRef;
  worker: ModWorkerLike | null;
  hash: string;
  error?: string;
}

interface CommandReg {
  plugin: string;
  description: string;
  argumentHint?: string;
}

/** Everything one session's mods share: what Claude Code keeps per session. */
interface Ctx {
  key: string;
  mods: LoadedMod[];
  theme: StandingTheme | null;
  commands: Map<string, CommandReg>;
  state: Map<string, { value: unknown; version: number }>;
  status: Map<string, string>;
  /** Set while the mods load: events wait for it. */
  loading: Promise<void> | null;
  loaded: boolean;
  lastUsed: number;
  /** Mods the agent wrote here wait for the user's yes. */
  devAsk: boolean;
  /** Said to the agent at its next turn: what became of the mods it wrote. */
  notice: string | null;
}

export interface ModCommand {
  name: string;
  description: string;
  argumentHint?: string;
  plugin: string;
}

export interface BandRow {
  plugin: string;
  tree: RenderNode;
}

/** How long a hook may hold an event the user waits on before it is passed by. */
const WAIT_MS = { render: 3000, prompt: 5000, command: 15000 } as const;
/** Sessions whose mods stay loaded; past it the longest unused session's Workers stop. */
const LIVE_SESSIONS = 6;
const THEME_ATTRS = new Set(["backdrop", "overrideColorScheme", "colors"]);
const BACKDROP_ATTRS = new Set(["scene", "id", "glass", "colorScheme", "color", "gradient", "vector", "image"]);
const COMMAND_NAME = /^[a-z0-9][a-z0-9:_-]{0,63}$/i;

const refKey = (ref: { plugin?: unknown; key?: unknown; id?: unknown }) => `${String(ref.plugin)}\0${String(ref.key)}\0${ref.id === undefined ? "" : String(ref.id)}`;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function checkTheme(args: unknown): ThemeArgs {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("theme.set takes one object of attributes");
  for (const k of Object.keys(args)) {
    if (!THEME_ATTRS.has(k)) throw new Error(`theme.set does not know the attribute "${k}"`);
  }
  const a = args as ThemeArgs;
  if (a.overrideColorScheme !== undefined && a.overrideColorScheme !== "light" && a.overrideColorScheme !== "dark") {
    throw new Error('overrideColorScheme is "light" or "dark"');
  }
  if (a.backdrop) {
    if (typeof a.backdrop !== "object") throw new Error("backdrop is an object or false");
    for (const k of Object.keys(a.backdrop)) {
      if (!BACKDROP_ATTRS.has(k)) throw new Error(`backdrop does not know the attribute "${k}"`);
    }
    const scene = a.backdrop.scene ?? a.backdrop.id;
    if (scene !== undefined && (typeof scene !== "string" || !scene)) throw new Error("a backdrop's scene is a name");
  }
  if (a.colors !== undefined) {
    const c = a.colors;
    if (!c || typeof c !== "object" || c.v !== 1 || typeof c.label !== "string" || !c.inputs || typeof c.inputs !== "object") {
      throw new Error("colors is a palette: { v: 1, label, inputs: { light?, dark? } }");
    }
  }
  return a;
}

export class ModHost {
  private ctxs = new Map<string, Ctx>();
  private listeners = new Set<() => void>();
  private toastSeq = 0;
  private consent: Record<string, "on" | "off">;
  /** Bumped on every change a drawing may read: subscribers compare it. */
  version = 0;
  toasts: ModToast[] = [];
  activeKey: string | null = null;

  private io: ModIo;
  private infoOf: (key: string) => SessionInfo;

  constructor(io: ModIo, infoOf: (key: string) => SessionInfo) {
    this.io = io;
    this.infoOf = infoOf;
    this.consent = io.loadConsent();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private ctx(key: string): Ctx {
    let c = this.ctxs.get(key);
    if (!c) {
      c = { key, mods: [], theme: null, commands: new Map(), state: new Map(), status: new Map(), loading: null, loaded: false, lastUsed: Date.now(), devAsk: false, notice: null };
      this.ctxs.set(key, c);
    }
    return c;
  }

  /** The session on screen: its mods load (once), and its theme is the one drawn. */
  async activate(key: string): Promise<void> {
    this.activeKey = key;
    const c = this.ctx(key);
    c.lastUsed = Date.now();
    this.emit();
    await this.ensureLoaded(c);
    this.trim();
  }

  private ensureLoaded(c: Ctx): Promise<void> {
    if (c.loaded) return Promise.resolve();
    c.loading ??= this.loadAll(c).finally(() => {
      c.loading = null;
      c.loaded = true;
      this.emit();
    });
    return c.loading;
  }

  private async loadAll(c: Ctx): Promise<void> {
    const refs = [...(await this.io.installedMods())];
    const { chatId, cliSessionId } = this.infoOf(c.key);
    if (chatId) {
      const dev = await this.io.devMods(chatId, cliSessionId ?? null);
      if (dev.length && this.consent[chatId] === "on") refs.push(...dev);
      else if (dev.length && !this.consent[chatId]) c.devAsk = true;
    }
    for (const ref of refs) await this.startMod(c, ref);
  }

  /** Loads one mod (again): `register`, then `session.start`. Its state and the theme stay. */
  private async startMod(c: Ctx, ref: ModRef, compiled?: { script: string; hash: string }): Promise<LoadedMod> {
    const old = c.mods.find((m) => m.ref.plugin === ref.plugin);
    let mod: LoadedMod;
    try {
      const out = compiled ?? (await compileMod(ref, this.io.readText));
      const worker = this.io.makeWorker(ref.plugin, out.script, (path, args) => this.call(c, ref, path, args));
      await worker.ready;
      mod = { ref, worker, hash: out.hash };
    } catch (e) {
      mod = { ref, worker: null, hash: compiled?.hash ?? "", error: errorText(e) };
      console.warn(`[mod ${ref.plugin}] not loaded: ${mod.error}`);
    }
    if (old) {
      old.worker?.terminate();
      // A reload registers its commands again; what the old code registered goes with it.
      for (const [name, reg] of c.commands) if (reg.plugin === ref.plugin) c.commands.delete(name);
      c.status.delete(ref.plugin);
      c.mods = c.mods.map((m) => (m === old ? mod : m));
    } else {
      c.mods.push(mod);
    }
    if (mod.worker) {
      try {
        const info = this.infoOf(c.key);
        await mod.worker.dispatch("session.start", { cwd: info.cwd ?? info.workspace ?? "", surface: "desktop", isInteractive: true }, async () => ({}), { timeoutMs: WAIT_MS.command });
      } catch (e) {
        this.log(ref.plugin, `session.start failed: ${errorText(e)}`, "error");
      }
    }
    this.emit();
    return mod;
  }

  private unloadMod(c: Ctx, plugin: string): void {
    const mod = c.mods.find((m) => m.ref.plugin === plugin);
    if (!mod) return;
    mod.worker?.terminate();
    c.mods = c.mods.filter((m) => m !== mod);
    for (const [name, reg] of c.commands) if (reg.plugin === plugin) c.commands.delete(name);
    c.status.delete(plugin);
    // A mod that unloads takes its theme with it, as in Claude Code.
    if (c.theme?.plugin === plugin) c.theme = null;
    this.emit();
  }

  /** Stops the Workers of sessions not used for longest; their state and theme stay for later. */
  private trim(): void {
    const live = [...this.ctxs.values()].filter((c) => c.loaded && c.key !== this.activeKey).sort((a, b) => b.lastUsed - a.lastUsed);
    for (const c of live.slice(LIVE_SESSIONS - 1)) {
      for (const m of c.mods) m.worker?.terminate();
      c.mods = [];
      c.commands.clear();
      c.loaded = false;
    }
  }

  /** A new session got its id with its first message: its mods go on under that id. */
  adopt(fromKey: string, toKey: string): void {
    const c = this.ctxs.get(fromKey);
    if (!c || this.ctxs.has(toKey)) return;
    this.ctxs.delete(fromKey);
    c.key = toKey;
    this.ctxs.set(toKey, c);
    if (this.activeKey === fromKey) this.activeKey = toKey;
    this.emit();
  }

  /** The installed plugins changed (enabled, disabled, updated): every session reloads what changed. */
  async reloadInstalled(): Promise<void> {
    const refs = await this.io.installedMods();
    for (const c of this.ctxs.values()) {
      if (!c.loaded) continue;
      for (const m of [...c.mods]) {
        if (m.ref.source === "installed" && !refs.some((r) => r.plugin === m.ref.plugin)) this.unloadMod(c, m.ref.plugin);
      }
      for (const ref of refs) await this.reloadIfChanged(c, ref);
    }
  }

  private async reloadIfChanged(c: Ctx, ref: ModRef): Promise<string | null> {
    let compiled: { script: string; hash: string } | undefined;
    let fault: string | null = null;
    try {
      compiled = await compileMod(ref, this.io.readText);
    } catch (e) {
      fault = errorText(e);
    }
    const cur = c.mods.find((m) => m.ref.plugin === ref.plugin);
    if (compiled && cur && cur.hash === compiled.hash && cur.worker) return null;
    if (!compiled) {
      // At a reload the previous version stays loaded.
      if (cur?.worker) return `${ref.plugin}: not reloaded, the previous version stays (${fault})`;
      const mod = await this.startMod(c, ref);
      return mod.error ? `${ref.plugin}: not loaded (${mod.error})` : `${ref.plugin}: loaded`;
    }
    const mod = await this.startMod(c, ref, compiled);
    return mod.error ? `${ref.plugin}: not loaded (${mod.error})` : `${ref.plugin}: ${cur ? "reloaded" : "loaded"}`;
  }

  // ---- Mods the agent writes ----

  /** A turn of the session ended: mods it wrote load or reload, or the user is asked first. */
  async turnEnded(key: string): Promise<void> {
    const c = this.ctxs.get(key);
    const { chatId, cliSessionId } = this.infoOf(key);
    if (!c || !chatId) return;
    const dev = await this.io.devMods(chatId, cliSessionId ?? null);
    if (!dev.length) return;
    const answer = this.consent[chatId];
    if (answer === "off") return;
    if (!answer) {
      if (!c.devAsk) {
        c.devAsk = true;
        this.emit();
      }
      return;
    }
    await this.ensureLoaded(c);
    const lines: string[] = [];
    for (const ref of dev) {
      const line = await this.reloadIfChanged(c, ref);
      if (line) lines.push(line);
    }
    if (lines.length) {
      c.notice = `Mods: ${lines.join("; ")}.`;
      this.emit();
    }
  }

  devConsentPending(key: string): boolean {
    return !!this.ctxs.get(key)?.devAsk;
  }

  /** The user's answer to "Turn on the mods Nyxs writes in this session?". */
  async answerDevConsent(key: string, on: boolean): Promise<void> {
    const c = this.ctxs.get(key);
    const chatId = this.infoOf(key).chatId;
    if (!c || !chatId) return;
    c.devAsk = false;
    this.consent = { ...this.consent, [chatId]: on ? "on" : "off" };
    this.io.saveConsent(this.consent);
    this.emit();
    if (on) await this.turnEnded(key);
    else c.notice = "Mods: the user did not turn on the mods written in this session; they are not loaded.";
  }

  /** What became of the mods the agent wrote, said once at its next turn. */
  takeNotice(key: string): string | null {
    const c = this.ctxs.get(key);
    const n = c?.notice ?? null;
    if (c) c.notice = null;
    return n;
  }

  // ---- Events ----

  private async chain(c: Ctx, event: string, e: unknown, bottom: (e: unknown) => Promise<unknown>, opts: { timeoutMs?: number; site?: string } = {}): Promise<unknown> {
    await this.ensureLoaded(c);
    const mods = c.mods.filter((m) => m.worker?.hears(event, e));
    const step = (i: number, ev: unknown): Promise<unknown> => {
      if (i >= mods.length) return bottom(ev);
      return mods[i].worker!.dispatch(event, ev, (next) => step(i + 1, next), opts).catch((err) => {
        this.log(mods[i].ref.plugin, `${event} hook skipped: ${errorText(err)}`, "error");
        return step(i + 1, ev);
      });
    };
    return step(0, e);
  }

  /** A prompt on its way: mods may rewrite it or drop it. */
  async submitPrompt(key: string, text: string): Promise<{ text: string } | { drop: string }> {
    const c = this.ctxs.get(key);
    if (!c) return { text };
    const out = (await this.chain(c, "prompt.submit", { text }, async (e) => ({ text: (e as { text: string }).text }), { timeoutMs: WAIT_MS.prompt })) as { text?: unknown; drop?: unknown } | null;
    if (out && typeof out.drop === "string") return { drop: out.drop };
    return { text: out && typeof out.text === "string" ? out.text : text };
  }

  /** The model's reply, once a turn ends, as the row Claude Code appends through `door: 'response'`. */
  async responded(key: string, text: string): Promise<void> {
    const c = this.ctxs.get(key);
    if (!c || !text.trim()) return;
    const message = { type: "assistant", role: "assistant", content: [{ type: "text", text }] };
    await this.chain(c, "session.append", { door: "response", origin: { kind: "model" }, message }, async (e) => ({ message: (e as { message: unknown }).message }), { timeoutMs: WAIT_MS.prompt }).catch(() => {});
  }

  commands(key: string | null): ModCommand[] {
    const c = key ? this.ctxs.get(key) : undefined;
    if (!c) return [];
    return [...c.commands].map(([name, r]) => ({ name, description: r.description, argumentHint: r.argumentHint, plugin: r.plugin }));
  }

  hasCommand(key: string | null, name: string): boolean {
    return !!key && !!this.ctxs.get(key)?.commands.has(name);
  }

  /**
   * `/name args` of a mod's command; what it answered. The answer is shown as a toast and never
   * becomes a message: changing the look of the app is no part of the conversation.
   */
  async runCommand(key: string, name: string, args: string): Promise<string> {
    const c = this.ctx(key);
    const e = { command: name, args, origin: { kind: "person" }, presentation: { isFullscreen: false, columns: 100 } };
    const out = (await this.chain(c, "command.run", e, async () => ({}), { timeoutMs: WAIT_MS.command })) as { text?: unknown } | null;
    const text = out && typeof out.text === "string" ? out.text : "";
    if (text.trim()) this.toast(c.commands.get(name)?.plugin ?? name, text);
    return text;
  }

  theme(key: string | null): StandingTheme | null {
    return (key && this.ctxs.get(key)?.theme) || null;
  }

  status(key: string | null): { plugin: string; text: string }[] {
    const c = key ? this.ctxs.get(key) : undefined;
    return c ? [...c.status].map(([plugin, text]) => ({ plugin, text })) : [];
  }

  /** The drawing behind the chat: the `Backdrop` hooks' answer to the standing scene. */
  async renderBackdrop(key: string): Promise<RenderNode | null> {
    const c = this.ctxs.get(key);
    const t = c?.theme;
    const b = t?.args.backdrop;
    if (!c || !t || !b) return null;
    const scene = b.scene ?? b.id;
    if (!scene) return null;
    const glass = b.glass === false ? false : { blur: b.glass?.blur ?? 16, tint: b.glass?.tint, opacity: b.glass?.opacity ?? 0.6 };
    const props = { scene, id: scene, plugin: t.plugin, glass, overrideColorScheme: t.args.overrideColorScheme ?? b.colorScheme };
    const e = { component: "Backdrop", surface: "desktop", requestId: "backdrop", props };
    const tree = await this.chain(c, "ui.render", e, async () => null, { timeoutMs: WAIT_MS.render, site: "backdrop" });
    return (tree as RenderNode | null) ?? null;
  }

  /** The band above the prompt: one row per mod, each drawn by that mod's `AbovePrompt` hook. */
  async renderBand(key: string, isWorking: boolean): Promise<BandRow[]> {
    const c = this.ctxs.get(key);
    if (!c) return [];
    await this.ensureLoaded(c);
    const rows: BandRow[] = [];
    for (const m of c.mods) {
      const e = { component: "AbovePrompt", surface: "desktop", requestId: `band:${m.ref.plugin}`, plugin: m.ref.plugin, props: { hasSurvey: false, isCollapsed: false, isWorking, bodyColumns: 100 } };
      if (!m.worker?.hears("ui.render", e)) continue;
      try {
        const tree = (await m.worker.dispatch("ui.render", e, async () => null, { timeoutMs: WAIT_MS.render, site: e.requestId })) as RenderNode | null;
        if (tree) rows.push({ plugin: m.ref.plugin, tree });
      } catch (err) {
        this.log(m.ref.plugin, `ui.render hook skipped: ${errorText(err)}`, "error");
      }
    }
    return rows;
  }

  /** A press on a Button a mod drew. */
  press(key: string, plugin: string, fn: number, args: unknown[] = []): void {
    this.ctxs.get(key)?.mods.find((m) => m.ref.plugin === plugin)?.worker?.invoke(fn, args);
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit();
  }

  private toast(plugin: string, text: string, timeoutMs = 6000): void {
    const id = ++this.toastSeq;
    // A toast takes the place of its own plugin's toast only.
    this.toasts = [...this.toasts.filter((t) => t.plugin !== plugin), { id, plugin, text: String(text).slice(0, 10_000), timeoutMs }];
    this.emit();
  }

  private log(plugin: string, text: string, to?: string): void {
    if (to === "debug") {
      console.debug(`[mod ${plugin}] ${text}`);
      return;
    }
    console.info(`[mod ${plugin}] ${text}`);
    this.toast(plugin, `${plugin}: ${text}`);
  }

  // ---- $ ----

  private async call(c: Ctx, ref: ModRef, path: string, rawArgs: unknown): Promise<unknown> {
    const args = (Array.isArray(rawArgs) ? rawArgs : [rawArgs]) as unknown[];
    const plugin = ref.plugin;
    switch (path) {
      case "theme.set": {
        const a = checkTheme(args[0]);
        c.theme = { plugin, root: ref.root, args: a };
        this.emit();
        return { isDrawn: true, requestId: a.backdrop && (a.backdrop.scene ?? a.backdrop.id) ? "backdrop" : "theme" };
      }
      case "theme.clear": {
        const had = !!c.theme;
        c.theme = null;
        this.emit();
        return { isDrawn: false, reason: had ? "The theme was cleared." : "No theme stood." };
      }
      case "ui.toast": {
        const opts = args[1] as { timeoutMs?: number } | undefined;
        this.toast(plugin, String(args[0] ?? ""), opts?.timeoutMs);
        return undefined;
      }
      case "ui.status": {
        const text = args[0];
        if (text === undefined || text === null || text === "") c.status.delete(plugin);
        else c.status.set(plugin, String(text).slice(0, 10_000));
        this.emit();
        return undefined;
      }
      case "ui.log":
        this.log(plugin, String(args[0] ?? ""), (args[1] as { to?: string } | undefined)?.to);
        return undefined;
      case "ui.invalidate":
        this.emit();
        return undefined;
      case "ui.place":
        // Rows placed in the transcript aren't drawn yet: the mod draws above the prompt instead.
        return { isPlaced: false };
      case "store.get":
        return this.io.loadStore(plugin)[String(args[0])];
      case "store.set": {
        const data = this.io.loadStore(plugin);
        const k = String(args[0]);
        // A key written again goes last, so the store's order is the order of the last writes.
        delete data[k];
        data[k] = args[1];
        this.io.saveStore(plugin, data);
        return undefined;
      }
      case "store.delete": {
        const data = this.io.loadStore(plugin);
        delete data[String(args[0])];
        this.io.saveStore(plugin, data);
        return undefined;
      }
      case "store.keys":
        return Object.keys(this.io.loadStore(plugin));
      case "state.get": {
        const r = this.ref(args[0]);
        const s = c.state.get(refKey(r));
        return { value: s?.value, version: s?.version ?? 0 };
      }
      case "state.set": {
        const r = this.ref(args[0]);
        if (r.plugin !== plugin) throw new Error(`only ${String(r.plugin)} writes its own state`);
        const k = refKey(r);
        const cur = c.state.get(k);
        const version = cur?.version ?? 0;
        const ifVersion = (args[2] as { ifVersion?: number } | undefined)?.ifVersion;
        if (ifVersion !== undefined && ifVersion !== version) return { isSet: false, version };
        c.state.set(k, { value: args[1], version: version + 1 });
        this.emit();
        return { isSet: true, version: version + 1 };
      }
      case "session.id":
        return this.infoOf(c.key).chatId ?? c.key;
      case "session.cwd": {
        const i = this.infoOf(c.key);
        return i.cwd ?? i.workspace ?? "";
      }
      case "session.root":
        return this.infoOf(c.key).workspace ?? "";
      case "session.model":
        return this.infoOf(c.key).model ?? "";
      case "session.turns":
        return this.infoOf(c.key).turns;
      case "session.repo":
        return this.repoOf(this.infoOf(c.key).cwd ?? this.infoOf(c.key).workspace);
      case "fs.stat":
        return this.io.stat(String(args[0]), !!(args[1] as { resolve?: boolean } | undefined)?.resolve);
      case "fs.exists":
        return this.io.exists(String(args[0]));
      case "fs.read": {
        const text = await this.io.readText(String(args[0]));
        if (text === null) throw new Error(`${String(args[0])}: not found`);
        return text;
      }
      case "fs.list":
        return (await this.io.list(String(args[0] ?? this.infoOf(c.key).cwd ?? ""))).map((name) => ({ name }));
      case "env.get":
        // Nothing of the user's environment reaches a mod.
        return undefined;
      case "command.register": {
        const spec = args[0] as { name?: unknown; description?: unknown; argumentHint?: unknown };
        const name = typeof spec?.name === "string" ? spec.name.replace(/^\//, "") : "";
        if (!COMMAND_NAME.test(name)) throw new Error(`"${String(spec?.name)}" is not a command name`);
        if (this.io.isReservedCommand(name)) throw new Error(`/${name} is a command of Nyxs`);
        const taken = c.commands.get(name);
        if (taken && taken.plugin !== plugin) throw new Error(`/${name} is ${taken.plugin}'s`);
        c.commands.set(name, { plugin, description: String(spec.description ?? "").slice(0, 4096), argumentHint: typeof spec.argumentHint === "string" ? spec.argumentHint : undefined });
        this.emit();
        return undefined;
      }
      case "command.list":
        return this.commands(c.key).map(({ name, description }) => ({ name, description }));
      default:
        throw new TypeError(`$.${path} is not available in Nyxs`);
    }
  }

  private ref(v: unknown): { plugin?: unknown; key?: unknown; id?: unknown } {
    if (!v || typeof v !== "object") throw new Error("a state reference is { plugin, key }");
    return v as { plugin?: unknown; key?: unknown; id?: unknown };
  }

  private async repoOf(dir: string | null): Promise<unknown> {
    if (!dir) return null;
    let cur = dir.replace(/[\\/]+$/, "");
    for (let i = 0; i < 64 && cur; i++) {
      if (await this.io.exists(`${cur}/.git`)) {
        const name = cur.split(/[\\/]/).pop() || null;
        return { root: cur, remote: null, internal: false, name };
      }
      const parent = cur.replace(/[\\/][^\\/]*$/, "");
      if (parent === cur || !parent || /^[A-Za-z]:$/.test(cur)) break;
      cur = parent;
    }
    return null;
  }
}

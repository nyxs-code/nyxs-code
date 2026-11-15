/**
 * How the agent's video tools reach the editor, for every kind of agent.
 *
 * The app has one live editor (`timelineStore`: one document at a time), but several chats may
 * have an agent working on video. Each chat is bound to a project, and each call goes to:
 *
 * - the live store when that project is open in it, whichever chat's panel shows it: the user
 *   watches each change, every edit is one undo step, and the store saves it;
 * - otherwise a headless document (a chat in the background, the panel closed): the same edits
 *   and undo, written through to timeline.json at once, so opening the project later just reads
 *   it. Its undo steps go to the store when the project opens there.
 *
 * Two agents on one project share the same document (live or headless), and their calls run one
 * at a time per project, each against the latest document: nothing is overwritten. A call that
 * finds the document changed since this chat last looked says so, so the model re-reads.
 */
import { useSyncExternalStore } from "react";
import type { Bounds } from "@/lib/previewWebview";
import { loadWorkspace } from "@/lib/workspace";
import { timelineError, VideoToolError, type EditResult } from "./agentEdits";
import { requestVideoOpen } from "./videoOpen";
import * as ops from "./timelineOps";
import { validateTimeline, type Timeline } from "./timelineSchema";
import {
  flushSave,
  getPlayhead,
  getTimelineState,
  hasUnsavedEdits,
  isGestureActive,
  redo as storeRedo,
  seedHistory,
  serializeTimeline,
  setPlayhead,
  timelineActions,
  undo as storeUndo,
} from "./timelineStore";
import { listProjects, readTimeline, writeTimeline, type VideoProjectInfo } from "./videoApi";

/** The player of the open editor, as the tools drive it (see `usePlayer`). */
export interface LivePlayer {
  workspace: string;
  slug: string;
  iframe(): HTMLIFrameElement | null;
  state(): { ready: boolean; playing: boolean; loop: boolean; rate: number; volume: number; muted: boolean; zoom: "fit" | number; safeAreas: boolean; grid: boolean; sceneError: { message: string } | null; startError: string | null; timedOut: boolean; url: string | null };
  actions(): {
    play(): void;
    pause(): void;
    toggle(): void;
    step(frames: number): void;
    toStart(): void;
    toEnd(): void;
    seek(frame: number): void;
    setRate(rate: number): void;
    setLoop(loop: boolean): void;
    setVolume(volume: number): void;
    setMuted(muted: boolean): void;
    setZoom(zoom: "fit" | number): void;
    setSafeAreas(on: boolean): void;
    setGrid(on: boolean): void;
  };
  /** Hides the selection box, the grid and the safe areas in the picture while `run` captures. */
  cleanOverlay<T>(run: () => Promise<T>): Promise<T>;
}

/** The editor's frame, for what isn't in the store: its panels and its place on screen. */
export interface EditorShell {
  workspace: string;
  slug: string;
  /** The chat whose panel it is in right now. */
  chat?: string;
  visible(): boolean;
  root(): HTMLElement | null;
  panels(): { bin: boolean; inspector: boolean };
  togglePanel(panel: "bin" | "inspector"): void;
  timelineWidth(): number;
}

let livePlayer: LivePlayer | null = null;
let shell: EditorShell | null = null;

export function registerLivePlayer(player: LivePlayer): () => void {
  livePlayer = player;
  return () => {
    if (livePlayer === player) livePlayer = null;
  };
}

export function registerEditorShell(next: EditorShell): () => void {
  shell = next;
  return () => {
    if (shell === next) shell = null;
  };
}

// What the app tells this module about its chats.

let activeChat: () => string | undefined = () => undefined;
let workspaceOfChat: (chat: string) => string | null | undefined = () => undefined;
let abortChat: (chat: string) => void = () => undefined;

/** useChatViews says which chat is on screen and what folder each one has. */
export function setVideoChatContext(ctx: { active: () => string | undefined; workspaceOf: (chat: string) => string | null | undefined }): void {
  activeChat = ctx.active;
  workspaceOfChat = ctx.workspaceOf;
}

/** The app says how to stop a chat's turn, for the editor's Stop button. */
export function setVideoAgentStopper(stop: (chat: string) => void): void {
  abortChat = stop;
}

const planChats = new Set<string>();
const stoppedChats = new Set<string>();

/** A turn starts in `chat`: the user's Stop lasts until they send something, and the MCP path
 *  has no other way to learn the chat's permission mode. */
export function noteVideoChatTurn(chat: string | undefined, permissionMode: string): void {
  if (!chat) return;
  stoppedChats.delete(chat);
  if (permissionMode === "plan") planChats.add(chat);
  else planChats.delete(chat);
}

export function chatInPlanMode(chat: string | undefined): boolean {
  return !!chat && planChats.has(chat);
}

/** Who is asking: the chat its agent runs in, and for the built-in models what they have at hand. */
export interface VideoCallContext {
  chat?: string;
  workspace?: string | null;
  signal?: AbortSignal;
  toolCallId?: string;
  /** Makes a file edit revertible (rewind), before it happens. */
  trackEdit?: (absolutePath: string) => Promise<void>;
  /** Makes a path the model gave absolute. */
  resolve?: (path: string) => string;
  /** Set inside a batch: its edits are one undo step. */
  txn?: string;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const keyOf = (workspace: string, slug: string) => `${norm(workspace)}|${slug}`;

export function workspaceFor(ctx: VideoCallContext): string {
  const ws = ctx.workspace ?? (ctx.chat ? workspaceOfChat(ctx.chat) : undefined) ?? loadWorkspace();
  if (!ws) throw new VideoToolError("Video projects live in a project folder, and this chat has none open.");
  return ws;
}

// Each chat's project.

interface Binding {
  workspace: string;
  slug: string;
}

const bindings = new Map<string, Binding>();

const liveProject = (workspace: string, slug: string) => {
  const { project, status } = getTimelineState();
  return !!project && project.slug === slug && norm(project.workspace) === norm(workspace) && status !== "idle";
};

const isShownFor = (chat: string | undefined) => !chat || chat === activeChat();

/** A document nothing shows: what a chat in the background edits. */
class HeadlessDoc {
  readonly workspace: string;
  readonly slug: string;
  timeline: Timeline;
  compositionId: string;
  /** What timeline.json held when last read or written. */
  disk: string;
  past: Timeline[] = [];
  future: Timeline[] = [];
  playhead = 0;
  selection: string[] = [];
  inPoint: number | null = null;
  outPoint: number | null = null;
  coalesce: string | null = null;
  constructor(workspace: string, slug: string, timeline: Timeline, compositionId: string, disk: string) {
    this.workspace = workspace;
    this.slug = slug;
    this.timeline = timeline;
    this.compositionId = compositionId;
    this.disk = disk;
  }

  /** Someone else changed the file (the agent's own Edit tool, another Nyxs): that is the
   *  document now, as the live store does it, and an undo step. */
  async sync(): Promise<void> {
    const text = await readTimeline(this.workspace, this.slug);
    if (text === this.disk) return;
    const parsed = parseTimeline(text);
    this.past.push(this.timeline);
    this.future = [];
    this.coalesce = null;
    this.timeline = parsed;
    this.disk = text;
    if (!parsed.compositions.some((c) => c.id === this.compositionId)) this.compositionId = parsed.compositions[0].id;
  }

  async write(): Promise<void> {
    const json = serializeTimeline(this.timeline);
    if (json === this.disk) return;
    await writeTimeline(this.workspace, this.slug, json);
    this.disk = json;
  }
}

function parseTimeline(text: string): Timeline {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new VideoToolError(`timeline.json isn't valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const first = validateTimeline(json);
  if (first.ok) return first.timeline;
  const repaired = typeof json === "object" && json && Array.isArray((json as Timeline).compositions) ? validateTimeline(ops.repairTimeline(json as Timeline)) : first;
  if (repaired.ok) return repaired.timeline;
  throw new VideoToolError(`timeline.json is invalid, fix it first:\n${first.errors.slice(0, 12).join("\n")}`);
}

const headless = new Map<string, HeadlessDoc>();

/** The project opened in the live store: its undo steps go along, and the document is its. */
function handOver(workspace: string, slug: string): void {
  const key = keyOf(workspace, slug);
  const doc = headless.get(key);
  if (!doc) return;
  headless.delete(key);
  seedHistory(doc.past);
}

/** What the tools see of the document, wherever it is. */
export interface VideoTarget {
  kind: "live" | "headless";
  workspace: string;
  slug: string;
  timeline(): Timeline;
  compositionId(): string;
  setComposition(id: string): void;
  commit(next: Timeline, opts: { txn?: string; select?: string[] }): Promise<boolean>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  canUndo(): boolean;
  canRedo(): boolean;
  playhead(): number;
  setPlayhead(frame: number): void;
  selection(): string[];
  select(ids: string[]): void;
  inOut(): { inPoint: number | null; outPoint: number | null };
  setInOut(inPoint: number | null, outPoint: number | null): void;
  /** Everything is in timeline.json once this resolves. */
  flush(): Promise<void>;
  unsaved(): boolean;
  saveError(): string | null;
}

function liveTarget(workspace: string, slug: string): VideoTarget {
  const state = getTimelineState;
  return {
    kind: "live",
    workspace,
    slug,
    timeline: () => state().timeline as Timeline,
    compositionId: () => state().compositionId as string,
    setComposition: (id) => timelineActions.setComposition(id),
    commit: async (next, { txn, select }) =>
      timelineActions.commit(next, {
        ...(txn ? { coalesce: txn, sticky: true } : {}),
        ...(select ? { selection: { clipIds: select, trackId: null, markerId: null } } : {}),
      }),
    undo: async () => {
      if (!state().canUndo) return false;
      storeUndo();
      return true;
    },
    redo: async () => {
      if (!state().canRedo) return false;
      storeRedo();
      return true;
    },
    canUndo: () => state().canUndo,
    canRedo: () => state().canRedo,
    playhead: getPlayhead,
    setPlayhead: (frame) => setPlayhead(frame),
    selection: () => state().selection.clipIds,
    select: (ids) => timelineActions.select(ids),
    inOut: () => ({ inPoint: state().inPoint, outPoint: state().outPoint }),
    setInOut: (a, b) => timelineActions.setInOut(a, b),
    flush: flushSave,
    unsaved: hasUnsavedEdits,
    saveError: () => state().saveError,
  };
}

function headlessTarget(doc: HeadlessDoc): VideoTarget {
  const compOf = () => doc.timeline.compositions.find((c) => c.id === doc.compositionId);
  return {
    kind: "headless",
    workspace: doc.workspace,
    slug: doc.slug,
    timeline: () => doc.timeline,
    compositionId: () => doc.compositionId,
    setComposition: (id) => {
      if (id === doc.compositionId) return;
      doc.compositionId = id;
      doc.selection = [];
      doc.inPoint = doc.outPoint = null;
      doc.playhead = 0;
    },
    commit: async (proposed, { txn, select }) => {
      const next = ops.repairTimeline(proposed);
      if (select) doc.selection = select;
      if (next === doc.timeline) return false;
      if (!txn || doc.coalesce !== txn) doc.past.push(doc.timeline);
      doc.coalesce = txn ?? null;
      doc.future = [];
      doc.timeline = next;
      await doc.write();
      return true;
    },
    undo: async () => {
      const prev = doc.past.pop();
      if (!prev) return false;
      doc.future.push(doc.timeline);
      doc.timeline = prev;
      doc.coalesce = null;
      await doc.write();
      return true;
    },
    redo: async () => {
      const next = doc.future.pop();
      if (!next) return false;
      doc.past.push(doc.timeline);
      doc.timeline = next;
      doc.coalesce = null;
      await doc.write();
      return true;
    },
    canUndo: () => doc.past.length > 0,
    canRedo: () => doc.future.length > 0,
    playhead: () => doc.playhead,
    setPlayhead: (frame) => {
      doc.playhead = Math.max(0, Math.min((compOf()?.durationInFrames ?? 1) - 1, Math.round(frame)));
    },
    selection: () => doc.selection,
    select: (ids) => {
      doc.selection = ids;
    },
    inOut: () => ({ inPoint: doc.inPoint, outPoint: doc.outPoint }),
    setInOut: (a, b) => {
      doc.inPoint = a;
      doc.outPoint = b;
    },
    flush: () => doc.write(),
    unsaved: () => serializeTimeline(doc.timeline) !== doc.disk,
    saveError: () => null,
  };
}

const LIVE_WAIT_MS = 20_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

/** Waits for the live store to finish opening the project; false if it doesn't in time. */
async function waitForLive(workspace: string, slug: string, signal?: AbortSignal, timeoutMs = LIVE_WAIT_MS): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const s = getTimelineState();
    if (liveProject(workspace, slug)) {
      if (s.status === "ready") return true;
      if (s.status === "error") throw new VideoToolError(`The project "${slug}" can't be opened: ${s.error ?? "invalid timeline.json"}`);
    }
    await sleep(50, signal);
  }
  return false;
}

/** The chat's project as the tools reach it right now. */
async function targetOf(b: Binding): Promise<VideoTarget> {
  const { workspace, slug } = b;
  if (liveProject(workspace, slug)) {
    const s = getTimelineState();
    if (s.status === "error") throw new VideoToolError(`The project "${slug}" can't be opened: ${s.error ?? "invalid timeline.json"}`);
    if (s.status === "ready" || (await waitForLive(workspace, slug, undefined, 5000))) {
      handOver(workspace, slug);
      return liveTarget(workspace, slug);
    }
  }
  const key = keyOf(workspace, slug);
  let doc = headless.get(key);
  if (doc) await doc.sync();
  else {
    const text = await readTimeline(workspace, slug);
    const timeline = parseTimeline(text);
    doc = new HeadlessDoc(workspace, slug, timeline, timeline.compositions[0].id, text);
    headless.set(key, doc);
  }
  return headlessTarget(doc);
}

const chatKey = (ctx: VideoCallContext) => ctx.chat ?? "";

function missingProject(projects: VideoProjectInfo[], asked?: string): VideoToolError {
  const names = projects.map((p) => `${p.slug} ("${p.name}")`);
  const head = asked ? `No project "${asked}" in videos/.` : "This chat has no video project open.";
  return new VideoToolError(`${head} ${names.length ? `Projects: ${names.join(", ")}. Open one with open_project.` : "There are none yet: make one with create_project."}`);
}

/** Binds the chat to a project and shows it in the chat's panel, opening the Video view (as the
 *  browser tools open the browser). The chat on screen waits for the live editor. A chat in the
 *  background gets the view for when the user goes there, and edits headless until then, since
 *  the one live editor may be showing the user something else. */
export async function openProjectFor(ctx: VideoCallContext, slug: string, at: { compositionId?: string; frame?: number } = {}): Promise<VideoTarget> {
  const workspace = workspaceFor(ctx);
  const projects = await listProjects(workspace);
  if (!projects.some((p) => p.slug === slug)) throw missingProject(projects, slug);
  bindings.set(chatKey(ctx), { workspace, slug });
  requestVideoOpen({ chat: ctx.chat, slug, compositionId: at.compositionId, frame: at.frame });
  if (isShownFor(ctx.chat)) await waitForLive(workspace, slug, ctx.signal);
  const target = await targetOf({ workspace, slug });
  if (at.compositionId && target.compositionId() !== at.compositionId) target.setComposition(at.compositionId);
  if (at.frame !== undefined) target.setPlayhead(at.frame);
  return target;
}

/** The chat's project, the way a tool call needs it. A chat that never opened one takes what the
 *  editor shows, else the project this folder left open or its only one (opening the view).
 *  Once bound, the panel isn't brought back: if the user closed it, that stands, and the agent
 *  keeps working out of sight until it calls open_project. */
export async function targetFor(ctx: VideoCallContext): Promise<VideoTarget> {
  const workspace = workspaceFor(ctx);
  const bound = bindings.get(chatKey(ctx));
  if (bound && norm(bound.workspace) === norm(workspace)) return targetOf(bound);
  const live = getTimelineState().project;
  if (live && norm(live.workspace) === norm(workspace) && isShownFor(ctx.chat)) {
    const b = { workspace, slug: live.slug };
    bindings.set(chatKey(ctx), b);
    return targetOf(b);
  }
  const projects = await listProjects(workspace);
  if (projects.length !== 1) throw missingProject(projects);
  return openProjectFor(ctx, projects[0].slug);
}

// One call at a time per project.

const queues = new Map<string, Promise<unknown>>();

function inTurn<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(run);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

const GESTURE_WAIT_MS = 10_000;

/** The user's drag wins: an edit waits for it, and gives up if it doesn't end. */
async function waitForUser(signal?: AbortSignal): Promise<void> {
  const until = Date.now() + GESTURE_WAIT_MS;
  while (isGestureActive()) {
    if (Date.now() > until) throw new VideoToolError("The user is dragging something in the timeline. Nothing was changed: try again in a moment.");
    await sleep(50, signal);
  }
}

// What each chat last saw, to tell it when someone else changed the document.

const lastSeen = new Map<string, Timeline>();
const seenKey = (ctx: VideoCallContext, t: VideoTarget) => `${chatKey(ctx)}\n${keyOf(t.workspace, t.slug)}`;

export function noteSeen(ctx: VideoCallContext, t: VideoTarget): void {
  lastSeen.set(seenKey(ctx, t), t.timeline());
}

function staleNote(ctx: VideoCallContext, t: VideoTarget): string {
  const seen = lastSeen.get(seenKey(ctx, t));
  // By content: a reload of what this chat wrote is a new object and no news.
  return seen && seen !== t.timeline() && serializeTimeline(seen) !== serializeTimeline(t.timeline()) ? "Note: the document changed since your last call (the user or another session edited it): snapshot if you need to see how.\n" : "";
}

/**
 * Runs one edit of the chat's project: in its turn, after the user's drag, on the latest document,
 * validated, and as one undo step (or part of its batch's).
 */
export async function runEdit(ctx: VideoCallContext, fn: (timeline: Timeline, compositionId: string, target: VideoTarget) => EditResult | Promise<EditResult>): Promise<string> {
  throwIfStopped(ctx.chat);
  const first = await targetFor(ctx);
  return inTurn(keyOf(first.workspace, first.slug), async () => {
    throwIfStopped(ctx.chat);
    await waitForUser(ctx.signal);
    // Again: the project may have opened or closed in the live editor while this waited.
    const target = await targetOf({ workspace: first.workspace, slug: first.slug });
    const note = staleNote(ctx, target);
    const base = target.timeline();
    const result = await fn(base, target.compositionId(), target);
    if (result.timeline === base && !result.select) {
      noteSeen(ctx, target);
      return `${note}${result.message}`;
    }
    const problem = timelineError(ops.repairTimeline(result.timeline));
    if (problem) throw new VideoToolError(problem);
    if (result.timeline !== base) await ctx.trackEdit?.(`${target.workspace.replace(/[\\/]+$/, "")}/videos/${target.slug}/timeline.json`);
    await target.commit(result.timeline, { txn: ctx.txn, select: result.select });
    noteActivity(ctx.chat, target, result.clipIds ?? []);
    noteSeen(ctx, target);
    return `${note}${result.message}`;
  });
}

// The agent at work, as the editor shows it.

export interface VideoAgentActivity {
  chat?: string;
  workspace: string;
  slug: string;
  clipIds: string[];
}

const ACTIVITY_MS = 2500;
let activity: VideoAgentActivity | null = null;
let activityTimer: ReturnType<typeof setTimeout> | null = null;
const activityListeners = new Set<() => void>();

function setActivity(next: VideoAgentActivity | null): void {
  activity = next;
  for (const l of [...activityListeners]) l();
}

function noteActivity(chat: string | undefined, t: VideoTarget, clipIds: string[]): void {
  if (activityTimer) clearTimeout(activityTimer);
  activityTimer = setTimeout(() => setActivity(null), ACTIVITY_MS);
  setActivity({ chat, workspace: t.workspace, slug: t.slug, clipIds });
}

function subscribeActivity(l: () => void): () => void {
  activityListeners.add(l);
  return () => activityListeners.delete(l);
}

/** The agent's latest edit of the project open in the editor, while it is fresh. */
export function useVideoAgentActivity(workspace: string, slug: string): VideoAgentActivity | null {
  const current = useSyncExternalStore(subscribeActivity, () => activity, () => null);
  return current && current.slug === slug && norm(current.workspace) === norm(workspace) ? current : null;
}

/** The clips the agent just touched; a stable empty list otherwise, so rows don't re-render. */
const NO_CLIPS: string[] = [];
export function useVideoAgentClips(): string[] {
  return useSyncExternalStore(subscribeActivity, () => activity?.clipIds ?? NO_CLIPS, () => NO_CLIPS);
}

/** The editor's Stop: ends the chat's turn, and its video edits are refused until the user
 *  writes to it again. What it already did stays, for the user to undo. */
export function stopVideoAgent(chat: string | undefined): void {
  if (chat) {
    stoppedChats.add(chat);
    abortChat(chat);
  }
  setActivity(null);
}

function throwIfStopped(chat: string | undefined): void {
  if (chat && stoppedChats.has(chat)) {
    throw new VideoToolError("The user pressed Stop on your work in the video editor. Nothing more was changed. Don't try again: tell the user where you got to and wait for them.");
  }
}

// Player and scene errors, as console_logs reads them.

export interface VideoLogEntry {
  at: number;
  level: "error" | "info";
  source: "player" | "scene" | "build" | "render";
  message: string;
}

const MAX_LOG = 200;
const logs = new Map<string, VideoLogEntry[]>();

export function logVideoEvent(workspace: string, slug: string, entry: Omit<VideoLogEntry, "at">): void {
  const key = keyOf(workspace, slug);
  const list = logs.get(key) ?? [];
  list.push({ ...entry, at: Date.now() });
  logs.set(key, list.slice(-MAX_LOG));
}

export function readVideoLog(workspace: string, slug: string, clear = false): VideoLogEntry[] {
  const key = keyOf(workspace, slug);
  const list = logs.get(key) ?? [];
  if (clear) logs.delete(key);
  return list;
}

/** The live player of this project, or why there is none. */
export function playerOf(t: VideoTarget): LivePlayer {
  if (t.kind === "live" && livePlayer && livePlayer.slug === t.slug && norm(livePlayer.workspace) === norm(t.workspace)) return livePlayer;
  throw new VideoToolError(
    `Project "${t.slug}" isn't in the live player right now (${isShownReason()}), so it can't play. Edits, seeking, stills and rendering still work; use open_project to show it.`,
  );
}

function isShownReason(): string {
  const open = getTimelineState().project;
  return open ? `the editor is on "${open.slug}"` : "the Video view is closed";
}

/** The editor when it shows this project on screen, else null. */
export function shellOnScreen(t: VideoTarget): EditorShell | null {
  if (t.kind !== "live" || !shell || shell.slug !== t.slug || norm(shell.workspace) !== norm(t.workspace)) return null;
  return shell.visible() ? shell : null;
}

/** The editor showing this project, on screen or not. */
export function shellOf(t: VideoTarget): EditorShell | null {
  return t.kind === "live" && shell && shell.slug === t.slug && norm(shell.workspace) === norm(t.workspace) ? shell : null;
}

/** A screen area for `preview_capture_png`, or null when `el` takes no room. */
export function boundsOf(el: Element | null): Bounds | null {
  const r = el?.getBoundingClientRect();
  return r && r.width >= 2 && r.height >= 2 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
}

/** Test hook: forgets every chat and document. */
export function resetVideoControlForTests(): void {
  bindings.clear();
  headless.clear();
  queues.clear();
  lastSeen.clear();
  planChats.clear();
  stoppedChats.clear();
  logs.clear();
  livePlayer = null;
  shell = null;
  activity = null;
  activeChat = () => undefined;
  workspaceOfChat = () => undefined;
}

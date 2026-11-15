import { invoke } from "@/lib/ipc";
import type { AgentCliId, CliProcess } from "./agentCli";
import { loadReloadState, saveReloadState } from "./reloadState";

/**
 * ACP agents kept alive between a chat's turns (Grok, OpenCode: starting one and reloading its
 * session took 2–4 s a turn). After a turn the process waits here for the chat's next message;
 * idle too long, or past the cap, it's stopped. A reload of the page leaves it running (Rust
 * detaches it) and the chat's next turn picks it up from what's saved here. Mirrors
 * claudeCodeProcesses.ts, without the replay: a turn cut by a reload isn't resumed, so only
 * idle processes are kept.
 */

type Json = Record<string, unknown>;

/** What a turn finds when it picks a process up again. */
export interface AcpState {
  /** The `initialize` answer (capabilities). */
  init: Json;
  /** The session the process has open, its answer (models, modes) and the guide it got. */
  sessionId: string;
  session: Json | null;
  guide?: string;
  /** The session's config options as last heard (models, reasoning levels). */
  configOptions: Json[];
  /** The mode the session is in, and the one it started in (left again after plan mode). */
  modeId?: string;
  defaultModeId?: string;
  /** Nyxs' MCP servers the process was given, for another session it opens. */
  mcpServers: Json[];
}

export interface LiveAcp<R = unknown> extends AcpState {
  chatKey: string;
  cli: AgentCliId;
  /** The settings it was started with: another set needs another process. */
  config: string;
  proc: CliProcess;
  /** The JSON-RPC connection (acpAgent's Rpc). */
  rpc: R;
  exited: boolean;
  /** The chat was cleared or deleted during the turn: stop the process when it ends. */
  closeWhenIdle?: boolean;
  idle?: ReturnType<typeof setTimeout>;
}

/** A parked process as saved for after a reload. */
export interface SavedAcp extends AcpState {
  runId: string;
  cwd: string;
  chatKey: string;
  cli: AgentCliId;
  config: string;
}

const IDLE_MS = 20 * 60 * 1000;
const MAX_PARKED = 4;
const SAVED_KEY = "acpRuns";

const parked = new Map<string, LiveAcp>();
const busy = new Map<string, LiveAcp>();
/** Parked before the page reloaded, not picked up by a turn yet: read once from storage. */
let unclaimed: SavedAcp[] | null = null;

function fromBeforeReload(): SavedAcp[] {
  unclaimed ??= loadReloadState<SavedAcp[]>(SAVED_KEY) ?? [];
  return unclaimed;
}

/** Saves the parked processes, and the ones from before a reload no turn has picked up yet. */
function persist(): void {
  const keep = fromBeforeReload();
  const now: SavedAcp[] = [...parked.values()].map((p) => ({
    runId: p.proc.runId,
    cwd: p.proc.cwd,
    chatKey: p.chatKey,
    cli: p.cli,
    config: p.config,
    init: p.init,
    sessionId: p.sessionId,
    session: p.session,
    guide: p.guide,
    configOptions: p.configOptions,
    modeId: p.modeId,
    defaultModeId: p.defaultModeId,
    mcpServers: p.mcpServers,
  }));
  const all = [...now, ...keep];
  saveReloadState(SAVED_KEY, all.length ? all : null);
}

function stop(live: LiveAcp): void {
  if (live.idle) clearTimeout(live.idle);
  live.idle = undefined;
  live.proc.closeInput();
  live.proc.kill();
}

/** Stops a parked process and forgets it. */
export function retireAcp(live: LiveAcp): void {
  if (parked.get(live.chatKey) === live) parked.delete(live.chatKey);
  stop(live);
  persist();
}

/** The chat's parked process when it runs with these settings (another one is stopped). */
export function takeParkedAcp<R>(chatKey: string, config: string): LiveAcp<R> | undefined {
  const live = parked.get(chatKey);
  if (!live) return undefined;
  parked.delete(chatKey);
  if (live.idle) clearTimeout(live.idle);
  live.idle = undefined;
  if (live.exited || live.config !== config) {
    stop(live);
    persist();
    return undefined;
  }
  persist();
  return live as LiveAcp<R>;
}

/** A process the chat had parked before the page reloaded, when it runs with these settings
 *  (one with others is stopped). The caller attaches it. */
export function takeSavedAcp(chatKey: string, config: string): SavedAcp | undefined {
  const list = fromBeforeReload();
  const found = list.find((s) => s.chatKey === chatKey);
  if (!found) return undefined;
  unclaimed = list.filter((s) => s !== found);
  persist();
  if (found.config === config) return found;
  void invoke("agent_cli_kill", { runId: found.runId }).catch(() => undefined);
  return undefined;
}

/** A turn is using the process: /clear or deleting the chat meanwhile closes it at the end. */
export function markAcpBusy(live: LiveAcp): void {
  busy.set(live.chatKey, live);
}

/** After a turn: kept for the chat's next one, unless it ended, its chat was closed, or it
 *  failed (`ok` false: its state is unknown). */
export function parkAcp(live: LiveAcp, ok: boolean): void {
  if (busy.get(live.chatKey) === live) busy.delete(live.chatKey);
  if (!ok || live.exited || live.closeWhenIdle) {
    stop(live);
    return;
  }
  const other = parked.get(live.chatKey);
  if (other && other !== live) stop(other);
  parked.delete(live.chatKey);
  parked.set(live.chatKey, live);
  live.idle = setTimeout(() => retireAcp(live), IDLE_MS);
  // The oldest go first past the cap.
  while (parked.size > MAX_PARKED) {
    const oldest = parked.values().next().value as LiveAcp;
    parked.delete(oldest.chatKey);
    stop(oldest);
  }
  persist();
}

/** Called once the process ends on its own: a parked one is forgotten. */
export function acpExited(live: LiveAcp): void {
  live.exited = true;
  if (parked.get(live.chatKey) === live) {
    parked.delete(live.chatKey);
    if (live.idle) clearTimeout(live.idle);
    persist();
  }
}

/** The chat was cleared or deleted: its process goes now, or when its turn ends. */
export function endAcpChat(chatKey: string): void {
  const live = parked.get(chatKey);
  if (live) retireAcp(live);
  const running = busy.get(chatKey);
  if (running) running.closeWhenIdle = true;
  const list = fromBeforeReload();
  const gone = list.filter((s) => s.chatKey === chatKey);
  if (!gone.length) return;
  for (const s of gone) void invoke("agent_cli_kill", { runId: s.runId }).catch(() => undefined);
  unclaimed = list.filter((s) => s.chatKey !== chatKey);
  persist();
}

/** After a reload: stops the kept-alive processes nothing here knows about (one in the middle of
 *  a turn when the page reloaded; that turn isn't resumed), and forgets saved ones that ended. */
export async function sweepAcpRuns(): Promise<void> {
  const alive = await invoke<string[]>("agent_cli_runs").catch(() => null);
  if (!alive) return;
  const list = fromBeforeReload();
  const known = new Set([...list.map((s) => s.runId), ...[...parked.values(), ...busy.values()].map((p) => p.proc.runId)]);
  for (const runId of alive) if (!known.has(runId)) void invoke("agent_cli_kill", { runId }).catch(() => undefined);
  const live = new Set(alive);
  if (list.some((s) => !live.has(s.runId))) {
    unclaimed = list.filter((s) => live.has(s.runId));
    persist();
  }
}

/** For tests: what a reload of the page does here (its memory goes, sessionStorage stays). */
export function forgetAcpForReload(): void {
  for (const live of parked.values()) if (live.idle) clearTimeout(live.idle);
  parked.clear();
  busy.clear();
  unclaimed = null;
}

/** For tests: forgets every process without stopping it, and what was saved. */
export function resetAcpProcesses(): void {
  for (const live of parked.values()) if (live.idle) clearTimeout(live.idle);
  parked.clear();
  busy.clear();
  unclaimed = null;
  saveReloadState(SAVED_KEY, null);
}

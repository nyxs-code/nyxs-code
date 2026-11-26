import { Channel } from "@tauri-apps/api/core";
import { invoke } from "@/lib/ipc";
import { observeClaudeCodeMessage, runningClaudeCodeTasks, setRunCwd, stopClaudeCodeTasksOfRun } from "./claudeCodeTasks";
import { hostedMcpHandler } from "./browserMcp";
import { sweepAcpRuns } from "./acpProcesses";
import { noteClaudeRateLimit } from "./claudeCodeUsage";
import { loadReloadState, saveReloadState } from "./reloadState";

// The Claude Code processes this page drives: spawning, parking idle ones for the next turn,
// picking them up after a reload, and answering what they send while no turn is shown.

type ProcessEvent =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "exit"; code: number | null };

export type Json = Record<string, unknown>;

const CONTROL_TIMEOUT_MS = 8000;

export function controlRequest(proc: LiveProcess, request: Json): Promise<Json | null> {
  const id = `nyxs-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.pending.delete(id);
      resolve(null);
    }, CONTROL_TIMEOUT_MS);
    proc.pending.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    void sendTo(proc, { type: "control_request", request_id: id, request });
  });
}

export interface TurnSink {
  line: (msg: Json) => Promise<void>;
  exit: (code: number | null) => void;
}

export interface LiveProcess {
  runId: string;
  config: string;
  sessionId?: string;
  exited: boolean;
  stderrTail: string[];
  queue: Promise<void>;
  sink: TurnSink | null;
  autonomous: { done: Promise<void>; resolve: () => void } | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsed: number;
  /** Our own control requests (usage, context) waiting for the CLI's answer, by request id. */
  pending: Map<string, (response: Json | null) => void>;
  /** A turn Claude Code started on its own, kept while the app comes to show it. */
  backlog: Json[] | null;
  backlogTimer: ReturnType<typeof setTimeout> | null;
  /** A turn left background work running (a background command, Monitor, a wake-up), so
   *  Claude Code will speak again on its own: keep its process alive much longer. Worked out
   *  again each time the process is parked. */
  expectsWake: boolean;
  /** A Monitor or ScheduleWakeup Claude Code hasn't spoken up from yet: unlike a background
   *  command, no task tracks it. Cleared when Claude Code starts a turn on its own. */
  wakeScheduled?: boolean;
  /** The chat whose turns this process runs, to find it again after the page reloads. */
  chatKey?: string;
  /** Picked up again after a reload in the middle of a turn: that turn is being replayed. */
  resumed: boolean;
  /** Its chat was cleared or deleted while a turn ran: it ends once the turn does, not parked. */
  closeWhenIdle?: boolean;
}

/** Every process this page started or picked up, by run id, until it exits or is let go. */
export const procs = new Map<string, LiveProcess>();

interface SavedRun {
  runId: string;
  config: string;
  sessionId?: string;
  chatKey?: string;
  expectsWake: boolean;
}

/** Stops one of Claude Code's tasks (a sub-agent or a background command) and leaves the turn
 *  running. False when its process is gone or the CLI refused. */
export async function stopClaudeCodeTask(runId: string, taskId: string): Promise<boolean> {
  const proc = procs.get(runId);
  if (!proc || proc.exited) return false;
  const response = await controlRequest(proc, { subtype: "stop_task", task_id: taskId });
  return response?.subtype === "success";
}

/** Remembers the processes across a reload of the page; they keep running in the native side. */
export function persistRuns(): void {
  const runs: SavedRun[] = [...procs.values()]
    .filter((p) => !p.exited)
    .map((p) => ({ runId: p.runId, config: p.config, sessionId: p.sessionId, chatKey: p.chatKey, expectsWake: p.expectsWake }));
  saveReloadState("claudeRuns", runs.length ? runs : null);
}

/** Answers whether the app will show a turn that Claude Code started on its own in the
 *  given session; it then calls streamClaudeCode with `attachSession`. `resumed` is a turn
 *  that was already running when the page reloaded: its reply is rebuilt from the start. */
type WakeListener = (sessionId: string, opts: { chatKey?: string; resumed: boolean }) => boolean;
let wakeListener: WakeListener | null = null;

export function onClaudeCodeWake(listener: WakeListener): () => void {
  wakeListener = listener;
  return () => {
    if (wakeListener === listener) wakeListener = null;
  };
}

const WAKE_ATTACH_MS = 5000;
export const INBOX_SETTLE_MS = 20_000;
const RESUME_ATTACH_MS = 60_000;

export interface SpawnOptions {
  config: string;
  cwd: string | undefined;
  model: string;
  resume: string | undefined;
  /** Cuts the resumed session at this message uuid and goes on in a new session. */
  resumeAt?: string;
  permissionMode: string | null;
  effort: string | null;
  noTools: boolean;
  ephemeral: boolean;
  /** MCP servers Nyxs hosts for this chat (see hostedMcpHandler). */
  hostedMcp: string[];
  /** Nyxs' instructions added to Claude Code's own system prompt. */
  appendSystemPrompt: string | null;
  /** The session's saved-environment variables. */
  env?: Record<string, string>;
  /** `--max-turns`: headless `--max-steps`. */
  maxTurns?: number;
  /** The folder's own Claude Code config isn't trusted: the CLI loads only the user's. */
  untrustedProject?: boolean;
  /** Claude Code guesses the user's next message after each turn (see onClaudeCodeSuggestion). */
  promptSuggestions?: boolean;
}

export interface AttemptOutcome {
  output: string;
  resumeMissing: boolean;
}

const LIVE_IDLE_MS = 20 * 60 * 1000;
const WAKE_IDLE_MS = 3 * 60 * 60 * 1000;
const MAX_LIVE_PROCESSES = 4;
export const AUTONOMOUS_WAIT_MS = 120_000;
export const live = new Map<string, LiveProcess>();

export function sendTo(proc: LiveProcess, msg: Json): Promise<unknown> {
  return invoke("claude_code_send", { runId: proc.runId, line: JSON.stringify(msg) }).catch(() => undefined);
}

export function forget(proc: LiveProcess): void {
  if (proc.idleTimer) clearTimeout(proc.idleTimer);
  proc.idleTimer = null;
  for (const [key, value] of live) if (value === proc) live.delete(key);
}

export function retire(proc: LiveProcess): void {
  forget(proc);
  procs.delete(proc.runId);
  persistRuns();
  if (!proc.exited) void invoke("claude_code_close_input", { runId: proc.runId }).catch(() => undefined);
}

/**
 * Ends the Claude Code process of a chat that was cleared (/clear) or deleted, instead of leaving
 * it idle until its timeout: the next turn starts a new session anyway. Found by the chat it runs
 * for, or by `sessionId` when it never learned its chat; a process another chat runs is left
 * alone even when it shares the session (a fork that hasn't had a turn of its own yet). One
 * still running a turn ends when that turn does. Returns the sessions it ended.
 */
export function endClaudeCodeChat(chatKey: string, sessionId?: string): string[] {
  const ended: string[] = [];
  for (const proc of [...procs.values()]) {
    const ours = proc.chatKey ? proc.chatKey === chatKey : !!sessionId && proc.sessionId === sessionId;
    if (!ours) continue;
    if (proc.sessionId) ended.push(proc.sessionId);
    if (proc.sink || proc.backlog) proc.closeWhenIdle = true;
    else retire(proc);
  }
  return ended;
}

export function park(proc: LiveProcess): void {
  forget(proc);
  if (proc.exited || !proc.sessionId || proc.closeWhenIdle) {
    retire(proc);
    return;
  }
  proc.lastUsed = Date.now();
  // Set by any turn that left background work, it stayed set after the work was done, and the
  // process kept the long wait (and kept other idle ones from being let go first) for nothing.
  proc.expectsWake = !!proc.wakeScheduled || runningClaudeCodeTasks(proc.runId) > 0;
  live.set(proc.sessionId, proc);
  const expire = () => {
    if (runningClaudeCodeTasks(proc.runId) > 0) proc.idleTimer = setTimeout(expire, WAKE_IDLE_MS);
    else retire(proc);
  };
  proc.idleTimer = setTimeout(expire, proc.expectsWake ? WAKE_IDLE_MS : LIVE_IDLE_MS);
  const idle = [...live.values()]
    .filter((p) => !p.sink && !p.backlog && !p.resumed && runningClaudeCodeTasks(p.runId) === 0)
    .sort((a, b) => Number(a.expectsWake) - Number(b.expectsWake) || a.lastUsed - b.lastUsed);
  while (live.size > MAX_LIVE_PROCESSES && idle.length) retire(idle.shift()!);
}

/** A message that arrives while no turn of ours is running. When Claude Code starts a turn on
 *  its own, the app is offered it: its messages wait in the backlog until the app shows it,
 *  or are let go after a few seconds. */
function onUnattended(proc: LiveProcess, msg: Json): void {
  if (proc.backlog) {
    proc.backlog.push(msg);
    return;
  }
  const starts = !proc.autonomous && (msg.type === "stream_event" || msg.type === "assistant");
  if (starts && proc.sessionId && wakeListener) {
    proc.backlog = [msg];
    // A process picked up after a reload may only now have learned its session.
    if (!live.has(proc.sessionId)) live.set(proc.sessionId, proc);
    const resumed = proc.resumed;
    proc.resumed = false;
    if (!wakeListener(proc.sessionId, { chatKey: proc.chatKey, resumed })) {
      proc.backlog = null;
      unattendedDefault(proc, msg);
      return;
    }
    // The reloaded app may first have to load the chat back from disk.
    proc.backlogTimer = setTimeout(() => {
      const waiting = proc.backlog ?? [];
      proc.backlog = null;
      proc.backlogTimer = null;
      for (const m of waiting) unattendedDefault(proc, m);
    }, resumed ? RESUME_ATTACH_MS : WAKE_ATTACH_MS);
    return;
  }
  unattendedDefault(proc, msg);
}

/** Decides a tool request from a turn nobody is showing, from the session's permission mode. */
type UnattendedPermission = (sessionId: string, toolName: string, input: Json) => Promise<boolean>;
let unattendedPermission: UnattendedPermission | null = null;

export function onClaudeCodeUnattendedPermission(resolver: UnattendedPermission): () => void {
  unattendedPermission = resolver;
  return () => {
    if (unattendedPermission === resolver) unattendedPermission = null;
  };
}

async function answerUnattendedTool(proc: LiveProcess, msg: Json, request: Json): Promise<void> {
  const input = (request.input ?? {}) as Json;
  let allow = false;
  if (unattendedPermission && proc.sessionId) {
    allow = await unattendedPermission(proc.sessionId, String(request.tool_name ?? ""), input).catch(() => false);
  }
  await sendTo(proc, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: msg.request_id,
      response: allow
        ? { behavior: "allow", updatedInput: input, toolUseID: request.tool_use_id }
        : {
            behavior: "deny",
            message: "Nobody is watching this session right now and its permission mode doesn't allow this on its own. Tell the user what you wanted to do in your reply.",
            toolUseID: request.tool_use_id,
          },
    },
  });
}

function unattendedDefault(proc: LiveProcess, msg: Json): void {
  if (msg.type === "control_request" && ((msg.request ?? {}) as Json).subtype === "can_use_tool") {
    void answerUnattendedTool(proc, msg, (msg.request ?? {}) as Json);
    return;
  }
  if (msg.type === "control_request") {
    const request = (msg.request ?? {}) as Json;
    void sendTo(
      proc,
      request.subtype === "can_use_tool"
        ? {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: msg.request_id,
              response: { behavior: "deny", message: "Nobody is attending this session right now.", toolUseID: request.tool_use_id },
            },
          }
        : {
            type: "control_response",
            response: { subtype: "error", request_id: msg.request_id, error: `Unsupported request: ${String(request.subtype)}` },
          },
    );
    return;
  }
  if (msg.type === "result") {
    proc.autonomous?.resolve();
    proc.autonomous = null;
    return;
  }
  if (!proc.autonomous && (msg.type === "stream_event" || msg.type === "assistant")) {
    proc.wakeScheduled = false;
    let resolve: () => void = () => undefined;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    proc.autonomous = { done, resolve };
  }
}

function newProc(runId: string, config: string): LiveProcess {
  const proc: LiveProcess = {
    runId,
    config,
    exited: false,
    stderrTail: [],
    queue: Promise.resolve(),
    sink: null,
    autonomous: null,
    idleTimer: null,
    lastUsed: Date.now(),
    pending: new Map(),
    backlog: null,
    backlogTimer: null,
    expectsWake: false,
    resumed: false,
  };
  procs.set(runId, proc);
  return proc;
}

export async function spawnLive(o: SpawnOptions): Promise<LiveProcess> {
  const proc = newProc(`cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, o.config);
  const channel = channelFor(proc);
  setRunCwd(proc.runId, o.cwd);
  await invoke("claude_code_start", {
    request: {
      runId: proc.runId,
      cwd: o.cwd ?? null,
      model: o.model,
      resume: o.resume ?? null,
      resumeAt: o.resumeAt ?? null,
      permissionMode: o.permissionMode,
      effort: o.effort,
      noTools: o.noTools,
      ephemeral: o.ephemeral,
      sdkMcpServers: o.hostedMcp,
      appendSystemPrompt: o.appendSystemPrompt,
      env: o.env ?? {},
      maxTurns: o.maxTurns ?? null,
      untrustedProject: o.untrustedProject ?? false,
    },
    onEvent: channel,
  });
  persistRuns();
  // The CLI only connects to the servers we host once the initialize request names them. The
  // next-prompt guess is turned on there too, as Claude Code Desktop does: the CLI forks the turn
  // it just ran (its cache included), so the guess sees the whole session, tools and all. A CLI
  // that doesn't know the option ignores it.
  if (o.hostedMcp.length || o.promptSuggestions) {
    await controlRequest(proc, {
      subtype: "initialize",
      ...(o.hostedMcp.length ? { sdkMcpServers: o.hostedMcp } : {}),
      ...(o.promptSuggestions ? { promptSuggestions: true } : {}),
    });
  }
  return proc;
}

type SuggestionListener = (chatKey: string, suggestion: string) => void;
let suggestionListener: SuggestionListener | null = null;

/** Hears the next message Claude Code guesses for a chat once a turn of it ends. */
export function onClaudeCodeSuggestion(listener: SuggestionListener): () => void {
  suggestionListener = listener;
  return () => {
    if (suggestionListener === listener) suggestionListener = null;
  };
}

/** Picks up the Claude Code processes that kept running while the page reloaded. Idle ones wait
 *  for the chat's next message as before; one in the middle of a turn has that turn replayed
 *  and shown again in its chat (see onClaudeCodeWake), where it carries on live. */
export async function reattachClaudeCodeRuns(): Promise<void> {
  // The kept-alive ACP agents (Grok) wait for their chat's next turn to be picked up; the ones
  // nothing here knows about (cut mid-turn by the reload) are stopped now.
  void sweepAcpRuns();
  const saved = loadReloadState<SavedRun[]>("claudeRuns") ?? [];
  const alive = await invoke<{ runId: string; sessionId: string | null; busy: boolean; exited: boolean }[]>("claude_code_runs").catch(() => []);
  for (const info of alive) {
    const s = saved.find((r) => r.runId === info.runId);
    if (procs.has(info.runId)) continue;
    // Only this page drives Claude Code: a run it never noted started just as it reloaded
    // (its start answered too late), and would wait for input until Nyxs closes.
    if (!s) {
      if (!info.exited) void invoke("claude_code_kill", { runId: info.runId }).catch(() => undefined);
      continue;
    }
    const proc = newProc(info.runId, s.config);
    proc.sessionId = info.sessionId ?? s.sessionId;
    proc.chatKey = s.chatKey;
    proc.expectsWake = s.expectsWake;
    // This page doesn't know the tasks it left running: still waiting until Claude Code speaks.
    proc.wakeScheduled = s.expectsWake;
    proc.resumed = info.busy;
    if (!info.exited && proc.sessionId) park(proc);
    try {
      await invoke("claude_code_attach", { runId: info.runId, replay: info.busy, onEvent: channelFor(proc) });
    } catch {
      procs.delete(info.runId);
      forget(proc);
    }
  }
  persistRuns();
}

function channelFor(proc: LiveProcess): Channel<ProcessEvent> {
  const channel = new Channel<ProcessEvent>();
  channel.onmessage = (event) => {
    if (event.kind === "stderr") {
      proc.stderrTail.push(event.line);
      if (proc.stderrTail.length > 20) proc.stderrTail.shift();
      return;
    }
    if (event.kind === "exit") {
      proc.exited = true;
      for (const resolve of proc.pending.values()) resolve(null);
      proc.pending.clear();
      forget(proc);
      procs.delete(proc.runId);
      persistRuns();
      proc.autonomous?.resolve();
      proc.autonomous = null;
      if (proc.backlogTimer) clearTimeout(proc.backlogTimer);
      proc.backlogTimer = null;
      proc.backlog = null;
      stopClaudeCodeTasksOfRun(proc.runId);
      proc.queue = proc.queue.then(() => proc.sink?.exit(event.code));
      return;
    }
    let msg: Json;
    try {
      msg = JSON.parse(event.line) as Json;
    } catch {
      return;
    }
    if (msg.type === "system" && msg.subtype === "init" && typeof msg.session_id === "string" && proc.sessionId !== msg.session_id) {
      proc.sessionId = msg.session_id;
      persistRuns();
    }
    if (msg.type === "system" && msg.subtype === "init" && typeof msg.cwd === "string") setRunCwd(proc.runId, msg.cwd);
    observeClaudeCodeMessage(proc.runId, proc.sessionId, msg);
    if (msg.type === "rate_limit_event") {
      noteClaudeRateLimit((msg.rate_limit_info ?? {}) as Json);
      return;
    }
    // A tool call for an MCP server Nyxs hosts: answered at once, whether or not a turn is running.
    if (msg.type === "control_request" && (msg.request as Json | undefined)?.subtype === "mcp_message") {
      void answerHostedMcp(proc, msg);
      return;
    }
    // Sent after the turn's result: queued behind it, so the reply is finished in the chat first.
    if (msg.type === "prompt_suggestion") {
      const chatKey = proc.chatKey;
      const text = typeof msg.suggestion === "string" ? msg.suggestion.trim() : "";
      if (chatKey && text) proc.queue = proc.queue.then(() => suggestionListener?.(chatKey, text)).catch(() => undefined);
      return;
    }
    if (msg.type === "control_response") {
      const response = (msg.response ?? {}) as Json;
      const waiting = proc.pending.get(String(response.request_id));
      if (waiting) {
        proc.pending.delete(String(response.request_id));
        waiting(response);
        return;
      }
    }
    proc.queue = proc.queue
      .then(() => (proc.sink ? proc.sink.line(msg) : onUnattended(proc, msg)))
      .catch(() => undefined);
  };
  return channel;
}

async function answerHostedMcp(proc: LiveProcess, msg: Json): Promise<void> {
  const request = (msg.request ?? {}) as Json;
  const handler = hostedMcpHandler(String(request.server_name));
  let response: Json;
  try {
    if (!handler) throw new Error(`Unknown MCP server: ${String(request.server_name)}`);
    response = { subtype: "success", request_id: msg.request_id, response: { mcp_response: await handler((request.message ?? {}) as Json, proc.chatKey) } };
  } catch (err) {
    response = { subtype: "error", request_id: msg.request_id, error: err instanceof Error ? err.message : String(err) };
  }
  if (!proc.exited) await sendTo(proc, { type: "control_response", response });
}

import type { ModelMessage } from "ai";
import type { ModelInfo } from "./models";
import type { EffortLevel } from "./effort";
import type { CacheStats, ChatTurn } from "./ai";
import type { InboxMessage, TurnInbox } from "./turnInbox";
import type { PublishedChange } from "./prDetect";
import { EDIT_TOOLS } from "./permissions";
import {
  buildToolDetail,
  previewToolOutput,
  OUTPUT_PREVIEW_TOOLS,
  type AskQuestion,
  type AskUserFn,
  type FileEditTracker,
  type PermissionGate,
  type Todo,
  type ToolDetail,
} from "./agentTools";
import { diffFromStructuredPatch, diffStatsOf, editStatsOfResult } from "./toolDetail";
import { INBOX_SETTLE_MS, sendTo, type Json, type LiveProcess } from "./claudeCodeProcesses";
import { editedPath, resultText, shortError, toolLabel, userContent } from "./claudeCodeText";

// What one Claude Code turn does with each message the CLI streams back: the turn's state in one
// object (TurnState) and a handler per message type. runTurn in claudeCode.ts owns the process
// around it (sending the prompt, the sink, stopping, the final result).

export interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Json;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface ResultMessage {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface ClaudeCodeTurn {
  model: ModelInfo;
  history: ChatTurn[];
  workspace?: string | null;
  signal?: AbortSignal;
  planMode: boolean;
  effort: EffortLevel;
  gate?: PermissionGate;
  askUser?: AskUserFn;
  onChunk: (text: string) => void;
  onTool?: (id: string, detail: ToolDetail) => void;
  onUsage?: (tokens: number) => void;
  onContext?: (usedTokens: number) => void;
  onTodos?: (todos: Todo[]) => void;
  onPlan?: (plan: string) => void;
  onFileEdit?: FileEditTracker;
  onReasoning?: (id: string, delta: string) => void;
  onMessages?: (messages: ModelMessage[]) => void;
  onCacheStats?: (stats: CacheStats) => void;
  /** Claude Code started or finished compacting its session. */
  onCompacting?: (active: boolean) => void;
  /** Its compaction is done (`compact_boundary`); `preTokens` is the context before, when it says. */
  onCompactBoundary?: (c: { preTokens?: number }) => void;
  /** A request failed and will be sent again (`rateLimited`: waiting out the usage limit); null once it's going again. */
  onRetrying?: (retry: { rateLimited: boolean; waitMs?: number } | null) => void;
  /** Claude Code is being made ready on this machine; null once it is. */
  onRemoteSetup?: (host: string | null) => void;
  /** The most agentic turns the process may take (`--max-turns`); headless `--max-steps`. */
  maxTurns?: number;
  /** A subagent of this turn edited a file (its messages are otherwise left out of the chat). */
  onSubagentEdit?: (edit: { path: string; added: number; removed: number }) => void;
  /** Claude Code saw the session publish a code change (`code_change_published`): a PR it
   *  opened, or one it pushed to, merged, commented on… (`action` says which). */
  onPrPublished?: (change: PublishedChange) => void;
  ephemeral?: boolean;
  /** Shows a turn Claude Code started on its own in this session (a background task woke it),
   *  instead of sending a new message. */
  attachSession?: string;
  inbox?: TurnInbox;
  /** The chat this turn belongs to, so the process can be found again after a reload. */
  chatKey?: string;
}

/** Everything a turn keeps track of while its messages arrive. */
export interface TurnState {
  /** All the text the chat was sent, markers included. */
  full: string;
  /** The model's own words, for the reply the chat saves. */
  assistantText: string;
  reasonSeq: number;
  /** The reasoning block being written to, until text or a new content block ends it. */
  reasonPhaseId: string | null;
  todoEmitted: boolean;
  planEmitted: boolean;
  sessionId: string | undefined;
  /** The uuid of the turn's last message in the session: where a chat cut back to this reply
   *  resumes it from (see claudeCodeHeads). */
  lastEntry: string | undefined;
  result: ResultMessage | null;
  apiError: string | null;
  apiErrorText: string;
  /** The real model behind the alias the chat picked ("opus" → "claude-opus-5-5"), for pricing. */
  servedModel: string;
  outputTokens: number;
  messageOutput: number;
  exitCode: number | null;
  /** Tool calls shown in the chat, by id. */
  placed: Map<string, { name: string; detail: ToolDetail }>;
  /** Files already reported to the file history this turn. */
  tracked: Set<string>;
  /** Queued messages sent to Claude Code that it hasn't replayed yet. */
  inflight: { item: InboxMessage; sent: string }[];
  stopping: boolean;
  // What the status line shows besides the stream: only changes are reported.
  compacting: boolean;
  retrying: boolean;
  /** The turn's own prompt comes back first; every later replay is a queued message. */
  promptEchoed: boolean;
  settleTimer: ReturnType<typeof setTimeout> | null;
  awaitingInbox: boolean;
}

export function newTurnState(sessionId: string | undefined, promptEchoed: boolean): TurnState {
  return {
    full: "",
    assistantText: "",
    reasonSeq: 0,
    reasonPhaseId: null,
    todoEmitted: false,
    planEmitted: false,
    sessionId,
    lastEntry: undefined,
    result: null,
    apiError: null,
    apiErrorText: "",
    servedModel: "",
    outputTokens: 0,
    messageOutput: 0,
    exitCode: null,
    placed: new Map(),
    tracked: new Set(),
    inflight: [],
    stopping: false,
    compacting: false,
    retrying: false,
    promptEchoed,
    settleTimer: null,
    awaitingInbox: false,
  };
}

/** One running turn: what the chat asked for, the process it runs on and its state. */
export interface StreamTurn {
  t: ClaudeCodeTurn;
  proc: LiveProcess;
  workspace: string | undefined;
  s: TurnState;
  /** Ends the turn (its result arrived, the process exited, or the queue went quiet). */
  finish: () => void;
}

export function emit(c: StreamTurn, text: string): void {
  if (!text) return;
  c.s.reasonPhaseId = null;
  c.s.full += text;
  c.t.onChunk(text);
}

export function emitReasoning(c: StreamTurn, text: string): void {
  if (!text) return;
  if (c.s.reasonPhaseId === null) {
    const id = `r${++c.s.reasonSeq}`;
    emit(c, `\n\n⟦REASONING⟧${id}⟦/REASONING⟧\n\n`);
    c.s.reasonPhaseId = id;
  }
  c.t.onReasoning?.(c.s.reasonPhaseId, text);
}

async function trackEdit(c: StreamTurn, path: string | null): Promise<void> {
  if (!path || !c.t.onFileEdit || c.s.tracked.has(path)) return;
  c.s.tracked.add(path);
  try {
    await c.t.onFileEdit(path);
  } catch {
    c.s.tracked.delete(path);
  }
}

export function setCompacting(c: StreamTurn, on: boolean): void {
  if (on === c.s.compacting) return;
  c.s.compacting = on;
  c.t.onCompacting?.(on);
}

export function setRetrying(c: StreamTurn, retry: { rateLimited: boolean; waitMs?: number } | null): void {
  if (!retry && !c.s.retrying) return;
  c.s.retrying = !!retry;
  c.t.onRetrying?.(retry);
}

/** The answer to Claude Code asking whether a tool may run: the user's question and the plan
 *  are answered here, everything else goes through the chat's permission gate. */
export async function decidePermission(c: StreamTurn, toolName: string, input: Json): Promise<Json> {
  if (toolName === "AskUserQuestion") {
    const questions = (Array.isArray(input.questions) ? input.questions : []) as AskQuestion[];
    const answers = c.t.askUser ? await c.t.askUser(questions) : null;
    if (!answers) return { behavior: "deny", message: "The user dismissed the question without answering." };
    return {
      behavior: "allow",
      updatedInput: { ...input, answers: Object.fromEntries(answers.map((a) => [a.question, a.answer])) },
    };
  }
  if (toolName === "ExitPlanMode") {
    c.t.onPlan?.(String(input.plan ?? ""));
    if (!c.s.planEmitted) {
      emit(c, "\n\n⟦PLAN⟧\n\n");
      c.s.planEmitted = true;
    }
    return {
      behavior: "deny",
      message: "The plan is now shown to the user for review. Stop here and wait for the user's reply before making any changes.",
    };
  }
  const allowed = c.t.gate ? await c.t.gate(toolName, input) : true;
  if (!allowed) return { behavior: "deny", message: "The user denied this action." };
  await trackEdit(c, editedPath(toolName, input));
  return { behavior: "allow", updatedInput: input };
}

/** A `control_request` from Claude Code: only `can_use_tool` is supported. */
export async function onControlRequest(c: StreamTurn, msg: Json): Promise<void> {
  const requestId = msg.request_id as string;
  const request = (msg.request ?? {}) as Json;
  if (request.subtype !== "can_use_tool") {
    await sendTo(c.proc, {
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error: `Unsupported request: ${String(request.subtype)}` },
    });
    return;
  }
  let response: Json;
  try {
    response = await decidePermission(c, String(request.tool_name ?? ""), (request.input ?? {}) as Json);
  } catch (err) {
    response = { behavior: "deny", message: err instanceof Error ? err.message : String(err) };
  }
  if (c.proc.exited) return;
  await sendTo(c.proc, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { ...response, toolUseID: request.tool_use_id },
    },
  });
}

export async function onToolUse(c: StreamTurn, block: ContentBlock): Promise<void> {
  const id = block.id ?? "";
  const name = block.name ?? "";
  const input = block.input ?? {};
  if (!id || c.s.placed.has(id) || name === "AskUserQuestion" || name === "ExitPlanMode") return;
  if (input.run_in_background === true || name === "Monitor" || name === "ScheduleWakeup") c.proc.expectsWake = true;
  if (name === "Monitor" || name === "ScheduleWakeup") c.proc.wakeScheduled = true;
  if (name === "TodoWrite") {
    c.t.onTodos?.((input.todos as Todo[]) ?? []);
    if (!c.s.todoEmitted) {
      emit(c, "\n\n⟦TODO⟧\n\n");
      c.s.todoEmitted = true;
    }
    return;
  }
  const label = toolLabel(name, input);
  emit(c, `\n\n⟦TOOL⟧${id}⟦SEP⟧${label.name}⟦SEP⟧${label.detail}⟦/TOOL⟧\n\n`);
  const built = await buildToolDetail(name, input, c.workspace).catch(() => ({ name: label.name, detail: label.detail }));
  const detail: ToolDetail = { ...built, name: label.name, detail: label.detail, startedAt: Date.now() };
  c.s.placed.set(id, { name, detail });
  c.t.onTool?.(id, detail);
  void trackEdit(c, editedPath(name, input));
}

export function onToolResult(c: StreamTurn, block: ContentBlock, toolResult: unknown): void {
  const id = block.tool_use_id ?? "";
  const entry = c.s.placed.get(id);
  if (!entry) return;
  const text = resultText(block.content);
  let detail: ToolDetail = { ...entry.detail, endedAt: Date.now() };
  if (block.is_error) {
    emit(c, `⟦TOOLEND⟧${id}⟦SEP⟧err⟦SEP⟧${shortError(text)}⟦/TOOLEND⟧`);
  } else {
    emit(c, `⟦TOOLEND⟧${id}⟦SEP⟧ok⟦/TOOLEND⟧`);
    if ((OUTPUT_PREVIEW_TOOLS.has(entry.name) || entry.name === "PowerShell") && text.trim()) {
      detail = { ...detail, ...previewToolOutput(text) };
    }
    if (EDIT_TOOLS.has(entry.name)) {
      const patch = diffFromStructuredPatch((toolResult as Json | undefined)?.structuredPatch);
      if (patch) detail = { ...detail, ...diffStatsOf(patch), diff: patch };
    }
  }
  entry.detail = detail;
  c.t.onTool?.(id, detail);
}

/** A raw API event (`stream_event`): text and thinking as they are written, and token counts. */
export function onStreamEvent(c: StreamTurn, event: Json): void {
  const s = c.s;
  switch (event.type) {
    case "message_start": {
      s.messageOutput = 0;
      const usage = ((event.message as Json | undefined)?.usage ?? {}) as Record<string, number | undefined>;
      const context =
        (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      if (context > 0) c.t.onContext?.(context);
      break;
    }
    case "content_block_delta": {
      const delta = (event.delta ?? {}) as Json;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        s.assistantText += delta.text;
        emit(c, delta.text);
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        emitReasoning(c, delta.thinking);
      }
      break;
    }
    case "content_block_stop":
      s.reasonPhaseId = null;
      break;
    case "message_delta": {
      const out = ((event.usage ?? {}) as Json).output_tokens;
      if (typeof out === "number") {
        s.messageOutput = out;
        c.t.onUsage?.(s.outputTokens + s.messageOutput);
      }
      break;
    }
    case "message_stop":
      s.outputTokens += s.messageOutput;
      s.messageOutput = 0;
      if (s.assistantText && !s.assistantText.endsWith("\n")) s.assistantText += "\n\n";
      break;
  }
}

export function onSystemMessage(c: StreamTurn, msg: Json): void {
  if (msg.subtype === "init" && typeof msg.session_id === "string") c.s.sessionId = msg.session_id;
  // Claude Code compacting its own session: `status: "compacting"`, then another status
  // (or the boundary) once it's done.
  else if (msg.subtype === "status") setCompacting(c, msg.status === "compacting");
  else if (msg.subtype === "compact_boundary") {
    setCompacting(c, false);
    const pre = (msg.compact_metadata as Json | undefined)?.pre_tokens;
    c.t.onCompactBoundary?.(typeof pre === "number" && pre > 0 ? { preTokens: pre } : {});
  }
  // A failed request it will send again after `retry_delay_ms`; 429 is the usage limit.
  // Claude Code's own PR detection (`gh pr create` and friends), the same event Claude Code
  // Desktop links sessions to PRs with.
  else if (msg.subtype === "code_change_published") {
    if (typeof msg.url === "string") {
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      c.t.onPrPublished?.({ url: msg.url, repo: str(msg.repo), identifier: str(msg.identifier), action: str(msg.action), branch: str(msg.branch) });
    }
  }
  else if (msg.subtype === "api_retry") {
    const waitMs = typeof msg.retry_delay_ms === "number" && msg.retry_delay_ms > 0 ? msg.retry_delay_ms : undefined;
    setRetrying(c, { rateLimited: msg.error_status === 429 || msg.error === "rate_limit", ...(waitMs ? { waitMs } : {}) });
  }
}

/** A whole assistant message: its tool calls (the text already came as stream events), or an
 *  API error Claude Code reports as a synthetic message. */
export async function onAssistantMessage(c: StreamTurn, msg: Json): Promise<void> {
  const s = c.s;
  const message = (msg.message ?? {}) as Json;
  const blocks = (Array.isArray(message.content) ? message.content : []) as ContentBlock[];
  if (typeof msg.error === "string" || message.model === "<synthetic>") {
    s.apiError = typeof msg.error === "string" ? msg.error : s.apiError;
    s.apiErrorText = blocks.map((b) => b.text ?? "").join("\n").trim() || s.apiErrorText;
    return;
  }
  if (typeof message.model === "string" && message.model) s.servedModel = message.model;
  if (typeof msg.uuid === "string" && msg.uuid) s.lastEntry = msg.uuid;
  for (const block of blocks) if (block.type === "tool_use") await onToolUse(c, block);
}

/** A user message: a replay of a message sent to Claude Code (the prompt or a queued one), or
 *  tool results. */
export function onUserMessage(c: StreamTurn, msg: Json): void {
  const s = c.s;
  const message = (msg.message ?? {}) as Json;
  const blocks = (Array.isArray(message.content) ? message.content : []) as ContentBlock[];
  if (msg.isReplay) {
    // Matched by text, else by order (Claude Code replays them in the order they were
    // sent). A message with only an image has no text to match, and waiting for a
    // match that never came left the turn "working" forever.
    const text = blocks.find((b) => b.type === "text")?.text;
    const byText = s.inflight.findIndex((f) => f.sent === text);
    if (byText < 0 && !s.promptEchoed) {
      s.promptEchoed = true;
      return;
    }
    const i = byText >= 0 ? byText : s.inflight.length ? 0 : -1;
    if (i >= 0) {
      const [arrived] = s.inflight.splice(i, 1);
      if (s.assistantText && !s.assistantText.endsWith("\n")) s.assistantText += "\n\n";
      c.t.inbox?.consumed([arrived.item]);
      // Claude Code took a queued message and works on it until its next result, which waits
      // again for whatever is still on its way: no quiet-turn timer in between.
      s.awaitingInbox = false;
    }
    return;
  }
  // Claude Code sends one tool result per user message, with its structured output alongside.
  const toolResult = msg.tool_use_result ?? msg.toolUseResult;
  for (const block of blocks) if (block.type === "tool_result") onToolResult(c, block, toolResult);
}

/** The turn's result. With queued messages still on their way, the turn waits for them. */
export function onResultMessage(c: StreamTurn, msg: Json): void {
  const s = c.s;
  s.result = msg as ResultMessage;
  if (typeof s.result.session_id === "string") s.sessionId = s.result.session_id;
  if (s.inflight.length && !s.stopping && !c.proc.exited) {
    s.awaitingInbox = true;
    return;
  }
  c.finish();
}

/** A subagent's own messages stay out of the chat, but the files it edits belong to this
 *  turn's changes: their results carry the exact patch. */
export function onSubagentMessage(c: StreamTurn, msg: Json): void {
  if (msg.type === "user") {
    const edit = editStatsOfResult(msg.tool_use_result ?? msg.toolUseResult);
    if (edit) c.t.onSubagentEdit?.(edit);
  }
}

/** Every message the process sends while the turn runs. */
export async function handleMessage(c: StreamTurn, msg: Json): Promise<void> {
  const s = c.s;
  if (s.settleTimer) {
    clearTimeout(s.settleTimer);
    s.settleTimer = null;
  }
  if (msg.type === "control_request") {
    void onControlRequest(c, msg);
    return;
  }
  if (msg.parent_tool_use_id) {
    onSubagentMessage(c, msg);
    return;
  }
  switch (msg.type) {
    case "system":
      onSystemMessage(c, msg);
      break;
    case "stream_event":
      setRetrying(c, null);
      onStreamEvent(c, (msg.event ?? {}) as Json);
      break;
    case "assistant":
      await onAssistantMessage(c, msg);
      break;
    case "user":
      onUserMessage(c, msg);
      break;
    case "result":
      onResultMessage(c, msg);
      break;
  }
  // Claude Code goes on to the queued messages. If it goes quiet without doing so, the turn
  // still ends instead of showing as working forever; the messages go back to the chat.
  if (s.awaitingInbox && s.inflight.length) s.settleTimer = setTimeout(c.finish, INBOX_SETTLE_MS);
}

/** Sends the messages the user queued during the turn on to Claude Code. */
export function deliverInbox(c: StreamTurn): void {
  if (!c.t.inbox || c.proc.exited || c.s.stopping) return;
  for (const item of c.t.inbox.take()) {
    const content = userContent({ role: "user", content: item.text, images: item.images }, "");
    const sent = content.find((b) => b.type === "text")?.text as string | undefined;
    c.s.inflight.push({ item, sent: sent ?? "" });
    void sendTo(c.proc, { type: "user", session_id: "", message: { role: "user", content }, parent_tool_use_id: null });
  }
}

/** "Send now" on a queued message: interrupts what Claude Code is doing so it gets to it. */
export function hurryInbox(c: StreamTurn): void {
  if (!c.s.inflight.length || c.proc.exited || c.s.stopping) return;
  void sendTo(c.proc, { type: "control_request", request_id: `${c.proc.runId}-hurry-${Date.now()}`, request: { subtype: "interrupt" } });
}

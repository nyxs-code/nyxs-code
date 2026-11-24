import type { TextStreamPart, ToolSet } from "ai";
import { createReasoningRouter } from "./reasoningStream";
import { subscribeToolProgress } from "./toolProgress";
import { memoryStopIn } from "./commandMemory";
import { movedIn } from "./commandBackground";
import {
  OUTPUT_PREVIEW_TOOLS,
  buildToolDetail,
  describeToolCall,
  parseDiagnosticsBlock,
  previewToolOutput,
  type Todo,
  type ToolDetail,
} from "./toolDetail";

/** An error a provider sent inside the stream. OpenAI-compatible endpoints send their own object
 *  (`{ message }`, `{ error: { message } }`, `{ detail }`), which `String()` turned into
 *  "[object Object]". */
export function streamErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; error?: unknown; detail?: unknown };
    for (const v of [e.message, (e.error as { message?: unknown } | undefined)?.message, e.error, e.detail]) {
      if (typeof v === "string" && v) return v;
    }
    try {
      return JSON.stringify(error).slice(0, 1000);
    } catch {
      // A cyclic object: fall through to its tag.
    }
  }
  return String(error);
}

/** How a stopped stream ends: the SDK closes it quietly with an `abort` part, which a caller would
 *  take for a finished answer. */
function abortError(reason?: string): Error {
  const err = new Error(reason ?? "The user stopped the turn.");
  err.name = "AbortError";
  return err;
}

/** The text of a call that doesn't stream to the user, read whole. Through `fullStream`, not
 *  `textStream`: `textStream` drops the error part, so a rejected request read as an empty answer. */
export async function collectText(fullStream: AsyncIterable<TextStreamPart<ToolSet>>): Promise<string> {
  let text = "";
  for await (const part of fullStream) {
    if (part.type === "text-delta") text += part.text;
    else if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(streamErrorMessage(part.error));
    else if (part.type === "abort") throw abortError(part.reason);
  }
  return text;
}

export interface TurnStreamState {
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalInputTokens: number;
  providerCostUsd: number;
  contextUsed: number;
  lastStepInput: number;
  finishReason: string | undefined;
  reasoningChars: number;
  textChars: number;
  stepCount: number;
  stepText: string;
  /** The step being streamed showed the user some text or started a tool call. */
  stepActed: boolean;
  /** The same for the last finished step: one that ran out of output tokens without it only thought. */
  lastStepActed: boolean;
  stepReasoning: string;
  lastStepReasoning: string;
  todoEmitted: boolean;
  planEmitted: boolean;
  toolCalls: Map<string, { name: string; input: unknown }>;
  toolDetails: Map<string, ToolDetail>;
  editedDiag: Map<string, { tool: string; body: string }>;
}

export function newTurnStreamState(): TurnStreamState {
  return {
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    totalInputTokens: 0,
    providerCostUsd: 0,
    contextUsed: 0,
    lastStepInput: 0,
    finishReason: undefined,
    reasoningChars: 0,
    textChars: 0,
    stepCount: 0,
    stepText: "",
    stepActed: false,
    lastStepActed: false,
    stepReasoning: "",
    lastStepReasoning: "",
    todoEmitted: false,
    planEmitted: false,
    toolCalls: new Map(),
    toolDetails: new Map(),
    editedDiag: new Map(),
  };
}

export interface TurnStreamSinks {
  emit: (text: string) => void;
  emitReasoning: (text: string) => void;
  endReasoningPhase: () => void;
  mark: (name: string) => void;
  passthroughReasoning: boolean;
  showDiagInUi: boolean;
  workspace?: string;
  onTool?: (id: string, detail: ToolDetail) => void;
  onUsage?: (tokens: number) => void;
  onContext?: (usedTokens: number) => void;
  onTodos?: (todos: Todo[]) => void;
  onPlan?: (plan: string) => void;
  onPreview?: (path: string) => void;
  emitEvent: (event: { type: "tool.executed"; tool: string; ok: boolean }) => void;
  afterToolResult?: (call: { name: string; input: unknown }, output: unknown) => Promise<void>;
  now?: () => number;
}

export const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const STREAM_PROGRESS_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const REPORT_EVERY_BYTES = 2048;
const FILE_PATH_RE = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const MAX_TOOL_ERROR_CHARS = 400;
const MARKER_CHARS = /[⟦⟧]/g;

export function hasBlockingDiagnostics(body: string): boolean {
  if (/\berror\b/i.test(body)) return true;
  return !/\b(warning|info|hint)\b/i.test(body);
}

export function compactToolError(raw: string): string {
  const safe = raw.replace(MARKER_CHARS, "");
  const m = safe.match(
    /^(.*?(?:JSON parsing failed|Type validation failed)):\s*(?:Text|Value):\s*([\s\S]*?)\.\s*Error message:\s*([\s\S]*)$/,
  );
  if (m) {
    const [, head, dump, reason] = m;
    const kb = (dump.length / 1024).toFixed(1);
    return `${head} — ${reason.trim()} (entrada de ~${kb} KB omitida)`;
  }
  if (safe.length > MAX_TOOL_ERROR_CHARS) {
    return `${safe.slice(0, MAX_TOOL_ERROR_CHARS)} … (+${safe.length - MAX_TOOL_ERROR_CHARS} caracteres omitidos)`;
  }
  return safe;
}

const outputOf = (u: { outputTokens?: number; totalTokens?: number } | undefined) => u?.outputTokens ?? u?.totalTokens ?? 0;

export function stampToolEnd(state: TurnStreamState, sinks: Pick<TurnStreamSinks, "onTool" | "now">, id: string): void {
  const prev = state.toolDetails.get(id);
  if (!prev) return;
  const next = { ...prev, endedAt: (sinks.now ?? Date.now)() };
  state.toolDetails.set(id, next);
  sinks.onTool?.(id, next);
}

/** The stream, with running tools' progress lines (toolProgress.ts) forwarded while it lasts. */
async function* withToolProgress<T>(stream: AsyncIterable<T>, onProgress: (id: string, text: string) => void): AsyncGenerator<T> {
  const stop = subscribeToolProgress(onProgress);
  try {
    yield* stream;
  } finally {
    stop();
  }
}

export async function processTurnStream(
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
  state: TurnStreamState,
  sinks: TurnStreamSinks,
): Promise<void> {
  const { emit, mark, onTool, onUsage, onContext } = sinks;
  const now = sinks.now ?? Date.now;
  // Reasoning comes as its own parts or inside <think> tags in the text: both count as thinking,
  // only the answer text the router lets through counts as a reply.
  const emitReasoning = (text: string) => {
    state.stepReasoning += text;
    sinks.emitReasoning(text);
  };
  const emitAnswer = (text: string) => {
    if (text.trim()) state.stepActed = true;
    emit(text);
  };
  const router = createReasoningRouter({ passthrough: sinks.passthroughReasoning, emit: emitAnswer, emitReasoning });
  const streamingCalls = new Map<
    string,
    { name: string; buf: string; placed: boolean; path: string; start: number; lastReport: number }
  >();
  const reportStreamProgress = (id: string, sc: { name: string; buf: string; path: string; start: number }) => {
    const bytes = sc.buf.length;
    const lines = (sc.buf.match(/\\n/g)?.length ?? 0) + 1;
    onTool?.(id, {
      name: describeToolCall(sc.name, { file_path: sc.path }).name,
      detail: sc.path,
      streaming: true,
      streamBytes: bytes,
      streamLines: lines,
      streamStart: sc.start,
    });
    onUsage?.(state.outputTokens + Math.round(bytes / 4));
  };

  const progressed = withToolProgress(fullStream, (id, progress) => {
    const prev = state.toolDetails.get(id);
    if (!prev || prev.endedAt) return;
    const next = { ...prev, progress };
    state.toolDetails.set(id, next);
    onTool?.(id, next);
  });
  for await (const part of progressed) {
    mark("providerFirstChunk");
    if (part.type === "text-delta") {
      mark("providerFirstToken");
      mark("firstTextDelta");
      state.textChars += part.text.length;
    } else if (part.type === "reasoning-delta") {
      mark("providerFirstToken");
      mark("firstReasoningDelta");
      state.reasoningChars += part.text.length;
    }
    if (part.type !== "text-delta") router.flush();
    if (part.type !== "text-delta" && part.type !== "reasoning-delta") sinks.endReasoningPhase();
    switch (part.type) {
      case "text-delta":
        state.stepText += part.text;
        router.push(part.text);
        break;
      case "tool-input-start":
        state.stepActed = true;
        if (STREAM_PROGRESS_TOOLS.has(part.toolName)) {
          streamingCalls.set(part.id, { name: part.toolName, buf: "", placed: false, path: "", start: now(), lastReport: 0 });
        }
        break;
      case "tool-input-delta": {
        const sc = streamingCalls.get(part.id);
        if (!sc) break;
        sc.buf += part.delta;
        if (!sc.path) {
          const m = sc.buf.match(FILE_PATH_RE);
          if (m) {
            try {
              sc.path = JSON.parse(`"${m[1]}"`);
            } catch {
              sc.path = m[1];
            }
          }
        }
        if (!sc.placed && (sc.path || sc.buf.length > REPORT_EVERY_BYTES)) {
          sc.placed = true;
          const { name } = describeToolCall(sc.name, { file_path: sc.path });
          emit(`\n\n⟦TOOL⟧${part.id}⟦SEP⟧${name}⟦SEP⟧${sc.path}⟦/TOOL⟧\n\n`);
          reportStreamProgress(part.id, sc);
          sc.lastReport = sc.buf.length;
        } else if (sc.placed && sc.buf.length - sc.lastReport >= REPORT_EVERY_BYTES) {
          reportStreamProgress(part.id, sc);
          sc.lastReport = sc.buf.length;
        }
        break;
      }
      case "tool-input-end":
        break;
      case "reasoning-delta":
        router.markReasoningSeen();
        emitReasoning(part.text);
        break;
      case "finish-step": {
        router.newStep();
        state.stepText = "";
        state.lastStepActed = state.stepActed;
        state.lastStepReasoning = state.stepReasoning;
        state.stepActed = false;
        state.stepReasoning = "";
        state.stepCount++;
        state.outputTokens += outputOf(part.usage);
        onUsage?.(state.outputTokens);
        const input = part.usage?.inputTokens ?? 0;
        state.lastStepInput = input;
        // The latest request is what the context holds now; it shrinks after a mid-turn compaction.
        if (input > 0 && input !== state.contextUsed) {
          state.contextUsed = input;
          onContext?.(state.contextUsed);
        }
        const stepUsage = part.usage as { cachedInputTokens?: number } | undefined;
        state.cacheReadTokens += stepUsage?.cachedInputTokens ?? 0;
        const anthropicMeta = (part as { providerMetadata?: { anthropic?: { cacheCreationInputTokens?: number } } })
          .providerMetadata?.anthropic;
        state.cacheCreateTokens += anthropicMeta?.cacheCreationInputTokens ?? 0;
        state.totalInputTokens += input;
        const meta = (part as { providerMetadata?: Record<string, { usage?: { cost?: number }; cost?: number }> })
          .providerMetadata;
        const stepCost = meta?.openrouter?.usage?.cost ?? meta?.openrouter?.cost;
        if (typeof stepCost === "number" && Number.isFinite(stepCost)) state.providerCostUsd += stepCost;
        break;
      }
      case "tool-call": {
        state.stepActed = true;
        state.toolCalls.set(part.toolCallId, { name: part.toolName, input: part.input });
        if (part.toolName === "TodoWrite") {
          const todos = ((part.input as { todos?: Todo[] })?.todos) ?? [];
          sinks.onTodos?.(todos);
          if (!state.todoEmitted) {
            emit("\n\n⟦TODO⟧\n\n");
            state.todoEmitted = true;
          }
          break;
        }
        if (part.toolName === "WritePlan") {
          const plan = ((part.input as { plan?: string })?.plan) ?? "";
          sinks.onPlan?.(plan);
          if (!state.planEmitted) {
            emit("\n\n⟦PLAN⟧\n\n");
            state.planEmitted = true;
          }
          break;
        }
        if (part.toolName === "Preview") {
          sinks.onPreview?.(((part.input as { path?: string })?.path) ?? "");
        }
        const { name, detail } = describeToolCall(part.toolName, part.input);
        const streamed = streamingCalls.get(part.toolCallId);
        if (!streamed?.placed) {
          emit(`\n\n⟦TOOL⟧${part.toolCallId}⟦SEP⟧${name}⟦SEP⟧${detail}⟦/TOOL⟧\n\n`);
        }
        streamingCalls.delete(part.toolCallId);
        const builtDetail = {
          ...(await buildToolDetail(part.toolName, part.input, sinks.workspace)),
          startedAt: streamed?.start ?? now(),
        };
        state.toolDetails.set(part.toolCallId, builtDetail);
        onTool?.(part.toolCallId, builtDetail);
        break;
      }
      case "tool-result": {
        stampToolEnd(state, sinks, part.toolCallId);
        emit(`⟦TOOLEND⟧${part.toolCallId}⟦SEP⟧ok⟦/TOOLEND⟧`);
        const call = state.toolCalls.get(part.toolCallId);
        if (call) sinks.emitEvent({ type: "tool.executed", tool: call.name, ok: true });
        const out = (part as { output?: unknown }).output;
        const text =
          typeof out === "string"
            ? out
            : typeof (out as { value?: unknown })?.value === "string"
              ? (out as { value: string }).value
              : "";
        const parsed = text ? parseDiagnosticsBlock(text) : null;
        if (parsed && sinks.showDiagInUi) {
          const prev = state.toolDetails.get(part.toolCallId);
          if (prev) onTool?.(part.toolCallId, { ...prev, diagnostics: parsed.body, diagnosticsTool: parsed.tool });
        }
        if (call && OUTPUT_PREVIEW_TOOLS.has(call.name) && text.trim()) {
          const prev = state.toolDetails.get(part.toolCallId);
          if (prev) {
            const memoryStop = memoryStopIn(text);
            const background = movedIn(text);
            const next = { ...prev, ...previewToolOutput(text), ...(memoryStop && { memoryStop }), ...(background && { background }) };
            state.toolDetails.set(part.toolCallId, next);
            onTool?.(part.toolCallId, next);
          }
        }
        const thumbnail = (out as { thumbnail?: unknown } | null)?.thumbnail;
        if (call && (call.name === "VideoStill" || call.name === "VideoRender" || call.name === "VideoScreenshot") && typeof thumbnail === "string") {
          const prev = state.toolDetails.get(part.toolCallId);
          if (prev) {
            const next = { ...prev, thumbnail };
            state.toolDetails.set(part.toolCallId, next);
            onTool?.(part.toolCallId, next);
          }
        }
        if (call && EDIT_TOOLS.has(call.name)) {
          const filePath = (call.input as { file_path?: string })?.file_path;
          if (filePath) {
            if (parsed && hasBlockingDiagnostics(parsed.body)) state.editedDiag.set(filePath, { tool: parsed.tool, body: parsed.body });
            else state.editedDiag.delete(filePath);
          }
        }
        if (call) await sinks.afterToolResult?.(call, out);
        break;
      }
      case "tool-error":
        stampToolEnd(state, sinks, part.toolCallId);
        emit(`⟦TOOLEND⟧${part.toolCallId}⟦SEP⟧err⟦SEP⟧${compactToolError(String(part.error))}⟦/TOOLEND⟧`);
        sinks.emitEvent({ type: "tool.executed", tool: state.toolCalls.get(part.toolCallId)?.name ?? "unknown", ok: false });
        break;
      case "finish":
        state.finishReason = part.finishReason;
        break;
      case "error":
        throw part.error instanceof Error ? part.error : new Error(streamErrorMessage(part.error));
      case "abort":
        // A turn that returned would be saved and shown as finished.
        throw abortError(part.reason);
    }
  }
  router.flush();
}

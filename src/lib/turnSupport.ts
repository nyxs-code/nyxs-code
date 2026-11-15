import { builtinVideoToolName, VIDEO_TOOLS } from "./videoTools";
import {
  smoothStream,
  parsePartialJson,
  NoSuchToolError,
  type ModelMessage,
  type ToolSet,
  type ToolCallRepairFunction,
} from "ai";
import { jsonrepair } from "jsonrepair";
import { truncatedToolCalls, CONTENT_WRITE_TOOLS } from "./agentTools";
import { coerceToolInput, matchToolName } from "./toolRepair";
import type { ModelInfo } from "./models";
import { costFromPrice, priceForModel } from "./pricing";
import type { CacheStats } from "./turnInput";
import type { TurnStreamState } from "./turnStream";

export function timingEnabled(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if (window.localStorage?.getItem("NYXS_TIMING") === "1") return true;
  } catch {
    /* localStorage can be unavailable */
  }
  return Boolean(import.meta.env?.DEV);
}

export interface TurnTiming {
  marks: Record<string, number>;
  totalMs: number;
  modelId: string;
  outputTokens: number;
  reasoningChars: number;
  textChars: number;
  steps: number;
  promptChars: number;
  toolChars: number;
  arrivalChars: number;
  arrivalMs: number;
}

export function reportTurnTiming(t: TurnTiming): void {
  if (!timingEnabled()) return;
  const { marks, totalMs } = t;
  const ms = (n: number | undefined) => (n === undefined ? "—" : `${n} ms`);
  const preflight = marks.preflight ?? 0;
  const firstToken = marks.providerFirstToken;
  const ttft = firstToken !== undefined ? firstToken - preflight : undefined;
  const generation = firstToken !== undefined ? totalMs - firstToken : undefined;

  const reasonStart = marks.firstReasoningDelta;
  const answerStart = marks.firstTextDelta;
  const reasonWindow =
    reasonStart === undefined ? undefined : (answerStart ?? totalMs) - reasonStart;
  const answerWindow = answerStart === undefined ? undefined : totalMs - answerStart;
  const phase = (chars: number, windowMs: number | undefined) =>
    windowMs && windowMs > 0
      ? `${chars} chars in ${windowMs} ms, ~${Math.round((chars / 4 / windowMs) * 1000)} tok/s`
      : `${chars} chars`;

  const tps =
    t.outputTokens > 0 && generation && generation > 0
      ? `~${Math.round((t.outputTokens / generation) * 1000)} tok/s, ${t.outputTokens} tokens`
      : "provider reported no usage";
  const kb = (n: number) => `${(n / 1024).toFixed(1)} kB, ~${Math.round(n / 4)} tok`;
  console.info(
    [
      `[nyxs-timing] ${t.modelId} — total ${totalMs} ms, ${t.steps} step(s)`,
      `  prompt sent:                      system ${kb(t.promptChars)} + tools ${kb(t.toolChars)}`,
      `  preflight (skills/git/mcp/hooks): ${ms(preflight)}`,
      `  provider first chunk:             ${ms(marks.providerFirstChunk)}`,
      `  provider first token (TTFT):      ${ms(firstToken)}${ttft !== undefined ? `  (${ttft} ms after preflight)` : ""}`,
      `  first pixel painted in UI:        ${ms(marks.firstPaint)}`,
      `  reasoning phase from ${ms(reasonStart)}:     ${phase(t.reasoningChars, reasonWindow)}`,
      `  answer phase from ${ms(answerStart)}:     ${phase(t.textChars, answerWindow)}`,
      `  answer as sent BY PROVIDER:       ${phase(t.arrivalChars, t.arrivalMs)}`,
      `  generation after TTFT:            ${ms(generation)}  (${tps})`,
    ].join("\n"),
  );
}

export const MAX_AGENT_STEPS = 40;

const SMOOTH_DELAY_MS = 5;
const SMOOTH_MAX_LAG_MS = 120;
const SMOOTH_WORD = /\S+\s+/m;
const smoothDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type ArrivalSink = (chars: number) => void;
export const uiSmoothing = (onArrival?: ArrivalSink): ReturnType<typeof smoothStream> => () => {
  let buffer = "";
  let id = "";
  let due = 0;
  return new TransformStream({
    async transform(chunk, controller) {
      if (chunk.type !== "text-delta") {
        if (buffer.length > 0) {
          controller.enqueue({ type: "text-delta", text: buffer, id });
          buffer = "";
        }
        controller.enqueue(chunk);
        return;
      }
      onArrival?.(chunk.text.length);
      if (chunk.id !== id && buffer.length > 0) {
        controller.enqueue({ type: "text-delta", text: buffer, id });
        buffer = "";
      }
      buffer += chunk.text;
      id = chunk.id;
      let match;
      while ((match = SMOOTH_WORD.exec(buffer)) != null) {
        const text = buffer.slice(0, match.index) + match[0];
        controller.enqueue({ type: "text-delta", text, id });
        buffer = buffer.slice(text.length);
        const now = Date.now();
        due = Math.max(due, now) + SMOOTH_DELAY_MS;
        const wait = due - now;
        if (wait > SMOOTH_MAX_LAG_MS) {
          due = now;
          if (buffer.length > 0) {
            controller.enqueue({ type: "text-delta", text: buffer, id });
            buffer = "";
          }
          break;
        }
        await smoothDelay(wait);
      }
    },
    flush(controller) {
      if (buffer.length > 0) controller.enqueue({ type: "text-delta", text: buffer, id });
    },
  });
};

const FILE_PATH_TOOLS = new Set(["Write", "Edit", "MultiEdit", "Read", "ReadPdf", "WritePdf", "WatchVideo"]);
const FILE_PATH_ALIASES = ["path", "filepath", "filename", "file", "target_file", "targetFile"];
function normalizeToolInput(toolName: string, obj: Record<string, unknown>): void {
  if (!FILE_PATH_TOOLS.has(toolName)) return;
  if (typeof obj.file_path === "string" && obj.file_path) return;
  for (const a of FILE_PATH_ALIASES) {
    if (typeof obj[a] === "string" && obj[a]) {
      obj.file_path = obj[a];
      delete obj[a];
      return;
    }
  }
}

const CONTEXT_OVERFLOW_RE =
  /prompt is too long|context[_ ]length|context window|maximum context|too many tokens|exceeds? the (?:model'?s? )?(?:maximum|context)|input is too long|request too large|reduce the length|token limit/i;
const TRANSIENT_STREAM_RE = /overloaded|rate.?limit|temporarily unavailable|timeout|timed out|ECONNRESET|socket hang up|network|502|503|504|529/i;

function errorText(err: unknown): string {
  if (!err) return "";
  const e = err as { message?: string; responseBody?: string; cause?: unknown; lastError?: unknown };
  return [e.message, e.responseBody, e.lastError ? errorText(e.lastError) : "", e.cause ? errorText(e.cause) : ""]
    .filter(Boolean)
    .join(" ");
}

export function isContextOverflowError(err: unknown): boolean {
  return CONTEXT_OVERFLOW_RE.test(errorText(err));
}

export function isTransientStreamError(err: unknown): boolean {
  const text = errorText(err);
  return !isContextOverflowError(err) && !/\b40[0-4]\b|invalid|unauthorized|forbidden|billing|balance/i.test(text) && TRANSIENT_STREAM_RE.test(text);
}

export function createToolCallRepair(
  onUnknownTool?: (toolName: string) => void,
): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, error, tools, inputSchema }) => {
    if (NoSuchToolError.isInstance(error)) {
      const fixed = matchToolName(toolCall.toolName, Object.keys(tools));
      if (fixed && fixed !== toolCall.toolName) return { ...toolCall, toolName: fixed };
      onUnknownTool?.(fixed ?? toolCall.toolName);
      return null;
    }
    const repaired = await repairToolInput(toolCall);
    if (!repaired) return null;
    let schema: unknown;
    try {
      schema = await inputSchema({ toolName: toolCall.toolName });
    } catch {
      schema = undefined;
    }
    const obj = JSON.parse(repaired.input) as Record<string, unknown>;
    const coerced = coerceToolInput(obj, schema);
    return coerced.changed ? { ...repaired, input: JSON.stringify(coerced.value) } : repaired;
  };
}

export const repairMalformedToolCall = createToolCallRepair();

const repairToolInput = async (
  toolCall: Parameters<ToolCallRepairFunction<ToolSet>>[0]["toolCall"],
): Promise<Parameters<ToolCallRepairFunction<ToolSet>>[0]["toolCall"] | null> => {
  let obj: Record<string, unknown> | null = null;
  let viaTruncationRepair = false;
  try {
    const { value, state } = await parsePartialJson(toolCall.input);
    if ((state === "repaired-parse" || state === "successful-parse") && value && typeof value === "object") {
      obj = value as Record<string, unknown>;
      viaTruncationRepair = state === "repaired-parse";
    }
  } catch {
    /* sigue a la pasada 2 */
  }
  if (!obj) {
    try {
      const value = JSON.parse(jsonrepair(toolCall.input));
      if (value && typeof value === "object") obj = value as Record<string, unknown>;
    } catch {
      /* irreparable → error normal */
    }
  }
  if (!obj) return null;
  if (viaTruncationRepair && CONTENT_WRITE_TOOLS.has(toolCall.toolName)) {
    truncatedToolCalls.add(toolCall.toolCallId);
  }
  normalizeToolInput(toolCall.toolName, obj);
  return { ...toolCall, input: JSON.stringify(obj) };
};

// WebSearch and WebFetch stay loaded: the system prompt sends the model straight to them, and
// models without Anthropic's native tool search called them before ToolSearch and failed.
export const DEFER_LOCAL_TOOLS = new Set<string>([
  "Preview",
  "ReadPdf",
  "WritePdf",
  "WatchVideo",
  "Computer",
  "GitStatus",
  "GitDiff",
  "GitLog",
  "GitBlame",
  "Lsp",
  "Agent",
  "TaskCreate",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "Workflow",
  "SessionSearch",
  ...VIDEO_TOOLS.map((def) => builtinVideoToolName(def.name)),
]);

export const MAX_SUBAGENT_STEPS = 200;

export function toolResultTexts(messages: ModelMessage[], toolName: string): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const part of m.content as { type?: string; toolName?: string; output?: { value?: unknown } }[]) {
      if (part?.type === "tool-result" && part.toolName === toolName && typeof part.output?.value === "string") {
        out.push(part.output.value);
      }
    }
  }
  return out;
}

export function toolSchemaChars(tools: ToolSet): number {
  let n = 0;
  for (const [name, def] of Object.entries(tools)) {
    const d = def as { description?: string; inputSchema?: unknown };
    n += name.length + (d.description?.length ?? 0);
    try {
      const schema = d.inputSchema as { jsonSchema?: unknown } | undefined;
      n += JSON.stringify(schema?.jsonSchema ?? schema ?? {}).length;
    } catch {
      n += 200;
    }
  }
  return n;
}

export function inertTools(tools: ToolSet): ToolSet {
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    if (!t.execute) {
      out[name] = t;
      continue;
    }
    const copy = { ...t };
    delete copy.execute;
    out[name] = copy;
  }
  return out;
}

export function withCacheBreakpoint(msg: ModelMessage): ModelMessage {
  const prev = (msg as { providerOptions?: Record<string, unknown> }).providerOptions ?? {};
  return {
    ...msg,
    providerOptions: { ...prev, anthropic: { cacheControl: { type: "ephemeral" } } },
  } as ModelMessage;
}

/** The system prompt as messages, with the Anthropic cache breakpoint on block `cacheIndex`. */
export function buildSystemMessages(blocks: string[], cacheIndex: number, isAnthropic: boolean): ModelMessage[] {
  return blocks.map((content, i) => {
    const msg: ModelMessage = { role: "system", content };
    if (i === cacheIndex && isAnthropic) {
      (msg as { providerOptions?: unknown }).providerOptions = {
        anthropic: { cacheControl: { type: "ephemeral" } },
      };
    }
    return msg;
  });
}

export function buildAutoFixPrompt(entries: [string, { tool: string; body: string }][]): string {
  const blocks = entries
    .map(([file, d]) => `### ${file} (${d.tool})\n${d.body}`)
    .join("\n\n");
  return (
    "Some files you edited this turn still have unresolved checker errors. You MUST fix the errors your changes introduced, then finish. " +
    "Only address errors related to your edits — leave unrelated pre-existing issues alone. After you edit, the checker re-runs automatically.\n\n" +
    blocks
  );
}

/** The turn's cache and cost totals; the provider's own cost when it reports one, else our estimate. */
export function turnCacheStats(st: TurnStreamState, model: Pick<ModelInfo, "provider" | "apiModel">): CacheStats {
  const price = st.providerCostUsd ? null : priceForModel(model.provider, model.apiModel);
  const estimatedCost = price
    ? costFromPrice(price, {
        inputTokens: st.totalInputTokens,
        outputTokens: st.outputTokens,
        cacheReadTokens: st.cacheReadTokens,
        cacheWriteTokens: st.cacheCreateTokens,
      })
    : 0;
  return {
    readTokens: st.cacheReadTokens,
    creationTokens: st.cacheCreateTokens,
    inputTokens: st.totalInputTokens,
    outputTokens: st.outputTokens,
    costUsd: st.providerCostUsd || estimatedCost || undefined,
  };
}

/** Characters the tool names, descriptions and schemas add to the prompt, for timing reports. */
export function toolPromptChars(tools: ToolSet): number {
  let chars = 0;
  for (const [name, def] of Object.entries(tools)) {
    const d = def as { description?: string; inputSchema?: unknown };
    chars += name.length + (d.description?.length ?? 0);
    try {
      chars += JSON.stringify(d.inputSchema ?? {}).length;
    } catch {
      /* non-serializable schema: skip its size */
    }
  }
  return chars;
}

export const SUBAGENT_REPORT_PROMPT =
  "You've used all your steps, so stop calling tools now — any tool call will be ignored. Write your final report for the agent that delegated this task, based on everything you found so far: answer its request directly, cite concrete evidence (`path:line`), and say plainly what you could not check.";

export const STEP_LIMIT_PROMPT =
  "You've reached this turn's step limit, so stop calling tools now — any tool call will be ignored. Briefly summarize for the user what you did this turn and the current state (what's done, what's left, anything that needs their attention). Reply in the user's language. If the task isn't finished, say so and that they can ask you to continue.";

/** How much of the cut-off reasoning goes back to the model with the retry, from its end. */
export const OUTPUT_LIMIT_REASONING_TAIL = 6000;

/** The one retry of a step that ran out of output tokens while thinking, before any reply or tool
 *  call: it asks the model to act now, carrying the end of what it had worked out. */
export function buildOutputLimitRetryPrompt(reasoning: string): string {
  const head =
    "Your previous attempt at this step ran out of output tokens while you were still thinking, before you wrote a reply or called a tool, so none of it reached the user. " +
    "Don't deliberate at length again: keep your reasoning short and act now — call the tool you need, or answer directly. Reply in the user's language.";
  const tail = reasoning.trim().slice(-OUTPUT_LIMIT_REASONING_TAIL);
  if (!tail) return head;
  return `${head}\n\nThe end of what you had worked out so far:\n\n<previous_reasoning>\n${tail}\n</previous_reasoning>`;
}

/** The pass's messages without its last step when that step only thought: an assistant message
 *  with no text and no tool call. */
export function withoutThoughtOnlyTail(messages: ModelMessage[]): ModelMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return messages;
  const parts = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  const acted = parts.some((p) => p.type === "tool-call" || (p.type === "text" && !!(p as { text: string }).text.trim()));
  return acted ? messages : messages.slice(0, -1);
}

export const EXTRACT_SYSTEM =`You read a web page for a coding agent and return only what its request asks for.
- Use only the page content. If the page does not contain the answer, say so in one line.
- Copy code, commands, versions, option names and URLs exactly.
- Be concise: at most about 400 words, unless the request needs a longer exact excerpt.`;

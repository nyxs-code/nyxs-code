import { stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { callModel, type CallModelRequest } from "./callModel";
import {
  COMPACT_PROMPT,
  TURN_PREFIX_COMPACT_PROMPT,
  formatCompactSummary,
  getContinuationMessage,
  getTurnPrefixMessage,
  isContinuationMessage,
} from "./compact";
import { chooseCompactionCut, type CompactionBudget } from "./contextBudget";
import { emitEvent } from "./events";
import { applyToolResultPruning, estimateMessageTokens, planToolResultPruning, type PruneMap } from "./microcompact";
import { inertTools, isContextOverflowError, withCacheBreakpoint } from "./turnSupport";

/** Options every model call of a turn shares: retries, output cap, abort, reasoning. */
export type TurnCallOptions = Pick<CallModelRequest, "maxRetries" | "maxOutputTokens" | "providerOptions" | "abortSignal">;

/** Summarizes `prefix`; `prompt` is COMPACT_PROMPT unless given (the turn-prefix summary's). */
export type Compactor = (prefix: ModelMessage[], prompt?: string) => Promise<string>;

export interface CompactorOptions {
  model: LanguageModel;
  systemMessages: ModelMessage[];
  isAnthropic: boolean;
  /** Sent inert so the request prefix matches the turn's and hits the prompt cache. */
  tools?: ToolSet;
  activeTools?: () => string[];
  callOptions: TurnCallOptions;
  onCompacting?: (active: boolean) => void;
}

/** How many times a summary request that is itself too long for the window is sent again
 *  without the oldest part of what it summarizes. */
const COMPACT_OVERFLOW_RETRIES = 4;

export function createCompactor(o: CompactorOptions): Compactor {
  return async (prefix, prompt = COMPACT_PROMPT) => {
    o.onCompacting?.(true);
    try {
      let body = prefix;
      for (let attempt = 0; ; attempt++) {
        try {
          const text = await summarize(o, body, prompt);
          emitEvent({ type: "compaction.triggered", kind: prompt === TURN_PREFIX_COMPACT_PROMPT ? "turn" : "summary" });
          return formatCompactSummary(text);
        } catch (err) {
          // What needs summarizing is past the window itself, so the summary can only cover
          // the newer part of it.
          const shorter = attempt < COMPACT_OVERFLOW_RETRIES && isContextOverflowError(err) ? dropOldest(body) : null;
          if (!shorter) throw err;
          body = shorter;
        }
      }
    } finally {
      o.onCompacting?.(false);
    }
  };
}

async function summarize(o: CompactorOptions, prefix: ModelMessage[], prompt: string): Promise<string> {
  const body = [...prefix];
  if (o.isAnthropic && body.length) body[body.length - 1] = withCacheBreakpoint(body[body.length - 1]);
  const res = callModel({
    model: o.model,
    messages: [...o.systemMessages, ...body, { role: "user", content: prompt }],
    ...(o.tools ? { tools: inertTools(o.tools), stopWhen: stepCountIs(1) } : {}),
    ...(o.activeTools ? { activeTools: o.activeTools() } : {}),
    ...o.callOptions,
  });
  // fullStream, not textStream: textStream drops the error part, so a rejected request would
  // read as an empty summary instead of an error the caller can act on.
  let text = "";
  for await (const part of res.fullStream) {
    if (part.type === "text-delta") text += part.text;
    else if (part.type === "error") throw part.error;
  }
  return text;
}

const MAX_ESTIMATE_SCALE = 3;

const DROPPED_NOTE: ModelMessage = {
  role: "user",
  content: "[The oldest part of this conversation was too long to summarize and was left out.]",
};

/**
 * `prefix` without about its oldest third, for a summary request the provider rejected as too
 * long. The cut lands right before a user or model message, so a tool result never loses its
 * call, and a summary of earlier turns at its head stays. Null when nothing more can go.
 */
export function dropOldest(prefix: ModelMessage[]): ModelMessage[] | null {
  const head = prefix.length && isContinuationMessage(prefix[0]) ? 1 : 0;
  const sizes = prefix.map((m) => estimateMessageTokens([m]));
  let total = 0;
  for (let i = head; i < sizes.length; i++) total += sizes[i];
  let dropped = 0;
  for (let i = head; i < prefix.length; i++) {
    if (i > head && dropped >= total / 3 && prefix[i].role !== "tool") {
      const rest = prefix.slice(i);
      return [...prefix.slice(0, head), ...(prefix[i].role === "user" ? [] : [DROPPED_NOTE]), ...rest];
    }
    dropped += sizes[i];
  }
  return null;
}

export interface TurnContextOptions {
  budget: CompactionBudget;
  /** System prompt and tool schemas, which every request carries. */
  overheadTokens: number;
  systemMessages: ModelMessage[];
  historyTurns: number;
  compact: Compactor;
  /** Called with the messages the model now sees after pruning or compacting them. */
  onReshaped: (visible: ModelMessage[]) => void;
  onPruneToolResults?: (prune: PruneMap) => void;
  onCompacted?: (c: Compacted) => void;
  signal?: AbortSignal;
}

/** Earlier turns replaced by a summary. The tokens are estimates of the request's size before
 *  and after it. */
export interface Compacted {
  summary: string;
  /** How many history turns it covers. */
  turns: number;
  beforeTokens?: number;
  afterTokens?: number;
}

/**
 * Keeps one turn's requests inside the context window: prunes old tool
 * results, summarizes old turns before the first call, once mid-turn
 * replaces everything before the cache anchor with a summary, and when the
 * turn alone no longer fits, summarizes its first steps.
 */
export class TurnContext {
  prune: PruneMap = {};
  private midCut: { index: number; summary: ModelMessage } | null = null;
  private midCompactionTried = false;
  private anchor = -1;
  /** Where this turn's own steps begin, after the user's request (a message index, -1 unknown). */
  private turnStart = -1;
  /** This turn's first steps, [start, end) in the step messages, replaced by their summary. `kept`
   *  fingerprints the first step kept, so a later pass whose messages differ drops the cut. */
  private stepCut: { start: number; end: number; kept: string; summary: ModelMessage } | null = null;
  /** Real tokens per estimated one, from the provider's count of the last request. chars/4
   *  undercounts for some tokenizers (code, JSON, text that isn't English), and the compaction
   *  trigger has to see the size the provider will. */
  private scale = 1;
  private readonly o: TurnContextOptions;
  private readonly sysCount: number;

  constructor(o: TurnContextOptions) {
    this.o = o;
    this.sysCount = o.systemMessages.length;
  }

  get budgetWindow(): number {
    return this.o.budget.window;
  }

  estimateUsed(msgs: ModelMessage[]): number {
    return Math.ceil((this.o.overheadTokens + estimateMessageTokens(msgs)) * this.scale);
  }

  /** Learns `scale` from the request just sent: `shaped` without the step it answered with. */
  private calibrate(shaped: ModelMessage[], realInput: number): void {
    let reply = shaped.length - 1;
    while (reply >= 0 && shaped[reply].role !== "assistant") reply--;
    if (reply <= 0 || realInput <= 0) return;
    const estimated = this.o.overheadTokens + estimateMessageTokens(shaped.slice(0, reply));
    this.scale = Math.min(MAX_ESTIMATE_SCALE, Math.max(1, realInput / estimated));
  }

  /** Fits the history before the first call. `turnStarts` indexes each turn's first message. */
  async fitHistory(messages: ModelMessage[], turnStarts: number[]): Promise<{ messages: ModelMessage[]; reshaped: boolean }> {
    const { budget, historyTurns, signal } = this.o;
    let reshaped = false;
    let used = this.estimateUsed(messages);
    const plan = planToolResultPruning(messages, { usedTokens: used, contextWindow: budget.window });
    if (plan.added) {
      this.prune = plan.prune;
      messages = applyToolResultPruning(messages, this.prune);
      this.o.onPruneToolResults?.(this.prune);
      emitEvent({ type: "compaction.triggered", kind: "micro", clearedCount: plan.added, clearedTokens: plan.freedTokens });
      used = this.estimateUsed(messages);
      reshaped = true;
    }
    if (used > budget.trigger && historyTurns > 1) {
      const turnTokens = turnStarts.map((s, i) => estimateMessageTokens(messages.slice(s, turnStarts[i + 1] ?? messages.length)));
      const cut = chooseCompactionCut(turnTokens, budget.keep);
      if (cut >= 1) {
        try {
          const summary = await this.o.compact(messages.slice(0, turnStarts[cut]));
          if (summary) {
            messages = [{ role: "user", content: getContinuationMessage(summary) }, ...messages.slice(turnStarts[cut])];
            this.o.onCompacted?.({ summary, turns: cut, beforeTokens: used, afterTokens: this.estimateUsed(messages) });
            reshaped = true;
          }
        } catch (err) {
          if (signal?.aborted) throw err;
        }
      }
    }
    if (reshaped) this.o.onReshaped(messages);
    return { messages, reshaped };
  }

  /** The history message the prompt cache is anchored on; mid-turn compaction summarizes what precedes it. */
  setAnchor(index: number): void {
    this.anchor = index;
  }

  private get anchorStepIndex(): number {
    return this.sysCount + this.anchor;
  }

  /** The first message after the user's request, where this turn's steps begin. Set once: a
   *  later pass of the same turn (a retry, an auto-fix round) keeps the first one's. */
  setTurnStart(index: number): void {
    if (this.turnStart < 0) this.turnStart = index;
  }

  /** The messages as the model should see them: pruned, the turn's first steps summarized, and
   *  cut at the mid-turn summary. */
  shape(msgs: ModelMessage[]): ModelMessage[] {
    let out = applyToolResultPruning(msgs, this.prune);
    const cut = this.stepCut;
    if (cut && out.length > cut.end) {
      if (fingerprint(msgs[cut.end]) === cut.kept) out = [...out.slice(0, cut.start), cut.summary, ...out.slice(cut.end)];
      else this.stepCut = null;
    }
    if (this.midCut && out.length > this.midCut.index) {
      out = [...out.slice(0, this.sysCount), this.midCut.summary, ...out.slice(this.midCut.index)];
    }
    return out;
  }

  /** Between steps, when the last request was large. */
  async relieveStepPressure(stepMessages: ModelMessage[], lastStepInput: number): Promise<void> {
    const { budget, signal } = this.o;
    const sys = this.sysCount;
    let shaped = this.shape(stepMessages);
    this.calibrate(shaped.slice(sys), lastStepInput);
    let used = Math.max(this.estimateUsed(shaped.slice(sys)), lastStepInput);
    const plan = planToolResultPruning(shaped.slice(sys), {
      usedTokens: used,
      contextWindow: budget.window,
      existing: this.prune,
    });
    if (plan.added) {
      this.prune = plan.prune;
      this.o.onPruneToolResults?.(this.prune);
      emitEvent({ type: "compaction.triggered", kind: "micro", clearedCount: plan.added, clearedTokens: plan.freedTokens });
      shaped = this.shape(stepMessages);
      used = this.estimateUsed(shaped.slice(sys));
      this.o.onReshaped(shaped.slice(sys));
    }
    if (used <= budget.trigger) return;
    if (!this.midCut && !this.midCompactionTried && this.anchor >= 1) {
      this.midCompactionTried = true;
      try {
        const summary = await this.o.compact(shaped.slice(sys, this.anchorStepIndex));
        if (summary) {
          this.midCut = { index: this.anchorStepIndex, summary: { role: "user", content: getContinuationMessage(summary) } };
          const before = used;
          shaped = this.shape(stepMessages);
          used = this.estimateUsed(shaped.slice(sys));
          this.o.onCompacted?.({ summary, turns: this.o.historyTurns - 1, beforeTokens: before, afterTokens: used });
          this.o.onReshaped(shaped.slice(sys));
        }
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }
    // The turn alone is still too big: its first steps go into a summary.
    if (used > budget.trigger && (await this.cutTurnPrefix(stepMessages))) this.o.onReshaped(this.shape(stepMessages).slice(sys));
  }

  /**
   * Summarizes this turn's first steps, from just after the user's request up to the steps the
   * keep budget holds (whole steps: the cut lands right before one of the model's messages, so a
   * tool call never loses its result). The request and those latest steps stay verbatim; an
   * earlier cut's summary is folded into the new one. Returns whether a cut was made.
   */
  private async cutTurnPrefix(stepMessages: ModelMessage[]): Promise<boolean> {
    if (this.turnStart < 0) return false;
    const start = this.sysCount + this.turnStart;
    const done = this.stepCut?.end ?? start;
    const pruned = applyToolResultPruning(stepMessages, this.prune);
    let kept = 0;
    let end = -1;
    let latest = -1;
    for (let i = stepMessages.length - 1; i > done; i--) {
      kept += estimateMessageTokens([pruned[i]]);
      if (stepMessages[i].role !== "assistant") continue;
      if (latest < 0) latest = i;
      if (kept > this.o.budget.keep) break;
      end = i;
    }
    // Even the latest step is past the keep budget: keep that one step alone.
    if (end < 0) end = latest;
    if (end <= done) return false;
    try {
      const summary = await this.o.compact(this.shape(stepMessages.slice(0, end)).slice(this.sysCount), TURN_PREFIX_COMPACT_PROMPT);
      if (!summary) return false;
      this.stepCut = { start, end, kept: fingerprint(stepMessages[end]), summary: { role: "user", content: getTurnPrefixMessage(summary) } };
      return true;
    } catch (err) {
      if (this.o.signal?.aborted) throw err;
      return false;
    }
  }

  /** After the provider rejected a request as too long. Returns whether anything was freed. */
  async forceRelief(msgs: ModelMessage[]): Promise<boolean> {
    const { budget, signal } = this.o;
    const sys = this.sysCount;
    const all = [...this.o.systemMessages, ...msgs];
    const shaped = this.shape(all).slice(sys);
    // The provider counted at least a full window where the estimate saw less.
    const sent = this.estimateUsed(shaped);
    if (sent > 0 && sent < budget.window) this.scale = Math.min(MAX_ESTIMATE_SCALE, (this.scale * budget.window) / sent);
    const plan = planToolResultPruning(shaped, {
      usedTokens: budget.window,
      contextWindow: budget.window,
      existing: this.prune,
    });
    let relieved = false;
    if (plan.added) {
      this.prune = plan.prune;
      this.o.onPruneToolResults?.(this.prune);
      relieved = true;
    }
    if (!this.midCut && this.anchor >= 1) {
      try {
        const summary = await this.o.compact(this.shape(all).slice(sys, this.anchorStepIndex));
        if (summary) {
          this.midCut = { index: this.anchorStepIndex, summary: { role: "user", content: getContinuationMessage(summary) } };
          // The provider turned down the request as too long: it was at least a full window.
          const beforeTokens = Math.max(budget.window, this.estimateUsed(shaped));
          this.o.onCompacted?.({ summary, turns: this.o.historyTurns - 1, beforeTokens, afterTokens: this.estimateUsed(this.shape(all).slice(sys)) });
          relieved = true;
        }
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }
    // The provider still said no to less than this: the turn's own steps are the rest.
    if ((!relieved || this.estimateUsed(this.shape(all).slice(sys)) > budget.trigger) && (await this.cutTurnPrefix(all))) relieved = true;
    return relieved;
  }
}

/** A message told apart from others at the same place: its role, size and start. */
function fingerprint(m: ModelMessage | undefined): string {
  if (!m) return "";
  const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  return `${m.role}:${body.length}:${body.slice(0, 160)}`;
}

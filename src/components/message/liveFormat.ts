import type { OrbLook } from "@/components/ui/thinking-orbs";
import type { ToolDetail } from "@/lib/agentTools";
import type { Segment, ToolEnd } from "./parse";

export type LivePhase = "thinking" | "tool" | "writing" | "confirm" | "ask" | "working" | "compacting" | "retrying";

export interface LiveTurn {
  phase: LivePhase;
  tool?: string;
  startedAt: number;
  tokens?: number;
  /** Compacting: Claude Code compacting its own session, not Nyxs summarising the chat. */
  native?: boolean;
  /** Retrying: waiting out the usage limit rather than an error. */
  rateLimited?: boolean;
  /** Retrying: when the next try goes (epoch ms), if the agent said. */
  retryAt?: number;
  /** The turn started because background work finished. */
  wake?: boolean;
}

/** What the turn is doing that its stream doesn't say. */
export interface TurnStatus {
  compacting?: "summary" | "native";
  retrying?: { rateLimited: boolean; at?: number };
  wake?: boolean;
}

/** The phase read from the stream, overridden by what the turn reports on the side. Waiting on
 *  the person still comes first: that is what they need to see. */
export function withTurnStatus(live: { phase: LivePhase; tool?: string }, status?: TurnStatus): Omit<LiveTurn, "startedAt" | "tokens"> {
  if (!status || live.phase === "ask" || live.phase === "confirm") return live;
  if (status.retrying) {
    const { rateLimited, at } = status.retrying;
    return { phase: "retrying", rateLimited, ...(at ? { retryAt: at } : {}) };
  }
  if (status.compacting) return { phase: "compacting", native: status.compacting === "native" };
  if (status.wake && live.phase === "working") return { ...live, wake: true };
  return live;
}

export type WorkItem =
  | { kind: "tool"; id: string; name: string; detail: string }
  | { kind: "reasoning"; id: string; active: boolean };

export type ReasoningTimes = Record<string, { start: number; end: number }>;

export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Running clock of a live turn, down to tenths of a second ("10m 11.4s"). Floors instead of
 *  rounding so it never shows "60.0s" before the minute ticks over. */
export function liveElapsedLabel(ms: number): string {
  const tenths = Math.max(0, Math.floor(ms / 100));
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = ((tenths % 600) / 10).toFixed(1);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function tokensLabel(n: number): string {
  return `${n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)} tokens`;
}

const SEARCH_TOOLS = new Set([
  "Grep",
  "Glob",
  "ListDir",
  "WebSearch",
  "WebFetch",
  "retrieve_context",
  "RetrieveContext",
  "ToolSearch",
  "Lsp",
  "GitLog",
  "GitBlame",
]);

const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const AGENT_TOOLS = new Set(["Agent", "Task", "Workflow"]);
/** Tools that look after work running in the background rather than doing it. */
const BACKGROUND_TOOLS = new Set(["BashOutput", "TaskOutput", "KillShell", "KillBash", "TaskStop", "Monitor", "ScheduleWakeup"]);

/** The orb for what the turn is doing: a state, and a variant of it where two things share one. */
export function orbLookFor(live: Pick<LiveTurn, "phase" | "tool" | "native" | "rateLimited" | "wake">): OrbLook {
  switch (live.phase) {
    case "thinking":
      return { state: "reasoning" };
    case "tool": {
      const tool = live.tool ?? "";
      // Subagents: two walkers, as there is more than one mind at it.
      if (AGENT_TOOLS.has(tool)) return { state: "reasoning", variant: "twins" };
      // The web: a lighthouse sweeping far, apart from the lens over the code.
      if (WEB_TOOLS.has(tool)) return { state: "searching", variant: "lighthouse" };
      if (SEARCH_TOOLS.has(tool)) return { state: "searching" };
      if (BACKGROUND_TOOLS.has(tool)) return { state: "background" };
      // Commands: the gyro wobbles like a top while something runs on its own.
      if (SHELL_TOOLS.has(tool)) return { state: "working", variant: "gyro" };
      return { state: "working" };
    }
    case "writing":
      return { state: "base" };
    case "confirm":
    case "ask":
      return { state: "waiting" };
    case "compacting":
      return live.native ? { state: "compacting", variant: "squeeze" } : { state: "compacting" };
    case "retrying":
      return live.rateLimited ? { state: "retrying", variant: "surge" } : { state: "retrying" };
    default:
      return live.wake ? { state: "background", variant: "spiral" } : { state: "working" };
  }
}

export function livePhaseOf(
  segments: Segment[],
  endMap: Map<string, ToolEnd>,
  awaitingPermission: boolean,
  awaitingAnswer: boolean,
  quiet: boolean,
): { phase: LivePhase; tool?: string } {
  if (awaitingAnswer) return { phase: "ask" };
  if (awaitingPermission) return { phase: "confirm" };
  for (let k = segments.length - 1; k >= 0; k--) {
    const s = segments[k];
    if (s.type === "text" && !s.content.trim()) continue;
    if (s.type === "reasoning") return { phase: "thinking" };
    if (s.type === "tool") return endMap.has(s.id) ? { phase: "working" } : { phase: "tool", tool: s.name };
    if (s.type === "text" || s.type === "code") return { phase: quiet ? "working" : "writing" };
    return { phase: "working" };
  }
  return { phase: "working" };
}

export function reasoningSeconds(time: { start: number; end: number } | undefined): number | null {
  if (!time) return null;
  return Math.max(1, Math.round((time.end - time.start) / 1000));
}

export function runSeconds(
  items: WorkItem[],
  toolData: Record<string, ToolDetail>,
  reasoningTimes: ReasoningTimes,
): number | null {
  let first = Infinity;
  let last = -Infinity;
  let untimedTool = false;
  for (const it of items) {
    if (it.kind === "tool") {
      const d = toolData[it.id];
      if (typeof d?.startedAt !== "number") {
        untimedTool = true;
        continue;
      }
      first = Math.min(first, d.startedAt);
      last = Math.max(last, d.endedAt ?? d.startedAt);
    } else {
      const t = reasoningTimes[it.id];
      if (!t) continue;
      first = Math.min(first, t.start);
      last = Math.max(last, t.end);
    }
  }
  if (untimedTool || !Number.isFinite(first)) return null;
  return Math.max(1, Math.round((last - first) / 1000));
}

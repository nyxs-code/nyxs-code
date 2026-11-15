import { Channel } from "@tauri-apps/api/core";
import { invoke } from "@/lib/ipc";
import type { ModelMessage } from "ai";
import type { ModelInfo, ProviderId } from "./models";
import { EFFORT_LEVELS, type EffortLevel } from "./effort";
import type { CacheStats, ChatTurn } from "./turnInput";
import type { PermissionMode } from "@/components/ui/claude-style-chat-input";
import type { PlanLimit, PlanUsage } from "./claudeCode";
import { EDIT_TOOLS } from "./permissions";
import { stoppedToolMarker } from "./toolMarkers";
import { detectReplyLanguage, languageCheckNote } from "./replyLanguage";
import { stripAnsi } from "./ansi";
import { persistedCache } from "./swrCache";
import { setRunCwd } from "./claudeCodeTasks";
import { sessionMovedOn, setSessionHead } from "./claudeCodeHeads";
import {
  buildToolDetail,
  describeToolCall,
  previewToolOutput,
  OUTPUT_PREVIEW_TOOLS,
  type AskUserFn,
  type FileEditTracker,
  type PermissionGate,
  type Todo,
  type ToolDetail,
} from "./agentTools";

/** Other vendors' coding agents, run like Claude Code: the user's own Grok CLI or Antigravity
 *  CLI with its own sign-in. Each turn is one run of the CLI; the conversation carries on
 *  through the session id the CLI hands back. */
export type AgentCliId = "grok" | "antigravity" | "cursor" | "codex" | "deepseek" | "devin" | "opencode";

export const AGENT_CLI_PROVIDERS: Partial<Record<ProviderId, AgentCliId>> = {
  "grok-cli": "grok",
  "antigravity-cli": "antigravity",
  "cursor-cli": "cursor",
  "codex-cli": "codex",
  "deepseek-cli": "deepseek",
  "devin-cli": "devin",
  "opencode-cli": "opencode",
};

export function agentCliOf(provider: ProviderId): AgentCliId | undefined {
  return AGENT_CLI_PROVIDERS[provider];
}

/** Stored in place of an API key: the CLI's own sign-in is what connects it. */
export const AGENT_CLI_CONNECTED = "cli";

/** The CLI's own default model, for when its model list can't be read. */
export const AGENT_CLI_DEFAULT_MODEL = "default";

export interface AgentCliStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  /** Null when the CLI can't tell without starting a session (Grok). */
  loggedIn: boolean | null;
  /** Who is signed in, as the CLI's own files say (Antigravity's log, Grok's and Codex's auth). */
  account?: AgentCliAccountInfo | null;
}

export interface AgentCliAccountInfo {
  email: string | null;
  name: string | null;
  plan: string | null;
}

export function getAgentCliStatus(cli: AgentCliId): Promise<AgentCliStatus> {
  return invoke<AgentCliStatus>("agent_cli_status", { cli });
}

/** Opens the CLI's own sign-in in a terminal (signing in needs the user; installing doesn't). */
export function openAgentCliTerminal(cli: AgentCliId, action: "login"): Promise<void> {
  return invoke("agent_cli_open_terminal", { cli, action });
}

/** Installs a CLI ("claude-code", "grok"…) quietly with its official installer, as zeron does:
 *  no terminal, resolves once it can be found (fails with what the installer said). */
export function installCli(cli: AgentCliId | "claude-code"): Promise<void> {
  return invoke("cli_install", { cli });
}

export function cancelCliInstall(cli: AgentCliId | "claude-code"): Promise<void> {
  return invoke("cli_install_cancel", { cli });
}

export class AgentCliAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentCliAuthError";
  }
}

/** What a failed run says about itself, to tell a sign-in problem by: the CLI's own error, and
 *  the end of its stderr only once it has exited. While it runs, stderr carries the logs of the
 *  tools and servers it calls (a 401 among them), and the model's words are never part of it. */
export function cliFailureText(error: string, stderrTail: string[], exited: boolean): string {
  return exited ? `${error}\n${stderrTail.slice(-5).join("\n")}` : error;
}

export function isAgentCliAuthFailure(text: string): boolean {
  return /authenticat|not (signed|logged) in|sign[ -]?in required|please (log|sign) ?in|unauthori[sz]ed|\b401\b|invalid (api )?key|api key[^\n]*invalid|no api key|expired token|cached_token/i.test(text);
}

const LABELS: Record<AgentCliId, string> = {
  grok: "Grok CLI",
  antigravity: "Antigravity CLI",
  cursor: "Cursor CLI",
  codex: "Codex CLI",
  deepseek: "DeepSeek Harness",
  devin: "Devin",
  opencode: "OpenCode",
};
const PROVIDER_OF: Record<AgentCliId, ProviderId> = {
  grok: "grok-cli",
  antigravity: "antigravity-cli",
  cursor: "cursor-cli",
  codex: "codex-cli",
  deepseek: "deepseek-cli",
  devin: "devin-cli",
  opencode: "opencode-cli",
};

function defaultModel(cli: AgentCliId): ModelInfo {
  return {
    id: `${PROVIDER_OF[cli]}:${AGENT_CLI_DEFAULT_MODEL}`,
    apiModel: AGENT_CLI_DEFAULT_MODEL,
    name: `${LABELS[cli]} (predeterminado)`,
    description: LABELS[cli],
    provider: PROVIDER_OF[cli],
  };
}

/** Antigravity's `/usage` answer (`agy -p /usage --output-format json`): each group of models
 *  shares weekly buckets with the fraction left. As the chat's meter shows them: percent used. */
export function parseAntigravityUsage(text: string): PlanUsage | null {
  let data: Json;
  try {
    data = JSON.parse(text.trim()) as Json;
  } catch {
    return null;
  }
  const groups = ((((data.command ?? {}) as Json).data ?? {}) as Json).groups;
  if (!Array.isArray(groups)) return null;
  const limits: PlanLimit[] = [];
  for (const group of groups as Json[]) {
    for (const bucket of (Array.isArray(group.buckets) ? group.buckets : []) as Json[]) {
      if (typeof bucket.remaining_fraction !== "number") continue;
      const used = Math.round(Math.min(1, Math.max(0, 1 - bucket.remaining_fraction)) * 100);
      // Each group has its own limit: named after it ("Gemini Models").
      limits.push({
        kind: groups.length > 1 ? "model" : "weekly",
        model: typeof group.name === "string" ? group.name : undefined,
        utilization: used,
        resetsAt: typeof bucket.reset_time === "string" ? bucket.reset_time : null,
      });
    }
  }
  return { subscription: null, limits };
}

/** Grok's billing (what its `/usage` shows): the share of the current period used, the Grok
 *  Build product's when it's listed. Null when the account reports no share. */
export function parseGrokUsage(text: string): PlanUsage | null {
  let data: Json;
  try {
    data = JSON.parse(text.trim()) as Json;
  } catch {
    return null;
  }
  const config = data.config as Json | undefined;
  if (!config || typeof config !== "object") return null;
  const products = (Array.isArray(config.productUsage) ? config.productUsage : []) as Json[];
  const build = products.find((p) => p.product === "GrokBuild");
  const percent =
    typeof build?.usagePercent === "number" ? build.usagePercent : typeof config.creditUsagePercent === "number" ? config.creditUsagePercent : null;
  if (percent === null) return null;
  const period = (config.currentPeriod ?? {}) as Json;
  const end = typeof period.end === "string" ? period.end : typeof config.billingPeriodEnd === "string" ? config.billingPeriodEnd : null;
  return {
    subscription: null,
    limits: [
      {
        kind: period.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "weekly" : "period",
        utilization: Math.round(Math.min(100, Math.max(0, percent))),
        resetsAt: end,
      },
    ],
  };
}

/** The CLIs whose plan limits can be read without a model call (Cursor and DeepSeek have none). */
export function reportsPlanUsage(cli: AgentCliId | undefined): cli is "antigravity" | "grok" | "codex" {
  return cli === "antigravity" || cli === "grok" || cli === "codex";
}

const PLAN_USAGE_TTL_MS = 60_000;
/** The last good reading, kept across restarts so the settings and the chat's meter show it at
 *  once while a fresh one is read. */
const planUsage = persistedCache<PlanUsage>("nyxs.agentCliPlanUsage.v1");
const planUsagePending = new Map<AgentCliId, Promise<PlanUsage | null>>();

/** The CLI's plan limits (Antigravity, Grok and Codex report them), kept for a minute. */
export function fetchAgentCliPlanUsage(cli: AgentCliId, force = false): Promise<PlanUsage | null> {
  if (!reportsPlanUsage(cli)) return Promise.resolve(null);
  const saved = planUsage.get(cli);
  if (!force && saved && Date.now() - saved.at < PLAN_USAGE_TTL_MS) return Promise.resolve(saved.value);
  let pending = planUsagePending.get(cli);
  if (!pending) {
    const read: Promise<PlanUsage | null> =
      cli === "codex"
        ? import("./codexCli").then((m) => m.fetchCodexPlanUsage()).catch(() => null)
        : invoke<string>("agent_cli_usage", { cli }).then(cli === "grok" ? parseGrokUsage : parseAntigravityUsage, () => null);
    pending = read
      .then((value) => {
        if (value) planUsage.set(cli, value);
        return value ?? saved?.value ?? null;
      })
      .finally(() => planUsagePending.delete(cli));
    planUsagePending.set(cli, pending);
  }
  return pending;
}

/** The limits last read, shown at once while they're read again. */
export function cachedAgentCliPlanUsage(cli: AgentCliId): PlanUsage | null {
  return planUsage.get(cli)?.value ?? null;
}

export interface CliModelEntry {
  id: string;
  name: string;
}

/** The models in what `<cli> models` prints: JSON when it gives JSON, else one per line, its
 *  slug first ("gemini-3.8-flash-high") and, after a tab, its display name ("Gemini 3.8 Flash
 *  (High)"), past bullets and table borders. */
export function parseModelList(text: string): CliModelEntry[] {
  const out = new Map<string, string>();
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      const data = JSON.parse(trimmed) as unknown;
      const list = Array.isArray(data) ? data : ((data as Record<string, unknown>).models ?? (data as Record<string, unknown>).data);
      for (const item of Array.isArray(list) ? list : []) {
        const rec = (typeof item === "object" && item ? item : {}) as Record<string, unknown>;
        const id = typeof item === "string" ? item : rec.id ?? rec.slug ?? rec.name;
        const name = rec.displayName ?? rec.display_name ?? rec.name;
        if (typeof id === "string" && id.trim()) out.set(id.trim(), typeof name === "string" && name.trim() ? name.trim() : id.trim());
      }
      if (out.size) return [...out].map(([id, name]) => ({ id, name }));
    } catch {
      /* not JSON after all: read it as text */
    }
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = stripAnsi(raw).replace(/^[ *•\-–>│|✓✔·]+/, "");
    // Cursor's listing: "gpt-5.3-codex - Codex 5.3", "auto - Auto (default)".
    const dashed = /^([a-z0-9][\w.\-:/@]*)\s+-\s+(.+)$/i.exec(line.trim());
    if (dashed) {
      out.set(dashed[1], dashed[2].replace(/\s*\(default\)\s*$/i, "").trim() || dashed[1]);
      continue;
    }
    const token = line.split(/[\s│|,(]+/)[0]?.replace(/[:;]+$/, "") ?? "";
    if (!(/^[a-z0-9][\w.\-:/@]*$/i.test(token) && /[a-z]/i.test(token) && /[-.\d]/.test(token) && token.length <= 80)) continue;
    const name = line.split("\t")[1]?.replace(/[│|]/g, "").trim();
    out.set(token, name || token);
  }
  return [...out].map(([id, name]) => ({ id, name }));
}

/** The CLI's models. Grok reports them over ACP with their context window and reasoning
 *  levels; otherwise they're read from `<cli> models`. When no list can be read (Antigravity
 *  prints none until signed in), a single stand-in runs whatever model the CLI itself has
 *  chosen, so the CLI still connects. */
export async function fetchAgentCliModels(cli: AgentCliId, apiKey?: string): Promise<ModelInfo[]> {
  // Loaded on demand: these build on this module.
  if (cli === "grok") {
    const reported = await import("./grokCli").then((m) => m.fetchGrokModels()).catch(() => []);
    if (reported.length) return reported;
  }
  if (cli === "codex") {
    const reported = await import("./codexCli").then((m) => m.fetchCodexModels()).catch(() => []);
    return reported.length ? reported : [defaultModel(cli)];
  }
  if (cli === "deepseek") {
    const reported = await import("./deepseekCli").then((m) => m.fetchDeepseekModels(apiKey)).catch(() => []);
    return reported.length ? reported : [defaultModel(cli)];
  }
  if (cli === "devin") {
    const text = await invoke<string>("agent_cli_models", { cli }).catch(() => "");
    const reported = await import("./devinCli").then((m) => m.parseDevinCatalog(text)).catch(() => []);
    return reported.length ? reported : [defaultModel(cli)];
  }
  const text = await invoke<string>("agent_cli_models", { cli }).catch(() => "");
  const entries = parseModelList(text).filter((m) => m.id !== AGENT_CLI_DEFAULT_MODEL);
  if (!entries.length) return [defaultModel(cli)];
  return entries.map(({ id, name }) => ({
    id: `${PROVIDER_OF[cli]}:${id}`,
    apiModel: id,
    name,
    description: LABELS[cli],
    provider: PROVIDER_OF[cli],
  }));
}

/** Whether a saved list still has the stand-in for the CLI's own model: it was connected
 *  before its models could be read, so they should be read again. */
export function hasAgentCliPlaceholder(models: ModelInfo[] | undefined): boolean {
  return !models?.length || models.some((m) => m.apiModel === AGENT_CLI_DEFAULT_MODEL);
}

/** Turned on when connecting: the first model the CLI lists (its default comes first). */
export function agentCliDefaultEnabled(models: ModelInfo[]): string[] {
  return models.slice(0, 1).map((m) => m.id);
}

const TO_CLI_EFFORT: Record<EffortLevel, string> = { low: "low", medium: "medium", high: "high", extra: "xhigh", max: "max" };
const CLI_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

/** The levels a CLI model takes, in the CLI's words: what the CLI reported for it (Grok does),
 *  else what the CLI accepts for it (Grok's `--effort` goes up to xhigh). */
function cliLevelsOf(model: ModelInfo): string[] {
  if (model.effortLevels) return model.effortLevels;
  const cli = agentCliOf(model.provider);
  if (cli === "grok" || cli === "codex") return ["low", "medium", "high", "xhigh"];
  if (cli === "antigravity") return antigravityLevelsOf(model.apiModel);
  // Cursor has no reasoning setting: its models come in thinking and non-thinking variants.
  if (cli === "cursor") return [];
  // DeepSeek Harness: Off, Low, High and Max.
  if (cli === "deepseek") return ["low", "high", "max"];
  // Devin's levels come with each model from its catalog; OpenCode's models have none it takes over ACP.
  if (cli === "devin" || cli === "opencode") return [];
  return CLI_EFFORT_ORDER;
}

/** `agy` (1.4.7) lists one model per level ("gemini-3.8-flash-high") and refuses any other
 *  `--effort` for it; its Claude models take no `--effort` at all. Only the plain Gemini model,
 *  its default, has levels: low to high ("has no max effort"). */
function antigravityLevelsOf(apiModel: string): string[] {
  if (/-(low|medium|high)$/i.test(apiModel) || /^claude-/i.test(apiModel)) return [];
  if (apiModel === AGENT_CLI_DEFAULT_MODEL || /^gemini-/i.test(apiModel)) return ["low", "medium", "high"];
  return [];
}

/** The effort menu's levels for a CLI model; null when it has none. */
export function agentCliEffortLevels(model: ModelInfo): EffortLevel[] | null {
  const levels = cliLevelsOf(model);
  const offered = EFFORT_LEVELS.filter((l) => levels.includes(TO_CLI_EFFORT[l]));
  return offered.length ? offered : null;
}

/** The level a turn runs at: the chosen one, or the closest below it that the model takes
 *  (the CLIs fail a turn at a level the model lacks). Null when the model has no levels. */
export function cliEffortFor(model: ModelInfo, effort: EffortLevel): string | null {
  const levels = cliLevelsOf(model);
  if (!levels.length) return null;
  for (let i = CLI_EFFORT_ORDER.indexOf(TO_CLI_EFFORT[effort]); i >= 0; i--) {
    if (levels.includes(CLI_EFFORT_ORDER[i])) return CLI_EFFORT_ORDER[i];
  }
  return levels[0];
}

export interface AgentCliTurn {
  model: ModelInfo;
  history: ChatTurn[];
  workspace?: string | null;
  signal?: AbortSignal;
  planMode: boolean;
  /** The chat's permission mode. Antigravity's headless mode can't ask, so it is told up front. */
  permissionMode?: PermissionMode;
  effort: EffortLevel;
  gate?: PermissionGate;
  /** Multiple-choice questions to the user (Cursor's `cursor/ask_question`). */
  askUser?: AskUserFn;
  /** A plan handed over for review (Cursor's `cursor/create_plan`). */
  onPlan?: (plan: string) => void;
  onChunk: (text: string) => void;
  onTool?: (id: string, detail: ToolDetail) => void;
  onUsage?: (tokens: number) => void;
  onContext?: (usedTokens: number) => void;
  onTodos?: (todos: Todo[]) => void;
  onFileEdit?: FileEditTracker;
  onReasoning?: (id: string, delta: string) => void;
  onMessages?: (messages: ModelMessage[]) => void;
  onCacheStats?: (stats: CacheStats) => void;
  /** The CLI is waiting to send a failed request again (Grok's `retry_state`); null once the
   *  turn goes on. */
  onRetrying?: (retry: { rateLimited: boolean; waitMs?: number } | null) => void;
  /** A one-off run (a summary): its session isn't kept for the chat. */
  ephemeral?: boolean;
  /** The chat the turn runs in: Nyxs' own tools (its browser) act on that chat alone. */
  chatKey?: string;
  /** Extra environment for the CLI (DeepSeek Harness's `DEEPSEEK_API_KEY`). */
  env?: Record<string, string>;
}

type Json = Record<string, unknown>;

const SESSION_OPTION_KEY: Record<AgentCliId, string> = {
  grok: "grokCli",
  antigravity: "antigravityCli",
  cursor: "cursorCli",
  codex: "codexCli",
  deepseek: "deepseekCli",
  devin: "devinCli",
  opencode: "opencodeCli",
};
const MARKER_RE = /⟦(TOOL|TOOLEND|REASONING)⟧[\s\S]*?⟦\/\1⟧|⟦(?:TODO|PLAN)⟧/g;

// Each CLI's sessions have a head too, like Claude Code's (claudeCodeHeads.ts): the turn of
// the reply that last went on in them, and its chat. These CLIs can't cut a session at a
// turn, so a chat that no longer ends there (an edited, retried or rewound message, a fork)
// starts a new session, given the chat so far as text.
const headKey = (cli: AgentCliId, sessionId: string) => `${cli}:${sessionId}`;

/** The CLI session an earlier reply of the chat left, the turns since it, and the fingerprint of
 *  the guide that session started with (none for a session from before guides were tracked).
 *  No session when it went on past that reply, or another chat has it now. */
export function resumePoint(cli: AgentCliId, prior: ChatTurn[], chatKey?: string): { sessionId?: string; since: ChatTurn[]; guide?: string } {
  for (let i = prior.length - 1; i >= 0; i--) {
    for (const m of prior[i].messages ?? []) {
      const opts = (m as { providerOptions?: Record<string, Json> }).providerOptions?.[SESSION_OPTION_KEY[cli]];
      const id = opts?.sessionId;
      if (typeof id === "string" && id) {
        if (sessionMovedOn(headKey(cli, id), typeof opts?.at === "string" ? opts.at : undefined, chatKey)) return { since: prior };
        return { sessionId: id, since: prior.slice(i + 1), ...(typeof opts?.guide === "string" ? { guide: opts.guide } : {}) };
      }
    }
  }
  return { since: prior };
}

/** The reply as the chat keeps it, carrying the CLI's session (and the fingerprint of the guide
 *  it started with) for the next turn. The session's head moves to it. */
export function sessionMessage(cli: AgentCliId, sessionId: string, text: string, guide?: string, chatKey?: string): ModelMessage {
  const at = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  setSessionHead(headKey(cli, sessionId), { at, chatKey });
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    providerOptions: { [SESSION_OPTION_KEY[cli]]: { sessionId, at, ...(guide ? { guide } : {}) } },
  };
}

/** A turn reached the session but the chat keeps no reply of it (stopped, failed): the next
 *  turn leaves the session, which has that message, for a new one given the chat as text. */
export function sessionLeftBehind(cli: AgentCliId, sessionId: string, chatKey?: string): void {
  setSessionHead(headKey(cli, sessionId), { at: "stopped", chatKey });
}

/** A short fingerprint of a session's guide (FNV-1a), so a changed one is noticed. */
export function guideFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${h.toString(36)}`;
}

/** Whether a session to continue started with another guide than the one it would get now: the
 *  CLI keeps the guide a session started with, so a changed one needs a new session. */
export function guideChanged(resume: { sessionId?: string; guide?: string }, now: string | undefined): boolean {
  return !!resume.sessionId && !!now && !!resume.guide && resume.guide !== now;
}

/** Earlier turns the CLI's session doesn't have (another model answered them), as text. */
export function priorContext(turns: ChatTurn[], budget: number): string {
  const text = turns
    .map((t) => ({ role: t.role, body: t.content.replace(MARKER_RE, "").replace(/\n{3,}/g, "\n\n").trim() }))
    .filter((t) => t.body)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.body}`)
    .join("\n\n");
  if (!text) return "";
  const clipped = text.length > budget ? `…${text.slice(-budget)}` : text;
  return `<earlier_conversation>\n${clipped}\n</earlier_conversation>\n\n`;
}

/** The user's message as the CLI gets it, with the language reminder the other models get. */
export function promptText(turn: ChatTurn, preamble: string): string {
  const lang = detectReplyLanguage(turn.content);
  const text = preamble + turn.content + (lang ? `\n\n${languageCheckNote(lang)}` : "");
  return text.trim() ? text : "(empty message)";
}

export interface CliProcess {
  runId: string;
  /** The folder the CLI works in. */
  cwd: string;
  send: (line: string) => Promise<void>;
  closeInput: () => void;
  kill: () => void;
  exited: Promise<number | null>;
  stderrTail: string[];
}

type ProcessEvent = { kind: "stdout"; line: string } | { kind: "stderr"; line: string } | { kind: "exit"; code: number | null };

let runSeq = 0;

/** A run's channel and the process handle around it. */
function processFor(runId: string, onLine: (line: string) => void): { channel: Channel<ProcessEvent>; make: (cwd: string) => CliProcess } {
  const stderrTail: string[] = [];
  let exit: (code: number | null) => void = () => undefined;
  const exited = new Promise<number | null>((resolve) => {
    exit = resolve;
  });
  const channel = new Channel<ProcessEvent>();
  channel.onmessage = (event) => {
    if (event.kind === "stdout") onLine(event.line);
    else if (event.kind === "stderr") {
      stderrTail.push(event.line);
      if (stderrTail.length > 40) stderrTail.shift();
    } else exit(event.code);
  };
  return {
    channel,
    make: (cwd) => ({
      runId,
      cwd,
      send: (line) => invoke("agent_cli_send", { runId, line }),
      closeInput: () => void invoke("agent_cli_close_input", { runId }).catch(() => undefined),
      kill: () => void invoke("agent_cli_kill", { runId }).catch(() => undefined),
      exited,
      stderrTail,
    }),
  };
}

/** Starts a CLI. `keepAlive`: the page keeps it between turns, so a reload of the page leaves
 *  it running for the next turn to pick up (`attachCliProcess`). */
export async function startCliProcess(
  cli: AgentCliId,
  args: string[],
  cwd: string | null | undefined,
  onLine: (line: string) => void,
  env?: Record<string, string>,
  opts: { keepAlive?: boolean } = {},
): Promise<CliProcess> {
  const runId = `${cli}-${Date.now().toString(36)}-${++runSeq}`;
  const p = processFor(runId, onLine);
  const realCwd = await invoke<string>("agent_cli_start", {
    request: { runId, cli, args, cwd: cwd || null, env: env ?? {}, ...(opts.keepAlive ? { keepAlive: true } : {}) },
    onEvent: p.channel,
  });
  setRunCwd(runId, realCwd);
  return p.make(realCwd);
}

/** A kept-alive CLI the page started before a reload, its output sent here from now on. */
export async function attachCliProcess(runId: string, cwd: string, onLine: (line: string) => void): Promise<CliProcess> {
  const p = processFor(runId, onLine);
  await invoke("agent_cli_attach", { runId, onEvent: p.channel });
  setRunCwd(runId, cwd);
  return p.make(cwd);
}

function shortError(text: string): string {
  const flat = text.replace(/⟦|⟧/g, "").trim().split(/\r?\n/).slice(0, 3).join(" ");
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/** What a turn writes to the chat: text, thinking phases, and tool cards with their results,
 *  in the same markers Claude Code's turns use. */
export function createTurnOutput(t: AgentCliTurn) {
  const workspace = t.workspace || undefined;
  let full = "";
  let reply = "";
  let reasonSeq = 0;
  let reasonPhaseId: string | null = null;
  let todoEmitted = false;
  let planEmitted = false;
  const placed = new Map<string, { name: string; detail: ToolDetail }>();
  const tracked = new Set<string>();
  let retrying = false;
  const retried = () => {
    if (!retrying) return;
    retrying = false;
    t.onRetrying?.(null);
  };

  const emit = (text: string) => {
    if (!text) return;
    retried();
    reasonPhaseId = null;
    full += text;
    t.onChunk(text);
  };

  return {
    get full() {
      return full;
    },
    get reply() {
      return reply;
    },
    text(delta: string) {
      reply += delta;
      emit(delta);
    },
    /** The CLI will send a failed request again; cleared by whatever the turn says next, or by
     *  `retrying(null)`. */
    retrying(retry: { rateLimited: boolean; waitMs?: number } | null) {
      if (!retry) return retried();
      retrying = true;
      t.onRetrying?.(retry);
    },
    reasoning(delta: string) {
      if (!delta) return;
      retried();
      if (reasonPhaseId === null) {
        const id = `r${++reasonSeq}`;
        emit(`\n\n⟦REASONING⟧${id}⟦/REASONING⟧\n\n`);
        reasonPhaseId = id;
      }
      t.onReasoning?.(reasonPhaseId, delta);
    },
    /** Snapshots a file before the CLI changes it, so the turn's changes can be shown and undone. */
    async trackEdit(path: string | null | undefined) {
      if (!path || !t.onFileEdit || tracked.has(path)) return;
      tracked.add(path);
      try {
        await t.onFileEdit(path);
      } catch {
        tracked.delete(path);
      }
    },
    todos(todos: Todo[]) {
      t.onTodos?.(todos);
      if (!todoEmitted) {
        emit("\n\n⟦TODO⟧\n\n");
        todoEmitted = true;
      }
    },
    /** A plan for the user to review, shown the way Nyxs' own plan mode shows one. */
    plan(text: string) {
      t.onPlan?.(text);
      if (!planEmitted) {
        emit("\n\n⟦PLAN⟧\n\n");
        planEmitted = true;
      }
    },
    get planShown() {
      return planEmitted;
    },
    has(id: string) {
      return placed.has(id);
    },
    async toolStart(id: string, name: string, input: Json) {
      if (!id || placed.has(id)) return;
      const label = describeToolCall(name, input);
      if (reply && !reply.endsWith("\n")) reply += "\n\n";
      emit(`\n\n⟦TOOL⟧${id}⟦SEP⟧${label.name}⟦SEP⟧${label.detail}⟦/TOOL⟧\n\n`);
      const entry = { name, detail: { name: label.name, detail: label.detail, startedAt: Date.now() } as ToolDetail };
      placed.set(id, entry);
      t.onTool?.(id, entry.detail);
      const built = await buildToolDetail(name, input, workspace).catch(() => null);
      if (built && !entry.detail.endedAt) {
        entry.detail = { ...built, name: label.name, detail: label.detail, startedAt: entry.detail.startedAt };
        t.onTool?.(id, entry.detail);
      }
      if (EDIT_TOOLS.has(name)) void this.trackEdit(typeof input.file_path === "string" ? input.file_path : null);
    },
    toolEnd(id: string, ok: boolean, output = "") {
      const entry = placed.get(id);
      if (!entry || entry.detail.endedAt) return;
      let detail: ToolDetail = { ...entry.detail, endedAt: Date.now() };
      if (!ok) emit(`⟦TOOLEND⟧${id}⟦SEP⟧err⟦SEP⟧${shortError(output || "Error")}⟦/TOOLEND⟧`);
      else {
        emit(`⟦TOOLEND⟧${id}⟦SEP⟧ok⟦/TOOLEND⟧`);
        if (OUTPUT_PREVIEW_TOOLS.has(entry.name) && output.trim()) detail = { ...detail, ...previewToolOutput(output) };
      }
      entry.detail = detail;
      t.onTool?.(id, detail);
    },
    /** Closes the cards of tools still running when the turn ends: done if it finished, cut off
     *  (not failed) if it was stopped or broke off. */
    endOpenTools(ok: boolean) {
      retried();
      if (ok) {
        for (const id of placed.keys()) this.toolEnd(id, true);
        return;
      }
      for (const [id, entry] of placed) {
        if (entry.detail.endedAt) continue;
        entry.detail = { ...entry.detail, endedAt: Date.now() };
        emit(stoppedToolMarker(id));
        t.onTool?.(id, entry.detail);
      }
    },
  };
}

export type TurnOutput = ReturnType<typeof createTurnOutput>;

/** Maps a CLI's own tool to the Nyxs tool it amounts to, so permission rules, cards and edit
 *  tracking treat it like Nyxs' own: running a command is Bash, changing a file is Edit… */
export function nyxsTool(kind: string, name: string, input: Json, path?: string | null): { name: string; input: Json } {
  const str = (...keys: string[]) => {
    for (const k of keys) if (typeof input[k] === "string" && input[k]) return input[k] as string;
    return "";
  };
  // Antigravity's MCP calls: named as Claude Code names them ("mcp__nyxs-browser__navigate"),
  // so the permission rules and the browser's own cards know them.
  if (name === "call_mcp_tool" && str("ServerName") && str("ToolName")) {
    const args = (input.Arguments && typeof input.Arguments === "object" ? input.Arguments : {}) as Json;
    return { name: `mcp__${str("ServerName")}__${str("ToolName")}`, input: args };
  }
  const file = path || str("file_path", "path", "Path", "TargetFile", "AbsolutePath", "file", "filePath", "target_file");
  const k = `${kind} ${name}`.toLowerCase();
  // Antigravity's own names: run_command, write_to_file, replace_file_content, view_file,
  // list_dir, grep_search, find_by_name, read_url_content, search_web, browser_*.
  if (/execute|command|shell|terminal|bash|run_/.test(k)) {
    return { name: "Bash", input: { ...input, command: str("command", "CommandLine", "cmd") || name } };
  }
  if (/edit|write|replace|create|patch|delete|move|rename|sed_file/.test(k)) return { name: "Edit", input: { ...input, file_path: file } };
  if (/fetch|url|web|browse/.test(k)) return { name: "WebFetch", input: { ...input, url: str("url", "Url", "Query", "query") || name } };
  if (/read|view|open_file|cat/.test(k)) return { name: "Read", input: { ...input, file_path: file } };
  if (/search|grep|find|glob|list/.test(k)) {
    return { name: "Grep", input: { ...input, pattern: str("pattern", "Pattern", "query", "Query", "SearchPath", "DirectoryPath") || name } };
  }
  return { name: name || kind || "Tool", input };
}

/** A tool's output as text, whatever shape the CLI gives it in. */
export function outputText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(outputText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const v = value as Json;
    if (typeof v.text === "string") return v.text;
    if (v.content !== undefined) return outputText(v.content);
    if (typeof v.output === "string") return v.output;
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

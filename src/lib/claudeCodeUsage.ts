import { invoke } from "@/lib/ipc";
import type { ModelMessage } from "ai";
import { accountKey } from "./accountScope";
import { claudeFolderUntrusted } from "./claudeCodeModels";
import { controlRequest, live, type Json } from "./claudeCodeProcesses";
import { sessionIdOf } from "./claudeCodeText";

// What fills a Claude Code chat's context, and the signed-in account's plan limits.

/** A tool or file that makes up a context slice. */
export interface ContextChild {
  /** Stable key for the panel, when the source has one. */
  id?: string;
  name: string;
  tokens: number;
}

/** One slice of the context window, as Claude Code itself measures it (`/context`). */
export interface ContextCategory {
  name: string;
  tokens: number;
  /** "used" for content, "buffer" for room held back for auto-compaction, "free" for the rest,
   *  "deferred" for tools listed for the model but not loaded into the window yet. */
  kind: string;
  /** Stable key the panel uses to find its label, since `name` is only a display string. */
  id?: string;
  /** Per-tool or per-file rows behind this slice. */
  children?: ContextChild[];
  /** The slice itself (and its rows) are Nyxs' estimate, not a measurement. */
  estimated?: boolean;
  /** The slice's tokens are measured, but the rows under it are Nyxs' estimate. */
  childrenEstimated?: boolean;
}

export interface ContextBreakdown {
  categories: ContextCategory[];
  totalTokens: number;
  maxTokens: number;
  /** Built from what Nyxs knows it will send, rather than measured by Claude Code. */
  estimated?: boolean;
}

const CATEGORY_IDS: Record<string, string> = {
  "System prompt": "system-prompt",
  "System instructions": "system-prompt",
  "System tools": "system-tools",
  "System tools (deferred)": "system-tools-deferred",
  "MCP tools": "mcp-tools",
  "MCP tools (deferred)": "mcp-tools-deferred",
  "MCP server instructions": "mcp-instructions",
  "Custom agents": "custom-agents",
  "Agents": "custom-agents",
  "Memory files": "memory-files",
  "Skills": "skills",
  "Messages": "messages",
  "Conversation": "messages",
  "Autocompact buffer": "autocompact-buffer",
  "Free space": "free",
};

/** Stable id for a context category, so the panel doesn't depend on the CLI's English names. */
export function contextCategoryId(name: string, deferred = false): string {
  const known = CATEGORY_IDS[name] ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return deferred && !known.endsWith("-deferred") ? `${known}-deferred` : known;
}

/** A plan limit the signed-in account is subject to. "period" is a billing period other than a
 *  week (Grok's can be a day or a month). */
export interface PlanLimit {
  kind: "session" | "weekly" | "model" | "period";
  /** For model-scoped weekly limits, the model it applies to ("Fable"). */
  model?: string;
  /** Percentage of the limit already used, 0–100. */
  utilization: number;
  resetsAt: string | null;
}

export interface PlanUsage {
  subscription: string | null;
  limits: PlanLimit[];
}

/** The Claude Code session a chat is using, from the session id saved on its replies. */
export function claudeCodeSessionOf(replies: (ModelMessage[] | undefined)[]): string | undefined {
  for (let i = replies.length - 1; i >= 0; i--) {
    const id = sessionIdOf({ role: "assistant", content: "", messages: replies[i] });
    if (id) return id;
  }
  return undefined;
}

/** What fills a chat's context window, asked of its still-running Claude Code process.
 *  Null when the process has gone idle and exited: nothing is spawned just to measure. */
export async function fetchClaudeCodeContext(sessionId: string): Promise<ContextBreakdown | null> {
  const proc = live.get(sessionId);
  if (!proc || proc.exited) return null;
  const res = await controlRequest(proc, { subtype: "get_context_usage", detail: "summary" });
  if (res?.subtype !== "success") return null;
  return parseContext((res.response ?? {}) as Json);
}

const num = (value: unknown): number => Number(value) || 0;

function parseChildList(list: unknown, nameOf: (entry: Json) => string): ContextChild[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((raw) => {
      const entry = (raw ?? {}) as Json;
      const name = nameOf(entry).trim();
      return name ? { name, tokens: num(entry.tokens) } : null;
    })
    .filter((child): child is ContextChild => child !== null && child.tokens > 0);
}

/** MCP tools, split into the ones loaded into the window and the ones only listed. */
function parseMcpTools(list: unknown): { loaded: ContextChild[]; deferred: ContextChild[] } {
  if (!Array.isArray(list)) return { loaded: [], deferred: [] };
  const loaded: ContextChild[] = [];
  const deferred: ContextChild[] = [];
  for (const raw of list) {
    const entry = (raw ?? {}) as Json;
    const server = String(entry.serverName ?? entry.server ?? "").trim();
    const tool = String(entry.name ?? entry.tool ?? "").trim();
    const name = server ? `${server} · ${tool}` : tool;
    const child = { name, tokens: num(entry.tokens) };
    if (!name || child.tokens <= 0) continue;
    (entry.isLoaded === false ? deferred : loaded).push(child);
  }
  return { loaded, deferred };
}

/** Scales rows so they add up to the measured slice exactly (the CLI's rows can round). */
function scaleChildren(children: ContextChild[], target: number): ContextChild[] {
  if (target <= 0) return [];
  const total = children.reduce((n, child) => n + child.tokens, 0);
  if (total <= 0) return [];
  if (total === target) return children;
  let remaining = target;
  return children
    .map((child, i) => {
      const tokens = i === children.length - 1 ? remaining : Math.floor((child.tokens * target) / total);
      remaining -= tokens;
      return { ...child, tokens };
    })
    .filter((child) => child.tokens > 0);
}

function attachChildren(categories: ContextCategory[], id: string, children: ContextChild[]): void {
  const category = categories.find((c) => c.id === id);
  if (!category || category.children?.length || children.length === 0) return;
  category.children = scaleChildren(children, category.tokens);
}

function parseContext(body: Json): ContextBreakdown {
  const categories = Array.isArray(body.categories)
    ? (body.categories as Json[]).map((c) => {
        const name = String(c.name ?? "");
        const deferred = c.isDeferred === true || String(c.kind ?? "") === "deferred";
        return {
          name,
          tokens: num(c.tokens),
          kind: deferred ? "deferred" : String(c.kind ?? "used"),
          id: typeof c.id === "string" && c.id ? c.id : contextCategoryId(name, deferred),
        };
      })
    : [];
  // The summary payload already carries per-file and per-tool rows; `detail: "full"` would add
  // token-counting API requests the panel shouldn't make just for opening.
  attachChildren(categories, "system-prompt", parseChildList(body.systemPromptSections, (e) => String(e.name ?? "")));
  attachChildren(categories, "system-tools", parseChildList(body.systemTools, (e) => String(e.name ?? "")));
  const mcp = parseMcpTools(body.mcpTools);
  attachChildren(categories, "mcp-tools", mcp.loaded);
  attachChildren(categories, "mcp-tools-deferred", mcp.deferred);
  attachChildren(categories, "memory-files", parseChildList(body.memoryFiles, (e) => String(e.path ?? e.name ?? "")));
  attachChildren(categories, "custom-agents", parseChildList(body.agents, (e) => String(e.agentType ?? e.name ?? "")));
  attachChildren(categories, "system-tools-deferred", parseChildList(body.deferredBuiltinTools, (e) => String(e.name ?? "")));
  return { categories, totalTokens: num(body.totalTokens), maxTokens: num(body.maxTokens) };
}

const baselineCache = new Map<string, Promise<ContextBreakdown | null>>();

/** What a new chat's context already holds before its first message, and the model's real
 *  window. Measured once per model and folder by a Claude Code process that sends nothing. */
export async function fetchClaudeCodeBaseline(model: string | undefined, cwd: string | null): Promise<ContextBreakdown | null> {
  const untrustedProject = await claudeFolderUntrusted(cwd);
  const key = `${model ?? ""}|${cwd ?? ""}|${untrustedProject}`;
  let pending = baselineCache.get(key);
  if (!pending) {
    pending = invoke<Json>("claude_code_context_baseline", { model: model ?? null, cwd: cwd ?? null, session: null, untrustedProject })
      .then(parseContext)
      .catch(() => {
        baselineCache.delete(key);
        return null;
      });
    baselineCache.set(key, pending);
  }
  return pending;
}

const sessionContextCache = new Map<string, Promise<ContextBreakdown | null>>();

/** A chat's context when its Claude Code process has already exited (idle, or the app
 *  reloaded): a throwaway process resumes the session read-only and measures it. `stamp`
 *  changes when the chat does (its token count), so a stale measurement isn't reused. */
export async function fetchClaudeCodeSessionContext(
  sessionId: string,
  model: string | undefined,
  cwd: string | null,
  stamp: number,
): Promise<ContextBreakdown | null> {
  const untrustedProject = await claudeFolderUntrusted(cwd);
  const key = `${sessionId}|${stamp}|${untrustedProject}`;
  let pending = sessionContextCache.get(key);
  if (!pending) {
    pending = invoke<Json>("claude_code_context_baseline", { model: model ?? null, cwd: cwd ?? null, session: sessionId, untrustedProject })
      .then(parseContext)
      .catch(() => {
        sessionContextCache.delete(key);
        return null;
      });
    sessionContextCache.set(key, pending);
  }
  return pending;
}

function parsePlanUsage(body: Json): PlanUsage | null {
  if (!body.rate_limits_available) return null;
  const rl = (body.rate_limits ?? {}) as Json;
  const window = (kind: PlanLimit["kind"], w: unknown, model?: string): PlanLimit | null => {
    const v = w as { utilization?: number | null; resets_at?: string | null } | null;
    if (!v || typeof v.utilization !== "number") return null;
    return { kind, model, utilization: Math.max(0, Math.min(100, Math.round(v.utilization))), resetsAt: v.resets_at ?? null };
  };
  const limits = [
    window("session", rl.five_hour),
    window("weekly", rl.seven_day),
    ...(Array.isArray(rl.model_scoped)
      ? (rl.model_scoped as Json[]).map((m) => window("model", m, String(m.display_name ?? "")))
      : []),
  ].filter((l): l is PlanLimit => l !== null);
  return { subscription: typeof body.subscription_type === "string" ? body.subscription_type : null, limits };
}

const PLAN_USAGE_TTL_MS = 60_000;
/** The last reading is kept across restarts and shown while a fresh one loads, as long as it
 *  is recent enough to still be roughly right. Spawning Claude Code to ask takes seconds. */
const PLAN_USAGE_KEY = "nyxs.claudePlanUsage.v1";
const PLAN_USAGE_STALE_MS = 60 * 60_000;
let planUsageCache: { at: number; value: PlanUsage | null } | null = null;
let planUsageInFlight: Promise<PlanUsage | null> | null = null;

function storedPlanUsage(): PlanUsage | null {
  try {
    const raw = JSON.parse(localStorage.getItem(accountKey(PLAN_USAGE_KEY)) || "null") as { at: number; value: PlanUsage } | null;
    return raw && Date.now() - raw.at < PLAN_USAGE_STALE_MS ? raw.value : null;
  } catch {
    return null;
  }
}

/** The last plan usage read, if any, so the panel can show it while a fresh one loads. */
export function cachedClaudePlanUsage(): PlanUsage | null {
  return planUsageCache?.value ?? storedPlanUsage();
}

function rememberPlanUsage(value: PlanUsage): void {
  try { localStorage.setItem(accountKey(PLAN_USAGE_KEY), JSON.stringify({ at: Date.now(), value })); } catch { /* storage full */ }
}

const planUsageListeners = new Set<(usage: PlanUsage) => void>();

/** Called with each new plan usage as Claude Code reports it during turns. */
export function onClaudePlanUsage(listener: (usage: PlanUsage) => void): () => void {
  planUsageListeners.add(listener);
  return () => planUsageListeners.delete(listener);
}

/** The plan turning requests away: until when (ms) and which window did it, when Claude Code
 *  names one of the two it reports ("seven_day_opus" and the like leave it null). */
export interface PlanRefusal {
  until: number;
  kind: "session" | "weekly" | null;
}

let planRefusal: PlanRefusal | null = null;
const planRefusalListeners = new Set<() => void>();

/** The refusal still in force, if any. */
export function claudePlanRefusal(): PlanRefusal | null {
  return planRefusal && Date.now() < planRefusal.until ? planRefusal : null;
}

/** Whether the plan is turning requests away now, so background helpers don't spawn for nothing. */
export function claudePlanRefused(): boolean {
  return claudePlanRefusal() !== null;
}

/** Called when a refusal starts or ends. */
export function onClaudePlanRefusal(listener: () => void): () => void {
  planRefusalListeners.add(listener);
  return () => planRefusalListeners.delete(listener);
}

/**
 * A `rate_limit_event` from any Claude Code process. Its 5-hour and weekly windows update the
 * last reading at once (the model-scoped limits only `get_usage` reports stay as they were),
 * without counting as a fresh reading: the panel still asks once its minute is up.
 */
export function noteClaudeRateLimit(info: Json): void {
  // A refused request can still be served from extra usage; only the top-level status says.
  const refused = info.status === "rejected" && info.isUsingOverage !== true && info.overageInUse !== true;
  const next: PlanRefusal | null =
    refused && typeof info.resetsAt === "number"
      ? { until: info.resetsAt * 1000, kind: info.rateLimitType === "five_hour" ? "session" : info.rateLimitType === "seven_day" ? "weekly" : null }
      : null;
  if (next?.until !== planRefusal?.until || next?.kind !== planRefusal?.kind) {
    planRefusal = next;
    for (const listener of planRefusalListeners) listener();
  }

  const seen: PlanLimit[] = [];
  // Utilization comes as a fraction here (0.43) and as a percentage from get_usage (43).
  const add = (kind: PlanLimit["kind"], w: unknown) => {
    const v = w as { utilization?: unknown; resetsAt?: unknown } | null | undefined;
    if (!v || typeof v.utilization !== "number") return;
    const resetsAt = typeof v.resetsAt === "number" ? new Date(v.resetsAt * 1000).toISOString() : null;
    seen.push({ kind, utilization: Math.max(0, Math.min(100, Math.round(v.utilization * 100))), resetsAt });
  };
  const windows = (info.unifiedWindows ?? {}) as Json;
  add("session", windows.five_hour);
  add("weekly", windows.seven_day);
  // Without the per-window figures, the top level describes the window that limits the account.
  if (seen.length === 0 && info.rateLimitType === "five_hour") add("session", info);
  if (seen.length === 0 && info.rateLimitType === "seven_day") add("weekly", info);
  if (seen.length === 0) return;

  const base = cachedClaudePlanUsage() ?? { subscription: null, limits: [] };
  const kinds = new Set(seen.map((l) => l.kind));
  const value: PlanUsage = { ...base, limits: [...seen, ...base.limits.filter((l) => !kinds.has(l.kind))] };
  planUsageCache = { at: planUsageCache?.at ?? 0, value };
  rememberPlanUsage(value);
  for (const listener of planUsageListeners) listener(value);
}

/** The connected Claude account's 5-hour and weekly usage. Asks a running chat process
 *  when there is one; otherwise a short-lived Claude Code process answers it. Concurrent
 *  callers (the warm-up and the panel opening) share one request. */
export function fetchClaudePlanUsage(force = false): Promise<PlanUsage | null> {
  if (!force && planUsageCache && Date.now() - planUsageCache.at < PLAN_USAGE_TTL_MS) return Promise.resolve(planUsageCache.value);
  if (planUsageInFlight) return planUsageInFlight;
  planUsageInFlight = (async () => {
    let body: Json | null = null;
    const proc = [...live.values()].find((p) => !p.exited);
    if (proc) {
      const res = await controlRequest(proc, { subtype: "get_usage" });
      if (res?.subtype === "success") body = (res.response ?? {}) as Json;
    }
    if (!body) body = await invoke<Json>("claude_code_usage").catch(() => null);
    const value = body ? parsePlanUsage(body) : null;
    planUsageCache = { at: Date.now(), value };
    if (value) {
      rememberPlanUsage(value);
      for (const listener of planUsageListeners) listener(value);
    }
    return value;
  })().finally(() => { planUsageInFlight = null; });
  return planUsageInFlight;
}

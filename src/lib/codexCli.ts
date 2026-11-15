import {
  AgentCliAuthError,
  createTurnOutput,
  isAgentCliAuthFailure,
  outputText,
  priorContext,
  promptText,
  resumePoint,
  sessionLeftBehind,
  cliFailureText,
  sessionMessage,
  startCliProcess,
  cliEffortFor,
  AGENT_CLI_DEFAULT_MODEL,
  type AgentCliTurn,
  type CliProcess,
} from "./agentCli";
import { appVersion, Rpc, RpcError, STARTUP_TIMEOUT_MS, type Json } from "./acpAgent";
import type { AskQuestion, Todo } from "./agentTools";
import type { PlanLimit, PlanUsage } from "./claudeCode";
import { createCodexSubagents } from "./codexSubagents";
import type { ModelInfo } from "./models";
import { bridgeUrl, hostedServersFor, startMcpBridge } from "./mcpBridge";
import { splitAnswer } from "./questionAnswers";

/**
 * OpenAI's Codex CLI driven through its app-server (`codex app-server`): JSON-RPC over stdio,
 * one message per line, without the `"jsonrpc"` field. A turn opens or resumes a thread,
 * starts a turn, and shows the `item/*` notifications as they come; the agent asks before
 * running a command or changing files (`item/*\/requestApproval`) and Nyxs answers with the
 * chat's own permission rules. Field names follow the schema `codex app-server
 * generate-json-schema` gives (Codex 0.164).
 */

const PRIOR_CONTEXT_CHAR_BUDGET = 60_000;
const INTERRUPT_GRACE_MS = 4000;
const LABEL = "Codex CLI";
const LOGIN_HINT = "Inicia sesión con «codex login».";

/** Opens the app-server and does its handshake: `initialize`, then the `initialized` notification. */
async function openAppServer(cwd: string | null | undefined, onLine: (rpc: Rpc) => (line: string) => void): Promise<{ rpc: Rpc; proc: CliProcess }> {
  const rpc = new Rpc(LABEL, { bare: true });
  const proc = await startCliProcess("codex", ["app-server"], cwd, onLine(rpc));
  rpc.proc = proc;
  void proc.exited.then((code) => {
    const tail = proc.stderrTail.slice(-5).join("\n").trim();
    rpc.fail(new Error(`${LABEL} terminó (código ${code ?? "?"})${tail ? `: ${tail}` : ""}`));
  });
  await rpc.request("initialize", { clientInfo: { name: "nyxs", title: "Nyxs", version: await appVersion() } }, STARTUP_TIMEOUT_MS);
  rpc.notify("initialized", {});
  return { rpc, proc };
}

/** The chat's permission mode as Codex's own approval policy and sandbox. Whatever Codex then
 *  asks about still goes through Nyxs' permission rules. */
function policyFor(t: AgentCliTurn): { approvalPolicy: string; sandbox: string } {
  if (t.planMode || t.permissionMode === "plan") return { approvalPolicy: "on-request", sandbox: "read-only" };
  if (t.permissionMode === "skip") return { approvalPolicy: "never", sandbox: "danger-full-access" };
  if (t.permissionMode === "ask") return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
  return { approvalPolicy: "on-request", sandbox: "workspace-write" };
}

/** Nyxs' own tools (the built-in browser) for this thread, as Codex config overrides. */
async function mcpConfig(workspace: string | null | undefined, chat: string | undefined): Promise<Json | null> {
  const names = hostedServersFor(workspace, chat);
  if (!names.length) return null;
  const info = await startMcpBridge().catch(() => null);
  if (!info) return null;
  return {
    mcp_servers: Object.fromEntries(
      names.map((name) => [name, { url: bridgeUrl(info, name, chat), http_headers: { Authorization: `Bearer ${info.token}` } }]),
    ),
  };
}

const PLAN_STATUS: Record<string, Todo["status"]> = { pending: "pending", inProgress: "in_progress", in_progress: "in_progress", completed: "completed" };

/** A Codex item as the Nyxs tool it amounts to, for its card and the permission rules. */
function toolOfItem(item: Json): { name: string; input: Json } | null {
  switch (item.type) {
    case "commandExecution":
      return { name: "Bash", input: { command: String(item.command ?? "") } };
    case "fileChange": {
      const changes = (Array.isArray(item.changes) ? item.changes : []) as Json[];
      return { name: "Edit", input: { file_path: String(changes[0]?.path ?? "") } };
    }
    case "mcpToolCall":
      return { name: `mcp__${String(item.server)}__${String(item.tool)}`, input: (item.arguments ?? {}) as Json };
    case "webSearch":
      return { name: "WebSearch", input: { query: String(item.query ?? "") } };
    case "dynamicToolCall":
      return { name: String(item.tool ?? "Tool"), input: (item.arguments ?? {}) as Json };
    // Starting a sub-agent; Codex's other agent calls (wait, sendInput…) stay out of the reply.
    case "collabAgentToolCall":
      return item.tool === "spawnAgent" ? { name: "Agent", input: { description: String(item.prompt ?? ""), prompt: String(item.prompt ?? "") } } : null;
    default:
      return null;
  }
}

function itemSucceeded(item: Json): boolean {
  if (item.type === "mcpToolCall") return !item.error && item.status !== "failed";
  if (item.type === "commandExecution") return item.status === "completed" && (item.exitCode == null || item.exitCode === 0);
  return item.status !== "failed" && item.status !== "declined";
}

function itemOutput(item: Json): string {
  if (item.type === "commandExecution") return String(item.aggregatedOutput ?? "");
  if (item.type === "mcpToolCall") return outputText(item.error ?? item.result);
  return "";
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);

const USAGE_FIELDS = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];

/** Codex's token counts `a - b`, field by field. */
function usageMinus(a: Json, b: Json): Json {
  return Object.fromEntries(USAGE_FIELDS.map((k) => [k, Math.max(0, num(a[k]) - num(b[k]))]));
}

export async function streamCodexCli(t: AgentCliTurn): Promise<string> {
  const current = t.history[t.history.length - 1];
  if (!current || current.role !== "user") throw new Error(`No hay mensaje del usuario para ${LABEL}`);
  const prior = t.history.slice(0, -1);
  const resume = t.ephemeral ? { since: prior } : resumePoint("codex", prior, t.chatKey);
  let prompted = false;

  const out = createTurnOutput(t);
  let threadId = "";
  let turnId = "";
  let cancelled = false;
  let finish: (turn: Json) => void = () => undefined;
  const done = new Promise<Json>((resolve) => {
    finish = resolve;
  });
  // Files a pending change touches, by item, for its approval request (which names none).
  const changeFiles = new Map<string, string[]>();
  const streamed = new Set<string>();
  let lastUsage: Json | null = null;
  // The thread's totals before this turn's first model call: its usage is what they grew by.
  // `last` is only the latest call, and a turn with tools makes several.
  let totalBefore: Json | null = null;

  let subagents: ReturnType<typeof createCodexSubagents> | null = null;
  const onNotification = (method: string, params: Json) => {
    // A sub-agent's thread: followed in the background-tasks panel, never in the reply. By
    // thread, not turn: `turn/completed` has no `turnId`, and a sub-agent's would end this turn.
    if (threadId && typeof params.threadId === "string" && params.threadId !== threadId) {
      if (method === "item/started" || method === "item/completed") subagents?.collabItem((params.item ?? {}) as Json, method === "item/completed");
      if (subagents?.childNotification(method, params)) return;
    }
    if (cancelled && method !== "turn/completed") return;
    if (turnId && params.turnId && params.turnId !== turnId) return;
    if (method === "item/started" || method === "item/completed") subagents?.collabItem((params.item ?? {}) as Json, method === "item/completed");
    switch (method) {
      case "item/agentMessage/delta":
        streamed.add(String(params.itemId));
        out.text(String(params.delta ?? ""));
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        out.reasoning(String(params.delta ?? ""));
        break;
      case "item/started": {
        const item = (params.item ?? {}) as Json;
        if (item.type === "fileChange") {
          const changes = (Array.isArray(item.changes) ? item.changes : []) as Json[];
          changeFiles.set(String(item.id), changes.map((c) => String(c.path ?? "")).filter(Boolean));
        }
        const tool = toolOfItem(item);
        if (tool) void out.toolStart(String(item.id), tool.name, tool.input);
        break;
      }
      case "item/completed": {
        const item = (params.item ?? {}) as Json;
        if (item.type === "agentMessage" && !streamed.has(String(item.id)) && typeof item.text === "string") out.text(item.text);
        else if (toolOfItem(item)) {
          if (!out.has(String(item.id))) {
            const tool = toolOfItem(item)!;
            void out.toolStart(String(item.id), tool.name, tool.input);
          }
          out.toolEnd(String(item.id), itemSucceeded(item), itemOutput(item));
        }
        break;
      }
      case "turn/plan/updated": {
        const steps = (Array.isArray(params.plan) ? params.plan : []) as Json[];
        out.todos(steps.map((s) => ({ content: String(s.step ?? ""), status: PLAN_STATUS[String(s.status)] ?? "pending" })));
        break;
      }
      case "thread/tokenUsage/updated":
        lastUsage = (params.tokenUsage ?? null) as Json | null;
        if (lastUsage) {
          const last = (lastUsage.last ?? {}) as Json;
          if (typeof last.inputTokens === "number") t.onContext?.(last.inputTokens);
          if (!totalBefore) totalBefore = usageMinus((lastUsage.total ?? {}) as Json, last);
        }
        break;
      case "turn/completed":
        finish((params.turn ?? {}) as Json);
        break;
    }
  };

  const approve = async (name: string, input: Json, path?: string): Promise<Json> => {
    if (cancelled) return { decision: "cancel" };
    const allowed = t.gate ? await t.gate(name, input) : true;
    if (cancelled) return { decision: "cancel" };
    if (allowed && path) await out.trackEdit(path);
    return { decision: allowed ? "accept" : "decline" };
  };

  const onRequest = async (method: string, params: Json): Promise<Json> => {
    switch (method) {
      case "item/commandExecution/requestApproval":
        return approve("Bash", { command: String(params.command ?? ""), cwd: params.cwd });
      case "item/fileChange/requestApproval": {
        const files = changeFiles.get(String(params.itemId)) ?? [];
        let result: Json = { decision: "accept" };
        for (const file of files.length ? files : [""]) {
          result = await approve("Edit", { file_path: file }, file || undefined);
          if (result.decision !== "accept") break;
        }
        return result;
      }
      case "item/tool/requestUserInput": {
        const raw = (Array.isArray(params.questions) ? params.questions : []) as Json[];
        if (!t.askUser || !raw.length) return { answers: {} };
        const questions: AskQuestion[] = raw.map((q) => ({
          question: String(q.question ?? ""),
          header: String(q.header ?? "Codex").slice(0, 30),
          options: ((Array.isArray(q.options) ? q.options : []) as Json[]).map((o) => ({ label: String(o.label ?? ""), description: String(o.description ?? "") })),
        }));
        const answers = (await t.askUser(questions)) ?? [];
        return {
          answers: Object.fromEntries(
            raw.map((q, i) => {
              const given = answers.find((a) => a.question === questions[i].question)?.answer ?? "";
              const { picked, text } = splitAnswer(given, questions[i].options.map((o) => o.label));
              return [String(q.id), { answers: text ? [...picked, text] : picked }];
            }),
          ),
        };
      }
      default:
        throw new RpcError(`Method not found: ${method}`, -32601);
    }
  };

  const { rpc, proc } = await openAppServer(t.workspace, (r) => {
    r.onNotification = onNotification;
    r.onRequest = onRequest;
    return (line) => r.line(line);
  });
  subagents = createCodexSubagents({
    runId: proc.runId,
    toolOf: toolOfItem,
    interrupt: (child, childTurn) => rpc.request("turn/interrupt", { threadId: child, turnId: childTurn }),
  });

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    cancelled = true;
    if (threadId && turnId) void rpc.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    killTimer = setTimeout(proc.kill, INTERRUPT_GRACE_MS);
    finish({ status: "interrupted" });
  };
  if (t.signal?.aborted) onAbort();
  else t.signal?.addEventListener("abort", onAbort, { once: true });
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
    finish({ status: "failed", error: { message: proc.stderrTail.slice(-5).join("\n") || `${LABEL} terminó` } });
  });

  try {
    const account = await rpc.request("account/read", { refreshToken: false }, STARTUP_TIMEOUT_MS);
    if (!account.account && account.requiresOpenaiAuth !== false) throw new AgentCliAuthError(`${LABEL} no tiene una sesión iniciada. ${LOGIN_HINT}`);

    const policy = policyFor(t);
    const config = await mcpConfig(t.workspace, t.chatKey);
    const model = t.model.apiModel !== AGENT_CLI_DEFAULT_MODEL ? t.model.apiModel : null;
    const threadParams: Json = { cwd: proc.cwd, model, ...policy, ...(config ? { config } : {}) };
    let since = resume.since;
    if (resume.sessionId) {
      const resumed = await rpc.request("thread/resume", { ...threadParams, threadId: resume.sessionId, excludeTurns: true }, STARTUP_TIMEOUT_MS).catch(() => null);
      threadId = String(((resumed?.thread ?? {}) as Json).id ?? "");
    }
    if (!threadId) {
      const started = await rpc.request("thread/start", { ...threadParams, ephemeral: !!t.ephemeral }, STARTUP_TIMEOUT_MS);
      threadId = String(((started.thread ?? {}) as Json).id ?? "");
      if (!threadId) throw new Error(`${LABEL} no abrió una conversación`);
      since = prior;
    }

    if (cancelled) throw new DOMException("Aborted", "AbortError");
    const input: Json[] = [{ type: "text", text: promptText(current, priorContext(since, PRIOR_CONTEXT_CHAR_BUDGET)) }];
    for (const img of current.images ?? []) input.push({ type: "image", url: img.dataUrl });
    const effort = cliEffortFor(t.model, t.effort);
    prompted = true;
    const started = await rpc.request("turn/start", { threadId, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    turnId = String(((started.turn ?? {}) as Json).id ?? "");

    const turn = await done;
    if (t.signal?.aborted || turn.status === "interrupted") throw new DOMException("Aborted", "AbortError");
    if (turn.status === "failed") {
      const message = String(((turn.error ?? {}) as Json).message ?? `${LABEL} falló`);
      if (isAgentCliAuthFailure(message)) throw new AgentCliAuthError(`${LABEL} no tiene una sesión iniciada. ${LOGIN_HINT}`);
      throw new Error(message);
    }
    out.endOpenTools(true);
    const usage = lastUsage as Json | null;
    if (usage) {
      const total = (usage.total ?? {}) as Json;
      // Without totals (an older Codex), the last call is all there is to count.
      const turnUsage = totalBefore && typeof total.inputTokens === "number" ? usageMinus(total, totalBefore) : ((usage.last ?? {}) as Json);
      t.onUsage?.(num(turnUsage.outputTokens));
      t.onCacheStats?.({
        readTokens: num(turnUsage.cachedInputTokens),
        creationTokens: num(turnUsage.cacheWriteInputTokens),
        inputTokens: num(turnUsage.inputTokens),
        outputTokens: num(turnUsage.outputTokens),
      });
    }
    if (threadId && !t.ephemeral) t.onMessages?.([sessionMessage("codex", threadId, out.reply.trim(), undefined, t.chatKey)]);
    return out.full;
  } catch (err) {
    out.endOpenTools(false);
    if (prompted && threadId && !t.ephemeral) sessionLeftBehind("codex", threadId, t.chatKey);
    if (t.signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) throw new DOMException("Aborted", "AbortError");
    if (err instanceof AgentCliAuthError) throw err;
    const said = cliFailureText(err instanceof Error ? err.message : String(err), proc.stderrTail, exited);
    if (isAgentCliAuthFailure(said)) throw new AgentCliAuthError(`${LABEL} no tiene una sesión iniciada. ${LOGIN_HINT}`, { cause: err });
    throw err;
  } finally {
    t.signal?.removeEventListener("abort", onAbort);
    if (killTimer) clearTimeout(killTimer);
    subagents.end();
    proc.closeInput();
    proc.kill();
  }
}

/** Codex's models with their reasoning levels, from the app-server's `model/list`. */
export async function fetchCodexModels(): Promise<ModelInfo[]> {
  let opened: { rpc: Rpc; proc: CliProcess } | null = null;
  try {
    opened = await openAppServer(null, (r) => (line) => r.line(line));
    const result = await opened.rpc.request("model/list", { includeHidden: false }, STARTUP_TIMEOUT_MS);
    const data = (Array.isArray(result.data) ? result.data : []) as Json[];
    const models = data
      .filter((m) => !m.hidden && typeof m.model === "string")
      .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
    return models.map((m) => ({
      id: `codex-cli:${String(m.model)}`,
      apiModel: String(m.model),
      name: typeof m.displayName === "string" && m.displayName ? m.displayName : String(m.model),
      description: LABEL,
      provider: "codex-cli" as const,
      effortLevels: ((Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []) as Json[]).map((e) => String(e.reasoningEffort)),
    }));
  } catch {
    return [];
  } finally {
    opened?.proc.closeInput();
    opened?.proc.kill();
  }
}

/** The account's 5-hour and weekly windows, from the app-server's `account/rateLimits/read`. */
export async function fetchCodexPlanUsage(): Promise<PlanUsage | null> {
  let opened: { rpc: Rpc; proc: CliProcess } | null = null;
  try {
    opened = await openAppServer(null, (r) => (line) => r.line(line));
    const result = await opened.rpc.request("account/rateLimits/read", {}, STARTUP_TIMEOUT_MS);
    const snapshot = (result.rateLimits ?? {}) as Json;
    const limits: PlanLimit[] = [];
    for (const key of ["primary", "secondary"]) {
      const w = snapshot[key] as Json | null | undefined;
      if (!w || typeof w.usedPercent !== "number") continue;
      const mins = typeof w.windowDurationMins === "number" ? w.windowDurationMins : null;
      limits.push({
        // Codex's windows: 5 hours and a week.
        kind: mins !== null && mins <= 24 * 60 ? "session" : "weekly",
        utilization: Math.round(w.usedPercent),
        resetsAt: typeof w.resetsAt === "number" ? new Date(w.resetsAt * 1000).toISOString() : null,
      });
    }
    return { subscription: typeof snapshot.planType === "string" ? snapshot.planType : null, limits };
  } catch {
    return null;
  } finally {
    opened?.proc.closeInput();
    opened?.proc.kill();
  }
}

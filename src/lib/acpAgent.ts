import {
  AgentCliAuthError,
  attachCliProcess,
  createTurnOutput,
  guideChanged,
  guideFingerprint,
  isAgentCliAuthFailure,
  nyxsTool,
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
  type AgentCliId,
  type AgentCliTurn,
  type CliProcess,
  type TurnOutput,
} from "./agentCli";
import type { Todo } from "./agentTools";
import { getVersion } from "@tauri-apps/api/app";
import { acpMcpServers, hostedServersFor } from "./mcpBridge";
import { acpExited, markAcpBusy, parkAcp, takeParkedAcp, takeSavedAcp, type LiveAcp } from "./acpProcesses";
import { BROWSER_MCP_SERVER } from "./browserTools";
import { VIDEO_MCP_SERVER } from "./videoTools";
import { SESSIONS_MCP_SERVER } from "./sessionTools";
import { CHAT_MCP_SERVER, registerChatTurn } from "./chatMcp";
import { sessionGuide, type GuidedCli } from "./cliGuide";

/**
 * A coding agent driven over the Agent Client Protocol (Grok CLI's `grok agent stdio`, Cursor
 * CLI's `cursor-agent acp`): JSON-RPC 2.0, one message per line. Nyxs is the client: it opens
 * or reloads a session, sends the prompt, and shows the `session/update` notifications as they
 * come; the agent asks before using a tool (`session/request_permission`) and Nyxs answers with
 * the chat's own permission rules. What differs per CLI is in its `AcpSpec`.
 */

export type Json = Record<string, unknown>;

const PRIOR_CONTEXT_CHAR_BUDGET = 60_000;
const INTERRUPT_GRACE_MS = 4000;
export const STARTUP_TIMEOUT_MS = 60_000;

export class RpcError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/** The JSON-RPC side of the connection: requests out, their answers back, and whatever the
 *  agent sends on its own (notifications, and requests Nyxs must answer). */
export class Rpc {
  private next = 0;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  proc: CliProcess | null = null;
  onNotification: (method: string, params: Json) => void = () => undefined;
  onRequest: (method: string, params: Json) => Promise<Json> = async (method) => {
    throw new RpcError(`Method not found: ${method}`, -32601);
  };

  private label: string;
  /** Codex's app-server speaks JSON-RPC without the `"jsonrpc":"2.0"` field. */
  private bare: boolean;

  constructor(label: string, opts: { bare?: boolean } = {}) {
    this.label = label;
    this.bare = !!opts.bare;
  }

  line(raw: string) {
    let msg: Json;
    try {
      msg = JSON.parse(raw) as Json;
    } catch {
      return;
    }
    if (typeof msg.method === "string") {
      const params = (msg.params ?? {}) as Json;
      if (msg.id === undefined || msg.id === null) {
        this.onNotification(msg.method, params);
        return;
      }
      const id = msg.id;
      void this.onRequest(msg.method, params).then(
        (result) => this.write({ jsonrpc: "2.0", id, result }),
        (err: unknown) =>
          this.write({
            jsonrpc: "2.0",
            id,
            error: { code: err instanceof RpcError ? err.code : -32603, message: err instanceof Error ? err.message : String(err) },
          }),
      );
      return;
    }
    const waiting = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!waiting) return;
    this.pending.delete(msg.id as number);
    if (msg.error) {
      const e = msg.error as Json;
      waiting.reject(new RpcError(String(e.message ?? "Error"), typeof e.code === "number" ? e.code : -32603));
    } else waiting.resolve((msg.result ?? {}) as Json);
  }

  request(method: string, params: Json, timeoutMs?: number): Promise<Json> {
    const id = ++this.next;
    return new Promise<Json>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${this.label} no respondió a ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      void this.write({ jsonrpc: "2.0", id, method, params }).catch((e: unknown) => {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  notify(method: string, params: Json) {
    void this.write({ jsonrpc: "2.0", method, params }).catch(() => undefined);
  }

  /** The process ended: every request still waiting fails with what it last said. */
  fail(reason: Error) {
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
  }

  private write(msg: Json): Promise<void> {
    if (!this.proc) return Promise.reject(new Error(`${this.label} no está en marcha`));
    if (this.bare) {
      const { jsonrpc: _version, ...rest } = msg;
      return this.proc.send(JSON.stringify(rest));
    }
    return this.proc.send(JSON.stringify(msg));
  }
}

export async function appVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "0.0.0";
  }
}

/** The `initialize` request every ACP agent gets first. The CLI reads, writes and runs
 *  commands itself, so Nyxs offers no file system or terminal of its own. */
export async function initializeParams(): Promise<Json> {
  return {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    // Grok rejects an `initialize` whose clientInfo has no version ("Invalid params").
    clientInfo: { name: "nyxs", title: "Nyxs", version: await appVersion() },
  };
}

/** What a CLI's own extensions get to work with. */
export interface AcpContext {
  t: AgentCliTurn;
  out: TurnOutput;
  rpc: Rpc;
  sessionId: () => string;
  /** Ends the turn the way the user's Stop does. */
  cancel: () => void;
}

export interface AcpSpec {
  cli: AgentCliId;
  label: string;
  /** The CLI's arguments for one turn (its model, reasoning level…). */
  args: (t: AgentCliTurn) => string[];
  /** Auth methods to use, in order of preference; the agent's first one otherwise. */
  authMethods: string[];
  /** How to sign in, for the error when there's no session. */
  loginHint: string;
  /** False: never `authenticate` in a turn, the CLI uses the sign-in it saved (Devin's only
   *  method opens a browser sign-in). */
  authenticate?: boolean;
  /** How long to wait for the session to offer the chat's model in a `config_option_update`
   *  (Devin refreshes its catalog after `session/new`). */
  modelWaitMs?: number;
  /** The CLI's own requests (Cursor's questions and plans); null when it isn't one. */
  request?: (ctx: AcpContext, method: string, params: Json) => Promise<Json> | null;
  /** The CLI's own notifications (Cursor's todo list). */
  notification?: (ctx: AcpContext, method: string, params: Json) => void;
  /** Nyxs' guide (previews, its browser, NYXS.md…) as the new session's rules: Grok appends
   *  `_meta.rules` to its system prompt and keeps them with the session (those sent on
   *  `session/load` are ignored, so a session keeps the guide it started with). */
  guide?: GuidedCli;
  /** Offers Nyxs' questions and plan review as MCP tools (chatMcp.ts). */
  chatTools?: boolean;
  /** Keeps the process between the chat's turns (acpProcesses.ts): for agents whose start and
   *  session reload are slow (Grok ≈4 s, OpenCode ≈2 s a turn; Devin ≈0.2 s isn't worth it). */
  keepAlive?: boolean;
  /** The CLI's sub-agents for the background-tasks panel (Grok's), made for each turn once the
   *  process runs. */
  subagents?: (ctx: AcpContext, runId: string) => AcpSubagents;
}

/** A CLI's sub-agents over ACP, followed in the background-tasks panel for one turn. */
export interface AcpSubagents {
  /** A notification of the CLI's own; true when it was about a sub-agent. */
  notification: (method: string, params: Json) => boolean;
  /** A `session/update` of another session than the turn's: a sub-agent's own activity. */
  childUpdate: (sessionId: string, update: Json) => void;
  /** The turn ended: a sub-agent it didn't hear end is over too. */
  end: () => void;
}

const CHAT_TOOL_PREFIX = `mcp__${CHAT_MCP_SERVER}__`;

const TODO_STATUS: Record<string, Todo["status"]> = { pending: "pending", in_progress: "in_progress", completed: "completed" };

/** A tool call as Nyxs' own tool, for its card and the permission rules. */
export function toolOf(call: Json): { name: string; input: Json; path: string | null } {
  const locations = Array.isArray(call.locations) ? (call.locations as Json[]) : [];
  const path = typeof locations[0]?.path === "string" ? (locations[0].path as string) : null;
  const raw = (call.rawInput && typeof call.rawInput === "object" ? call.rawInput : {}) as Json;
  const title = typeof call.title === "string" ? call.title : "";
  // An MCP tool runs through Grok's `use_tool` ("nyxs-browser__navigate"): named as Claude Code
  // names it ("mcp__nyxs-browser__navigate"), so the permission rules and the browser's own
  // cards know it.
  if (typeof raw.tool_name === "string" && raw.tool_name.includes("__")) {
    const input = (raw.tool_input && typeof raw.tool_input === "object" ? raw.tool_input : {}) as Json;
    return { name: `mcp__${raw.tool_name}`, input, path };
  }
  // A command whose input the CLI leaves out has its command line as the title.
  return { ...nyxsTool(String(call.kind ?? ""), title, raw, path), path };
}

/** What the turn used, as Grok reports it with the prompt's answer: the last model call's input
 *  is what the context holds now; `usage` adds up the turn's calls. */
function reportUsage(t: AgentCliTurn, meta: Json) {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (num(meta.inputTokens)) t.onContext?.(num(meta.inputTokens));
  const usage = (meta.usage ?? {}) as Json;
  if (!num(usage.inputTokens) && !num(usage.outputTokens)) return;
  t.onUsage?.(num(usage.outputTokens));
  t.onCacheStats?.({
    readTokens: num(usage.cachedReadTokens),
    creationTokens: num(usage.cacheCreationTokens),
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
  });
}

/** The text a finished tool call reports: its output, or the diff summary of an edit. */
function callOutput(content: unknown): string {
  if (!Array.isArray(content)) return outputText(content);
  return (content as Json[])
    .map((c) => {
      if (c.type === "diff") return `${String(c.path ?? "")}`;
      if (c.type === "content") return outputText(c.content);
      return outputText(c);
    })
    .filter(Boolean)
    .join("\n");
}

function handleUpdate(out: TurnOutput, update: Json) {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = (update.content ?? {}) as Json;
      if (content.type === "text" && typeof content.text === "string") out.text(content.text);
      break;
    }
    case "agent_thought_chunk": {
      const content = (update.content ?? {}) as Json;
      if (typeof content.text === "string") out.reasoning(content.text);
      break;
    }
    case "tool_call": {
      const id = String(update.toolCallId ?? "");
      const tool = toolOf(update);
      void out.toolStart(id, tool.name, tool.input);
      if (update.status === "completed" || update.status === "failed") out.toolEnd(id, update.status === "completed", callOutput(update.content));
      break;
    }
    case "tool_call_update": {
      const id = String(update.toolCallId ?? "");
      if (!out.has(id)) {
        const tool = toolOf(update);
        void out.toolStart(id, tool.name, tool.input);
      }
      if (update.status === "completed" || update.status === "failed") out.toolEnd(id, update.status === "completed", callOutput(update.content));
      break;
    }
    case "plan": {
      const entries = Array.isArray(update.entries) ? (update.entries as Json[]) : [];
      out.todos(entries.map((e) => ({ content: String(e.content ?? ""), status: TODO_STATUS[String(e.status)] ?? "pending" })));
      break;
    }
  }
}

/** Every value a session config option offers, its groups flattened. */
export function configValues(option: Json): { value: string; name: string; description?: string }[] {
  const out: { value: string; name: string; description?: string }[] = [];
  for (const o of (Array.isArray(option.options) ? option.options : []) as Json[]) {
    if (Array.isArray(o.options)) out.push(...configValues(o));
    else if (typeof o.value === "string") {
      out.push({ value: o.value, name: typeof o.name === "string" ? o.name : o.value, description: typeof o.description === "string" ? o.description : undefined });
    }
  }
  return out;
}

/** The session's config options as last heard: `session/new`'s, then each
 *  `config_option_update` and each `set_config_option` answer. */
interface ConfigState {
  options: Json[];
}

/** The chat's model and reasoning level, through the session's own config options where the
 *  agent offers them (`session/set_config_option`: DeepSeek Harness's `model` and
 *  `reasoning_effort`, Devin's `model` and `thought_level`). The model goes first: the levels
 *  offered depend on it. Says whether the chat's model was set: null when the session has no
 *  model option (or the chat leaves the model to the agent). */
async function applyConfigOptions(rpc: Rpc, sessionId: string, config: ConfigState, t: AgentCliTurn, waitMs: number): Promise<boolean | null> {
  const set = async (option: Json, value: string): Promise<boolean> => {
    const res = await rpc.request("session/set_config_option", { sessionId, configId: option.id, value }).catch(() => null);
    if (res && Array.isArray(res.configOptions)) config.options = res.configOptions as Json[];
    return res !== null;
  };
  const isModel = (o: Json) => o.category === "model" || o.id === "model";
  let modelSet: boolean | null = null;
  if (t.model.apiModel !== AGENT_CLI_DEFAULT_MODEL) {
    const ids = [t.model.apiModel, ...(t.model.aliases ?? [])];
    const deadline = Date.now() + waitMs;
    for (;;) {
      const model = config.options.find(isModel);
      const pick = model && ids.find((id) => configValues(model).some((v) => v.value === id));
      if (model && pick) {
        modelSet = model.currentValue === pick || (await set(model, pick));
        break;
      }
      if (Date.now() >= deadline) {
        if (model) modelSet = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const effort = config.options.find((o) => o.category === "thought_level" || o.id === "reasoning_effort");
  const wanted = effort ? cliEffortFor(t.model, t.effort) : null;
  if (effort && wanted && effort.currentValue !== wanted && configValues(effort).some((v) => v.value === wanted)) await set(effort, wanted);
  return modelSet;
}

/** The option of a permission request that allows (or rejects) once: by its kind, else by its
 *  id ("allow-once", Cursor's). */
function permissionOption(options: Json[], allow: boolean): string | undefined {
  const kinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  const byKind = options.find((o) => kinds.includes(String(o.kind)))?.optionId;
  if (byKind !== undefined) return String(byKind);
  const re = allow ? /allow/i : /reject|deny/i;
  const byId = options.find((o) => re.test(String(o.optionId)))?.optionId;
  return byId !== undefined ? String(byId) : undefined;
}

export async function streamAcpAgent(spec: AcpSpec, t: AgentCliTurn): Promise<string> {
  const current = t.history[t.history.length - 1];
  if (!current || current.role !== "user") throw new Error(`No hay mensaje del usuario para ${spec.label}`);
  const prior = t.history.slice(0, -1);
  const resume = t.ephemeral ? { since: prior } : resumePoint(spec.cli, prior, t.chatKey);

  const out = createTurnOutput(t);
  // The chat's process from its last turn, when this agent is kept alive and the settings it was
  // started with still hold (see acpProcesses.ts); picked up again after a reload of the page.
  const keep = !!spec.keepAlive && !t.ephemeral && !!t.chatKey;
  const processKey = keep ? acpProcessKey(spec, t) : "";
  let live: LiveAcp<Rpc> | undefined = keep ? takeParkedAcp<Rpc>(t.chatKey!, processKey) : undefined;
  if (!live && keep) {
    const saved = takeSavedAcp(t.chatKey!, processKey);
    if (saved) {
      const attached = new Rpc(spec.label);
      const proc = await attachCliProcess(saved.runId, saved.cwd, (line) => attached.line(line)).catch(() => null);
      if (proc) {
        attached.proc = proc;
        live = { ...saved, proc, rpc: attached, exited: false };
        const entry = live;
        void proc.exited.then(() => acpExited(entry));
      }
    }
  }
  const rpc = live?.rpc ?? new Rpc(spec.label);
  // Updates that replay a reloaded session's history aren't part of this turn.
  let replaying = false;
  let sessionId = "";
  let cancelled = false;

  let proc: CliProcess | null = live?.proc ?? null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    cancelled = true;
    if (sessionId) rpc.notify("session/cancel", { sessionId });
    killTimer = setTimeout(() => proc?.kill(), INTERRUPT_GRACE_MS);
  };
  const ctx: AcpContext = { t, out, rpc, sessionId: () => sessionId, cancel: onAbort };

  const config: ConfigState = { options: [] };
  let subagents: AcpSubagents | undefined = undefined;
  rpc.onNotification = (method, params) => {
    const update = (params.update ?? {}) as Json;
    if (method === "session/update" && update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
      config.options = update.configOptions as Json[];
    }
    if (replaying || cancelled) return;
    if (method === "session/update") {
      // Another session's update is a sub-agent's (Grok streams theirs on the same connection):
      // never part of the reply.
      const from = typeof params.sessionId === "string" ? params.sessionId : "";
      if (subagents && from && sessionId && from !== sessionId) subagents.childUpdate(from, update);
      else handleUpdate(out, update);
    } else if (!subagents?.notification(method, params)) spec.notification?.(ctx, method, params);
  };
  rpc.onRequest = async (method, params) => {
    if (method !== "session/request_permission") {
      const own = spec.request?.(ctx, method, params);
      if (own) return own;
      throw new RpcError(`Method not found: ${method}`, -32601);
    }
    const options = (Array.isArray(params.options) ? params.options : []) as Json[];
    if (cancelled) return { outcome: { outcome: "cancelled" } };
    const tool = toolOf((params.toolCall ?? {}) as Json);
    // Nyxs' own questions and plan review only show the user something: never a prompt of their own.
    const allowed = tool.name.startsWith(CHAT_TOOL_PREFIX) ? true : t.gate ? await t.gate(tool.name, tool.input) : true;
    if (cancelled) return { outcome: { outcome: "cancelled" } };
    if (allowed && tool.name === "Edit") await out.trackEdit(tool.path ?? (tool.input.file_path as string | undefined));
    const optionId = permissionOption(options, allowed);
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
  };

  proc ??= await startCliProcess(spec.cli, spec.args(t), t.workspace, (line) => rpc.line(line), t.env, { keepAlive: keep });
  const started = proc;
  rpc.proc = started;
  subagents = spec.subagents?.(ctx, started.runId);
  let exitCode: number | null | undefined;
  void started.exited.then((code) => {
    exitCode = code;
    const tail = started.stderrTail.slice(-5).join("\n").trim();
    rpc.fail(new Error(`${spec.label} terminó (código ${code ?? "?"})${tail ? `: ${tail}` : ""}`));
  });
  // What the process keeps for the chat's next turn; a new one is watched from now on.
  const entry: LiveAcp<Rpc> | undefined = keep
    ? (live ?? { chatKey: t.chatKey!, cli: spec.cli, config: processKey, proc: started, rpc, exited: false, init: {}, sessionId: "", session: null, configOptions: [], mcpServers: [] })
    : undefined;
  if (entry && !live) void started.exited.then(() => acpExited(entry));
  if (entry) markAcpBusy(entry);
  let ok = false;
  let prompted = false;
  // The guide the session runs with, known once it's open (unknown for an older one).
  let sessionGuidePrint: string | undefined;
  const keepSession = () => {
    if (sessionId && !t.ephemeral) t.onMessages?.([sessionMessage(spec.cli, sessionId, out.reply.trim(), sessionGuidePrint, t.chatKey)]);
  };

  if (t.signal?.aborted) onAbort();
  else t.signal?.addEventListener("abort", onAbort, { once: true });

  const notSignedIn = () => `${spec.label} no tiene una sesión iniciada. ${spec.loginHint}`;
  let releaseChat: (() => void) | undefined;
  try {
    let init: Json;
    let mcpServers: Json[];
    if (live) {
      // Started, signed in and given its MCP servers on an earlier turn.
      init = live.init;
      mcpServers = live.mcpServers;
    } else {
      init = await rpc.request("initialize", await initializeParams(), STARTUP_TIMEOUT_MS);
      const methods = (Array.isArray(init.authMethods) ? init.authMethods : []) as Json[];
      if (methods.length && spec.authenticate !== false) {
        const ids = methods.map((m) => String(m.id));
        const methodId = spec.authMethods.find((m) => ids.includes(m)) ?? ids[0];
        try {
          await rpc.request("authenticate", { methodId, _meta: { headless: true } }, STARTUP_TIMEOUT_MS);
        } catch (err) {
          throw new AgentCliAuthError(`${notSignedIn()} (${err instanceof Error ? err.message : String(err)})`, { cause: err });
        }
      }
      // Nyxs' own tools (the built-in browser…), served over HTTP by the app.
      const caps = (init.agentCapabilities ?? {}) as Json;
      mcpServers =
        ((caps.mcpCapabilities ?? {}) as Json).http === true ? await acpMcpServers(t.workspace, t.chatKey, { chatTools: spec.chatTools && !t.ephemeral }) : [];
    }
    const caps = (init.agentCapabilities ?? {}) as Json;
    const canLoad = caps.loadSession === true;
    // Resuming without replaying the history (DeepSeek Harness offers only this).
    const canResume = ((caps.sessionCapabilities ?? {}) as Json).resume !== undefined;
    const images = ((caps.promptCapabilities ?? {}) as Json).image === true;
    const served = new Set(mcpServers.map((s) => String(s.name)));
    if (served.has(CHAT_MCP_SERVER)) {
      releaseChat = registerChatTurn(t.chatKey, { askUser: t.askUser, plan: t.planMode ? (p) => out.plan(p) : undefined }).release;
    }
    // Nyxs' guide for this session, built every turn (NYXS.md is cached): its fingerprint tells
    // whether the session to continue still has it.
    const guide = spec.guide && !t.ephemeral
      ? await sessionGuide(spec.guide, {
          browser: served.has(BROWSER_MCP_SERVER),
          sessions: served.has(SESSIONS_MCP_SERVER),
          video: served.has(VIDEO_MCP_SERVER),
          chatTools: served.has(CHAT_MCP_SERVER),
          workspace: t.workspace,
        })
      : null;
    const guidePrint = guide !== null ? guideFingerprint(guide) : undefined;
    const newSessionMeta = (): Json => (guide !== null ? { _meta: { rules: guide } } : {});

    let session: Json | null = null;
    let since = resume.since;
    // Rules only reach a session at `session/new`: an edited guide (NYXS.md, the tools served)
    // starts a new session, given the chat so far as text, as one the CLI no longer has is.
    const reload = guideChanged(resume, guidePrint) ? undefined : resume.sessionId;
    let startedNew = false;
    // The kept process already has the chat's session open: nothing to reload.
    const reused = !!live && !!reload && live.sessionId === reload;
    if (reused) {
      sessionId = reload!;
      session = live!.session;
      config.options = live!.configOptions;
    } else if (reload && canLoad) {
      replaying = true;
      try {
        session = await rpc.request("session/load", { sessionId: reload, cwd: started.cwd, mcpServers }, STARTUP_TIMEOUT_MS);
        sessionId = reload;
      } catch {
        session = null;
      } finally {
        replaying = false;
      }
    } else if (reload && canResume) {
      session = await rpc
        .request("session/resume", { sessionId: reload, cwd: started.cwd, mcpServers }, STARTUP_TIMEOUT_MS)
        .catch(() => null);
      if (session) sessionId = reload;
    }
    if (!sessionId) {
      session = await rpc.request("session/new", { cwd: started.cwd, mcpServers, ...newSessionMeta() }, STARTUP_TIMEOUT_MS);
      sessionId = String(session.sessionId ?? "");
      if (!sessionId) throw new Error(`${spec.label} no abrió una sesión`);
      since = prior;
      startedNew = true;
    }

    // The chat's model and mode, where the agent offers them; its own defaults otherwise.
    const models = ((session?.models ?? {}) as Json).availableModels;
    // Whether the chat's model was set: null where the session offers no way to.
    let modelSet: boolean | null = null;
    if (t.model.apiModel !== AGENT_CLI_DEFAULT_MODEL && Array.isArray(models) && models.length) {
      modelSet =
        (models as Json[]).some((m) => m.modelId === t.model.apiModel) &&
        (await rpc.request("session/set_model", { sessionId, modelId: t.model.apiModel }).then(() => true, () => false));
    }
    // An update that came in before `session/new` answered is the newer list.
    if (!config.options.length && Array.isArray(session?.configOptions)) config.options = session.configOptions as Json[];
    const byConfig = await applyConfigOptions(rpc, sessionId, config, t, spec.modelWaitMs ?? 0);
    if (byConfig !== null) modelSet = modelSet === true || byConfig;
    // Not set, and not started with it either (Cursor's `--model`): the turn would quietly run on
    // the agent's own default instead of the model the chat shows.
    if (modelSet === false && !spec.args(t).includes(t.model.apiModel)) {
      throw new Error(`${spec.label} no pudo usar el modelo ${t.model.name}: no lo ofrece en esta sesión o rechazó el cambio. Elige otro modelo para este chat.`);
    }
    const modeState = (session?.modes ?? {}) as Json;
    const modes = modeState.availableModes;
    // A session kept from the last turn may still be in plan mode: it goes back to the mode it
    // started in when this turn isn't planning.
    const defaultModeId = reused ? live!.defaultModeId : typeof modeState.currentModeId === "string" ? modeState.currentModeId : undefined;
    let modeId = reused ? live!.modeId : defaultModeId;
    const plan = t.planMode && Array.isArray(modes) ? (modes as Json[]).find((m) => /plan/i.test(`${String(m.id)} ${String(m.name ?? "")}`)) : undefined;
    const wantedMode = plan ? String(plan.id) : t.planMode ? modeId : defaultModeId;
    if (wantedMode && wantedMode !== modeId) {
      const set = await rpc.request("session/set_mode", { sessionId, modeId: wantedMode }).then(() => true, () => false);
      if (set) modeId = wantedMode;
    }

    if (cancelled) throw new DOMException("Aborted", "AbortError");
    const prompt: Json[] = [{ type: "text", text: promptText(current, priorContext(since, PRIOR_CONTEXT_CHAR_BUDGET)) }];
    if (images) {
      for (const img of current.images ?? []) {
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(img.dataUrl);
        if (m) prompt.push({ type: "image", mimeType: m[1], data: m[2] });
      }
    }
    // A continued session keeps the guide it started with.
    sessionGuidePrint = startedNew ? guidePrint : reused ? live!.guide : resume.guide;
    prompted = true;
    const result = await rpc.request("session/prompt", { sessionId, prompt });
    // A plan handed over for review ends the turn as Nyxs' own plan mode does.
    if (t.signal?.aborted || (result.stopReason === "cancelled" && !out.planShown)) throw new DOMException("Aborted", "AbortError");
    out.endOpenTools(true);
    if (result.stopReason === "refusal" && !out.reply.trim()) throw new Error(`${spec.label} se negó a responder a este mensaje.`);
    reportUsage(t, (result._meta ?? {}) as Json);

    keepSession();
    if (entry) {
      Object.assign(entry, { init, mcpServers, sessionId, session, guide: sessionGuidePrint, configOptions: config.options, modeId, defaultModeId });
    }
    ok = true;
    return out.full;
  } catch (err) {
    // A plan handed over for review ends the turn, and the turn was cancelled for it: Cursor may
    // answer that only by exiting, or not at all until the grace runs out and it is stopped.
    if (prompted && out.planShown && !t.signal?.aborted) {
      out.endOpenTools(true);
      keepSession();
      return out.full;
    }
    out.endOpenTools(false);
    if (prompted && sessionId && !t.ephemeral) sessionLeftBehind(spec.cli, sessionId, t.chatKey);
    if (t.signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) throw new DOMException("Aborted", "AbortError");
    const said = cliFailureText(err instanceof Error ? err.message : String(err), started.stderrTail, exitCode !== undefined);
    if (!(err instanceof AgentCliAuthError) && isAgentCliAuthFailure(said)) throw new AgentCliAuthError(notSignedIn(), { cause: err });
    if (exitCode !== undefined && !(err instanceof AgentCliAuthError)) {
      const tail = started.stderrTail.slice(-5).join("\n").trim();
      throw new Error(`${spec.label} terminó sin respuesta (código ${exitCode ?? "?"})${tail ? `: ${tail}` : ""}`, { cause: err });
    }
    throw err;
  } finally {
    subagents?.end();
    releaseChat?.();
    t.signal?.removeEventListener("abort", onAbort);
    if (killTimer) clearTimeout(killTimer);
    if (entry) {
      // Waiting for the chat's next message: only the session's config is listened to, and
      // nothing it asks for is allowed.
      rpc.onNotification = (method, params) => {
        const update = (params.update ?? {}) as Json;
        if (method === "session/update" && update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
          entry.configOptions = update.configOptions as Json[];
        }
      };
      rpc.onRequest = async (method) => {
        if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } };
        throw new RpcError(`Method not found: ${method}`, -32601);
      };
      parkAcp(entry, ok);
    } else {
      started.closeInput();
      started.kill();
    }
  }
}

/** The settings a kept process was started with: another set needs another process. */
function acpProcessKey(spec: AcpSpec, t: AgentCliTurn): string {
  return JSON.stringify([spec.cli, spec.args(t), t.workspace ?? "", t.env ?? null, hostedServersFor(t.workspace, t.chatKey), !!spec.chatTools]);
}

import {
  AgentCliAuthError,
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
  type AgentCliTurn,
} from "./agentCli";
import { createAntigravitySubagents } from "./antigravitySubagents";
import { BROWSER_MCP_SERVER } from "./browserTools";
import { VIDEO_MCP_SERVER } from "./videoTools";
import { CHAT_MCP_SERVER, registerChatTurn } from "./chatMcp";
import { sessionGuide } from "./cliGuide";
import { antigravityMcpEnv, syncAntigravityMcp } from "./mcpBridge";
import { getMergedSnapshot } from "./settingsRuntime";
import { abortChatTurn } from "./turnAborts";
import { invoke } from "@/lib/ipc";

/**
 * Antigravity CLI (`agy`) in its headless mode: one prompt per run, read from stdin (without
 * `-p` agy takes it from there, of any length: a 66k-character prompt arrived whole with 1.4.10,
 * where the command line capped it at 24k), answered as stream-json (an `init`, `step_update`s
 * with text deltas and tool steps, then a `result`). A run continues the chat's conversation
 * with `--conversation <id>`.
 *
 * Headless runs can't ask for permission (a tool that needs it is skipped), so the chat's
 * permission mode is turned into the CLI's own up front.
 */

type Json = Record<string, unknown>;

const PRIOR_CONTEXT_CHAR_BUDGET = 60_000;

/** Headless agy denies every MCP call that has no allow rule, so Nyxs' servers are allowed for
 *  the run (session-only settings, never saved): the chat tools only show the user a question or
 *  a plan, and the browser's calls go through the chat's own permission mode when they arrive
 *  (browserMcp.ts), as Claude Code's do. `--settings` replaces the `permissions` of the user's
 *  settings.json for the run, so theirs (`user`) are sent along. */
export function hostedToolsSettings(served: { browser: boolean; chatTools: boolean; video?: boolean }, user?: Json | null): string | null {
  const ours = [...(served.chatTools ? [`mcp(${CHAT_MCP_SERVER}/*)`] : []), ...(served.browser ? [`mcp(${BROWSER_MCP_SERVER}/*)`] : []), ...(served.video ? [`mcp(${VIDEO_MCP_SERVER}/*)`] : [])];
  if (!ours.length) return null;
  const theirs = Array.isArray(user?.allow) ? (user.allow as unknown[]).filter((r): r is string => typeof r === "string") : [];
  return JSON.stringify({ permissions: { ...(user ?? {}), allow: [...new Set([...theirs, ...ours])] } });
}

function runArgs(t: AgentCliTurn, conversation: string | undefined, settings: string | null): string[] {
  const args = ["--output-format", "stream-json", "--disable-slash-commands", "--print-timeout", "60m"];
  if (settings) args.push("--settings", settings);
  if (t.model.apiModel !== AGENT_CLI_DEFAULT_MODEL) args.push("--model", t.model.apiModel);
  const effort = cliEffortFor(t.model, t.effort);
  if (effort) args.push("--effort", effort);
  if (conversation) args.push("--conversation", conversation);
  if (t.planMode || t.permissionMode === "plan") args.push("--mode", "plan");
  else if (t.permissionMode === "skip" || t.permissionMode === "auto") args.push("--dangerously-skip-permissions");
  else if (t.permissionMode === "acceptEdits") args.push("--mode", "accept-edits");
  return args;
}

export async function streamAntigravityCli(t: AgentCliTurn): Promise<string> {
  const current = t.history[t.history.length - 1];
  if (!current || current.role !== "user") throw new Error("No hay mensaje del usuario para Antigravity CLI");
  const prior = t.history.slice(0, -1);
  let resume: ReturnType<typeof resumePoint> = t.ephemeral ? { since: prior } : resumePoint("antigravity", prior, t.chatKey);

  const out = createTurnOutput(t);
  let conversationId = resume.sessionId ?? "";
  let result: Json | null = null;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  let subagents: ReturnType<typeof createAntigravitySubagents> | null = null;
  const onEvent = (raw: string) => {
    let msg: Json;
    try {
      msg = JSON.parse(raw) as Json;
    } catch {
      return;
    }
    switch (msg.event) {
      case "init":
        if (typeof msg.conversation_id === "string") conversationId = msg.conversation_id;
        break;
      case "step_update": {
        const step = (msg.step_update ?? {}) as Json;
        subagents?.step(step);
        if (typeof step.conversation_id === "string" && step.conversation_id) conversationId = step.conversation_id;
        const type = String(step.step_type ?? "");
        const usage = (step.usage ?? {}) as Json;
        if (typeof usage.output_tokens === "number") t.onUsage?.(usage.output_tokens);
        if (type === "tool" || step.tool_name || step.tool_info) {
          const info = (step.tool_info ?? {}) as Json;
          const name = String(step.tool_name ?? info.name ?? "tool");
          const params = (info.parameters && typeof info.parameters === "object" ? info.parameters : {}) as Json;
          const id = `s${String(step.step_index ?? name)}`;
          const tool = nyxsTool("", name, params);
          if (!out.has(id)) void out.toolStart(id, tool.name, tool.input);
          if (step.state === "DONE") {
            const error = info.error as Json | undefined;
            out.toolEnd(id, !error, error ? String(error.message ?? error.type ?? "Error") : outputText(info.output));
          }
        } else if (typeof step.text_delta === "string") {
          if (/think|reason/i.test(type)) out.reasoning(step.text_delta);
          else if (type === "agent_response" || !type) out.text(step.text_delta);
        }
        break;
      }
      case "result":
        result = (msg.result ?? {}) as Json;
        if (typeof result.conversation_id === "string" && result.conversation_id) conversationId = result.conversation_id;
        finish();
        break;
    }
  };

  // Nyxs' own tools (the built-in browser, questions and plan review): Antigravity reads MCP
  // servers only from its config.
  let served = { browser: false, chatTools: false, video: false };
  if (!t.ephemeral) {
    const allowPreview = (getMergedSnapshot() as { allowPreview?: boolean }).allowPreview !== false;
    served = await syncAntigravityMcp({ browser: allowPreview, chatTools: true, video: !!t.workspace });
  }
  // agy has no system-prompt flag: Nyxs' guide goes before a conversation's first message, and
  // the CLI keeps it in the conversation's context from then on. Built every turn (NYXS.md is
  // cached): a conversation that started with another guide is left for a new one, given the
  // chat so far as text.
  const fullGuide = t.ephemeral ? null : await sessionGuide("antigravity", { ...served, sessions: false, workspace: t.workspace });
  const guidePrint = fullGuide !== null ? guideFingerprint(fullGuide) : undefined;
  if (guideChanged(resume, guidePrint)) resume = { since: prior };
  const guide = fullGuide !== null && !resume.sessionId ? `<nyxs_instructions>\n${fullGuide}\n</nyxs_instructions>\n\n` : "";
  const turn =
    served.chatTools || served.browser
      ? registerChatTurn(t.chatKey, {
          askUser: t.askUser,
          plan: t.planMode || t.permissionMode === "plan" ? (p) => out.plan(p) : undefined,
          conversationId: resume.sessionId,
          gate: t.gate,
        })
      : null;
  const userPermissions = served.browser || served.chatTools ? await invoke<Json | null>("agent_cli_antigravity_permissions").catch(() => null) : null;
  const settings = hostedToolsSettings(served, userPermissions);
  // The servers' entries are global; this tells the proxies agy starts this Nyxs and chat.
  const env = served.browser || served.chatTools ? await antigravityMcpEnv(t.chatKey) : undefined;
  const prompt = promptText(current, guide + priorContext(resume.since, PRIOR_CONTEXT_CHAR_BUDGET));
  let proc: Awaited<ReturnType<typeof startCliProcess>>;
  try {
    proc = await startCliProcess(
      "antigravity",
      runArgs(t, resume.sessionId, settings),
      t.workspace,
      (line) => {
        onEvent(line);
        if (conversationId) turn?.update({ conversationId });
      },
      env,
    );
    subagents = createAntigravitySubagents({ runId: proc.runId, stopTurn: () => abortChatTurn(t.chatKey) });
    await proc.send(prompt);
  } catch (err) {
    turn?.release();
    throw err;
  }
  proc.closeInput();
  let exitCode: number | null = null;
  void proc.exited.then((code) => {
    exitCode = code;
    finish();
  });

  const onAbort = () => {
    proc.kill();
    finish();
  };
  if (t.signal?.aborted) onAbort();
  else t.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await done;
  } finally {
    t.signal?.removeEventListener("abort", onAbort);
    turn?.release();
    void subagents?.end(!t.signal?.aborted && String((result as Json | null)?.status ?? "") === "SUCCESS");
  }

  const final = result as Json | null;
  const status = String(final?.status ?? "");
  const failed = !final || (!!status && status !== "SUCCESS");
  // The conversation got the message; the chat keeps no reply of it.
  if ((t.signal?.aborted || failed) && conversationId && !t.ephemeral) sessionLeftBehind("antigravity", conversationId, t.chatKey);
  if (t.signal?.aborted) {
    out.endOpenTools(false);
    throw new DOMException("Aborted", "AbortError");
  }
  if (failed || !final) {
    out.endOpenTools(false);
    proc.kill();
    // Its own error, else how its stderr ends: never the reply, which is the model's words.
    const reported = outputText(final?.error).trim() || cliFailureText("", proc.stderrTail, true);
    if (isAgentCliAuthFailure(reported)) {
      throw new AgentCliAuthError("Antigravity CLI no tiene una sesión iniciada. Ábrelo una vez en una terminal («agy») para iniciar sesión.");
    }
    if (resume.sessionId && /conversation.*(not found|unknown|invalid)/i.test(reported)) {
      // The CLI no longer has this conversation: start a new one with the chat so far.
      return out.full + (await streamAntigravityCli({ ...t, ephemeral: false, history: t.history.map(stripSession) }));
    }
    const said = outputText(final?.error).trim() || proc.stderrTail.slice(-5).join("\n").trim();
    if (!final) throw new Error(`Antigravity CLI terminó sin respuesta (código ${exitCode ?? "?"})${said ? `: ${said}` : ""}`);
    throw new Error(`Antigravity CLI falló (${status})${said ? `: ${said}` : ""}`);
  }
  out.endOpenTools(true);

  if (!out.reply.trim() && typeof final.response === "string") out.text(final.response);
  const usage = (final.usage ?? {}) as Record<string, number | undefined>;
  if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
    const read = usage.cache_read_tokens ?? 0;
    t.onContext?.(usage.input_tokens ?? 0);
    t.onCacheStats?.({
      readTokens: read,
      creationTokens: 0,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0),
    });
  }
  // A continued conversation keeps the guide it started with (unknown for an older one).
  if (conversationId && !t.ephemeral) {
    t.onMessages?.([sessionMessage("antigravity", conversationId, out.reply.trim(), resume.sessionId ? resume.guide : guidePrint, t.chatKey)]);
  }
  return out.full;
}

/** A turn without the CLI session its replies carry, so the next run starts a new one. */
function stripSession<T extends { messages?: unknown[] }>(turn: T): T {
  return turn.messages ? { ...turn, messages: undefined } : turn;
}

import { invoke } from "@/lib/ipc";
import type { ModelMessage } from "ai";
import { endAcpChat } from "./acpProcesses";
import { BROWSER_MCP_SERVER } from "./browserTools";
import { CLI_VIDEO_PROMPT, VIDEO_MCP_SERVER } from "./videoTools";
import { CLI_SESSIONS_PROMPT as CLAUDE_SESSIONS_PROMPT, SESSIONS_MCP_SERVER } from "./sessionTools";
import { mcpNamer, projectPromptFor } from "./projects/projectPrompt";
import { getMergedSnapshot, settingsFor } from "./settingsRuntime";
import { computerUseEnabled, musicToolEnabled } from "./featureSettings";
import { COMPUTER_MCP_SERVER } from "@/tools/Computer/actions";
import { MUSIC_MCP_SERVER } from "@/tools/Music/tool";
import { connectorsPrompt, hostedConnectors, lendConnectorAsk } from "./connectorsMcp";
import { priceForModel, costFromPrice } from "./pricing";
import { VISUAL_PREVIEW_PROMPT } from "./prompts/visualPreview";
import { PR_CREATED_PROMPT } from "./prCreatedTag";
import { projectInstructionsSection } from "./systemPrompt";
import { cachedNyxsMemory } from "./preflight";
import { effortFor } from "./claudeCodeModels";
import { runningClaudeCodeTasks } from "./claudeCodeTasks";
import {
  AUTONOMOUS_WAIT_MS,
  controlRequest,
  forget,
  live,
  park,
  persistRuns,
  retire,
  sendTo,
  spawnLive,
  type AttemptOutcome,
  type Json,
  type LiveProcess,
  type TurnSink,
} from "./claudeCodeProcesses";
import { SESSION_OPTION_KEY, isAuthFailure, priorContext, resumePointOf, userContent } from "./claudeCodeText";
import { fetchClaudeCodeContext, type ContextBreakdown } from "./claudeCodeUsage";
import { forgetSessionHead, sessionMovedOn, setSessionHead } from "./claudeCodeHeads";
import { claudeCodeSessionOf } from "./claudeCodeUsage";
import { endClaudeCodeChat } from "./claudeCodeProcesses";
import { envForSession } from "./environments";
import {
  deliverInbox,
  emit,
  handleMessage,
  hurryInbox,
  newTurnState,
  setCompacting,
  setRetrying,
  type ClaudeCodeTurn,
  type StreamTurn,
} from "./claudeCodeStream";

// One Claude Code turn from the chat's point of view. The rest of the integration lives in
// claudeCodeModels (models, effort), claudeCodeUsage (context, plan limits), claudeCodeCli
// (install, updates, login), claudeCodeProcesses (the live CLI processes) and claudeCodeText
// (pure message helpers); this module re-exports their public API so callers import one place.
export {
  CLAUDE_CODE_CONNECTED,
  CLAUDE_CODE_DEFAULT_ENABLED,
  CLAUDE_CODE_MODELS,
  claudeCodeDefaultEffort,
  claudeCodeEffectiveEffort,
  claudeCodeEffortLevels,
  effortFor,
  fetchClaudeCodeModels,
} from "./claudeCodeModels";
export {
  cachedClaudePlanUsage,
  claudePlanRefusal,
  claudePlanRefused,
  onClaudePlanRefusal,
  onClaudePlanUsage,
  claudeCodeSessionOf,
  contextCategoryId,
  fetchClaudeCodeBaseline,
  fetchClaudeCodeContext,
  fetchClaudeCodeSessionContext,
  fetchClaudePlanUsage,
  type ContextBreakdown,
  type ContextCategory,
  type ContextChild,
  type PlanLimit,
  type PlanRefusal,
  type PlanUsage,
} from "./claudeCodeUsage";
export {
  autoUpdateClaudeCode,
  claudeCodeAccount,
  claudeCodeAccountLabel,
  claudeCodeNeedsUpdate,
  fetchClaudeCodeLatestVersion,
  getClaudeCodeStatus,
  keepClaudeLoginFresh,
  onClaudeCodeUpdated,
  openClaudeCodeTerminal,
  startClaudeCodeMaintenance,
  updateClaudeCode,
  type ClaudeCodeStatus,
} from "./claudeCodeCli";
import { remoteHostOf } from "./remote";
import { ensureRemoteClaude, ensureRemoteClaudeUnattended, forgetRemoteClaude } from "./remoteClaude";
export {
  onClaudeCodeUnattendedPermission,
  onClaudeCodeWake,
  reattachClaudeCodeRuns,
  stopClaudeCodeTask,
} from "./claudeCodeProcesses";

/**
 * A chat was cleared (/clear) or deleted: its Claude Code process ends now rather than after its
 * idle timeout, and its session is forgotten, so nothing resumes it. `replies` are the chat's
 * replies before it changed, which name its session. Other chats' processes stay, and one in the
 * middle of a turn ends when the turn does. The same goes for the chat's kept-alive ACP agent
 * (Grok), whose process is per chat too.
 */
export function closeClaudeCodeChat(chatKey: string, replies: (ModelMessage[] | undefined)[]): void {
  const sessionId = claudeCodeSessionOf(replies);
  const ended = endClaudeCodeChat(chatKey, sessionId);
  for (const id of new Set([...ended, ...(sessionId ? [sessionId] : [])])) forgetSessionHead(id, chatKey);
  endAcpChat(chatKey);
}

/** A remote machine's Claude Code is ready before a process starts there. Background helpers
 *  (titles, suggestions) never install anything or ask to sign in. */
async function readyRemoteMachine(t: ClaudeCodeTurn): Promise<void> {
  const host = remoteHostOf(t.workspace);
  if (!host || t.ephemeral) return;
  if (!t.onRemoteSetup) {
    if (!(await ensureRemoteClaudeUnattended(host))) throw new ClaudeCodeAuthError(`Claude Code no tiene una sesión iniciada en ${host}`);
    return;
  }
  t.onRemoteSetup(host);
  try {
    await ensureRemoteClaude(host, t.signal);
  } finally {
    t.onRemoteSetup?.(null);
  }
}

export class ClaudeCodeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeAuthError";
  }
}

export type { ClaudeCodeTurn } from "./claudeCodeStream";

const INTERRUPT_GRACE_MS = 4000;
/** The head of a session whose last turn left nothing in the chat: no reply's message is it. */
const STOPPED_HEAD = "stopped";

/** Runs one turn on `proc`: sends `content` as the user's message, or, when it is null, takes
 *  over the turn Claude Code already started on its own (see onUnattended). */
async function runTurn(t: ClaudeCodeTurn, proc: LiveProcess, content: Json[] | null, resume: string | undefined): Promise<AttemptOutcome> {
  const c: StreamTurn = {
    t,
    proc,
    workspace: t.workspace || undefined,
    // A turn taken over from Claude Code has no prompt of ours to come back.
    s: newTurnState(proc.sessionId, !content),
    finish: () => undefined,
  };
  const st = c.s;
  const done = new Promise<void>((resolve) => {
    c.finish = resolve;
  });
  const handle = (msg: Json) => handleMessage(c, msg);

  if (proc.autonomous && content) {
    // "Stop" ends the wait too: its listener below only goes on once the message is sent.
    let waited: ReturnType<typeof setTimeout> | undefined;
    let onStop = () => {};
    await Promise.race([
      proc.autonomous.done,
      new Promise((r) => (waited = setTimeout(r, AUTONOMOUS_WAIT_MS))),
      new Promise<void>((r) => {
        onStop = r;
        if (t.signal?.aborted) r();
        else t.signal?.addEventListener("abort", onStop, { once: true });
      }),
    ]);
    clearTimeout(waited);
    t.signal?.removeEventListener("abort", onStop);
    if (t.signal?.aborted) {
      // Never sent: the process goes back to its own turn, for this chat's next message.
      park(proc);
      throw new DOMException("Aborted", "AbortError");
    }
  }

  const sink: TurnSink = {
    line: handle,
    exit: (code) => {
      st.exitCode = code;
      c.finish();
    },
  };
  if (content) {
    proc.sink = sink;
  } else {
    // Taken over in the message queue, so what waited in the backlog is handled first and in order.
    proc.queue = proc.queue.then(async () => {
      if (proc.backlogTimer) clearTimeout(proc.backlogTimer);
      proc.backlogTimer = null;
      const waiting = proc.backlog ?? [];
      proc.backlog = null;
      proc.sink = sink;
      for (const m of waiting) await handle(m);
      if (proc.exited) c.finish();
    });
  }

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  // A connector's confirmations (Google's "Allow once") are asked in this chat while it runs.
  const releaseOnEnd: (undefined | (() => void))[] = [lendConnectorAsk(t.chatKey, t.askUser)];
  const onAbort = () => {
    st.stopping = true;
    void sendTo(proc, { type: "control_request", request_id: `${proc.runId}-interrupt-${Date.now()}`, request: { subtype: "interrupt" } });
    killTimer = setTimeout(() => void invoke("claude_code_kill", { runId: proc.runId }).catch(() => undefined), INTERRUPT_GRACE_MS);
  };

  try {
    if (proc.exited) {
      forgetRemoteClaude(remoteHostOf(t.workspace));
      const tail = proc.stderrTail.slice(-5).join("\n").trim();
      throw new Error(`Claude Code terminó antes de recibir el mensaje${tail ? `: ${tail}` : ""}`);
    }
    if (content) await sendTo(proc, { type: "user", session_id: "", message: { role: "user", content }, parent_tool_use_id: null });
    if (t.signal?.aborted) onAbort();
    else t.signal?.addEventListener("abort", onAbort, { once: true });
    deliverInbox(c);
    releaseOnEnd.push(t.inbox?.onArrive(() => deliverInbox(c)), t.inbox?.onHurry(() => hurryInbox(c)));
    await done;
  } finally {
    setCompacting(c, false);
    setRetrying(c, null);
    for (const off of releaseOnEnd) off?.();
    if (st.settleTimer) clearTimeout(st.settleTimer);
    t.signal?.removeEventListener("abort", onAbort);
    if (killTimer) clearTimeout(killTimer);
    proc.sink = null;
    if (st.sessionId) proc.sessionId = st.sessionId;
    if (!content) {
      proc.autonomous?.resolve();
      proc.autonomous = null;
    }
  }

  const finalResult = st.result;
  const failed = !finalResult || finalResult.is_error || st.apiError;
  if (t.ephemeral || (failed && !t.signal?.aborted)) retire(proc);
  else park(proc);

  // The session took the message although the chat keeps no reply for it: the head moves off
  // the chat's last reply, so the next turn cuts the session back there and sends what was
  // lost as text, instead of carrying the stopped message on and then getting it again.
  if ((failed || t.signal?.aborted) && content && st.sessionId && t.onMessages && !t.ephemeral) {
    setSessionHead(st.sessionId, { at: st.lastEntry ?? STOPPED_HEAD, chatKey: t.chatKey });
  }

  if (t.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  if (!finalResult || finalResult.is_error || st.apiError) {
    const reported = [finalResult?.result ?? "", st.apiErrorText].join("\n");
    // Whatever made it fail, the machine's next turn looks at its Claude Code again.
    if (!finalResult || isAuthFailure(reported, st.apiError)) forgetRemoteClaude(remoteHostOf(t.workspace));
    if (resume && RESUME_MISSING_RE.test(`${reported}\n${proc.stderrTail.join("\n")}`)) {
      return { output: st.full, resumeMissing: true };
    }
    if (isAuthFailure(reported, st.apiError)) {
      throw new ClaudeCodeAuthError(st.apiErrorText || "Claude Code no tiene una sesión iniciada");
    }
    if (!finalResult) {
      const tail = proc.stderrTail.slice(-5).join("\n").trim();
      throw new Error(`Claude Code terminó sin respuesta (código ${st.exitCode ?? "?"})${tail ? `: ${tail}` : ""}`);
    }
    throw new Error(st.apiErrorText || finalResult.result || `Claude Code falló (${finalResult.subtype ?? "error"})`);
  }

  if (!st.assistantText.trim() && finalResult.result) emit(c, finalResult.result);

  const usage = finalResult.usage ?? {};
  const read = usage.cache_read_input_tokens ?? 0;
  const created = usage.cache_creation_input_tokens ?? 0;
  const turnInput = (usage.input_tokens ?? 0) + read + created;
  const turnOutput = usage.output_tokens ?? st.outputTokens;
  // What the turn would cost at Anthropic's API prices: an estimate (a subscription pays a
  // flat fee), priced by the real model since the chat's id is only an alias like "opus".
  const price = priceForModel("anthropic", st.servedModel || t.model.apiModel);
  const costUsd = price
    ? costFromPrice(price, { inputTokens: turnInput, outputTokens: turnOutput, cacheReadTokens: read, cacheWriteTokens: created })
    : 0;
  t.onCacheStats?.({
    readTokens: read,
    creationTokens: created,
    inputTokens: turnInput,
    outputTokens: turnOutput,
    costUsd: costUsd || undefined,
  });

  if (st.sessionId && !t.ephemeral && t.onMessages) {
    t.onMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: st.assistantText.trim() || finalResult.result || "" }],
        providerOptions: { [SESSION_OPTION_KEY]: { sessionId: st.sessionId, ...(st.lastEntry ? { at: st.lastEntry } : {}) } },
      },
    ]);
    // Only replies the chat keeps move the head: /compact has none, so the next turn still
    // resumes the compacted session instead of cutting back to before it.
    if (st.lastEntry) setSessionHead(st.sessionId, { at: st.lastEntry, chatKey: t.chatKey });
  }

  return { output: st.full, resumeMissing: false };
}

/** Claude Code couldn't resume where it was asked: the session, or the message to cut it at, is gone. */
const RESUME_MISSING_RE = /no conversation found|no message found with message\.uuid/i;

export async function streamClaudeCode(t: ClaudeCodeTurn): Promise<string> {
  if (t.attachSession) {
    const proc = live.get(t.attachSession);
    if (!proc || proc.exited || proc.sink || !proc.backlog) return "";
    forget(proc);
    return (await runTurn(t, proc, null, t.attachSession)).output;
  }
  const current = t.history[t.history.length - 1];
  if (!current || current.role !== "user") throw new Error("No hay mensaje del usuario para Claude Code");
  const prior = t.history.slice(0, -1);

  let resumeIndex = -1;
  let resume: string | undefined;
  let resumeAt: string | undefined;
  for (let i = prior.length - 1; i >= 0; i--) {
    const point = resumePointOf(prior[i]);
    if (point) {
      resumeIndex = i;
      resume = point.sessionId;
      resumeAt = point.at;
      break;
    }
  }
  // `--resume` alone goes on from the session's newest turn. When the chat no longer ends
  // there (a message edited, deleted or retried, or the chat forked), the session is cut at
  // this reply into a new one; a reply without its message uuid can't be cut, so the chat
  // starts a new session with what it shows.
  let cut = false;
  if (resume && !t.ephemeral && sessionMovedOn(resume, resumeAt, t.chatKey)) {
    cut = !!resumeAt;
    if (!cut) {
      resume = undefined;
      resumeIndex = -1;
    }
  }

  const proc = await acquireProcess(t, resume, cut ? resumeAt : undefined);
  const first = await runTurn(t, proc, userContent(current, priorContext(prior.slice(resumeIndex + 1))), resume);
  if (!first.resumeMissing) return first.output;
  const retry = await runTurn(t, await acquireProcess(t, undefined), userContent(current, priorContext(prior)), undefined);
  return first.output + retry.output;
}

/** The session's live process when it runs with this turn's settings; otherwise a new one resuming
 *  it. With `resumeAt`, always a new one, forking the session at that message: the live process
 *  stays with the history it has, which another chat may still be using. */
async function acquireProcess(t: ClaudeCodeTurn, resumeId: string | undefined, resumeAt?: string): Promise<LiveProcess> {
  const workspace = t.workspace || undefined;
  const permissionMode = t.planMode ? "plan" : null;
  const effort = effortFor(t.model, t.effort);
  const noTools = !workspace;
  const ephemeral = Boolean(t.ephemeral);
  // The settings of the chat's own folder, which may not be the one open in the app (a session
  // woken in the background).
  const folder = await settingsFor(workspace).catch(() => null);
  const settings = folder?.merged ?? getMergedSnapshot();
  // The CLI loads the folder's .claude/settings*.json and .mcp.json by itself (hooks, env, allow
  // rules, MCP servers): until the user trusts the folder, or when that can't be told, it runs
  // with the user's own settings only.
  const untrustedProject = !!workspace && folder?.projectTrusted !== true;
  // The built-in browser, under the same setting as for the other models.
  const allowPreview = (settings as { allowPreview?: boolean }).allowPreview !== false;
  // The user's sessions too, as Claude Code Desktop has them: without them, Claude answered "create
  // a new session" with one of its own sub-agents, which the user never sees in Recents.
  const sessions = !noTools && !ephemeral && !!t.chatKey;
  // The desktop (Computer tool), under its setting, as for the other models.
  const computer = !noTools && !ephemeral && computerUseEnabled();
  // The video editor, as the built-in models have it.
  const video = !noTools && !ephemeral && (settings as { allowVideoTools?: boolean }).allowVideoTools !== false;
  const hostedMcp = [
    ...(!noTools && allowPreview ? [BROWSER_MCP_SERVER] : []),
    ...(sessions ? [SESSIONS_MCP_SERVER] : []),
    ...(computer ? [COMPUTER_MCP_SERVER] : []),
    ...(video ? [VIDEO_MCP_SERVER] : []),
    // A chat without a folder can ask for music too; background helpers can't.
    ...(!ephemeral && musicToolEnabled() ? [MUSIC_MCP_SERVER] : []),
  ];
  // The connectors the user signed in to in Nyxs (Gmail, Calendar…), which the CLI can't see.
  const nyxsConnectors = noTools || ephemeral ? [] : [...hostedConnectors(hostedMcp).keys()];
  hostedMcp.push(...nyxsConnectors);
  // Background helpers (titles, suggestions) don't answer the user, so they don't draw previews.
  // Claude Code loads CLAUDE.md and AGENTS.md itself, but not NYXS.md, so that goes in here too.
  const appendSystemPrompt = ephemeral
    ? null
    : appendPromptFor(
        [VISUAL_PREVIEW_PROMPT, ...(sessions ? [CLAUDE_SESSIONS_PROMPT, projectPromptFor(t.chatKey, mcpNamer(`mcp__${SESSIONS_MCP_SERVER}__`))].filter(Boolean) : []), ...(video ? [CLI_VIDEO_PROMPT] : []), ...(nyxsConnectors.length ? [connectorsPrompt(nyxsConnectors)] : []), ...(noTools ? [] : [PR_CREATED_PROMPT])].join("\n\n"),
        workspace ? await cachedNyxsMemory(workspace).catch(() => "") : "",
      );
  // A session started from a saved environment runs Claude Code with its variables; changing
  // them starts a fresh process (resuming the session) instead of reusing the old one.
  const sessionEnv = ephemeral ? undefined : await envForSession(t.chatKey).catch(() => undefined);
  // The connectors of the user's claude.ai account load into every run otherwise, their tool
  // list and instructions with them; --strict-mcp-config doesn't reach them.
  const connectors = (settings as { claudeAiConnectors?: boolean }).claudeAiConnectors === true;
  // The chat box's guess of the next message; background helpers have no chat box.
  const promptSuggestions = !ephemeral && (settings as { promptSuggestions?: boolean }).promptSuggestions !== false;
  // The user's hooks (~/.claude/settings.json) run inside Nyxs' sessions too; this lets one tell
  // and step aside: `[ -n "$NYXS_CLAUDE_CODE" ] && exit 0`.
  const env = { NYXS_CLAUDE_CODE: "1", ...(connectors ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: "false" }), ...sessionEnv };
  // The prompt goes in as a fingerprint: an edited NYXS.md starts a fresh process on the next turn.
  // So do the variables: `config` is kept in sessionStorage to find the process after a reload,
  // and a saved environment's values are often keys.
  // Trusting the folder, or its config changing, starts a fresh process the same way.
  const config = JSON.stringify([workspace ?? "", t.model.apiModel, permissionMode, effort, noTools, hostedMcp, appendSystemPrompt && fingerprint(appendSystemPrompt), envFingerprint(env), t.maxTurns ?? null, untrustedProject, promptSuggestions]);

  const existing = resumeId && !ephemeral && !resumeAt ? live.get(resumeId) : undefined;
  // Closing a process ends the background commands it runs. One running some takes the new
  // model, mode and effort in place when those are all that changed.
  const busy = !!existing && !existing.exited && !existing.sink && runningClaudeCodeTasks(existing.runId) > 0;
  if (busy && existing.config !== config && (await switchInPlace(existing, config, { model: t.model.apiModel, permissionMode, effort }))) {
    existing.config = config;
    persistRuns();
  }
  let proc: LiveProcess;
  if (existing && !existing.exited && !existing.sink && existing.config === config) {
    forget(existing);
    proc = existing;
  } else {
    // One that couldn't switch is left to finish its tasks; its idle timer lets it go after.
    if (existing && !existing.sink && !busy) retire(existing);
    await readyRemoteMachine(t);
    proc = await spawnLive({ config, cwd: workspace, model: t.model.apiModel, resume: resumeId, resumeAt, permissionMode, effort, noTools, ephemeral, hostedMcp, appendSystemPrompt, env, maxTurns: t.maxTurns, untrustedProject, promptSuggestions });
  }
  if (t.chatKey && proc.chatKey !== t.chatKey) {
    proc.chatKey = t.chatKey;
    persistRuns();
  }
  return proc;
}

/** `config`'s fields Claude Code can change on a running process, by their place in it. */
const SWITCHABLE = [1, 2, 3];

/**
 * Changes a live process's model, permission mode and effort with Claude Code's own control
 * requests (set_model, set_permission_mode, apply_flag_settings: 2.1.322 has them), when nothing
 * else of its config differs. False when something else did or the CLI turned one down.
 * Without `--permission-mode` a process runs in the user's default mode, which Nyxs doesn't
 * know: leaving plan mode goes to "default", which asks before more, never less.
 */
async function switchInPlace(proc: LiveProcess, config: string, to: { model: string; permissionMode: string | null; effort: string | null }): Promise<boolean> {
  let from: unknown[];
  let next: unknown[];
  try {
    from = JSON.parse(proc.config) as unknown[];
    next = JSON.parse(config) as unknown[];
  } catch {
    return false;
  }
  const rest = (c: unknown[]) => JSON.stringify(c.filter((_, i) => !SWITCHABLE.includes(i)));
  if (from.length !== next.length || rest(from) !== rest(next)) return false;
  const requests: Json[] = [];
  if (from[1] !== next[1]) requests.push({ subtype: "set_model", model: to.model });
  if (from[2] !== next[2]) requests.push({ subtype: "set_permission_mode", mode: to.permissionMode ?? "default" });
  if (from[3] !== next[3]) requests.push({ subtype: "apply_flag_settings", settings: { effortLevel: to.effort } });
  for (const request of requests) {
    const response = await controlRequest(proc, request);
    if (response?.subtype !== "success") return false;
  }
  return true;
}

// args.rs drops an appended prompt longer than this (MAX_APPEND_PROMPT), so NYXS.md gets what's left.
const APPEND_PROMPT_LIMIT = 16 * 1024;
const PROJECT_CUT_NOTE =
  "\n\n[The project instructions stop here: the rest didn't fit. Read NYXS.md, NYXS.local.md and .nyxs/rules/ in the project for all of them.]";

/** Nyxs' prompt for Claude Code with the project's instructions after it, cut at a line when they don't fit. */
export function appendPromptFor(fixed: string, memory: string): string {
  if (!memory.trim()) return fixed;
  const utf8 = new TextEncoder();
  const head = `${fixed}\n\n`;
  const section = utf8.encode(projectInstructionsSection(memory));
  const room = APPEND_PROMPT_LIMIT - utf8.encode(head).length;
  if (section.length <= room) return head + new TextDecoder().decode(section);
  const budget = room - utf8.encode(PROJECT_CUT_NOTE).length;
  if (budget <= 0) return fixed;
  const cut = new TextDecoder().decode(section.subarray(0, budget));
  const line = cut.lastIndexOf("\n");
  return head + (line > 0 ? cut.slice(0, line) : cut.replace(/�$/, "")).trimEnd() + PROJECT_CUT_NOTE;
}

/** A stand-in for a process's environment that tells a changed one apart without keeping its
 *  values. */
function envFingerprint(env: Record<string, string>): string {
  return fingerprint(JSON.stringify(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** A short stand-in for a long text (FNV-1a). */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

const COMPACT_TIMEOUT_MS = 10 * 60_000;

/**
 * Compacts a chat's Claude Code session with Claude Code's own /compact. The CLI keeps
 * the conversation and every turn resumes it, so a summary kept on Nyxs' side would never
 * shrink what the model sees. Returns the context the session holds afterwards.
 */
export async function compactClaudeCodeSession(
  o: Pick<ClaudeCodeTurn, "model" | "workspace" | "planMode" | "effort" | "signal" | "chatKey">,
  sessionId: string,
): Promise<ContextBreakdown | null> {
  const timeout = AbortSignal.timeout(COMPACT_TIMEOUT_MS);
  const t: ClaudeCodeTurn = {
    ...o,
    history: [],
    onChunk: () => undefined,
    signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
  };
  const proc = await acquireProcess(t, sessionId);
  const outcome = await runTurn(t, proc, [{ type: "text", text: "/compact" }], sessionId);
  if (outcome.resumeMissing) throw new Error("Claude Code ya no tiene esta sesión, así que no hay nada que compactar.");
  return fetchClaudeCodeContext(proc.sessionId ?? sessionId);
}

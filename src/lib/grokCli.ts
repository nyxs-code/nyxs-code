import { startCliProcess, cliEffortFor, AGENT_CLI_DEFAULT_MODEL, type AgentCliTurn } from "./agentCli";
import { initializeParams, Rpc, streamAcpAgent, STARTUP_TIMEOUT_MS, toolOf, type AcpContext, type AcpSpec, type Json } from "./acpAgent";
import { createGrokSubagents } from "./grokSubagents";
import type { ModelInfo } from "./models";

/**
 * Grok CLI over the Agent Client Protocol (`grok agent stdio`); the protocol itself is in
 * acpAgent.ts.
 */

/** `grok agent [-m <model>] [--reasoning-effort <level>] stdio`: the agent's options go before
 *  `stdio`. The CLI fails a turn at a level the model lacks rather than rounding, so the level
 *  is the closest one the model offers. */
function agentArgs(t: AgentCliTurn): string[] {
  const args = ["agent"];
  if (t.model.apiModel !== AGENT_CLI_DEFAULT_MODEL) args.push("-m", t.model.apiModel);
  const effort = cliEffortFor(t.model, t.effort);
  if (effort) args.push("--reasoning-effort", effort);
  args.push("stdio");
  return args;
}

/** How long until the next try, when Grok says: a field of its own if a version adds one, else
 *  "retry after 30s" / "try again in 2 minutes" in the error it quotes (1.x sends neither, but
 *  the API's message sometimes carries it). */
export function retryWaitMs(update: Json): number | undefined {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const ms = num(update.retry_after_ms) ?? num(update.delay_ms);
  if (ms) return ms;
  const secs = num(update.retry_after_secs) ?? num(update.retry_after);
  if (secs) return secs * 1000;
  const m = /(?:retry|try again)\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i.exec(String(update.reason ?? ""));
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return Math.round(unit.startsWith("ms") || unit.startsWith("milli") ? n : unit.startsWith("m") ? n * 60_000 : n * 1000) || undefined;
}

/** Grok's own updates (`_x.ai/session/update`, a `retry_state` among them): a request it will
 *  send again shows as Claude Code's do; giving up ("exhausted", "failed") ends the wait, and
 *  the turn's error says why. */
function grokNotification(ctx: AcpContext, method: string, params: Json): void {
  if (!method.startsWith("_x.ai/")) return;
  const update = (params.update ?? {}) as Json;
  if (update.sessionUpdate !== "retry_state") return;
  if (update.type !== "retrying") {
    ctx.out.retrying(null);
    return;
  }
  const rateLimited = update.error_type === "rate_limited" || update.is_rate_limited === true || /\b429\b/.test(String(update.reason ?? ""));
  const waitMs = retryWaitMs(update);
  ctx.out.retrying({ rateLimited, ...(waitMs ? { waitMs } : {}) });
}

export const GROK_ACP: AcpSpec = {
  cli: "grok",
  label: "Grok CLI",
  args: agentArgs,
  authMethods: ["cached_token"],
  loginHint: "Inicia sesión con «grok login».",
  guide: "grok",
  chatTools: true,
  notification: grokNotification,
  subagents: (ctx, runId) =>
    createGrokSubagents({
      runId,
      toolOf,
      cancel: (subagentId) => ctx.rpc.request("_x.ai/subagent/cancel", { sessionId: ctx.sessionId(), subagentId }),
    }),
  // Starting it and reloading its session took ≈4 s a turn.
  keepAlive: true,
};

export function streamGrokCli(t: AgentCliTurn): Promise<string> {
  return streamAcpAgent(GROK_ACP, t);
}

/**
 * Grok's models as its agent reports them on `initialize` (no session needed): name, context
 * window and the reasoning levels each one takes. Empty when it can't be read.
 */
export async function fetchGrokModels(): Promise<ModelInfo[]> {
  const rpc = new Rpc("Grok CLI");
  const proc = await startCliProcess("grok", ["agent", "stdio"], null, (line) => rpc.line(line));
  rpc.proc = proc;
  void proc.exited.then(() => rpc.fail(new Error("Grok CLI terminó")));
  try {
    const init = await rpc.request("initialize", await initializeParams(), STARTUP_TIMEOUT_MS);
    const state = (((init._meta ?? {}) as Json).modelState ?? {}) as Json;
    const models = (Array.isArray(state.availableModels) ? state.availableModels : []) as Json[];
    return models
      .filter((m) => typeof m.modelId === "string" && m.modelId)
      .map((m) => {
        const meta = (m._meta ?? {}) as Json;
        const efforts = Array.isArray(meta.reasoningEfforts) ? (meta.reasoningEfforts as Json[]) : [];
        const context = typeof meta.totalContextTokens === "number" ? meta.totalContextTokens : undefined;
        return {
          id: `grok-cli:${String(m.modelId)}`,
          apiModel: String(m.modelId),
          name: typeof m.name === "string" && m.name ? m.name : String(m.modelId),
          description: "Grok CLI",
          provider: "grok-cli" as const,
          contextWindow: context,
          effortLevels: meta.supportsReasoningEffort === false ? [] : efforts.map((e) => String(e.value ?? e.id)),
        };
      });
  } catch {
    return [];
  } finally {
    proc.closeInput();
    proc.kill();
  }
}

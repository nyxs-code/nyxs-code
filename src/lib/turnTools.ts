import { tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { gateToolSet, sortToolSet, type AskUserFn, type ContentExtractor, type PermissionGate, type SubagentRunner } from "./agentTools";
import { callModel } from "./callModel";
import type { ToolAccessMode } from "./configSchema";
import { DoomLoopGuard, loopStoppedMessage, type LoopDecision } from "./doomLoop";
import { emitEvent } from "./events";
import { askMcpApproval, withMcpApproval } from "./mcpElicitation";
import { getLanguage, getTranslations } from "./i18n";
import { anthropicTools, pickHelperModel } from "./modelClient";
import type { ModelInfo } from "./models";
import type { AgentRunner } from "./orchestrator";
import type { RunnerDeps } from "./orchestratorRunner";
import { supportsNativeToolSearch } from "./promptPrefix";
import { nativeToolSearchUnsupported } from "./providerFetch";
import { classifyFailure, formatRecoveryHint } from "./recovery";
import type { Settings } from "./settings";
import { collectText } from "./turnStream";
import { DEFER_LOCAL_TOOLS, EXTRACT_SYSTEM } from "./turnSupport";
import { buildWorkflowTool } from "./workflowTool";
import { getToolSearchDescription, rankDeferredTools, DEFER_THRESHOLD, type DeferredToolInfo } from "../tools/ToolSearch/prompt";

/** Reads long content (a fetched page) with a small helper model and returns only what was asked. */
export function createExtractor(o: {
  model: ModelInfo;
  languageModel: LanguageModel;
  settings: Settings;
  buildModel: (model: ModelInfo, settings: Settings) => LanguageModel;
  helperModelId?: string;
  signal?: AbortSignal;
}): ContentExtractor {
  const helperModel = pickHelperModel(o.model, o.settings, o.helperModelId);
  return async (request, content, extractSignal) => {
    const lm = helperModel.id === o.model.id ? o.languageModel : o.buildModel(helperModel, o.settings);
    const res = callModel({
      model: lm,
      system: EXTRACT_SYSTEM,
      messages: [{ role: "user", content: `<page>\n${content}\n</page>\n\nRequest: ${request}` }],
      maxOutputTokens: 2000,
      maxRetries: 2,
      abortSignal: extractSignal ?? o.signal,
    });
    return collectText(res.fullStream);
  };
}

/** Gates the MCP tools that loaded and reports the servers that didn't. A server's own
 *  confirmations (Gmail's "Allow once") are asked with the chat's question card. */
export function connectMcpTools(
  loaded: { tools: ToolSet; errors: string[] },
  gate: PermissionGate | undefined,
  warn: (text: string) => void,
  askUser?: AskUserFn,
): ToolSet {
  const { tools, errors } = loaded;
  for (const server of new Set(Object.keys(tools).map((k) => k.split("__")[1]).filter(Boolean))) {
    emitEvent({ type: "mcp.connected", server });
  }
  for (const err of errors) {
    emitEvent({ type: "mcp.server_failed", server: String(err) });
    const finding = classifyFailure(String(err));
    const hint = finding ? ` — ${formatRecoveryHint(finding)}` : "";
    warn(`\n\n> ⚠️ MCP — couldn't connect to ${err}${hint}\n\n`);
  }
  return gateToolSet(withMcpApproval(tools, askUser ? askMcpApproval(askUser) : undefined), gate);
}

/** The Workflow tool, whose agents run as this turn's sub-agents without showing in its sub-agent
 *  list; its run shows in the Workflow view of `chatId`. */
export function createWorkflowTool(runSubagent: SubagentRunner, deps: RunnerDeps, maxAgents: number, signal?: AbortSignal, chatId?: string) {
  const runner: AgentRunner = (prompt, opts) =>
    runSubagent({
      description: opts.subagentType ?? "review",
      prompt,
      subagentType: opts.subagentType ?? "Explore",
      model: opts.model,
      signal: opts.signal,
      onUsage: opts.onUsage,
      onActivity: opts.onActivity,
      reflect: false,
    });
  return buildWorkflowTool(deps, maxAgents, signal, runner, chatId);
}

export interface ToolDeferral {
  deferredNames: Set<string>;
  /** Tools the model may call now; ToolSearch adds to it. */
  activeToolNames: Set<string>;
  /** Our own ToolSearch is in use, so every call must pass `activeTools`. */
  deferActive: boolean;
}

/**
 * Hides rarely used tools behind ToolSearch so their schemas stay out of the
 * prompt. Uses Anthropic's native tool search when the model supports it.
 * Adds ToolSearch to `tools`. With `toolAccessMode` "preloaded", connector
 * (MCP) tools are always sent in full; rarely used local tools stay deferred.
 */
export function deferTools(
  tools: ToolSet,
  mcpToolNames: string[],
  model: Pick<ModelInfo, "id" | "provider" | "apiModel">,
  activatedTools: Set<string>,
  toolAccessMode: ToolAccessMode = "onDemand",
): ToolDeferral {
  const mcp = new Set(mcpToolNames);
  const deferLocalNames = Object.keys(tools).filter((n) => !mcp.has(n) && DEFER_LOCAL_TOOLS.has(n));
  // Below the threshold, the ToolSearch schema and its extra round trip cost more than the schemas it would hide.
  const deferMcp = toolAccessMode === "onDemand" && mcpToolNames.length > DEFER_THRESHOLD;
  const deferredNames = new Set<string>([...deferLocalNames, ...(deferMcp ? mcpToolNames : [])]);
  const nativeToolSearch =
    deferredNames.size > 0 &&
    supportsNativeToolSearch(model.provider, model.apiModel) &&
    !nativeToolSearchUnsupported.has(model.id);
  const activeToolNames = new Set(Object.keys(tools).filter((n) => !deferredNames.has(n) || activatedTools.has(n)));
  const deferActive = deferredNames.size > 0 && !nativeToolSearch;
  if (nativeToolSearch) {
    for (const name of deferredNames) {
      const t = tools[name] as { providerOptions?: Record<string, Record<string, unknown>> };
      tools[name] = {
        ...tools[name],
        providerOptions: { ...t.providerOptions, anthropic: { ...t.providerOptions?.anthropic, deferLoading: true } },
      } as ToolSet[string];
    }
    tools.ToolSearch = anthropicTools.toolSearchBm25_20251119();
  } else if (deferActive) {
    const catalog: DeferredToolInfo[] = [...deferredNames].map((name) => ({
      name,
      summary: ((tools[name] as { description?: string }).description ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
    }));
    tools.ToolSearch = tool({
      description: getToolSearchDescription(catalog),
      inputSchema: z.object({
        query: z.string().describe('Keywords for the capability you need, or "select:Name1,Name2" for exact tool names.'),
        max_results: z.number().int().min(1).max(25).optional().describe("Max tools to activate (default 5)."),
      }),
      execute: async ({ query, max_results }) => {
        const hits = rankDeferredTools(catalog, query, max_results ?? 5);
        if (!hits.length) return `No deferred tools matched "${query}". Refine your keywords or use "select:<exact name>".`;
        for (const h of hits) activeToolNames.add(h.name);
        const detail = hits
          .map((h) => `- ${h.name}: ${((tools[h.name] as { description?: string }).description ?? "").replace(/\s+/g, " ").trim()}`)
          .join("\n");
        return `Activated ${hits.length} tool(s) — now callable for the rest of the conversation:\n\n${detail}`;
      },
    });
    activeToolNames.add("ToolSearch");
  }
  return { deferredNames, activeToolNames, deferActive };
}

/** Reorders `tools` in place into the stable order the prompt cache depends on. */
export function sortToolsInPlace(tools: ToolSet): void {
  const ordered = sortToolSet(tools);
  for (const name of Object.keys(tools)) delete tools[name];
  Object.assign(tools, ordered);
}

/** Asks the user, on the question card, whether a repeated identical call should run. */
export function askAboutLoop(askUser: AskUserFn): (toolName: string, count: number) => Promise<LoopDecision> {
  return async (toolName, count) => {
    const t = getTranslations(getLanguage()).question;
    const question = t.loopQuestion.replace("{tool}", toolName).replace("{n}", String(count));
    const answers = await askUser([
      { question, header: t.loopHeader, options: [{ label: t.loopContinue }, { label: t.loopStop }] },
    ]);
    const answer = answers?.find((a) => a.question === question)?.answer.trim() ?? "";
    if (answer === t.loopContinue) return { run: true };
    // Dismissed, "Stop", or a typed answer: don't run it, and pass on what the user wrote.
    return { run: false, note: answer && answer !== t.loopStop ? answer : undefined };
  };
}

/** Refuses a repeated identical tool call instead of running it again. With `confirm` (the chat
 *  asks before acting) the user decides instead; otherwise the model is told to change course. */
export function guardDoomLoops(tools: ToolSet, confirm?: (toolName: string, count: number) => Promise<LoopDecision>): void {
  const doomGuard = new DoomLoopGuard();
  for (const [name, t] of Object.entries(tools)) {
    const run = (t as { execute?: (input: unknown, opts: unknown) => unknown }).execute;
    if (!run) continue;
    tools[name] = {
      ...t,
      execute: async (input: unknown, opts: unknown) => {
        const loop = doomGuard.check(name, input);
        if (loop && confirm) {
          const decision = await confirm(name, doomGuard.count);
          if (decision.run) {
            doomGuard.allow();
            return run(input, opts);
          }
          emitEvent({ type: "tool.denied", tool: name });
          return loopStoppedMessage(name, decision.note);
        }
        if (loop) {
          emitEvent({ type: "tool.denied", tool: name });
          return loop;
        }
        return run(input, opts);
      },
    } as typeof t;
  }
}

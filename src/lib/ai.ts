import type { ModelMessage } from "ai";
import { callModel } from "./callModel";
import { getModel, PROVIDERS, type ProviderId } from "./models";
import { type Settings } from "./settings";
import { effortRank, type EffortLevel } from "./effort";
import { COMPACT_PROMPT, formatCompactSummary } from "./compact";
import { streamClaudeCode, ClaudeCodeAuthError } from "./claudeCode";
import { MissingKeyError, buildModel, thinkingOptions } from "./modelClient";
import { serializeTurnsForSummary, type ChatTurn } from "./turnInput";
import { dropOldest } from "./turnContext";
import { collectText } from "./turnStream";
import { isContextOverflowError } from "./turnSupport";
import { runAgentTurn, defaultAgentTurnDeps, type StreamChatOptions } from "./agentTurn";
import { agentCliOf, AgentCliAuthError, type AgentCliId, type AgentCliTurn } from "./agentCli";
import { streamGrokCli } from "./grokCli";
import { streamAntigravityCli } from "./antigravityCli";
import { streamCursorCli } from "./cursorCli";
import { streamCodexCli } from "./codexCli";
import { deepseekEnv, streamDeepseekCli } from "./deepseekCli";
import { streamDevinCli } from "./devinCli";
import { streamOpenCodeCli } from "./opencodeCli";

const CLI_MARKER_RE = /⟦(TOOL|TOOLEND|REASONING)⟧[\s\S]*?⟦\/\1⟧|⟦(?:TODO|PLAN)⟧/g;

/** How many times a `/compact` summary too long for the window is asked again without the
 *  oldest third of the conversation. */
const SUMMARY_OVERFLOW_RETRIES = 4;

/** What a CLI needs from Nyxs to run: DeepSeek Harness's API key, which is what connects it. */
function cliEnv(provider: ProviderId, settings: Settings): Record<string, string> | undefined {
  return provider === "deepseek-cli" ? deepseekEnv(settings["deepseek-cli"]?.apiKey) : undefined;
}

function streamAgentCli(cli: AgentCliId, turn: AgentCliTurn): Promise<string> {
  if (cli === "grok") return streamGrokCli(turn);
  if (cli === "cursor") return streamCursorCli(turn);
  if (cli === "codex") return streamCodexCli(turn);
  if (cli === "deepseek") return streamDeepseekCli(turn);
  if (cli === "devin") return streamDevinCli(turn);
  if (cli === "opencode") return streamOpenCodeCli(turn);
  return streamAntigravityCli(turn);
}

export async function summarizeConversation(
  modelId: string,
  settings: Settings,
  turns: ChatTurn[],
  signal?: AbortSignal,
): Promise<string> {
  const model = getModel(modelId, settings);
  if (!model) return "";
  if (model.provider === "claude-code") {
    const transcript = serializeTurnsForSummary(turns);
    let text = "";
    await streamClaudeCode({
      model,
      history: [{ role: "user", content: `<conversation>\n${transcript}\n</conversation>\n\n${COMPACT_PROMPT}` }],
      workspace: null,
      signal,
      planMode: false,
      effort: "low",
      ephemeral: true,
      onChunk: (delta) => {
        text += delta;
      },
    });
    return formatCompactSummary(text);
  }
  const cli = agentCliOf(model.provider);
  if (cli) {
    let text = "";
    await streamAgentCli(cli, {
      model,
      history: [{ role: "user", content: `<conversation>\n${serializeTurnsForSummary(turns)}\n</conversation>\n\n${COMPACT_PROMPT}` }],
      workspace: null,
      signal,
      env: cliEnv(model.provider, settings),
      planMode: false,
      effort: "low",
      ephemeral: true,
      onChunk: (delta) => {
        text += delta;
      },
    });
    return formatCompactSummary(text.replace(CLI_MARKER_RE, "").trim());
  }
  const languageModel = buildModel(model, settings);
  // One message per turn, so a request too long for the window can go again without the oldest.
  let parts = turns.flatMap((t): ModelMessage[] => {
    const text = serializeTurnsForSummary([t]);
    return text ? [{ role: t.role, content: text } as ModelMessage] : [];
  });
  for (let attempt = 0; ; attempt++) {
    const transcript = parts.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n\n");
    try {
      const result = callModel({
        model: languageModel,
        messages: [{ role: "user", content: `<conversation>\n${transcript}\n</conversation>\n\n${COMPACT_PROMPT}` }],
        abortSignal: signal,
      });
      return formatCompactSummary(await collectText(result.fullStream));
    } catch (err) {
      const shorter = attempt < SUMMARY_OVERFLOW_RETRIES && !signal?.aborted && isContextOverflowError(err) ? dropOldest(parts) : null;
      if (!shorter) throw err;
      parts = shorter;
    }
  }
}

/** One question to the chat's own model, whatever runs it (an API, Claude Code or another agent
 *  CLI), with no tools and outside the chat's session: the answer's text. Low effort by default:
 *  a quick check, not a turn of work. */
export async function askModelOnce(
  modelId: string,
  settings: Settings,
  prompt: string,
  { effort = "low", signal }: { effort?: EffortLevel; signal?: AbortSignal } = {},
): Promise<string> {
  const model = getModel(modelId, settings);
  if (!model) return "";
  const history: ChatTurn[] = [{ role: "user", content: prompt }];
  let text = "";
  const onChunk = (delta: string) => {
    text += delta;
  };
  if (model.provider === "claude-code") {
    await streamClaudeCode({ model, history, workspace: null, signal, planMode: false, effort, ephemeral: true, onChunk });
    return text;
  }
  const cli = agentCliOf(model.provider);
  if (cli) {
    await streamAgentCli(cli, { model, history, workspace: null, signal, env: cliEnv(model.provider, settings), planMode: false, effort, ephemeral: true, onChunk });
    return text.replace(CLI_MARKER_RE, "").trim();
  }
  const result = callModel({
    model: buildModel(model, settings),
    messages: [{ role: "user", content: prompt }],
    ...thinkingOptions(model, effort, false),
    maxRetries: 1,
    abortSignal: signal,
  });
  return collectText(result.fullStream);
}

export async function streamChat(chatOptions: StreamChatOptions): Promise<string> {
  const {
    modelId,
    history,
    settings,
    onChunk,
    signal,
    workspace,
    onTool,
    onUsage,
    onContext,
    planMode = false,
    gate,
    onTodos,
    onPlan,
    onFileEdit,
    askUser,
    thinking = false,
    onReasoning,
    onMessages,
    onCacheStats,
    effort = "medium",
    attachSession,
    inbox,
  } = chatOptions;
  const model = getModel(modelId, settings);
  if (!model) throw new Error(`Unknown model: ${modelId}`);

  if (model.provider === "claude-code") {
    try {
      return await streamClaudeCode({
        model,
        history,
        workspace,
        signal,
        planMode,
        effort: thinking && effortRank(effort) < effortRank("high") ? "high" : effort,
        gate,
        askUser,
        onChunk,
        onTool,
        onUsage,
        onContext,
        onTodos,
        onPlan,
        onFileEdit,
        onReasoning,
        onMessages,
        onCacheStats,
        attachSession,
        inbox,
        chatKey: chatOptions.sessionKey,
        onCompacting: chatOptions.onCompacting && ((active) => chatOptions.onCompacting?.(active, true)),
        onCompactBoundary: chatOptions.onNativeCompacted,
        onRetrying: chatOptions.onRetrying,
        onRemoteSetup: chatOptions.onRemoteSetup,
        onSubagentEdit: chatOptions.onSubagentEdit,
        onPrPublished: chatOptions.onPrPublished,
        maxTurns: chatOptions.maxSteps,
      });
    } catch (err) {
      if (!(err instanceof ClaudeCodeAuthError)) throw err;
      const name = PROVIDERS["claude-code"].name;
      throw new MissingKeyError(name, { providerId: "claude-code", detail: `${name}: ${err.message}` });
    }
  }

  const cli = agentCliOf(model.provider);
  if (cli) {
    try {
      return await streamAgentCli(cli, {
        model,
        history,
        workspace,
        signal,
        planMode,
        permissionMode: chatOptions.permissionMode,
        env: cliEnv(model.provider, settings),
        effort: thinking && effortRank(effort) < effortRank("high") ? "high" : effort,
        gate,
        askUser,
        onPlan,
        onChunk,
        onTool,
        onUsage,
        onContext,
        onTodos,
        onFileEdit,
        onReasoning,
        onMessages,
        onCacheStats,
        onRetrying: chatOptions.onRetrying,
        chatKey: chatOptions.sessionKey,
      });
    } catch (err) {
      if (!(err instanceof AgentCliAuthError)) throw err;
      const name = PROVIDERS[model.provider].name;
      throw new MissingKeyError(name, { providerId: model.provider, detail: err.message.startsWith(name) ? err.message : `${name}: ${err.message}` });
    }
  }

  return runAgentTurn(chatOptions, defaultAgentTurnDeps());
}

export type { StreamChatOptions, AgentTurnDeps } from "./agentTurn";
export { runAgentTurn, defaultAgentTurnDeps } from "./agentTurn";
export type { ChatTurn, CacheStats, ImageAttachment } from "./turnInput";
export { serializeModelMessages, serializeTurnsForSummary } from "./turnInput";
export { MissingKeyError, warmModelRegistry, withPromptCacheKey, pickHelperModel } from "./modelClient";
export { isContextOverflowError, isTransientStreamError, createToolCallRepair, inertTools } from "./turnSupport";

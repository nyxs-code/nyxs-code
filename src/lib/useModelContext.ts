import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatMessage } from "@/components/Message";
import { accountKey } from "@/lib/accountScope";
import { agentCliEffortLevels, agentCliOf, cachedAgentCliPlanUsage, fetchAgentCliPlanUsage, reportsPlanUsage } from "@/lib/agentCli";
import {
  cachedClaudePlanUsage,
  claudeCodeDefaultEffort,
  claudeCodeEffectiveEffort,
  claudeCodeEffortLevels,
  claudeCodeSessionOf,
  fetchClaudeCodeBaseline,
  fetchClaudeCodeContext,
  fetchClaudeCodeSessionContext,
  fetchClaudePlanUsage,
  type ContextBreakdown,
} from "@/lib/claudeCode";
import { EFFORT_LEVELS, type EffortLevel } from "@/lib/effort";
import { getContextWindow, getModel } from "@/lib/models";
import type { Settings } from "@/lib/settings";

/** The real context window Claude Code reported per model, so it survives a reload. */
const CLAUDE_WINDOWS_KEY = "nyxs.claudeCodeWindows.v1";

interface ModelContextInput {
  model: string;
  settings: Settings;
  workspace: string | null;
  effort: EffortLevel;
  /** The open chat's messages. */
  messages: ChatMessage[] | undefined;
  /** The context size the open chat's last reply reported. */
  contextUsed: number;
  streaming: boolean;
}

/** What the chat box shows about the model in use: its context ring and the details behind
 *  it, the plan limits, the session's token use and cost, and the effort levels it takes. */
export function useModelContext({ model, settings, workspace, effort, messages, contextUsed, streaming }: ModelContextInput) {
  const currentModel = getModel(model, settings);
  const listedWindow = getContextWindow(currentModel);
  // Claude Code measures its own context and reports the account's plan limits; other
  // providers only give the total, so the panel estimates the split from the prompt it sends.
  const usesClaudeCode = currentModel?.provider === "claude-code";
  const claudeApiModel = usesClaudeCode ? currentModel?.apiModel : undefined;
  // Antigravity CLI, Grok CLI and Codex CLI report their plan limits too.
  const modelCli = currentModel ? agentCliOf(currentModel.provider) : undefined;
  const usageCli = reportsPlanUsage(modelCli) ? modelCli : undefined;
  const sessionUsage = useMemo(() => {
    const total = { inputTokens: 0, outputTokens: 0, readTokens: 0, costUsd: 0 };
    for (const m of messages ?? []) {
      if (!m.usage) continue;
      total.inputTokens += m.usage.inputTokens;
      total.outputTokens += m.usage.outputTokens;
      total.readTokens += m.usage.readTokens;
      total.costUsd += m.usage.costUsd ?? 0;
    }
    return total.inputTokens > 0 ? total : null;
  }, [messages]);
  const claudeSession = useMemo(
    () => (usesClaudeCode ? claudeCodeSessionOf((messages ?? []).map((m) => m.responseMessages)) : undefined),
    [usesClaudeCode, messages],
  );

  // Effort: Claude Code models offer only the levels their CLI accepts (none for some), run
  // at the closest supported one, and recommend whatever level the CLI itself would pick.
  const claudeModel = usesClaudeCode ? currentModel : undefined;
  // Grok CLI and Antigravity CLI take only the levels their headless modes accept.
  const cliModel = currentModel && agentCliOf(currentModel.provider) ? currentModel : undefined;
  const effortLevels = claudeModel
    ? claudeCodeEffortLevels(claudeModel)
    : cliModel
      ? agentCliEffortLevels(cliModel)
      : EFFORT_LEVELS;
  const shownEffort =
    (claudeModel && claudeCodeEffectiveEffort(claudeModel, effort)) ||
    (cliModel && effortLevels && !effortLevels.includes(effort) ? effortLevels[effortLevels.length - 1] : effort);
  const [claudeDefaultEfforts, setClaudeDefaultEfforts] = useState<Record<string, EffortLevel | null>>({});
  const defaultEffortKey = claudeApiModel && effortLevels ? `${claudeApiModel}|${workspace ?? ""}` : "";
  useEffect(() => {
    if (!defaultEffortKey || !claudeApiModel) return;
    let alive = true;
    void claudeCodeDefaultEffort(claudeApiModel, workspace).then((level) => {
      if (alive) setClaudeDefaultEfforts((prev) => (prev[defaultEffortKey] === level ? prev : { ...prev, [defaultEffortKey]: level }));
    });
    return () => { alive = false; };
  }, [defaultEffortKey, claudeApiModel, workspace]);
  const recommendedEffort: EffortLevel | undefined = claudeModel
    ? claudeDefaultEfforts[defaultEffortKey] ?? undefined
    : "high";
  // A chat with no reply yet has no Claude Code process to ask, so its panel reads what a
  // fresh process holds (system prompt, tools, memory, skills) for this model and folder.
  // A chat whose process has exited is measured by resuming its session read-only.
  // Other providers don't measure their context, so their panel gets an estimate built from
  // the same prompt and tools Nyxs would send (loaded on demand, when the panel opens).
  // Claude Code's measurement wins; only rows the CLI doesn't provide are estimated.
  const withEstimatedRows = useCallback(
    async (measured: ContextBreakdown | null) => {
      if (!measured || !currentModel) return measured;
      const { enrichMeasuredContext } = await import("./contextEstimate");
      return enrichMeasuredContext(measured, { model: currentModel, workspace });
    },
    [currentModel, workspace],
  );
  const loadContextDetails = useMemo(
    () =>
      claudeSession
        ? async () =>
            withEstimatedRows(
              (await fetchClaudeCodeContext(claudeSession)) ??
                (await fetchClaudeCodeSessionContext(claudeSession, claudeApiModel, workspace, contextUsed)),
            )
        : usesClaudeCode
          ? async () => withEstimatedRows(await fetchClaudeCodeBaseline(claudeApiModel, workspace))
          : currentModel
            ? () =>
                import("./contextEstimate").then(({ estimateProviderContext }) =>
                  estimateProviderContext({ model: currentModel, workspace, used: contextUsed, messages }),
                )
            : undefined,
    [claudeSession, usesClaudeCode, claudeApiModel, currentModel, workspace, contextUsed, messages, withEstimatedRows],
  );
  const loadCliPlanUsage = useCallback(() => (usageCli ? fetchAgentCliPlanUsage(usageCli) : Promise.resolve(null)), [usageCli]);
  const cachedCliPlanUsage = useCallback(() => (usageCli ? cachedAgentCliPlanUsage(usageCli) : null), [usageCli]);
  const loadPlanUsage = usesClaudeCode ? fetchClaudePlanUsage : usageCli ? loadCliPlanUsage : undefined;
  const cachedPlanUsage = usageCli ? cachedCliPlanUsage : cachedClaudePlanUsage;
  // Asking for the plan limits spawns the CLI (a few seconds): start it as soon as one of its
  // models is in use, so the panel opens on a fresh reading.
  useEffect(() => {
    if (usesClaudeCode) void fetchClaudePlanUsage();
    else if (usageCli) void fetchAgentCliPlanUsage(usageCli);
  }, [usesClaudeCode, usageCli]);
  // The window Claude Code really gives a model (1M for some) can differ from the size in
  // its model list, so after each reply ask the CLI and remember it per model. Kept across
  // reloads: a chat whose process has already exited has nobody to ask, and the list's 200k
  // would show a 1M chat as overflowing.
  const [claudeWindows, setClaudeWindows] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(accountKey(CLAUDE_WINDOWS_KEY)) || "{}") as Record<string, number>;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try { localStorage.setItem(accountKey(CLAUDE_WINDOWS_KEY), JSON.stringify(claudeWindows)); } catch { /* storage full: re-measured next time */ }
  }, [claudeWindows]);
  useEffect(() => {
    if (!claudeSession || streaming) return;
    let alive = true;
    const remember = (max: number | undefined) => {
      if (alive && max) setClaudeWindows((prev) => (prev[model] === max ? prev : { ...prev, [model]: max }));
    };
    void fetchClaudeCodeContext(claudeSession).then(async (d) => {
      if (d?.maxTokens) return remember(d.maxTokens);
      // The chat's process has exited (idle, or the app reloaded). The window belongs to the
      // model, not the chat, so the cached no-message measurement answers just as well.
      remember((await fetchClaudeCodeBaseline(claudeApiModel, workspace))?.maxTokens);
    });
    return () => { alive = false; };
  }, [claudeSession, streaming, contextUsed, model, claudeApiModel, workspace]);
  // Before the first message the ring shows that starting context, not zero.
  const [claudeBaseline, setClaudeBaseline] = useState<{ key: string; used: number } | null>(null);
  useEffect(() => {
    if (!usesClaudeCode || claudeSession) return;
    let alive = true;
    const key = `${model}|${workspace ?? ""}`;
    void fetchClaudeCodeBaseline(claudeApiModel, workspace).then((d) => {
      if (!alive || !d) return;
      setClaudeBaseline((prev) => (prev?.key === key && prev.used === d.totalTokens ? prev : { key, used: d.totalTokens }));
      if (d.maxTokens) setClaudeWindows((prev) => (prev[model] === d.maxTokens ? prev : { ...prev, [model]: d.maxTokens }));
    });
    return () => { alive = false; };
  }, [usesClaudeCode, claudeSession, model, claudeApiModel, workspace]);
  const contextTotal = (usesClaudeCode && claudeWindows[model]) || listedWindow;
  const contextShown =
    contextUsed ||
    (usesClaudeCode && !claudeSession && claudeBaseline?.key === `${model}|${workspace ?? ""}` ? claudeBaseline.used : 0);

  return {
    usesClaudeCode,
    contextShown,
    contextTotal,
    loadContextDetails,
    loadPlanUsage,
    cachedPlanUsage,
    sessionUsage,
    shownEffort,
    effortLevels,
    recommendedEffort,
  };
}

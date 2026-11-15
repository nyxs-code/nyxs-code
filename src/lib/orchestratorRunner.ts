import { streamChat, type ChatTurn } from "./ai";
import type { Settings } from "./settings";
import type { PermissionGate } from "./agentTools";
import type { EffortLevel } from "./effort";
import { createOrchestrator, type AgentRunner, type Orchestrator, type OrchestratorOptions } from "./orchestrator";

export interface RunnerDeps {
  modelId: string;
  settings: Settings;
  workspace: string | null;
  gate?: PermissionGate;
  effort?: EffortLevel;
  onUsage?: (tokens: number) => void;
}

export function createStreamChatRunner(deps: RunnerDeps): AgentRunner {
  return async (prompt, opts) => {
    const body = opts.subagentType ? `[Act as a ${opts.subagentType} agent]\n\n${prompt}` : prompt;
    const history: ChatTurn[] = [{ role: "user", content: body }];

    let lastOutput = 0;
    let lastInput = 0;

    const text = await streamChat({
      modelId: opts.model ?? deps.modelId,
      history,
      settings: deps.settings,
      onChunk: (delta) => opts.onActivity?.({ kind: "text", delta }),
      signal: opts.signal,
      workspace: deps.workspace,
      onUsage: (tokens) => { lastOutput = tokens; deps.onUsage?.(tokens); },
      onContext: (used) => { lastInput = used; },
      gate: deps.gate,
      effort: deps.effort ?? "medium",
    });

    opts.onUsage?.({ inputTokens: lastInput, outputTokens: lastOutput });
    return text;
  };
}

export function makeOrchestrator(deps: RunnerDeps, options: OrchestratorOptions = {}): Orchestrator {
  return createOrchestrator(createStreamChatRunner(deps), options);
}

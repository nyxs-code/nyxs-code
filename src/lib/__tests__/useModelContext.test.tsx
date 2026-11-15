// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ContextBreakdown } from "@/lib/claudeCode";
import type { EffortLevel } from "@/lib/effort";
import type { ModelInfo } from "@/lib/models";
import type { Settings } from "@/lib/settings";
import { useModelContext } from "@/lib/useModelContext";

const { measured, baseline } = vi.hoisted(() => {
  const measured: ContextBreakdown = {
    categories: [
      { name: "System prompt", tokens: 4_000, kind: "used" },
      { name: "Custom agents", tokens: 300, kind: "used" },
    ],
    totalTokens: 4_300,
    maxTokens: 1_000_000,
  };
  return { measured, baseline: vi.fn(async () => measured) };
});

vi.mock("@/lib/claudeCode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/claudeCode")>();
  return {
    ...actual,
    claudeCodeSessionOf: () => undefined,
    claudeCodeEffortLevels: () => ["low", "medium", "high"] as EffortLevel[],
    claudeCodeEffectiveEffort: (_model: ModelInfo, effort: EffortLevel) => effort,
    claudeCodeDefaultEffort: async () => "high" as EffortLevel,
    fetchClaudeCodeBaseline: baseline,
    fetchClaudeCodeContext: async () => null,
    fetchClaudeCodeSessionContext: async () => null,
    fetchClaudePlanUsage: async () => null,
    cachedClaudePlanUsage: () => null,
  };
});

const claude: ModelInfo = {
  id: "claude-opus-test",
  apiModel: "claude-opus-4-5",
  name: "Opus",
  description: "",
  provider: "claude-code",
};

const deepseek: ModelInfo = {
  id: "deepseek-flash-test",
  apiModel: "deepseek-v4.1-flash",
  name: "DeepSeek v4.1 Flash",
  description: "",
  provider: "deepseek",
};

const settingsWith = (model: ModelInfo): Settings =>
  ({ [model.provider]: { apiKey: "test", models: [model] } }) as unknown as Settings;

const options = (model: ModelInfo) => ({
  model: model.id,
  settings: settingsWith(model),
  workspace: null,
  effort: "medium" as const,
  messages: [],
  contextUsed: 0,
  streaming: false,
});

describe("useModelContext", () => {
  it("gives other providers an estimated breakdown", async () => {
    const { result } = renderHook(() => useModelContext(options(deepseek)));
    await act(async () => {});

    let details: ContextBreakdown | null | undefined;
    await act(async () => {
      details = await result.current.loadContextDetails?.();
    });

    expect(details?.estimated).toBe(true);
    expect(details?.categories.some((c) => c.name === "System prompt" && c.tokens > 0)).toBe(true);
  });

  it("keeps Claude Code's own measurement untouched", async () => {
    const { result } = renderHook(() => useModelContext(options(claude)));
    await act(async () => {});

    let details: ContextBreakdown | null | undefined;
    await act(async () => {
      details = await result.current.loadContextDetails?.();
    });

    expect(baseline).toHaveBeenCalled();
    expect(details).toEqual(measured);
    expect(details?.estimated).toBeUndefined();
  });
});

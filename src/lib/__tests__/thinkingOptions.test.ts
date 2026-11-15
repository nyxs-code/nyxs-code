import { describe, it, expect } from "vitest";
import type { ModelInfo, ProviderId } from "@/lib/models";

const { thinkingOptions } = await import("@/lib/modelClient");
const { supportsThinking } = await import("@/lib/models");

const m = (provider: ProviderId, apiModel: string): ModelInfo => ({ id: `${provider}:${apiModel}`, apiModel, name: apiModel, description: "", provider });
const anthropic = (apiModel: string) => m("anthropic", apiModel);
const google = (apiModel: string) => m("google", apiModel);

describe("thinking on Claude through Anthropic's API", () => {
  it("sets the depth with effort on the models that think adaptively", () => {
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2", "claude-mythos-5-2", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-6"]) {
      expect(supportsThinking(anthropic(id)), id).toBe(true);
      expect(thinkingOptions(anthropic(id), "medium", false), id).toEqual({
        providerOptions: { anthropic: { effort: "medium", thinking: { type: "adaptive", display: "summarized" } } },
      });
    }
  });

  it("never sends a thinking budget to them, which they turn down", () => {
    const opts = thinkingOptions(anthropic("claude-opus-4-7"), "max", false);
    expect(JSON.stringify(opts)).not.toContain("budget");
    expect(opts.maxOutputTokens).toBeUndefined();
  });

  it("maps the extra level to xhigh where the model has it, and to high on the 4.6 models", () => {
    const effort = (id: string) => (thinkingOptions(anthropic(id), "extra", false).providerOptions?.anthropic as { effort?: string }).effort;
    expect(effort("claude-opus-5-5")).toBe("xhigh");
    expect(effort("claude-opus-4-7")).toBe("xhigh");
    expect(effort("claude-sonnet-4-6")).toBe("high");
    expect(effort("claude-opus-4-6-20260205")).toBe("high");
  });

  it("asks for low effort without turning thinking on at the low level", () => {
    expect(thinkingOptions(anthropic("claude-opus-4-8"), "low", false)).toEqual({ providerOptions: { anthropic: { effort: "low" } } });
    expect(thinkingOptions(anthropic("claude-opus-4-8"), "low", true)).toEqual({
      providerOptions: { anthropic: { effort: "high", thinking: { type: "adaptive", display: "summarized" } } },
    });
  });

  it("keeps a thinking budget for Claude 3.7 to 4.5", () => {
    for (const id of ["claude-sonnet-4-5-20250929", "claude-haiku-4-5", "claude-opus-4-1", "claude-opus-4-20250514", "claude-3-7-sonnet-20250219"]) {
      expect(supportsThinking(anthropic(id)), id).toBe(true);
      expect(thinkingOptions(anthropic(id), "high", false), id).toEqual({
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 16000 } } },
        maxOutputTokens: 32000,
      });
    }
  });

  it("reaches Anthropic as adaptive thinking with output_config.effort", async () => {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const { generateText } = await import("ai");
    let body: Record<string, unknown> = {};
    const client = createAnthropic({
      apiKey: "test",
      fetch: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        throw new Error("captured");
      }) as unknown as typeof fetch,
    });
    const opts = thinkingOptions(anthropic("claude-opus-4-8"), "extra", false);
    const providerOptions = opts.providerOptions as Parameters<typeof generateText>[0]["providerOptions"];
    await generateText({ model: client("claude-opus-4-8"), prompt: "hola", maxRetries: 0, providerOptions }).catch(() => undefined);
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort: "xhigh" });
  });

  it("sends nothing to the Claude models that can't think", () => {
    for (const id of ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-latest", "claude-3-opus-20240229"]) {
      expect(supportsThinking(anthropic(id)), id).toBe(false);
      expect(thinkingOptions(anthropic(id), "max", false), id).toEqual({});
    }
  });
});

describe("thinking on Gemini through Google's API", () => {
  it("uses thinkingLevel on Gemini 3 and later", () => {
    const level = (id: string, effort: "low" | "medium" | "high" | "max") =>
      (thinkingOptions(google(id), effort, false).providerOptions?.google as { thinkingConfig?: Record<string, unknown> }).thinkingConfig;
    expect(supportsThinking(google("gemini-3.1-pro-preview"))).toBe(true);
    expect(level("gemini-3.1-pro-preview", "medium")).toEqual({ thinkingLevel: "medium", includeThoughts: true });
    expect(level("gemini-3.8-flash", "low")).toEqual({ thinkingLevel: "low", includeThoughts: true });
    expect(level("gemini-4-carbon", "max")).toEqual({ thinkingLevel: "high", includeThoughts: true });
  });

  it("asks Gemini 3 Pro, which has no medium level, for high instead", () => {
    const opts = thinkingOptions(google("gemini-3-pro-preview"), "medium", false);
    expect(opts).toEqual({ providerOptions: { google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } } } });
  });

  it("keeps the thinking budget on Gemini 2.5", () => {
    expect(thinkingOptions(google("gemini-2.5-flash"), "high", false)).toEqual({
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 16000, includeThoughts: true } } },
    });
  });

  it("sends nothing to the Gemini models that don't think", () => {
    expect(supportsThinking(google("gemini-2.0-flash"))).toBe(false);
    expect(supportsThinking(google("gemini-3.1-flash-image"))).toBe(false);
    expect(thinkingOptions(google("gemini-2.0-flash"), "max", false)).toEqual({});
  });
});

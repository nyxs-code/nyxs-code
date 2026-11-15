import { describe, it, expect } from "vitest";
import { estimateCostUsd, modelPricing, hasPricing, formatUsd } from "@/lib/pricing";

describe("estimateCostUsd", () => {
  it("prices Opus 4 input/output per 1M", () => {
    expect(estimateCostUsd("claude-opus-4-8", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(15);
    expect(estimateCostUsd("claude-opus-4-8", { inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(75);
    expect(estimateCostUsd("claude-opus-4-8", { inputTokens: 500_000, outputTokens: 200_000 })).toBeCloseTo(
      15 * 0.5 + 75 * 0.2,
    );
  });

  it("prices Sonnet 4", () => {
    expect(estimateCostUsd("claude-sonnet-4-6", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(18);
  });

  it("discounts cached-read tokens and removes them from full-price input", () => {
    const cost = estimateCostUsd("claude-opus-4-8", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 800_000,
    });
    expect(cost).toBeCloseTo((200_000 * 15 + 800_000 * 1.5) / 1e6);
  });

  it("matches the most specific pattern first", () => {
    expect(estimateCostUsd("gpt-4o-mini", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.15);
    expect(estimateCostUsd("gpt-4o", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(2.5);
    expect(estimateCostUsd("gpt-4.1-nano", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.1);
    expect(estimateCostUsd("gpt-4.1-mini", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.4);
    expect(estimateCostUsd("gpt-4.1", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(2);
    expect(estimateCostUsd("gemini-2.5-flash", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.3);
    expect(estimateCostUsd("gemini-2.0-flash", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.1);
  });

  it("returns 0 for unknown models", () => {
    expect(estimateCostUsd("some-random-model", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(0);
    expect(hasPricing("some-random-model")).toBe(false);
    expect(hasPricing("claude-opus-4-8")).toBe(true);
    expect(modelPricing("claude-sonnet-4-6")).not.toBeNull();
  });
});

describe("formatUsd", () => {
  it("formats across magnitudes without scientific notation", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(0.27)).toBe("$0.270");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(1340)).toBe("$1,340");
  });
});

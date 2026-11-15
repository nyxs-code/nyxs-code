import { lookupRegistryModel } from "./modelRegistry";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const PRICING: Array<{ match: RegExp; price: ModelPrice }> = [
  { match: /opus-4|claude-opus/i, price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: /sonnet-4|claude-3[.-]?7-sonnet|claude-sonnet/i, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: /haiku-4|claude-3[.-]?5-haiku|claude-haiku/i, price: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
  { match: /claude-3-opus/i, price: { input: 15, output: 75 } },
  { match: /claude-3-haiku/i, price: { input: 0.25, output: 1.25 } },

  { match: /gpt-4\.1-nano/i, price: { input: 0.1, output: 0.4 } },
  { match: /gpt-4\.1-mini/i, price: { input: 0.4, output: 1.6 } },
  { match: /gpt-4\.1/i, price: { input: 2, output: 8 } },
  { match: /gpt-4o-mini/i, price: { input: 0.15, output: 0.6 } },
  { match: /gpt-4o|chatgpt-4o/i, price: { input: 2.5, output: 10 } },
  { match: /o4-mini/i, price: { input: 1.1, output: 4.4 } },
  { match: /o3-mini/i, price: { input: 1.1, output: 4.4 } },
  { match: /\bo3\b/i, price: { input: 2, output: 8 } },
  { match: /\bo1-mini/i, price: { input: 1.1, output: 4.4 } },
  { match: /\bo1\b/i, price: { input: 15, output: 60 } },
  { match: /gpt-4-turbo/i, price: { input: 10, output: 30 } },
  { match: /gpt-3\.5/i, price: { input: 0.5, output: 1.5 } },

  { match: /gemini-2\.5-pro/i, price: { input: 1.25, output: 10 } },
  { match: /gemini-2\.5-flash/i, price: { input: 0.3, output: 2.5 } },
  { match: /gemini-2\.0-flash/i, price: { input: 0.1, output: 0.4 } },
  { match: /gemini-1\.5-pro/i, price: { input: 1.25, output: 5 } },
  { match: /gemini-1\.5-flash/i, price: { input: 0.075, output: 0.3 } },

  { match: /grok-4|grok-3/i, price: { input: 3, output: 15 } },
  { match: /grok-2|grok-beta/i, price: { input: 2, output: 10 } },
];

export function priceForModel(provider: string, apiModel: string): ModelPrice | null {
  return lookupRegistryModel(provider, apiModel)?.cost ?? modelPricing(apiModel);
}

export function costFromPrice(p: ModelPrice, usage: CostInput): number {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const fullInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  const cacheReadRate = p.cacheRead ?? p.input * 0.1;
  const cacheWriteRate = p.cacheWrite ?? p.input * 1.25;
  return (fullInput * p.input + cacheRead * cacheReadRate + cacheWrite * cacheWriteRate + usage.outputTokens * p.output) / 1_000_000;
}

export function modelPricing(modelId: string): ModelPrice | null {
  if (!modelId) return null;
  for (const { match, price } of PRICING) {
    if (match.test(modelId)) return price;
  }
  return null;
}

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function estimateCostUsd(modelId: string, usage: CostInput): number {
  const p = modelPricing(modelId);
  if (!p) return 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const fullInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  const cacheReadRate = p.cacheRead ?? p.input * 0.1;
  const cacheWriteRate = p.cacheWrite ?? p.input * 1.25;
  const usd =
    (fullInput * p.input +
      cacheRead * cacheReadRate +
      cacheWrite * cacheWriteRate +
      usage.outputTokens * p.output) /
    1_000_000;
  return usd;
}

export function hasPricing(modelId: string): boolean {
  return modelPricing(modelId) != null;
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

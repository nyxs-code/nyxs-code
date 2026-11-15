import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { anthropic as anthropicProvider, createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getModel, getActiveModels, claudeThinking, geminiThinking, supportsThinking, supportsThinkingTypeParam, supportsReasoningEffortParam, runsInCli, PROVIDERS, videoModelKey, type ModelInfo, type ProviderId } from "./models";
import { type Settings } from "./settings";
import { normalizeBaseUrl } from "./providerModels";
import { type EffortLevel, effortRank } from "./effort";
import {
  withFatalErrorShortCircuit,
  withNativeToolSearchFallback,
  withSingleToolCalls,
  withUsageAccounting,
} from "./providerFetch";
import { ensureModelRegistry } from "./modelRegistry";
import { withToolMedia } from "./toolMedia";
import type { ModelCallOptions } from "./callModel";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const httpFetch = isTauri ? (tauriFetch as unknown as typeof fetch) : undefined;

export const MAX_API_RETRIES = 5;

export const COMPAT_MAX_OUTPUT_TOKENS = 32768;

export const anthropicTools = anthropicProvider.tools;

/** A provider that can't be used until it is set up in Settings. The chat words it in the
 *  user's language (`missingKeyMessage` in assistantTurn.ts); `message` is only for logs. */
export class MissingKeyError extends Error {
  providerName: string;
  providerId?: ProviderId;
  /** What the provider itself said (a CLI not signed in), shown instead of "missing API key". */
  detail?: string;
  constructor(providerName: string, opts: { providerId?: ProviderId; detail?: string } = {}) {
    super(opts.detail ?? `Missing API key for ${providerName}`);
    this.name = "MissingKeyError";
    this.providerName = providerName;
    this.providerId = opts.providerId;
    this.detail = opts.detail;
  }
}

export function buildModel(model: ModelInfo, settings: Settings) {
  const provider = PROVIDERS[model.provider];
  const cfg = settings[model.provider];
  const apiKey = cfg?.apiKey?.trim() || (provider.local ? "local" : "");

  if (!apiKey) throw new MissingKeyError(provider.name, { providerId: provider.id });

  const safeFetch = withFatalErrorShortCircuit((httpFetch ?? globalThis.fetch) as typeof fetch);

  switch (provider.kind) {
    case "anthropic": {
      let anthropicBaseUrl = cfg?.baseUrl || provider.defaultBaseUrl || undefined;
      if (provider.id === "minimax-anthropic" && anthropicBaseUrl) {
        anthropicBaseUrl = anthropicBaseUrl.replace(/\/+$/, "");
        if (!/\/v\d+$/.test(anthropicBaseUrl)) anthropicBaseUrl += "/v1";
      }
      const workspaceId = provider.id === "anthropic" ? cfg?.workspaceId?.trim() : undefined;
      const client = createAnthropic({
        apiKey,
        baseURL: anthropicBaseUrl,
        fetch: provider.id === "anthropic" ? withNativeToolSearchFallback(safeFetch, model.id) : safeFetch,
        headers: {
          // The plugin would add `Origin: tauri://localhost`, which makes Anthropic treat the call
          // as a browser request; an empty Origin makes the plugin omit it. In a real browser the
          // direct-browser header is what enables CORS instead.
          ...(isTauri ? { Origin: "" } : { "anthropic-dangerous-direct-browser-access": "true" }),
          // An organization-scoped key isn't bound to a workspace, so it must name one.
          ...(workspaceId ? { "anthropic-workspace-id": workspaceId } : {}),
        },
      });
      return client(model.apiModel);
    }
    case "google": {
      const client = createGoogleGenerativeAI({ apiKey, fetch: withToolMedia(safeFetch, "google", videoModelKey(model)) });
      return client(model.apiModel);
    }
    case "openai": {
      const client = createOpenAI({ apiKey, fetch: safeFetch });
      return client(model.apiModel);
    }
    case "openai-compatible": {
      const rawBaseUrl = cfg?.baseUrl || provider.defaultBaseUrl || "";
      const baseURL = rawBaseUrl ? normalizeBaseUrl(rawBaseUrl) : "";
      const wantsCost = /openrouter/i.test(provider.id) || /openrouter/i.test(baseURL);
      const baseFetch = wantsCost ? withUsageAccounting(safeFetch) : safeFetch;
      const client = createOpenAICompatible({
        name: provider.id,
        apiKey,
        baseURL,
        includeUsage: true,
        fetch: withSingleToolCalls(withToolMedia(baseFetch, "openai", videoModelKey(model)), provider.id),
      });
      return client(model.apiModel);
    }
    case "claude-code":
    case "agent-cli":
      throw new Error(`${provider.name} solo está disponible en el chat principal`);
  }
}

export function warmModelRegistry(): Promise<void> {
  return ensureModelRegistry((httpFetch ?? globalThis.fetch) as typeof fetch);
}

const EFFORT_BUDGET: Record<EffortLevel, number> = {
  low: 0,
  medium: 8000,
  high: 16000,
  extra: 24000,
  max: 32000,
};

export function thinkingOptions(model: ModelInfo, effort: EffortLevel, thinking: boolean): ModelCallOptions {
  if (!supportsThinking(model)) return {};
  let level = effort;
  if (thinking && effortRank(level) < effortRank("high")) level = "high";
  if (supportsThinkingTypeParam(model)) {
    const enabled = level !== "low";
    return {
      providerOptions: { [model.provider]: { thinking: { type: enabled ? "enabled" : "disabled" } } },
    };
  }
  if (model.provider === "minimax-anthropic") {
    const enabled = level !== "low";
    return {
      providerOptions: {
        anthropic: {
          thinking: enabled ? { type: "adaptive", display: "summarized" } : { type: "disabled" },
        },
      },
    };
  }
  if (supportsReasoningEffortParam(model)) {
    const re = level === "low" ? "low" : level === "medium" ? "medium" : "high";
    return { providerOptions: { [model.provider]: { reasoning_effort: re } } };
  }
  const claude = model.provider === "anthropic" ? claudeThinking(model.apiModel) : null;
  if (claude?.mode === "adaptive") {
    // The SDK sends `effort` as `output_config.effort`. At low effort thinking isn't asked
    // for: the 4.x models then answer without it, and the 5.x ones, which always think, keep
    // it short. `display` defaults to "omitted" on the newer models, which would leave the
    // reasoning panel empty.
    const effort = level === "extra" ? (claude.xhigh ? "xhigh" : "high") : level;
    const adaptive = level === "low" ? {} : { thinking: { type: "adaptive", display: "summarized" } };
    return { providerOptions: { anthropic: { effort, ...adaptive } } };
  }
  if (model.provider === "google" && geminiThinking(model.apiModel) === "level") {
    // Gemini 3 Pro has only low and high.
    const noMedium = /gemini-3-pro/i.test(model.apiModel);
    const thinkingLevel = level === "low" ? "low" : level === "medium" && !noMedium ? "medium" : "high";
    return { providerOptions: { google: { thinkingConfig: { thinkingLevel, includeThoughts: true } } } };
  }
  if (level === "low") return {};
  const budget = EFFORT_BUDGET[level];
  switch (model.provider) {
    case "anthropic":
      return {
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: budget } } },
        maxOutputTokens: budget + 16000,
      };
    case "google":
      return { providerOptions: { google: { thinkingConfig: { thinkingBudget: budget, includeThoughts: true } } } };
    case "openai":
      return { providerOptions: { openai: { reasoningEffort: level === "medium" ? "medium" : "high" } } };
    default:
      return {};
  }
}

const PROMPT_CACHE_KEY_PROVIDERS = new Set(["zen", "deepinfra", "cerebras"]);

export function withPromptCacheKey<T extends object>(opts: T, model: ModelInfo, sessionKey: string | undefined): T {
  if (!sessionKey) return opts;
  let key: string | null = null;
  let entry: Record<string, unknown> = {};
  if (model.provider === "openai") {
    key = "openai";
    entry = { promptCacheKey: sessionKey };
  } else if (PROMPT_CACHE_KEY_PROVIDERS.has(model.provider)) {
    key = model.provider;
    entry = { prompt_cache_key: sessionKey };
  }
  if (!key) return opts;
  const current = (opts as { providerOptions?: Record<string, Record<string, unknown> | undefined> }).providerOptions;
  const providerOptions: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(current ?? {})) if (v) providerOptions[k] = v;
  providerOptions[key] = { ...(providerOptions[key] ?? {}), ...entry };
  return { ...opts, providerOptions };
}

const HELPER_MODEL_RE = /haiku|flash|mini|nano|lite|small|air|instant/i;
const NOT_CHAT_MODEL_RE = /image|audio|tts|embed|realtime|transcribe|moderation|guard/i;

export function pickHelperModel(model: ModelInfo, settings: Settings, preferred?: string): ModelInfo {
  if (preferred) {
    const chosen = getModel(preferred, settings);
    if (chosen && !runsInCli(chosen.provider)) return chosen;
  }
  const sameProvider = getActiveModels(settings).filter(
    (m) => m.provider === model.provider && !NOT_CHAT_MODEL_RE.test(m.apiModel),
  );
  return sameProvider.find((m) => HELPER_MODEL_RE.test(m.apiModel)) ?? model;
}

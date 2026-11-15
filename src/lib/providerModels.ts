import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { type ProviderInfo, type ProviderId, type ModelInfo } from "./models";
import { type ProviderSettings } from "./settings";
import { CLAUDE_CODE_MODELS, fetchClaudeCodeModels } from "./claudeCode";
import { agentCliOf, fetchAgentCliModels } from "./agentCli";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const httpFetch: typeof fetch = isTauri ? (tauriFetch as unknown as typeof fetch) : fetch;

export function modelId(provider: ProviderId, apiModel: string): string {
  return `${provider}:${apiModel}`;
}

const MINIMAX_MODELS: string[] = [
  "MiniMax-M3",
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.5-highspeed",
  "MiniMax-M2.1",
  "MiniMax-M2",
];

function isChatModel(id: string): boolean {
  return !/embedding|whisper|tts|dall-e|moderation|audio|image|realtime|transcribe|search|babbage|davinci|computer-use/i.test(
    id,
  );
}

export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim().replace(/\/+$/, "");
  if (!value) throw new Error("Falta la URL base del proveedor");
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  value = value.replace(/\/(v\d+\/)?models$/i, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`URL base inválida: ${raw}`);
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!path) url.pathname = "/v1";
  return url.toString().replace(/\/+$/, "");
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await httpFetch(url, { headers });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    // The address without its query: a key or token there would end up on screen and in logs.
    throw new Error(
      `${url.split("?")[0]} no devolvió JSON (¿es la URL base correcta?): ${body.slice(0, 120).replace(/\s+/g, " ")}`,
    );
  }
}

export async function fetchProviderModelsWithRetry(
  provider: ProviderInfo,
  cfg: ProviderSettings,
  retries = 2,
): Promise<ModelInfo[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchProviderModels(provider, cfg);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

export async function fetchProviderModels(
  provider: ProviderInfo,
  cfg: ProviderSettings,
): Promise<ModelInfo[]> {
  const apiKey = cfg.apiKey?.trim() || (provider.local ? "local" : "");
  if (!apiKey) throw new Error(`Falta la API key de ${provider.name}`);

  const mk = (
    apiModel: string,
    name: string,
    contextWindow?: number,
  ): ModelInfo => ({
    id: modelId(provider.id, apiModel),
    apiModel,
    name,
    description: provider.name,
    provider: provider.id,
    contextWindow,
  });

  if (provider.id === "minimax" || provider.id === "minimax-anthropic") {
    return MINIMAX_MODELS.map((m) => mk(m, m));
  }

  switch (provider.kind) {
    case "anthropic": {
      // The HTTP plugin adds `Origin: tauri://localhost`, which Anthropic reads as a browser call
      // and rejects when the org limits CORS; an empty value makes the plugin omit it. A real
      // browser does need the direct-browser header instead.
      const anthropicHeaders: Record<string, string> = {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
      if (isTauri) anthropicHeaders["Origin"] = "";
      else anthropicHeaders["anthropic-dangerous-direct-browser-access"] = "true";
      // An organization-scoped key isn't bound to a workspace, so it must name one.
      const workspaceId = cfg.workspaceId?.trim();
      if (workspaceId) anthropicHeaders["anthropic-workspace-id"] = workspaceId;
      const data = (await getJson(
        "https://api.anthropic.com/v1/models?limit=1000",
        anthropicHeaders,
      )) as { data?: { id: string; display_name?: string }[] };
      return (data.data ?? []).map((m) => mk(m.id, m.display_name || m.id));
    }

    case "openai": {
      const data = (await getJson("https://api.openai.com/v1/models", {
        Authorization: `Bearer ${apiKey}`,
      })) as { data?: { id: string }[] };
      return (data.data ?? [])
        .map((m) => m.id)
        .filter(isChatModel)
        .sort()
        .map((id) => mk(id, id));
    }

    case "google": {
      // In a header, as Google's docs show: in the address it would reach logs and errors.
      const data = (await getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
        "x-goog-api-key": apiKey,
      })) as {
        models?: {
          name: string;
          displayName?: string;
          inputTokenLimit?: number;
          supportedGenerationMethods?: string[];
        }[];
      };
      return (data.models ?? [])
        .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m) => {
          const apiModel = m.name.replace(/^models\//, "");
          return mk(apiModel, m.displayName || apiModel, m.inputTokenLimit);
        });
    }

    case "claude-code":
      return fetchClaudeCodeModels().catch(() => CLAUDE_CODE_MODELS);

    case "agent-cli": {
      const cli = agentCliOf(provider.id);
      if (!cli) throw new Error(`${provider.name} no es un CLI conocido`);
      // DeepSeek Harness lists the models its API key gives access to.
      return fetchAgentCliModels(cli, cfg.apiKey);
    }

    case "openai-compatible": {
      const baseURL = normalizeBaseUrl(cfg.baseUrl || provider.defaultBaseUrl || "");
      const data = (await getJson(`${baseURL}/models`, {
        Authorization: `Bearer ${apiKey}`,
      })) as { data?: (Record<string, unknown> & { id: string; context_length?: number })[] };
      return (data.data ?? [])
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((m) => mk(m.id, m.id, m.context_length));
    }
  }
}

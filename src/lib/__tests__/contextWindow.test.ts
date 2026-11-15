import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, ProviderId } from "@/lib/models";
import type { Settings } from "@/lib/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { getContextWindow, getModel, getActiveModels } = await import("@/lib/models");
const { compactRegistry, setRegistryIndex } = await import("@/lib/modelRegistry");

const m = (provider: ProviderId, apiModel: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id: `${provider}:${apiModel}`,
  apiModel,
  name: apiModel,
  description: "",
  provider,
  ...extra,
});

afterEach(() => setRegistryIndex(null));

describe("a model's context window from models.dev", () => {
  it("takes the input limit when it is below the context", () => {
    setRegistryIndex(compactRegistry({ anthropic: { models: { "claude-wide": { limit: { context: 400_000, input: 272_000, output: 128_000 } } } } }));
    expect(getContextWindow(m("anthropic", "claude-wide"))).toBe(272_000);
  });

  it("takes the smallest window when other hosts list the model differently", () => {
    setRegistryIndex(compactRegistry({
      "host-a": { models: { "qwen3-coder": { limit: { context: 262_144 } } } },
      "host-b": { models: { "qwen3-coder": { limit: { context: 131_072 } } } },
    }));
    expect(getContextWindow(m("custom", "someorg/qwen3-coder"))).toBe(131_072);
  });
});

describe("a context window the user set", () => {
  const llama = m("ollama", "llama3", { contextWindow: 8_192 });
  const settings = {
    ollama: { apiKey: "local", models: [llama], enabled: [llama.id], contextWindows: { [llama.id]: 32_768 } },
  } as unknown as Settings;

  it("wins over what the provider and models.dev say", () => {
    expect(getContextWindow(getModel(llama.id, settings))).toBe(32_768);
    expect(getContextWindow(getActiveModels(settings).find((x) => x.id === llama.id))).toBe(32_768);
  });

  it("leaves the detected window when there is none", () => {
    const plain = { ollama: { ...settings.ollama, contextWindows: {} } } as unknown as Settings;
    expect(getContextWindow(getModel(llama.id, plain))).toBe(8_192);
  });
});

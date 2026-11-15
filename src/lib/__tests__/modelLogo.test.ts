import { describe, expect, it } from "vitest";
import { modelDisplayName, modelFamilyLogo, modelLogo, type ModelInfo } from "@/lib/models";

const family = (apiModel: string, name = apiModel) => modelFamilyLogo({ apiModel, name })?.logo?.split("/").pop() ?? null;

describe("modelFamilyLogo", () => {
  it("tells the lab from ids as custom and aggregator providers write them", () => {
    expect(family("qwen3.8-flash-next")).toBe("qwen.svg");
    expect(family("deepseek-v4-flash")).toBe("deepseek.svg");
    expect(family("deepseek-ai/DeepSeek-V3")).toBe("deepseek.svg");
    expect(family("meta-llama/Llama-3.3-70B-Instruct")).toBe("meta-color.svg");
    expect(family("google/gemma-3-27b-it")).toBe("gemma-color.svg");
    expect(family("gemini-2.5-pro")).toBe("gemini-color.svg");
    expect(family("moonshotai/Kimi-K2-Instruct")).toBe("moonshot.svg");
    expect(family("z-ai/glm-4.6")).toBe("zhipu-color.svg");
    expect(family("mistralai/Devstral-Small")).toBe("mistral.svg");
    expect(family("openai/gpt-oss-120b")).toBe("openai.svg");
    expect(family("o3-mini")).toBe("openai.svg");
    expect(family("x-ai/grok-4")).toBe("grok.svg");
    expect(family("anthropic/claude-sonnet-4.5")).toBe("claude-color.svg");
    expect(family("microsoft/phi-4")).toBe("microsoft-color.svg");
    expect(family("nvidia/llama-3.1-nemotron-70b")).toBe("meta-color.svg");
  });

  it("marks single-colour logos so they follow the text colour", () => {
    expect(modelFamilyLogo({ apiModel: "gpt-5", name: "GPT-5" })).toMatchObject({ logoMono: true });
    expect(modelFamilyLogo({ apiModel: "qwen3", name: "Qwen 3" })?.logoMono).toBeFalsy();
  });

  it("knows nothing about an id with no lab in it", () => {
    expect(family("my-finetune-v2")).toBeNull();
    // "o3" inside another word is not OpenAI's o-series.
    expect(family("photo3d")).toBeNull();
  });
});

describe("modelLogo", () => {
  const model = (provider: ModelInfo["provider"], apiModel: string): ModelInfo =>
    ({ id: `${provider}:${apiModel}`, apiModel, name: apiModel, description: "", provider }) as ModelInfo;

  it("uses the provider's logo when it has one and the lab's for a custom endpoint", () => {
    expect(modelLogo(model("openrouter", "qwen/qwen3-32b")).logo).toContain("openrouter.svg");
    expect(modelLogo(model("custom", "qwen3.8-flash-next")).logo).toContain("qwen.svg");
    expect(modelLogo(model("custom", "my-finetune"))).toEqual({});
  });
});

describe("modelDisplayName", () => {
  it("drops the path a provider puts before the model", () => {
    expect(modelDisplayName("minimaxai/minimax-m3.1-flash")).toBe("minimax-m3.1-flash");
    expect(modelDisplayName("accounts/fireworks/models/llama-v3p1-8b")).toBe("llama-v3p1-8b");
    expect(modelDisplayName("gpt-5")).toBe("gpt-5");
  });

  it("leaves a real display name alone", () => {
    expect(modelDisplayName("Claude Opus 4")).toBe("Claude Opus 4");
    expect(modelDisplayName("Gemini 2.5 Pro / Flash")).toBe("Gemini 2.5 Pro / Flash");
  });
});

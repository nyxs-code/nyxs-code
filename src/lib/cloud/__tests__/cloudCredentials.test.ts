import { describe, expect, it } from "vitest";
import type { Settings } from "@/lib/settings";
import { cloudSupport, providerKeysForCloud, sanitizedCloudSettings } from "@/lib/cloud/cloudCredentials";

const settings = {
  anthropic: { apiKey: "sk-ant-1", models: [], enabled: ["claude-sonnet"] },
  openai: { apiKey: "  ", baseUrl: "https://api.openai.com/v1" },
  ollama: { apiKey: "", baseUrl: "http://localhost:11434/v1" },
  custom: { apiKey: "k", baseUrl: "http://192.168.1.20:8000/v1" },
  "claude-code": { apiKey: "" },
  "grok-cli": { apiKey: "" },
} as unknown as Settings;

describe("cloud credentials", () => {
  it("knows what each provider needs in the cloud", () => {
    expect(cloudSupport("anthropic", settings)).toEqual({ ok: true, key: "provider:anthropic" });
    expect(cloudSupport("claude-code", settings)).toEqual({ ok: true, key: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(cloudSupport("codex-cli", settings)).toEqual({ ok: true, key: "provider:openai" });
    expect(cloudSupport("grok-cli", settings)).toEqual({ ok: false, reason: "cli" });
  });

  it("leaves out providers the cloud can't reach", () => {
    expect(cloudSupport("ollama", settings)).toEqual({ ok: false, reason: "local" });
    expect(cloudSupport("custom", settings)).toEqual({ ok: false, reason: "local" });
  });

  it("sends only the chosen keys that exist", () => {
    expect(providerKeysForCloud(settings, ["anthropic", "openai", "custom", "claude-code"])).toEqual([
      { key: "provider:anthropic", value: "sk-ant-1" },
    ]);
  });

  it("never puts a key in the thread's settings", () => {
    const out = sanitizedCloudSettings(settings) as { providers: Record<string, Record<string, unknown>> };
    expect(JSON.stringify(out)).not.toContain("sk-ant-1");
    expect(out.providers.anthropic).toEqual({ models: [], enabled: ["claude-sonnet"] });
    expect(out.providers.ollama).toBeUndefined();
  });
});

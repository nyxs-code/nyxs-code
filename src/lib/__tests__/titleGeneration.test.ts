import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  generator: "auto" as unknown,
  privacy: {} as Record<string, boolean>,
  service: "Login con Google" as string | null,
  calls: [] as string[],
  claude: "Sesión tras callback de Google",
  codex: "Login de Google: callback",
  cliFails: false,
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async () => {
    fake.calls.push("service");
    if (fake.service === null) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ title: fake.service }) };
  },
}));
vi.mock("@/lib/auth", () => ({ AUTH_BASE: "https://example.invalid", getToken: async () => "token" }));
vi.mock("@/lib/settingsRuntime", () => ({
  getMergedSnapshot: () => ({ titleGeneration: fake.generator }),
  getSettingsForSource: async () => ({ privacy: fake.privacy }),
}));
vi.mock("@/lib/settings", () => ({ loadSettings: () => ({ "codex-cli": { models: [{ id: "codex-cli:gpt-5-codex-mini", apiModel: "gpt-5-codex-mini", name: "mini", description: "", provider: "codex-cli" }] } }) }));
vi.mock("@/lib/claudeCode", () => ({
  CLAUDE_CODE_MODELS: [{ id: "claude-code:haiku", apiModel: "haiku", name: "Haiku", description: "", provider: "claude-code" }],
  streamClaudeCode: async (t: { model: { apiModel: string }; ephemeral: boolean; onChunk: (d: string) => void }) => {
    fake.calls.push(`claude:${t.model.apiModel}:${t.ephemeral}`);
    if (fake.cliFails) throw new Error("not signed in");
    t.onChunk(`"${fake.claude}."\n`);
    return "";
  },
}));
vi.mock("@/lib/codexCli", () => ({
  streamCodexCli: async (t: { model: { apiModel: string }; ephemeral: boolean; onChunk: (d: string) => void }) => {
    fake.calls.push(`codex:${t.model.apiModel}:${t.ephemeral}`);
    if (fake.cliFails) throw new Error("codex is not installed");
    t.onChunk(fake.codex);
    return "";
  },
}));

const { generateChatTitle, testTitle } = await import("@/lib/titles");
const MESSAGE = "cuando inicio sesión con google no se guarda la sesión después del callback";

beforeEach(() => {
  Object.assign(fake, { generator: "auto", privacy: {}, service: "Login con Google", calls: [], cliFails: false });
});

describe("title generation", () => {
  it("automatic: Nyxs' service names the chat", async () => {
    expect(await generateChatTitle(MESSAGE, undefined, "claude-code")).toBe("Login con Google");
    expect(fake.calls).toEqual(["service"]);
  });

  it("automatic: without the service, the chat's own CLI does, on its small model", async () => {
    fake.service = null;
    expect(await generateChatTitle(MESSAGE, undefined, "claude-code")).toBe("Sesión tras callback de Google");
    expect(await generateChatTitle(MESSAGE, undefined, "codex-cli")).toBe("Login de Google: callback");
    expect(fake.calls).toEqual(["service", "claude:haiku:true", "service", "codex:gpt-5-codex-mini:true"]);
  });

  it("automatic with chat titles off in Privacy: the message names the chat and goes nowhere", async () => {
    fake.privacy = { chatTitles: false };
    expect(await generateChatTitle(MESSAGE, undefined, "claude-code")).toBe("cuando inicio sesión con google no");
    expect(fake.calls).toEqual([]);
  });

  it("Codex or Claude Haiku picked: that one names every chat", async () => {
    fake.generator = "codex";
    expect(await generateChatTitle(MESSAGE)).toBe("Login de Google: callback");
    fake.generator = "claude-haiku";
    expect(await generateChatTitle(MESSAGE)).toBe("Sesión tras callback de Google");
    expect(fake.calls).toEqual(["codex:gpt-5-codex-mini:true", "claude:haiku:true"]);
  });

  it("off, or a CLI that fails: the message names the chat", async () => {
    fake.generator = "off";
    expect(await generateChatTitle(MESSAGE)).toBe("cuando inicio sesión con google no");
    fake.generator = "codex";
    fake.cliFails = true;
    expect(await generateChatTitle(MESSAGE)).toBe("cuando inicio sesión con google no");
  });

  it("the test in Settings shows the title, or why it failed", async () => {
    expect(await testTitle("claude-haiku", MESSAGE)).toBe("Sesión tras callback de Google");
    fake.cliFails = true;
    await expect(testTitle("codex", MESSAGE)).rejects.toThrow("codex is not installed");
  });
});

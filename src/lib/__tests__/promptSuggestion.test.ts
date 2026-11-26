import { beforeEach, describe, it, expect, vi } from "vitest";

const backend = vi.hoisted(() => ({
  token: "tok" as string | null,
  status: 200,
  suggestion: "Añade un test para el login",
  calls: [] as { url: string; body: { system?: string; prompt?: string } }[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(async (url: string, init: { body: string }) => {
    backend.calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ suggestion: backend.suggestion }), { status: backend.status });
  }),
}));
vi.mock("@/lib/auth", () => ({ AUTH_BASE: "https://api.test", getToken: async () => backend.token }));

const claude = vi.hoisted(() => ({ refused: false, runs: 0 }));
vi.mock("@/lib/claudeCode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/claudeCode")>()),
  claudePlanRefused: () => claude.refused,
  streamClaudeCode: async (t: { onChunk: (d: string) => void }) => {
    claude.runs++;
    t.onChunk("Ejecuta los tests");
    return "";
  },
}));

const { cleanSuggestion, previewSuggestion, suggestNextPrompt } = await import("@/lib/promptSuggestion");
const { CLAUDE_CODE_MODELS } = await import("@/lib/claudeCode");

describe("suggestNextPrompt with Claude Code", () => {
  const model = CLAUDE_CODE_MODELS[0];
  const settings = { "claude-code": { models: [model] } } as unknown as Parameters<typeof suggestNextPrompt>[1];
  const turns = [
    { role: "user" as const, content: "Arregla el fallo del login" },
    { role: "assistant" as const, content: "Listo, ya entra." },
  ];

  beforeEach(() => {
    claude.refused = false;
    claude.runs = 0;
    backend.token = "tok";
    backend.status = 200;
    backend.calls = [];
  });

  it("asks the backend instead of starting the CLI", async () => {
    expect(await suggestNextPrompt(model.id, settings, turns)).toBe("Añade un test para el login");
    expect(claude.runs).toBe(0);
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].url).toBe("https://api.test/api/suggest");
    expect(backend.calls[0].body.prompt).toContain("Arregla el fallo del login");
    expect(backend.calls[0].body.system).toMatch(/next message/);
  });

  it("asks nothing while the plan turns requests away", async () => {
    claude.refused = true;
    expect(await suggestNextPrompt(model.id, settings, turns)).toBe("");
    expect(claude.runs).toBe(0);
    expect(backend.calls).toHaveLength(0);
  });

  it("falls back to the CLI when the backend can't be asked", async () => {
    backend.status = 404;
    expect(await suggestNextPrompt(model.id, settings, turns)).toBe("Ejecuta los tests");
    expect(claude.runs).toBe(1);

    backend.token = null;
    expect(await suggestNextPrompt(model.id, settings, turns)).toBe("Ejecuta los tests");
    expect(claude.runs).toBe(2);
  });

  it("sends nothing anywhere once the chat used Gmail or Google Calendar", async () => {
    const withGmail = [
      { role: "user" as const, content: "Show me my emails with [Demo] in the subject" },
      { role: "assistant" as const, content: "\n\n⟦TOOL⟧t1⟦SEP⟧search_threads⟦SEP⟧Gmail (MCP)⟦/TOOL⟧\n\nYou have 3 emails." },
      { role: "user" as const, content: "Summarize the second one again" },
      { role: "assistant" as const, content: "It asks whether you are free on Friday." },
    ];
    expect(await suggestNextPrompt(model.id, settings, withGmail)).toBe("");
    expect(backend.calls).toHaveLength(0);
    expect(claude.runs).toBe(0);
  });

  it("gives no suggestion when the backend fails, without starting the CLI", async () => {
    backend.status = 502;
    expect(await suggestNextPrompt(model.id, settings, turns)).toBe("");
    expect(claude.runs).toBe(0);
  });
});

describe("cleanSuggestion", () => {
  it("keeps the first line without quotes", () => {
    expect(cleanSuggestion('"Añade tests para esto"\nExplanation: it is useful')).toBe("Añade tests para esto");
  });

  it("drops NONE", () => {
    expect(cleanSuggestion("NONE")).toBe("");
    expect(cleanSuggestion(" none. ")).toBe("");
  });

  it("drops a question, since the user would send a request", () => {
    expect(cleanSuggestion("¿Qué tal el resto de la release?")).toBe("");
    expect(cleanSuggestion("What else is left?")).toBe("");
    expect(cleanSuggestion("Sí, súbelo y saca la release")).toBe("Sí, súbelo y saca la release");
  });

  it("removes Claude Code markers", () => {
    expect(cleanSuggestion("⟦REASONING⟧thinking⟦/REASONING⟧Run the build")).toBe("Run the build");
  });

  it("keeps the whole message so Tab inserts all of it", () => {
    const long = "Please refactor the whole authentication module so that it uses the new token service everywhere";
    expect(cleanSuggestion(long)).toBe(long);
  });

  it("cuts only the placeholder preview at a word", () => {
    const out = previewSuggestion("Please refactor the whole authentication module so that it uses the new token service everywhere");
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });
});

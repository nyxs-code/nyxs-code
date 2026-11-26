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

const helper = vi.hoisted(() => ({ answer: "Ejecuta los tests", calls: [] as { system?: string; prompt: string }[] }));
vi.mock("@/lib/modelClient", () => ({
  pickHelperModel: (model: unknown) => model,
  buildModel: () => ({}),
}));
vi.mock("@/lib/callModel", () => ({
  callModel: (o: { system?: string; messages: { content: string }[] }) => {
    helper.calls.push({ system: o.system, prompt: o.messages[0].content });
    return { textStream: (async function* () { yield helper.answer; })() };
  },
}));

const { cleanSuggestion, previewSuggestion, replyText, suggestNextPrompt } = await import("@/lib/promptSuggestion");

type Settings = Parameters<typeof suggestNextPrompt>[1];
const settings = {
  "claude-code": { models: [{ id: "cc:opus", provider: "claude-code", apiModel: "opus", name: "Opus" }] },
  "codex-cli": { models: [{ id: "codex:gpt", provider: "codex-cli", apiModel: "gpt-5", name: "GPT-5" }] },
  anthropic: { models: [{ id: "anthropic:sonnet", provider: "anthropic", apiModel: "claude-sonnet-5-5", name: "Sonnet" }] },
} as unknown as Settings;

const turns = [
  { role: "user" as const, content: "Arregla el fallo del login" },
  { role: "assistant" as const, content: "\n\n⟦TOOL⟧t1⟦SEP⟧Edit⟦SEP⟧src/login.ts⟦/TOOL⟧\n\n⟦TOOLEND⟧t1⟦SEP⟧ok⟦/TOOLEND⟧Listo, ya entra." },
];

beforeEach(() => {
  backend.token = "tok";
  backend.status = 200;
  backend.calls = [];
  helper.calls = [];
  helper.answer = "Ejecuta los tests";
});

describe("suggestNextPrompt", () => {
  it("leaves Claude Code chats to the CLI's own guess", async () => {
    expect(await suggestNextPrompt("cc:opus", settings, turns)).toBe("");
    expect(backend.calls).toHaveLength(0);
    expect(helper.calls).toHaveLength(0);
  });

  it("asks a helper model of an API provider, with the tool calls in the conversation", async () => {
    expect(await suggestNextPrompt("anthropic:sonnet", settings, turns)).toBe("Ejecuta los tests");
    expect(backend.calls).toHaveLength(0);
    expect(helper.calls[0].system).toMatch(/SUGGESTION MODE/);
    expect(helper.calls[0].prompt).toContain("[tool Edit: src/login.ts]");
    expect(helper.calls[0].prompt).not.toContain("⟦");
  });

  it("asks the backend for other CLI agents, with the instructions in the prompt", async () => {
    expect(await suggestNextPrompt("codex:gpt", settings, turns)).toBe("Añade un test para el login");
    expect(helper.calls).toHaveLength(0);
    expect(backend.calls[0].url).toBe("https://api.test/api/suggest");
    expect(backend.calls[0].body.prompt).toMatch(/SUGGESTION MODE[\s\S]*Arregla el fallo del login/);
    expect(backend.calls[0].body.system).toBe("");
  });

  it("gives no suggestion when the backend can't be asked or fails", async () => {
    backend.token = null;
    expect(await suggestNextPrompt("codex:gpt", settings, turns)).toBe("");
    backend.token = "tok";
    backend.status = 502;
    expect(await suggestNextPrompt("codex:gpt", settings, turns)).toBe("");
  });

  it("waits for more than a single plain answer, as Claude Code does", async () => {
    const plain = [{ role: "user" as const, content: "¿Qué es un mutex?" }, { role: "assistant" as const, content: "Un cerrojo." }];
    expect(await suggestNextPrompt("anthropic:sonnet", settings, plain)).toBe("");
    const cut = [...turns.slice(0, 1), { ...turns[1], cutOff: { modelId: "anthropic:sonnet", thinking: false } }];
    expect(await suggestNextPrompt("anthropic:sonnet", settings, cut)).toBe("");
    expect(helper.calls).toHaveLength(0);
  });

  it("sends nothing anywhere once the chat used Gmail or Google Calendar", async () => {
    const withGmail = [
      { role: "user" as const, content: "Show me my emails with [Demo] in the subject" },
      { role: "assistant" as const, content: "\n\n⟦TOOL⟧t1⟦SEP⟧search_threads⟦SEP⟧Gmail (MCP)⟦/TOOL⟧\n\nYou have 3 emails." },
      { role: "user" as const, content: "Summarize the second one again" },
      { role: "assistant" as const, content: "It asks whether you are free on Friday." },
    ];
    expect(await suggestNextPrompt("codex:gpt", settings, withGmail)).toBe("");
    expect(await suggestNextPrompt("anthropic:sonnet", settings, withGmail)).toBe("");
    expect(backend.calls).toHaveLength(0);
    expect(helper.calls).toHaveLength(0);
  });
});

describe("replyText", () => {
  it("shows tool calls and failures as lines and drops reasoning", () => {
    const text = replyText(
      "⟦REASONING⟧r1⟦/REASONING⟧Abro el PR.\n\n⟦TOOL⟧t1⟦SEP⟧Bash⟦SEP⟧gh pr create --fill⟦/TOOL⟧\n\n⟦TOOLEND⟧t1⟦SEP⟧ok⟦/TOOLEND⟧"
      + "⟦TOOL⟧t2⟦SEP⟧Bash⟦SEP⟧npm test⟦/TOOL⟧⟦TOOLEND⟧t2⟦SEP⟧err⟦SEP⟧2 failing⟦/TOOLEND⟧⟦TODO⟧Hecho.",
    );
    expect(text).toContain("[tool Bash: gh pr create --fill]");
    expect(text).toContain("[tool failed: 2 failing]");
    expect(text).not.toMatch(/⟦|r1/);
  });
});

describe("cleanSuggestion", () => {
  it("keeps the first line without quotes or a label", () => {
    expect(cleanSuggestion('"Añade tests para esto"\nExplanation: it is useful')).toBe("Añade tests para esto");
    expect(cleanSuggestion("Sugerencia: Ejecuta los tests")).toBe("Ejecuta los tests");
    expect(cleanSuggestion("<suggestion>run the tests</suggestion>")).toBe("run the tests");
  });

  it("drops NONE and the ways a model says it has nothing", () => {
    for (const raw of ["NONE", " none. ", "(silence)", "Silencio", "No suggestion", "done", "Listo"]) expect(cleanSuggestion(raw)).toBe("");
  });

  it("drops a question, since the user would send a request", () => {
    expect(cleanSuggestion("¿Qué tal el resto de la release?")).toBe("");
    expect(cleanSuggestion("What else is left?")).toBe("");
    expect(cleanSuggestion("Sí, súbelo y saca la release")).toBe("Sí, súbelo y saca la release");
  });

  it("drops praise, the assistant's voice and other messages a user wouldn't send", () => {
    for (const raw of ["Looks good, thanks", "Perfecto, gracias", "Let me run the tests", "Voy a revisar el login", "Aquí está el plan", "Run the tests. Then push", "Run **all** tests", "Tests", "Note: run the tests"]) {
      expect(cleanSuggestion(raw)).toBe("");
    }
  });

  it("keeps short replies a user does send and requests that start with puedes", () => {
    expect(cleanSuggestion("Sí")).toBe("Sí");
    expect(cleanSuggestion("dale")).toBe("dale");
    expect(cleanSuggestion("/commit")).toBe("/commit");
    expect(cleanSuggestion("Puedes añadir los tests del login")).toBe("Puedes añadir los tests del login");
  });

  it("drops a guess too long to be a quick next message", () => {
    expect(cleanSuggestion("Please refactor the whole authentication module so that it uses the new token service everywhere")).toBe("");
  });

  it("removes Claude Code markers", () => {
    expect(cleanSuggestion("⟦REASONING⟧thinking⟦/REASONING⟧Run the build")).toBe("Run the build");
  });

  it("cuts only the placeholder preview at a word", () => {
    const out = previewSuggestion("Please refactor the whole authentication module so that it uses the new token service everywhere");
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });
});

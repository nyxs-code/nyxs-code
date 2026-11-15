import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  semanticSearch: false,
  provider: "backend",
  consent: undefined as "granted" | "declined" | undefined,
  invoked: [] as string[],
  embedRequests: 0,
}));

vi.mock("@/lib/ipc", () => ({
  invoke: async (cmd: string) => {
    fake.invoked.push(cmd);
    if (cmd === "rag_collect_chunks") return [];
    if (cmd === "rag_search") return [];
    if (cmd === "rag_store") return { chunks: 0, files: 0, model: "", dim: 0, exists: true };
    return null;
  },
}));
// A stand-in for the embeddings service: no real request leaves.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async () => {
    fake.embedRequests++;
    return { ok: true, status: 200, json: async () => ({ embeddings: [[1, 0]] }) };
  },
}));
vi.mock("@/lib/auth", () => ({ AUTH_BASE: "https://example.invalid", getToken: async () => "token" }));
vi.mock("@/lib/settingsRuntime", () => ({
  getMergedSnapshot: () => ({ rag: { provider: fake.provider } }),
  getSettingsForSource: async () => ({ privacy: { semanticSearch: fake.semanticSearch } }),
}));
vi.mock("@/lib/globalConfig", () => ({ getRagConsent: async () => fake.consent }));

const { ragIndex, ragQuery, ragServiceAllowed } = await import("@/lib/rag");

beforeEach(() => {
  fake.semanticSearch = false;
  fake.provider = "backend";
  fake.consent = undefined;
  fake.invoked = [];
  fake.embedRequests = 0;
});

describe("semantic search on the Nyxs service", () => {
  it("sends nothing while the setting is off", async () => {
    fake.consent = "granted";
    expect(await ragServiceAllowed("E:/proj")).toBe(false);
    await expect(ragIndex("E:/proj")).rejects.toThrow(/Privacy/);
    await expect(ragQuery("E:/proj", "where is login")).rejects.toThrow(/Privacy/);
    expect(fake.invoked).toEqual([]);
    expect(fake.embedRequests).toBe(0);
  });

  it("sends nothing for a project the user hasn't said to index", async () => {
    fake.semanticSearch = true;
    expect(await ragServiceAllowed("E:/proj")).toBe(false);
    fake.consent = "declined";
    expect(await ragServiceAllowed("E:/proj")).toBe(false);
    await expect(ragIndex("E:/proj")).rejects.toThrow();
    expect(fake.invoked).toEqual([]);
  });

  it("indexes a project the user said to index", async () => {
    fake.semanticSearch = true;
    fake.consent = "granted";
    expect(await ragServiceAllowed("E:/proj")).toBe(true);
    await ragIndex("E:/proj");
    expect(fake.invoked).toContain("rag_collect_chunks");
  });

  it("works locally with the mock provider, which sends nothing", async () => {
    fake.provider = "mock";
    expect(await ragServiceAllowed("E:/proj")).toBe(true);
    await ragQuery("E:/proj", "where is login");
    expect(fake.embedRequests).toBe(0);
  });
});

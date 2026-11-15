import { beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const fake = vi.hoisted(() => ({
  calls: [] as Call[],
  chunks: [] as { path: string; startLine: number; endLine: number; hash: string; text: string; known: boolean }[],
  embedRequests: [] as string[][],
  /** The embeddings request (1-based) that fails, if any. */
  failOn: 0,
}));

vi.mock("@/lib/ipc", () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    fake.calls.push({ cmd, args });
    if (cmd === "rag_collect_chunks") return fake.chunks;
    if (cmd === "rag_store") return { chunks: 0, files: 0, model: String(args.model), dim: 2, exists: true };
    return null;
  },
}));

// A stand-in for the embeddings service: no real request leaves.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async (_url: string, init: { body: string }) => {
    const input = (JSON.parse(init.body) as { input: string[] }).input;
    fake.embedRequests.push(input);
    if (fake.embedRequests.length === fake.failOn) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ embeddings: input.map(() => [1, 0]) }) };
  },
}));
vi.mock("@/lib/auth", () => ({ AUTH_BASE: "https://example.invalid", getToken: async () => "token" }));
vi.mock("@/lib/settingsRuntime", () => ({
  getMergedSnapshot: () => ({ rag: { provider: "backend", embeddingModel: "embed-1" } }),
  // Semantic search on, and this project allowed (see ragConsent.test.ts for when it isn't).
  getSettingsForSource: async () => ({ privacy: { semanticSearch: true } }),
}));
vi.mock("@/lib/globalConfig", () => ({ getRagConsent: async () => "granted" }));

const { ragIndex } = await import("@/lib/rag");

const chunk = (n: number, known = false) => ({
  path: `src/f${n}.ts`,
  startLine: 1,
  endLine: 50,
  hash: `h${n}`,
  text: known ? "" : `export const v${n} = ${n};`,
  known,
});
const stores = () => fake.calls.filter((c) => c.cmd === "rag_store").map((c) => c.args);

beforeEach(() => {
  fake.calls = [];
  fake.embedRequests = [];
  fake.failOn = 0;
});

describe("indexing the project", () => {
  it("keeps what was embedded before a batch failed", async () => {
    fake.chunks = Array.from({ length: 600 }, (_, i) => chunk(i));
    fake.failOn = 9;
    await expect(ragIndex("E:/proj")).rejects.toThrow(/503/);
    const saved = stores();
    expect(saved).toHaveLength(1);
    expect((saved[0].newEntries as unknown[]).length).toBe(512);
    expect((saved[0].current as unknown[]).length).toBe(600);
  });

  it("only sends new text to be embedded", async () => {
    fake.chunks = [chunk(1, true), chunk(2), chunk(3, true)];
    await ragIndex("E:/proj");
    expect(fake.calls[0]).toMatchObject({ cmd: "rag_collect_chunks", args: { model: "backend:embed-1" } });
    expect(fake.embedRequests).toEqual([["export const v2 = 2;"]]);
    const [saved] = stores();
    expect(saved.newEntries).toEqual([{ hash: "h2", vector: [1, 0] }]);
    expect(saved.current).toEqual([1, 2, 3].map((n) => ({ path: `src/f${n}.ts`, startLine: 1, endLine: 50, hash: `h${n}` })));
  });

  it("still updates the index when nothing is new, for files moved or deleted", async () => {
    fake.chunks = [{ ...chunk(1, true), path: "src/renamed.ts" }];
    await ragIndex("E:/proj");
    expect(fake.embedRequests).toEqual([]);
    const [saved] = stores();
    expect(saved.newEntries).toEqual([]);
    expect(saved.current).toEqual([{ path: "src/renamed.ts", startLine: 1, endLine: 50, hash: "h1" }]);
  });
});

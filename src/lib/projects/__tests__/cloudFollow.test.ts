import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@/lib/chatStore";
import type { CloudEvent } from "@/lib/cloud/cloudApi";

const api = vi.hoisted(() => ({
  createCloudThread: vi.fn(async () => ({ id: "cloud-1", status: "queued" })),
  sendCloudMessage: vi.fn(async () => ({ ok: true })),
  stopCloudThread: vi.fn(async () => ({ ok: true })),
  followCloudThread: vi.fn(async (_id: string, after: number, onEvent: (e: CloudEvent) => void) => {
    const at = "2026-11-26T10:00:00Z";
    onEvent({ seq: after + 1, at, type: "text", data: { text: "Done." } });
    onEvent({ seq: after + 2, at, type: "done", data: { status: "review", preview: "Fixed it", prUrl: "https://github.com/me/shop/pull/7", branch: "nyxs/fix-1" } });
    return after + 2;
  }),
}));

vi.mock("@/lib/cloud/cloudApi", () => ({ ...api, CloudError: class extends Error { status = 0; } }));
vi.mock("@/lib/models", () => ({
  getActiveModels: () => [
    { id: "anthropic:opus", apiModel: "opus", name: "Opus", provider: "anthropic", description: "" },
    { id: "ollama:qwen", apiModel: "qwen", name: "Qwen", provider: "ollama", description: "" },
  ],
  getModel: (id: string) => [{ id: "anthropic:opus", apiModel: "opus", name: "Opus", provider: "anthropic", description: "" }, { id: "ollama:qwen", apiModel: "qwen", name: "Qwen", provider: "ollama", description: "" }].find((m) => m.id === id),
}));
vi.mock("@/lib/cloud/cloudCredentials", () => ({
  cloudSupport: (p: string) => (p === "ollama" ? { ok: false, reason: "local" } : { ok: true, key: `provider:${p}` }),
  sanitizedCloudSettings: () => ({ providers: {} }),
}));

const { createCloudThreads } = await import("../cloudFollow");
const { resetProjectsForTests } = await import("../projectStore");

const project = {
  id: "p-1",
  name: "Shop",
  createdAt: 1,
  repos: [{ path: "C:\\code\\shop", gitUrl: "https://github.com/me/shop" }],
  instructions: "Use pnpm.",
  defaults: { where: "cloud" as const },
  coordinatorChatId: "coord",
  memoryPath: "x",
};

function harness() {
  const chats = new Map<string, Chat>([["coord", { id: "coord", title: "Shop", workspace: "C:\\code\\shop", messages: [], model: "anthropic:opus", projectId: "p-1", projectRole: "coordinator" }]]);
  const delivered: [string, string, string][] = [];
  const statuses: [string, string][] = [];
  const cloud = createCloudThreads({
    live: (id) => chats.get(id),
    ensureLoaded: async (id) => chats.has(id),
    addChat: async (c) => void chats.set(c.id, c),
    patchChat: (id, fn) => {
      const c = chats.get(id);
      if (c) chats.set(id, fn(c));
    },
    save: async () => {},
    setStatus: async (id, status, preview) => {
      statuses.push([id, status]);
      const c = chats.get(id);
      if (c) chats.set(id, { ...c, threadStatus: status, ...(preview !== undefined ? { threadPreview: preview } : {}) });
      return true;
    },
    deliver: async (id, text, status) => void delivered.push([id, text, status]),
    newId: () => "t-1",
    settings: () => ({}) as never,
    effectiveModel: () => "anthropic:opus",
  });
  return { cloud, chats, delivered, statuses };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  vi.clearAllMocks();
  resetProjectsForTests([project], { "p-1": "- memo" });
});

describe("cloud threads", () => {
  it("opens one in the cloud and mirrors its turn into a session that reports back", async () => {
    const { cloud, chats, delivered } = harness();
    const out = await cloud.start("coord", project, { title: "Fix login", instructions: "Fix it" });
    expect(out).toEqual({ id: "t-1", model: "Opus", effort: "default", where: "cloud" });
    expect(api.createCloudThread).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-1", title: "Fix login", repo: { url: "https://github.com/me/shop" }, model: { id: "anthropic:opus", provider: "anthropic" }, projectInstructions: "Use pnpm.", memory: "- memo" }),
    );
    await settle();
    const thread = chats.get("t-1")!;
    expect(thread).toMatchObject({ parentId: "coord", projectRole: "thread", threadLocation: { kind: "cloud", cloudThreadId: "cloud-1", branch: "nyxs/fix-1" }, threadCloudSeq: 2, threadStatus: "review", threadPrUrl: "https://github.com/me/shop/pull/7" });
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(thread.messages[1].content).toBe("Done.");
    expect(delivered).toEqual([["t-1", "Fixed it\n\nPull request: https://github.com/me/shop/pull/7", "review"]]);
  });

  it("says why it can't: no repository URL, or a model the cloud can't reach", async () => {
    const { cloud } = harness();
    const noRepo = await cloud.start("coord", { ...project, repos: [{ path: "C:\\code\\shop" }] }, { title: "x", instructions: "y" });
    expect(noRepo).toMatchObject({ error: expect.stringContaining("repository URL") });
    const local = await cloud.start("coord", project, { title: "x", instructions: "y", model: "Qwen" });
    expect(local).toMatchObject({ error: expect.stringContaining("can't reach") });
    expect(api.createCloudThread).not.toHaveBeenCalled();
  });

  it("sends a follow-up to the cloud instead of a local turn, and stops it", async () => {
    const { cloud, chats, statuses } = harness();
    await cloud.start("coord", project, { title: "Fix login", instructions: "Fix it" });
    await settle();
    const sent = await cloud.send("t-1", { id: "u2", role: "user", content: "Also the logout" }, "Also the logout");
    expect(sent).toBe(true);
    expect(api.sendCloudMessage).toHaveBeenCalledWith("cloud-1", "Also the logout");
    expect(chats.get("t-1")!.messages.some((m) => m.id === "u2")).toBe(true);
    expect(await cloud.send("coord", { id: "u3", role: "user", content: "x" }, "x")).toBe(false);
    await settle();
    expect(await cloud.stop("t-1")).toBe(true);
    expect(api.stopCloudThread).toHaveBeenCalledWith("cloud-1");
    expect(statuses.at(-1)).toEqual(["t-1", "idle"]);
    cloud.dispose();
  });
});

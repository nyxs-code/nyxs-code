import { beforeAll, describe, expect, it, vi } from "vitest";

/** Each write waits until the test lets it finish. */
const calls: Array<{ cmd: string; id?: unknown; json?: unknown; done: () => void }> = [];
vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(
    (cmd: string, args: { id?: unknown; json?: unknown } = {}) =>
      new Promise<null>((resolve) => calls.push({ cmd, id: args.id, json: args.json, done: () => resolve(null) })),
  ),
}));

type ChatStore = typeof import("@/lib/chatStore");
let store: ChatStore;

beforeAll(async () => {
  (globalThis as unknown as { window: Record<string, unknown> }).window = { __TAURI_INTERNALS__: {} };
  store = await import("@/lib/chatStore");
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const chat = (content: string) => ({ id: "c1", title: "t", messages: [{ id: "m1", role: "user", content }] }) as never;

describe("chat file writes", () => {
  it("sends a chat's next write only after the previous one answered, so they land in order", async () => {
    const first = store.saveChatFile(chat("first"));
    const second = store.saveChatFile(chat("second"));
    const gone = store.deleteChatFile("c1");
    await flush();
    expect(calls.map((c) => c.cmd)).toEqual(["nyxs_save_chat"]);
    calls[0].done();
    await first;
    await flush();
    expect(calls).toHaveLength(2);
    expect(String(calls[1].json)).toContain("second");
    calls[1].done();
    await second;
    await flush();
    expect(calls[2].cmd).toBe("nyxs_delete_chat");
    calls[2].done();
    await gone;
  });

  it("leaves old screenshots out of the chat's file", async () => {
    calls.length = 0;
    const jpeg = "J".repeat(1000);
    const turn = (n: number) => ({
      id: `a${n}`,
      role: "assistant",
      content: "",
      responseMessages: [{ role: "tool", content: [{ type: "tool-result", toolCallId: `c${n}`, toolName: "Computer", output: { type: "content", value: [{ type: "image-data", data: jpeg, mediaType: "image/jpeg" }] } }] }],
    });
    const saving = store.saveChatFile({ id: "c9", title: "t", messages: [0, 1, 2, 3, 4].map(turn) } as never);
    await flush();
    calls[0].done();
    await saving;
    expect(String(calls[0].json).split(jpeg).length - 1).toBe(3);
  });

  it("doesn't hold one chat's write behind another's", async () => {
    calls.length = 0;
    void store.saveChatFile(chat("a"));
    void store.saveChatFile({ ...(chat("b") as object), id: "c2" } as never);
    await flush();
    expect(calls.map((c) => c.id)).toEqual(["c1", "c2"]);
    for (const c of calls) c.done();
  });
});

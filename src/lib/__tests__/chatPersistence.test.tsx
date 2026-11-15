// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const disk = {
  index: null as string | null,
  chats: new Map<string, string>(),
  /** Commands that fail like a file another process holds open. */
  failing: new Set<string>(),
  saves: [] as string[],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    if (disk.failing.has(cmd)) throw new Error("The process cannot access the file (os error 32)");
    switch (cmd) {
      case "nyxs_load_chat_index":
        return disk.index ?? "";
      case "nyxs_load_chat":
        return disk.chats.get(String(args.id)) ?? "";
      case "nyxs_load_chats":
        return "";
      case "nyxs_save_chat_index":
        disk.saves.push("index");
        disk.index = String(args.json);
        return null;
      case "nyxs_save_chat":
        disk.saves.push(`chat ${String(args.id)}`);
        disk.chats.set(String(args.id), String(args.json));
        return null;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  }),
}));

type Store = typeof import("@/lib/useChatStore");
let useChatStore: Store["useChatStore"];

const INDEX = JSON.stringify({
  version: 2,
  activeId: "c1",
  chats: [{ id: "c1", title: "Primer chat", workspace: null }, { id: "c2", title: "Otro", workspace: null }],
});
const CHAT = JSON.stringify({ messages: [{ id: "m1", role: "user", content: "hola" }] });

/** Past the 800 ms debounce after which the store saves. */
const afterSaveDelay = () => act(() => new Promise((r) => setTimeout(r, 950)));

beforeAll(async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  ({ useChatStore } = await import("@/lib/useChatStore"));
});

beforeEach(() => {
  disk.index = null;
  disk.chats.clear();
  disk.failing.clear();
  disk.saves = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("chat persistence", () => {
  it("doesn't save an empty list over an index it couldn't read", async () => {
    disk.index = INDEX;
    disk.failing.add("nyxs_load_chat_index");
    const { result } = renderHook(() => useChatStore());
    await waitFor(() => expect(result.current.chatsReady).toBe(true));
    await afterSaveDelay();
    expect(disk.saves).not.toContain("index");
    expect(disk.index).toBe(INDEX);
  });

  it("doesn't save a chat it couldn't read as one with no messages", async () => {
    disk.index = INDEX;
    disk.chats.set("c1", CHAT);
    disk.failing.add("nyxs_load_chat");
    const { result } = renderHook(() => useChatStore());
    await waitFor(() => expect(result.current.chatsReady).toBe(true));
    await afterSaveDelay();
    expect(disk.saves).not.toContain("chat c1");
    expect(disk.chats.get("c1")).toBe(CHAT);
    expect(result.current.hydratedRef.current.has("c1")).toBe(false);
  });

  it("tells the user where a corrupt index was moved", async () => {
    const { currentFileNotice, dismissFileNotice } = await import("@/lib/fileNotices");
    disk.index = JSON.stringify({ version: 2, activeId: null, chats: [], setAside: "C:\\data\\chats\\index.json.corrupt" });
    const { result } = renderHook(() => useChatStore());
    await waitFor(() => expect(result.current.chatsReady).toBe(true));
    expect(currentFileNotice()).toEqual({
      kind: "chatIndexSetAside",
      file: "C:\\data\\chats\\index.json.corrupt",
      folder: "C:\\data\\chats",
    });
    dismissFileNotice();
  });

  it("rewrites only the chats that changed", async () => {
    disk.index = INDEX;
    disk.chats.set("c1", CHAT);
    disk.chats.set("c2", CHAT);
    const { result } = renderHook(() => useChatStore());
    await waitFor(() => expect(result.current.chatsReady).toBe(true));
    await act(() => result.current.ensureHydrated("c2").then(() => {}));
    await afterSaveDelay();
    disk.saves = [];
    act(() =>
      result.current.setChats((prev) =>
        prev.map((c) => (c.id === "c1" ? { ...c, messages: [...c.messages, { id: "m2", role: "assistant", content: "hola" } as never] } : c)),
      ),
    );
    await afterSaveDelay();
    // The index holds no messages, so it's the same and isn't written either.
    expect(disk.saves).toEqual(["chat c1"]);
  });

  it("saves during a long reply, whose chunks keep putting the save off", async () => {
    disk.index = INDEX;
    disk.chats.set("c1", CHAT);
    const { result } = renderHook(() => useChatStore());
    await waitFor(() => expect(result.current.chatsReady).toBe(true));
    await afterSaveDelay();
    disk.saves = [];
    vi.useFakeTimers();
    try {
      // A chunk every 200 ms for 6 s: each one used to restart the 800 ms wait.
      for (let i = 0; i < 30; i++) {
        await act(async () => {
          result.current.setChats((prev) =>
            prev.map((c) => (c.id === "c1" ? { ...c, messages: [{ id: "m1", role: "assistant", content: "x".repeat(i + 1) } as never] } : c)),
          );
          await vi.advanceTimersByTimeAsync(200);
        });
      }
      expect(disk.saves).toContain("chat c1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still saves when everything read fine", async () => {
    disk.index = INDEX;
    disk.chats.set("c1", CHAT);
    const { result } = renderHook(() => useChatStore());
    await waitFor(() => expect(result.current.chatsReady).toBe(true));
    expect(result.current.chats.find((c) => c.id === "c1")?.messages).toHaveLength(1);
    await afterSaveDelay();
    expect(disk.saves).toContain("index");
    expect(JSON.parse(disk.index!).chats).toHaveLength(2);
    expect(JSON.parse(disk.chats.get("c1")!).messages).toHaveLength(1);
  });
});

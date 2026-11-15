import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { chatViewsWorkspace } = await import("@/lib/useChatViews");

const chats = [
  { id: "a", workspace: "D:\\optimicer" },
  { id: "b", workspace: null },
];

describe("chatViewsWorkspace", () => {
  it("keeps a chat's panel on its own project while another project opens", () => {
    expect(chatViewsWorkspace(chats, "a", "D:\\storefront")).toBe("D:\\optimicer");
  });

  it("keeps a chat with no project without one", () => {
    expect(chatViewsWorkspace(chats, "b", "D:\\optimicer")).toBeNull();
  });

  it("gives a chat not created yet the open project", () => {
    expect(chatViewsWorkspace(chats, null, "D:\\storefront")).toBe("D:\\storefront");
    expect(chatViewsWorkspace(chats, "missing", "D:\\storefront")).toBe("D:\\storefront");
    expect(chatViewsWorkspace([{ id: "old" }], "old", "D:\\storefront")).toBe("D:\\storefront");
  });
});

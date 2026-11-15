// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Chat } from "@/lib/chatStore";
import { chatModeOf } from "@/lib/chatModes";
import { checkPermission } from "@/lib/permissions";
import { setSessionBridge, type SessionBridge } from "@/lib/sessionBridge";
import { SESSION_TOOLS } from "@/lib/sessionTools";
import { useChatModeAndModel } from "@/lib/useChatModeAndModel";

const chats = [
  { id: "s1", title: "Here", workspace: "E:/ws", messages: [], model: "m", permissionMode: "auto" },
  { id: "s2", title: "There", workspace: "E:/ws", messages: [], model: "m", permissionMode: "skip" },
] as unknown as Chat[];

function mount() {
  return renderHook(() =>
    useChatModeAndModel({
      activeId: "s1",
      liveChatsRef: { current: chats },
      liveActiveIdRef: { current: "s1" },
      setChats: () => {},
      allowPermissionBypass: true,
      promptEnableBypass: () => {},
    }),
  );
}

describe("SendToSession with the app's chat modes", () => {
  it("asks before handing work to a session that may do more", async () => {
    const view = mount();
    setSessionBridge({ send: vi.fn(async () => "sent") } as unknown as SessionBridge);
    const asked: string[] = [];
    // The app's gate: the sender's mode, and the user saying no to whatever is asked.
    const gate = async (tool: string, input: Record<string, unknown>) => {
      const decision = checkPermission(tool, input, view.result.current.chatModeOf("s1"), []);
      if (decision === "ask") asked.push(tool);
      return decision === "allow" ? null : "Permission denied by the user for this SendToSession action.";
    };
    const send = SESSION_TOOLS.find((d) => d.name === "SendToSession")!;
    await expect(send.run({ session_id: "s2", message: "deploy" }, { chat: "s1", gate })).rejects.toThrow(/Permission denied/);
    expect(asked).toEqual(["SendToSession"]);
    setSessionBridge(null);
  });

  it("stops telling the modes once the app is gone", () => {
    const view = mount();
    expect(chatModeOf("s2")).toBe("skip");
    view.unmount();
    expect(chatModeOf("s2")).toBeUndefined();
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { checkPermission } from "@/lib/permissions";
import { setChatModeResolver } from "@/lib/chatModes";
import { setSessionBridge, type SessionBridge } from "@/lib/sessionBridge";
import { SESSION_TOOLS } from "@/lib/sessionTools";

const send = (target_mode?: string) => ({ session_id: "s2", message: "run the deploy", ...(target_mode ? { target_mode } : {}) });

afterEach(() => {
  setChatModeResolver(null);
  setSessionBridge(null);
});

describe("SendToSession and the other session's permission mode", () => {
  it("asks when the session it writes to may do more than this one", () => {
    expect(checkPermission("SendToSession", send("skip"), "auto", [])).toBe("ask");
    expect(checkPermission("SendToSession", send("auto"), "acceptEdits", [])).toBe("ask");
    expect(checkPermission("mcp__nyxs-sessions__send_to_session", send("skip"), "auto", [])).toBe("ask");
  });

  it("goes as before when that session may do as much or less", () => {
    expect(checkPermission("SendToSession", send("ask"), "auto", [])).toBe("allow");
    expect(checkPermission("SendToSession", send("auto"), "auto", [])).toBe("allow");
    expect(checkPermission("SendToSession", send(), "auto", [])).toBe("allow");
    expect(checkPermission("SendToSession", send("skip"), "plan", [])).toBe("deny");
  });

  it("tells the gate the mode of the session it writes to", async () => {
    setChatModeResolver((id) => (id === "s2" ? "skip" : "ask"));
    setSessionBridge({ send: vi.fn(async () => "sent") } as unknown as SessionBridge);
    const gate = vi.fn(async () => null);
    await SESSION_TOOLS.find((d) => d.name === "SendToSession")!.run({ session_id: "s2", message: "hi" }, { chat: "s1", gate });
    expect(gate).toHaveBeenCalledWith("SendToSession", { session_id: "s2", message: "hi", target_mode: "skip" });
  });
});

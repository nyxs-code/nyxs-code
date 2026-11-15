import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
const stopHandlers: ((e: { payload: string }) => void)[] = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, cb: (e: { payload: string }) => void) => {
    stopHandlers.push(cb);
    return () => undefined;
  },
}));
const abortChatTurn = vi.fn();
vi.mock("@/lib/turnAborts", () => ({ abortChatTurn: (id: string) => abortChatTurn(id) }));

import { checkPermission, permissionKey } from "@/lib/permissions";
import { describeComputerCall } from "@/lib/toolDetail";
import { handleComputerMcp } from "@/lib/computerMcp";
import { computerModelOutput, createComputerTool, releaseComputer, toNativeAction } from "@/tools/Computer/tool";
import type { ToolContext } from "@/tools/context";

const display = { index: 0, primary: true, x: 0, y: 0, width: 2560, height: 1440, shotWidth: 1280, shotHeight: 720 };
const shot = { data: "AAAA", width: 1280, height: 720, display, displays: [display], cursor: [10, 20] };

function run(input: Record<string, unknown>, allowImages = true) {
  const t = createComputerTool({ allowImages, nativeToolImages: true, sessionKey: "chat-1" } as unknown as ToolContext);
  return t.execute!(input as never, { toolCallId: "c1", messages: [] });
}

beforeEach(() => {
  invoke.mockReset();
  abortChatTurn.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "computer_screenshot" ? shot : cmd === "computer_element" ? "Clicked element 3." : undefined));
});

describe("toNativeAction", () => {
  it("maps clicks with their button, count and held modifiers", () => {
    expect(toNativeAction({ action: "left_click", coordinate: [5, 6] })).toEqual({ kind: "click", x: 5, y: 6, button: "left", modifiers: undefined });
    expect(toNativeAction({ action: "double_click", coordinate: [1, 2], text: "ctrl" })).toMatchObject({ count: 2, modifiers: "ctrl" });
    expect(toNativeAction({ action: "right_click" })).toEqual({ kind: "click", button: "right", modifiers: undefined });
  });

  it("turns scroll directions into signed wheel clicks", () => {
    expect(toNativeAction({ action: "scroll", coordinate: [0, 0], scroll_direction: "up", scroll_amount: 5 })).toMatchObject({ dx: 0, dy: -5 });
    expect(toNativeAction({ action: "scroll", scroll_direction: "right" })).toMatchObject({ dx: 3, dy: 0 });
  });

  it("says what is missing instead of acting", () => {
    expect(toNativeAction({ action: "left_click_drag", coordinate: [1, 1] })).toMatch(/start_coordinate/);
    expect(toNativeAction({ action: "key" })).toMatch(/needs text/);
    expect(toNativeAction({ action: "mouse_move" })).toMatch(/coordinate/);
  });

  it("caps hold_key at ten seconds", () => {
    expect(toNativeAction({ action: "hold_key", text: "shift", duration: 60 })).toEqual({ kind: "hold_key", keys: "shift", ms: 10_000 });
  });
});

describe("Computer tool", () => {
  it("acts, then answers with a fresh screenshot", async () => {
    const out = await run({ action: "left_click", coordinate: [100, 200] });
    expect(invoke).toHaveBeenCalledWith("computer_act", { chat: "chat-1", display: null, action: { kind: "click", x: 100, y: 200, button: "left", modifiers: undefined } });
    expect(out).toMatchObject({ kind: "shot", data: "AAAA" });
    expect((out as { text: string }).text).toContain("pointer at (10, 20)");
  });

  it("refuses screenshots for a model that can't see, but still acts", async () => {
    expect(await run({ action: "screenshot" }, false)).toMatchObject({ kind: "error" });
    const out = await run({ action: "key", text: "ctrl+s" }, false);
    expect(out).toMatchObject({ kind: "text" });
    expect(invoke).not.toHaveBeenCalledWith("computer_screenshot", expect.anything());
  });

  it("returns native errors as error text", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "computer_act") throw new Error("blocked");
    });
    expect(await run({ action: "type", text: "hi" })).toEqual({ kind: "error", message: "blocked" });
  });

  it("lists windows with their ids", async () => {
    invoke.mockImplementation(async (cmd: string) => cmd === "computer_windows" ? [{ id: 42, title: "Notepad", process: "notepad.exe", x: 0, y: 0, width: 1, height: 1, minimized: false, focused: true }] : undefined);
    const out = await run({ action: "list_windows" });
    expect((out as { text: string }).text).toContain('window_id 42: "Notepad" (notepad.exe) [focused]');
  });

  it("reads a window's controls and acts on one by number", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "computer_window_state"
        ? { windowId: 7, title: "Bloc de notas", tree: '[0] edit "Texto"\n[1] button "Guardar"', count: 2, truncated: false }
        : cmd === "computer_screenshot" ? shot : cmd === "computer_element" ? "Clicked element 1." : undefined,
    );
    const state = await run({ action: "get_window_state", window_id: 7 });
    expect((state as { text: string }).text).toContain('[1] button "Guardar"');
    await run({ action: "click_element", window_id: 7, element_index: 1, click_count: 2 });
    expect(invoke).toHaveBeenCalledWith("computer_element", { chat: "chat-1", window: 7, index: 1, action: "double_click", text: null });
    await run({ action: "set_value", window_id: 7, element_index: 0, text: "hola" });
    expect(invoke).toHaveBeenCalledWith("computer_element", { chat: "chat-1", window: 7, index: 0, action: "set_value", text: "hola" });
    expect(await run({ action: "click_element", window_id: 7 })).toMatchObject({ kind: "error" });
  });

  it("ends the holder's turn on Esc and lets go of the computer when a turn ends", async () => {
    await run({ action: "screenshot" });
    for (const h of stopHandlers) h({ payload: "chat-1" });
    expect(abortChatTurn).toHaveBeenCalledWith("chat-1");
    await run({ action: "screenshot" });
    releaseComputer("chat-1");
    expect(invoke).toHaveBeenCalledWith("computer_release", { chat: "chat-1" });
    invoke.mockClear();
    releaseComputer("chat-1");
    expect(invoke).not.toHaveBeenCalledWith("computer_release", expect.anything());
  });

  it("asks the permission gate before acting, and does nothing when denied", async () => {
    const gate = vi.fn(async () => false);
    const t = createComputerTool({ allowImages: true, nativeToolImages: true, sessionKey: "chat-1", gate } as unknown as ToolContext);
    const out = await t.execute!({ action: "left_click", coordinate: [1, 2] } as never, { toolCallId: "c2", messages: [] });
    expect(gate).toHaveBeenCalledWith("Computer", { action: "left_click", coordinate: [1, 2] });
    expect(out).toMatchObject({ kind: "error", message: expect.stringMatching(/Permission denied/) });
    expect(invoke).not.toHaveBeenCalledWith("computer_act", expect.anything());
  });

  it("refuses to act in plan mode even without a gate, but still looks", async () => {
    const t = createComputerTool({ allowImages: true, nativeToolImages: true, sessionKey: "chat-1", planMode: true } as unknown as ToolContext);
    const exec = (input: Record<string, unknown>) => t.execute!(input as never, { toolCallId: "c3", messages: [] });
    expect(await exec({ action: "type", text: "hi" })).toMatchObject({ kind: "error", message: expect.stringMatching(/plan mode/) });
    expect(invoke).not.toHaveBeenCalledWith("computer_act", expect.anything());
    expect(await exec({ action: "screenshot" })).toMatchObject({ kind: "shot" });
  });

  it("sends the screenshot to the model as an image", () => {
    const o = computerModelOutput({ kind: "shot", text: "Screenshot", data: "AAAA", mediaType: "image/jpeg" }, true);
    expect(o).toEqual({ type: "content", value: [{ type: "text", text: "Screenshot" }, { type: "image-data", data: "AAAA", mediaType: "image/jpeg" }] });
  });
});

describe("Computer permissions", () => {
  const check = (action: string, mode: string) => checkPermission("Computer", { action }, mode as never, []);

  it("lets the agent look without asking", () => {
    expect(check("screenshot", "ask")).toBe("allow");
    expect(check("list_windows", "plan")).toBe("allow");
  });

  it("asks before using the mouse or keyboard unless the mode acts alone", () => {
    expect(check("left_click", "ask")).toBe("ask");
    expect(check("type", "acceptEdits")).toBe("ask");
    expect(check("type", "plan")).toBe("deny");
    expect(check("key", "auto")).toBe("allow");
    expect(check("key", "skip")).toBe("allow");
  });

  it("honors rules on the action", () => {
    expect(permissionKey("Computer", { action: "type" })).toBe("type");
    expect(checkPermission("Computer", { action: "type" }, "ask", [{ toolName: "Computer", behavior: "allow" }])).toBe("allow");
    expect(checkPermission("Computer", { action: "key" }, "skip", [{ toolName: "Computer", ruleContent: "key", behavior: "deny" }])).toBe("deny");
  });
});

describe("computer MCP server", () => {
  it("lists one tool with a JSON schema and runs it for the asking chat", async () => {
    const list = (await handleComputerMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["computer"]);
    expect(Object.keys(list.result.tools[0].inputSchema.properties)).toContain("element_index");
    const call = (await handleComputerMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "computer", arguments: { action: "screenshot" } } },
      "chat-9",
    )) as { result: { content: { type: string }[] } };
    expect(call.result.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(invoke).toHaveBeenCalledWith("computer_screenshot", { chat: "chat-9", display: null, region: null });
  });

  it("refuses everything but looking while the chat is in plan mode", async () => {
    const { noteVideoChatTurn } = await import("@/lib/video/videoControl");
    noteVideoChatTurn("chat-plan", "plan");
    try {
      const call = (action: string) =>
        handleComputerMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "computer", arguments: { action, text: "x" } } }, "chat-plan") as Promise<{
          result: { content: { text: string }[]; isError?: boolean };
        }>;
      const typed = await call("type");
      expect(typed.result.isError).toBe(true);
      expect(typed.result.content[0].text).toMatch(/plan mode/);
      expect(invoke).not.toHaveBeenCalledWith("computer_act", expect.anything());
      expect((await call("screenshot")).result.isError).toBeUndefined();
    } finally {
      noteVideoChatTurn("chat-plan", "ask");
    }
  });

  it("is gated like the built-in tool", () => {
    const name = "mcp__nyxs-computer__computer";
    expect(checkPermission(name, { action: "get_window_state" }, "ask", [])).toBe("allow");
    expect(checkPermission(name, { action: "click_element" }, "ask", [])).toBe("ask");
  });
});

describe("describeComputerCall", () => {
  it("names the action and its target", () => {
    expect(describeComputerCall({ action: "left_click", coordinate: [3, 4] })).toBe("left_click (3, 4)");
    expect(describeComputerCall({ action: "type", text: "hola" })).toBe('type "hola"');
    expect(describeComputerCall({ action: "scroll", scroll_direction: "up", coordinate: [1, 2] })).toBe("scroll up (1, 2)");
  });
});

describe("the Computer tool's description per desktop", () => {
  it("speaks macOS on a Mac and Windows on Windows", async () => {
    const { getComputerDescription } = await import("@/tools/Computer/prompt");
    const mac = getComputerDescription("Bash", "macos");
    expect(mac).toContain("cmd+space");
    expect(mac).toContain("Accessibility");
    expect(mac).toContain("Finder");
    expect(mac).not.toMatch(/UI Automation|ctrl\+|Start-Process/);
    const win = getComputerDescription("Bash", "windows");
    expect(win).toContain("UI Automation");
    expect(win).toContain("ctrl+s");
    expect(win).not.toMatch(/cmd\+|Finder/);
  });
});

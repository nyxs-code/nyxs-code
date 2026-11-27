import { describe, it, expect, vi, beforeEach } from "vitest";

const exec = vi.fn();
const navigate = vi.fn();
const previewChats: (string | undefined)[] = [];
const addressed: [string, string | undefined][] = [];
const tab = { exec, navigate, reload: vi.fn(), info: () => ({ kind: "local", url: "" }), bounds: () => null };
vi.mock("@/lib/previewControl", () => ({
  ensurePreview: async (chat?: string) => {
    previewChats.push(chat);
    return tab;
  },
  previewForAddress: async (address: string, chat?: string) => {
    addressed.push([address, chat]);
    return tab;
  },
  previewWorkspace: () => null,
}));

import { handleBrowserMcp } from "@/lib/browserMcp";
import { BROWSER_TOOLS, browserToolFor, builtinBrowserToolName } from "@/lib/browserTools";
import { registerChatTurn } from "@/lib/chatMcp";
import { planToolResultPruning } from "@/lib/microcompact";
import { checkPermission } from "@/lib/permissions";
import { describeToolCall } from "@/lib/toolDetail";
import { addBrowserTools } from "@/tools/Browser/tool";
import type { ToolContext } from "@/tools/context";
import type { ToolSet } from "ai";

beforeEach(() => {
  exec.mockReset();
  navigate.mockReset();
});

describe("browser MCP server", () => {
  it("lists every browser tool with its schema", async () => {
    const res = (await handleBrowserMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string; inputSchema: unknown }[] } };
    const names = res.result.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["navigate", "snapshot", "find", "click", "fill", "fill_form", "upload", "press_key", "eval", "console_logs", "screenshot", "zoom", "click_at", "batch"]),
    );
    expect(res.result.tools.every((t) => t.inputSchema)).toBe(true);
  });

  it("answers initialize with the client's protocol version", async () => {
    const res = (await handleBrowserMcp({ jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "2025-03-26" } })) as { id: string; result: { protocolVersion: string } };
    expect(res.id).toBe("a");
    expect(res.result.protocolVersion).toBe("2025-03-26");
  });

  it("acknowledges notifications without a reply of their own", async () => {
    expect(await handleBrowserMcp({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({ jsonrpc: "2.0", id: 0, result: {} });
  });

  it("runs a tool in the page and returns its text", async () => {
    exec.mockResolvedValue('- button "Guardar" [ref=e1]');
    const res = (await handleBrowserMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "click", arguments: { ref: "e1" } } })) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(exec).toHaveBeenCalledWith("click", { ref: "e1" }, undefined);
    expect(res.result.content[0].text).toContain("Guardar");
    expect(res.result.isError).toBeUndefined();
  });

  it("reports a failing tool as a tool error, not a protocol error", async () => {
    exec.mockRejectedValue(new Error("Unknown ref e9. Take a new snapshot first."));
    const res = (await handleBrowserMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "click", arguments: { ref: "e9" } } })) as { result: { content: { text: string }[]; isError: boolean } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/new snapshot/);
  });

  it("puts headless Antigravity's calls through its chat's permission mode", async () => {
    exec.mockResolvedValue("ok");
    // The chat in "ask" mode: what the app's gate does, the user denying whatever is asked.
    const asked: string[] = [];
    const gate = vi.fn(async (tool: string, input: unknown) => {
      const decision = checkPermission(tool, input, "ask", []);
      if (decision === "ask") asked.push(tool);
      return decision === "allow";
    });
    const turn = registerChatTurn("chat-g", { gate, conversationId: "conv-1" });
    const call = (name: string, conversation?: string) =>
      handleBrowserMcp({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name, arguments: { ref: "e1" }, ...(conversation ? { _meta: { "antigravity.google/conversation_id": conversation } } : {}) },
      }) as Promise<{ result: { content: { text: string }[]; isError?: boolean } }>;
    try {
      // Reading the page never asks, and runs in the turn's own chat.
      expect((await call("snapshot", "conv-1")).result.isError).toBeUndefined();
      expect(exec).toHaveBeenLastCalledWith("snapshot", { ref: "e1" }, undefined);
      expect(previewChats.at(-1)).toBe("chat-g");
      // Acting on it asks; denied, nothing runs.
      const denied = await call("click", "conv-1");
      expect(denied.result.isError).toBe(true);
      expect(denied.result.content[0].text).toMatch(/denied/);
      expect(asked).toEqual(["mcp__nyxs-browser__click"]);
      expect(exec).toHaveBeenCalledTimes(1);
      // Claude Code (no Antigravity conversation) asked through its own request already, and
      // another agy conversation (a terminal run) is no Nyxs turn's.
      gate.mockClear();
      await call("click");
      await call("click", "conv-other");
      expect(gate).not.toHaveBeenCalled();
      expect(exec).toHaveBeenCalledTimes(3);
    } finally {
      turn.release();
    }
  });

  it("asks headless Antigravity for each step of a batch, not for the batch", async () => {
    exec.mockResolvedValue("ok");
    const asked: string[] = [];
    const gate = vi.fn(async (tool: string, input: unknown) => {
      const decision = checkPermission(tool, input, "ask", []);
      if (decision === "ask") asked.push(tool);
      return decision === "allow";
    });
    const turn = registerChatTurn("chat-h", { gate, conversationId: "conv-2" });
    try {
      const res = (await handleBrowserMcp({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "batch",
          arguments: { actions: [{ tool: "snapshot" }, { tool: "click", input: { ref: "e1" } }] },
          _meta: { "antigravity.google/conversation_id": "conv-2" },
        },
      })) as { result: { content: { text: string }[] } };
      expect(gate.mock.calls.map((c) => c[0])).toEqual(["mcp__nyxs-browser__snapshot", "mcp__nyxs-browser__click"]);
      expect(asked).toEqual(["mcp__nyxs-browser__click"]);
      expect(exec.mock.calls.map((c) => c[0])).toEqual(["snapshot"]);
      expect(res.result.content[0].text).toMatch(/2\. click: Permission denied/);
    } finally {
      turn.release();
    }
  });

  it("rejects unknown tools and methods", async () => {
    expect(await handleBrowserMcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } })).toHaveProperty("error.code", -32602);
    expect(await handleBrowserMcp({ jsonrpc: "2.0", id: 5, method: "resources/list" })).toHaveProperty("error.code", -32601);
  });
});

describe("browser tool names and permissions", () => {
  it("knows a tool by its built-in and its Claude Code name", () => {
    expect(builtinBrowserToolName("press_key")).toBe("BrowserPressKey");
    expect(browserToolFor("BrowserPressKey")?.name).toBe("press_key");
    expect(browserToolFor("mcp__nyxs-browser__press_key")?.name).toBe("press_key");
    expect(browserToolFor("mcp__other__press_key")).toBeUndefined();
  });

  it("lets the agent look at the page without asking, in every mode", () => {
    for (const mode of ["ask", "plan", "acceptEdits", "auto", "skip"] as const) {
      expect(checkPermission("mcp__nyxs-browser__snapshot", {}, mode, [])).toBe("allow");
      expect(checkPermission("BrowserConsoleLogs", {}, mode, [])).toBe("allow");
    }
  });

  it("asks before acting on the page only when the mode asks for everything", () => {
    expect(checkPermission("mcp__nyxs-browser__click", { ref: "e1" }, "ask", [])).toBe("ask");
    expect(checkPermission("BrowserEval", { expression: "1" }, "plan", [])).toBe("ask");
    expect(checkPermission("mcp__nyxs-browser__click", { ref: "e1" }, "acceptEdits", [])).toBe("allow");
    expect(checkPermission("BrowserFill", { ref: "e1", value: "x" }, "auto", [])).toBe("allow");
    expect(checkPermission("BrowserClick", {}, "ask", [{ toolName: "BrowserClick", behavior: "deny" }])).toBe("deny");
  });

  it("shows browser calls in the chat by what they did", () => {
    expect(describeToolCall("mcp__nyxs-browser__navigate", { url: "http://localhost:1420" })).toEqual({ name: "Browser", detail: "navigate · http://localhost:1420" });
    expect(describeToolCall("BrowserSnapshot", {})).toEqual({ name: "Browser", detail: "snapshot" });
  });
});

describe("browser tools that save round trips", () => {
  const run = (name: string, input: Record<string, unknown>) => BROWSER_TOOLS.find((d) => d.name === name)!.run(input);

  it("follows an action that navigated with what the new page shows", async () => {
    exec.mockImplementation(async (cmd: string) => (cmd === "click" ? "Done. The page navigated to http://localhost:3000/ok." : '- heading "Gracias" [ref=e1]'));
    const out = await run("click", { ref: "e4" });
    expect(exec).toHaveBeenNthCalledWith(2, "snapshot", {});
    expect(out.text).toMatch(/navigated to http:\/\/localhost:3000\/ok\.\n\n- heading "Gracias"/);
  });

  it("follows a page that loaded with its snapshot", async () => {
    navigate.mockResolvedValue("Loaded http://localhost:5173/.");
    exec.mockResolvedValue('- button "Entrar" [ref=e1]');
    const out = await run("navigate", { url: "http://localhost:5173" });
    expect(out.text).toBe('Loaded http://localhost:5173/.\n\n- button "Entrar" [ref=e1]');
  });

  it("lets the address choose the tab a page opens in, and reloads the tab it works in", async () => {
    navigate.mockResolvedValue("Loaded https://example.com/.");
    exec.mockResolvedValue("page");
    addressed.length = 0;
    await BROWSER_TOOLS.find((d) => d.name === "navigate")!.run({ url: " https://example.com " }, "chat-a");
    expect(addressed).toEqual([["https://example.com", "chat-a"]]);
    expect(navigate).toHaveBeenCalledWith("https://example.com");
    addressed.length = 0;
    tab.reload.mockResolvedValue("Reloaded https://example.com/.");
    await BROWSER_TOOLS.find((d) => d.name === "navigate")!.run({}, "chat-a");
    expect(addressed).toEqual([]);
    expect(tab.reload).toHaveBeenCalled();
  });

  it("runs a batch in order and says what each step did", async () => {
    exec.mockImplementation(async (cmd: string, args: { ref?: string }) => `${cmd} ${args.ref ?? ""}`.trim());
    const out = await run("batch", {
      actions: [
        { tool: "fill", input: { ref: "e1", value: "ana" } },
        { tool: "BrowserClick", input: { ref: "e2" } },
        { tool: "mcp__nyxs-browser__press_key", input: { key: "Enter" } },
      ],
    });
    expect(exec.mock.calls.map((c) => c[0])).toEqual(["fill", "click", "press"]);
    expect(out.text).toBe("1. fill: fill e1\n\n2. click: click e2\n\n3. press_key: press");
  });

  it("stops a batch at the first failure and names what didn't run", async () => {
    exec.mockImplementation(async (cmd: string) => {
      if (cmd === "click") throw new Error("button \"Pagar\" is covered by dialog \"Cookies\" at its center.");
      return "ok";
    });
    await expect(
      run("batch", { actions: [{ tool: "fill", input: { ref: "e1", value: "x" } }, { tool: "click", input: { ref: "e2" } }, { tool: "click", input: { ref: "e3" } }] }),
    ).rejects.toThrow(/1\. fill: ok\n\n2\. click failed: .*covered by dialog "Cookies".* The other 1 action wasn't run\./s);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("stops a batch when the page navigates, since the next refs are gone", async () => {
    exec.mockImplementation(async (cmd: string) => (cmd === "click" ? "Done. The page navigated to http://x/." : "page"));
    const out = await run("batch", { actions: [{ tool: "click", input: { ref: "e2" } }, { tool: "click", input: { ref: "e5" } }] });
    expect(exec.mock.calls.map((c) => c[0])).toEqual(["click", "snapshot"]);
    expect(out.text).toMatch(/the other 1 action wasn't run: their refs belong to the old page/);
  });

  it("refuses a batch inside a batch", async () => {
    await expect(run("batch", { actions: [{ tool: "batch", input: { actions: [] } }] })).rejects.toThrow(/no such browser tool/);
  });

  it("shows the new tools in the chat by what they did", () => {
    expect(describeToolCall("BrowserFind", { query: "guardar" })).toEqual({ name: "Browser", detail: "find · guardar" });
    expect(describeToolCall("BrowserFillForm", { fields: [{}, {}] })).toEqual({ name: "Browser", detail: "fill_form · 2 fields" });
    expect(describeToolCall("BrowserBatch", { actions: [{}] })).toEqual({ name: "Browser", detail: "batch · 1 action" });
    expect(describeToolCall("BrowserClickAt", { x: 10.4, y: 20 })).toEqual({ name: "Browser", detail: "click_at · 10, 20" });
  });

  it("asks before a batch when the mode asks for every action", () => {
    expect(checkPermission("BrowserBatch", { actions: [] }, "ask", [])).toBe("ask");
    expect(checkPermission("BrowserFind", { query: "x" }, "ask", [])).toBe("allow");
    expect(checkPermission("BrowserZoom", {}, "plan", [])).toBe("allow");
  });

  it("puts the built-in models' browser calls through the permission gate", async () => {
    exec.mockResolvedValue("ok");
    const gate = vi.fn(async (tool: string) => tool !== "BrowserClick");
    const tools: ToolSet = {};
    addBrowserTools(tools, { allowImages: true, nativeToolImages: true, browserChat: "chat-b", gate } as unknown as ToolContext);
    const call = (name: string, input: Record<string, unknown>) =>
      (tools[name].execute as unknown as (i: unknown, o: unknown) => Promise<{ text: string }>)(input, { toolCallId: "t1", messages: [] });
    const denied = await call("BrowserClick", { ref: "e1" });
    expect(gate).toHaveBeenCalledWith("BrowserClick", { ref: "e1" });
    expect(denied.text).toMatch(/Permission denied/);
    expect(exec).not.toHaveBeenCalled();
    expect((await call("BrowserFill", { ref: "e1", value: "x" })).text).toBe("ok");
    expect(exec).toHaveBeenCalledWith("fill", { ref: "e1", value: "x" }, undefined);
  });

  it("asks for each step of a batch under that step's own tool name", async () => {
    exec.mockImplementation(async (cmd: string) => cmd);
    const gate = vi.fn(async (tool: string) => tool !== "BrowserClick");
    const tools: ToolSet = {};
    addBrowserTools(tools, { allowImages: true, nativeToolImages: true, browserChat: "chat-b", gate } as unknown as ToolContext);
    const out = await (tools.BrowserBatch.execute as unknown as (i: unknown, o: unknown) => Promise<{ text: string }>)(
      { actions: [{ tool: "fill", input: { ref: "e1", value: "ana" } }, { tool: "click", input: { ref: "e2" } }, { tool: "press_key", input: { key: "Enter" } }] },
      { toolCallId: "t2", messages: [] },
    );
    expect(gate.mock.calls.map((c) => c[0])).toEqual(["BrowserFill", "BrowserClick"]);
    expect(gate).toHaveBeenCalledWith("BrowserClick", { ref: "e2" });
    expect(exec.mock.calls.map((c) => c[0])).toEqual(["fill"]);
    expect(out.text).toMatch(/1\. fill: fill\n\n2\. click: Permission denied.*The other 1 action wasn't run\./s);
  });

  it("lets context pruning drop old snapshots and screenshots", () => {
    const big = "x".repeat(40_000);
    const messages = [
      { role: "tool", content: [{ type: "tool-result", toolCallId: "s1", toolName: "BrowserSnapshot", output: { type: "text", value: big } }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "p1",
            toolName: "BrowserScreenshot",
            output: { type: "content", value: [{ type: "text", text: "Screenshot" }, { type: "image-data", data: "a".repeat(100_000), mediaType: "image/jpeg" }] },
          },
        ],
      },
      ...Array.from({ length: 6 }, (_, i) => ({
        role: "tool",
        content: [{ type: "tool-result", toolCallId: `r${i}`, toolName: "Read", output: { type: "text", value: big } }],
      })),
    ] as never;
    const plan = planToolResultPruning(messages, { usedTokens: 90_000, contextWindow: 100_000 });
    expect(plan.prune.s1).toBeDefined();
    expect(plan.prune.p1).toBe("clear");
  });
});

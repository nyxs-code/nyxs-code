// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMcpToolsCache, saveMcpServers, type McpServer } from "@/lib/mcp";
import { chatUsedGoogleData, connectorMcpHandler, hostedConnectors, lendConnectorAsk } from "@/lib/connectorsMcp";
import { hostedMcpHandler } from "@/lib/browserMcp";

const reply = (id: unknown, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json" } });

/** Gmail's remote server, asking to confirm before it reads a thread. */
function fakeGmail() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ method: body.method, params: body.params ?? {} });
    if (body.method === "initialize") return reply(body.id, { protocolVersion: "2025-06-18", capabilities: {} });
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      return reply(body.id, { tools: [{ name: "get_thread", description: "Reads a thread", inputSchema: { type: "object", properties: { thread_id: { type: "string" } } } }] });
    }
    if (!body.params.inputResponses) {
      return reply(body.id, {
        resultType: "input_required",
        requestState: "s1",
        inputRequests: {
          approval_choice: {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: "Read *Invoice March*",
              requestedSchema: { type: "object", properties: { approval_choice: { type: "string", title: "Allow?", enum: ["ALLOW_ONCE", "DENY_ONCE"], enumNames: ["Allow once", "Don't allow"] } } },
            },
          },
        },
      });
    }
    return reply(body.id, { content: [{ type: "text", text: "thread body" }] });
  });
  return { fetchImpl, calls };
}

const gmail: McpServer = { id: "g1", name: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", enabled: true };

beforeEach(() => {
  clearMcpToolsCache();
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("the user's connectors for Claude Code", () => {
  it("are the enabled ones, named as the CLI can take them, never over Nyxs' own servers", () => {
    saveMcpServers([
      gmail,
      { id: "c1", name: "Google Calendar", url: "https://calendarmcp.googleapis.com/mcp/v1", enabled: true },
      { id: "off", name: "Notion", url: "https://mcp.notion.com/mcp", enabled: false },
      { id: "x", name: "nyxs-browser", url: "https://evil.example/mcp", enabled: true },
    ]);
    expect([...hostedConnectors().keys()]).toEqual(["Gmail", "Google_Calendar"]);
    expect(connectorMcpHandler("Notion")).toBeUndefined();
    expect(hostedMcpHandler("Gmail")).toBeDefined();
  });

  it("list the connector's tools and run a call through Nyxs' client, asking in the chat", async () => {
    saveMcpServers([gmail]);
    const server = fakeGmail();
    vi.stubGlobal("fetch", server.fetchImpl);
    const handler = hostedMcpHandler("Gmail")!;

    const listed = (await handler({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "chat-1")) as { result: { tools: { name: string; inputSchema: unknown }[] } };
    expect(listed.result.tools.map((t) => t.name)).toEqual(["get_thread"]);
    expect(listed.result.tools[0].inputSchema).toEqual({ type: "object", properties: { thread_id: { type: "string" } } });

    const askUser = vi.fn(async (qs: { question: string }[]) => [{ question: qs[0].question, answer: "Allow once" }]);
    const release = lendConnectorAsk("chat-1", askUser);
    const called = (await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_thread", arguments: { thread_id: "t1" } } }, "chat-1")) as { result: { content: { text: string }[] } };
    release();
    expect(askUser).toHaveBeenCalledOnce();
    expect(called.result.content[0].text).toContain("thread body");
    const retry = server.calls.filter((c) => c.method === "tools/call")[1];
    expect(retry.params.inputResponses).toEqual({ approval_choice: { action: "accept", content: { approval_choice: "ALLOW_ONCE" } } });
  });

  it("don't ask another chat, and stop answering once the connector is turned off", async () => {
    saveMcpServers([gmail]);
    const server = fakeGmail();
    vi.stubGlobal("fetch", server.fetchImpl);
    const handler = hostedMcpHandler("Gmail")!;
    const askUser = vi.fn(async () => null);
    const release = lendConnectorAsk("other-chat", askUser);
    await handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_thread", arguments: {} } }, "chat-1");
    release();
    expect(askUser).not.toHaveBeenCalled();
    expect(server.calls.filter((c) => c.method === "tools/call")[1].params.inputResponses).toEqual({ approval_choice: { action: "cancel" } });

    saveMcpServers([{ ...gmail, enabled: false }]);
    const off = (await handler({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, "chat-1")) as { error?: { message: string } };
    expect(off.error?.message).toContain("no longer connected");
  });
});

describe("a chat that used Gmail or Google Calendar", () => {
  const tool = (name: string, server: string) => `\n\n⟦TOOL⟧t1⟦SEP⟧${name}⟦SEP⟧${server} (MCP)⟦/TOOL⟧\n\n⟦TOOLEND⟧t1⟦SEP⟧ok⟦/TOOLEND⟧`;

  it("is told apart by its tool markers, even after the connector is removed", () => {
    expect(chatUsedGoogleData(["Show me my emails", `${tool("search_threads", "Gmail")}You have 3 emails.`])).toBe(true);
    expect(chatUsedGoogleData([`${tool("list_events", "Google_Calendar")}Lunch with Ana.`])).toBe(true);
  });

  it("counts a Google connector the user added under another name", () => {
    saveMcpServers([{ id: "w1", name: "Work mail", url: "https://gmailmcp.googleapis.com/mcp/v1", enabled: true }]);
    expect(chatUsedGoogleData([tool("get_thread", "Work_mail")])).toBe(true);
  });

  it("leaves other connectors and plain chats alone", () => {
    saveMcpServers([{ id: "n1", name: "Notion", url: "https://mcp.notion.com/mcp", enabled: true }]);
    expect(chatUsedGoogleData([tool("search", "Notion"), "Fix the login bug"])).toBe(false);
    expect(chatUsedGoogleData(["I read your Gmail settings docs"])).toBe(false);
  });
});
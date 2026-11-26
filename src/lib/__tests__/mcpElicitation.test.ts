import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { clearMcpToolsCache, loadMcpTools, type InvokeImpl, type McpServer } from "@/lib/mcp";
import { askMcpApproval, withMcpApproval } from "@/lib/mcpElicitation";

const noInvoke: InvokeImpl = async () => {
  throw new Error("invoke must not be used for HTTP servers");
};

const reply = (id: unknown, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json" } });

const APPROVAL = {
  resultType: "input_required",
  requestState: "state-1",
  inputRequests: {
    approval_choice: {
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "**Read** the thread *Invoice March* from billing@example.com",
        requestedSchema: {
          type: "object",
          required: ["approval_choice"],
          properties: {
            approval_choice: { type: "string", title: "Allow Nyxs to read this email?", enum: ["ALLOW_ONCE", "DENY_ONCE"], enumNames: ["Allow once", "Don't allow"] },
          },
        },
      },
    },
  },
};

/** Gmail's remote server as its elicitation guide describes it. */
function fakeWorkspaceServer() {
  const calls: { method: string; params: Record<string, unknown>; protocol: string | null; name: string | null }[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    calls.push({ method: body.method, params: body.params ?? {}, protocol: headers.get("MCP-Protocol-Version"), name: headers.get("Mcp-Name") });
    // As Google does: the headers must say what the body does.
    if (String(body.method).startsWith("tools/")) {
      const ok = headers.get("MCP-Protocol-Version") === "2026-07-28" && headers.get("Mcp-Method") === body.method && (body.method !== "tools/call" || headers.get("Mcp-Name") === body.params.name);
      if (!ok) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32020, message: "Header mismatch" } }), { status: 400 });
    }
    if (body.method === "initialize") return reply(body.id, { protocolVersion: "2025-06-18", capabilities: {} });
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === "tools/list") return reply(body.id, { tools: [{ name: "get_thread", inputSchema: { type: "object", properties: {} } }] });
    const responses = body.params.inputResponses as Record<string, { action: string; content?: { approval_choice: string } }> | undefined;
    if (!responses) return reply(body.id, APPROVAL);
    const answer = responses.approval_choice;
    if (answer.action === "accept" && answer.content?.approval_choice === "ALLOW_ONCE") {
      return reply(body.id, { resultType: "complete", content: [{ type: "text", text: "thread body" }] });
    }
    return reply(body.id, { resultType: "complete", isError: true, content: [{ type: "text", text: "Action canceled. The user declined the confirmation request." }] });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const gmail: McpServer = { id: "g1", name: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", enabled: true };

async function run(tools: ToolSet, input: unknown = { thread_id: "t1" }): Promise<string> {
  const tool = tools["mcp__Gmail__get_thread"] as { execute: (input: unknown, options: unknown) => Promise<unknown> };
  return JSON.stringify(await tool.execute(input, { toolCallId: "c1", messages: [] }));
}

beforeEach(() => clearMcpToolsCache());

describe("confirmations a Google Workspace MCP server asks for", () => {
  it("tells the server on each tools call that Nyxs can show them", async () => {
    const { fetchImpl, calls } = fakeWorkspaceServer();
    await loadMcpTools([gmail], { fetchImpl, invokeImpl: noInvoke });
    const list = calls.find((c) => c.method === "tools/list")!;
    expect((list.params._meta as Record<string, unknown>)["io.modelcontextprotocol/clientCapabilities"]).toEqual({ elicitation: { form: {} } });
    expect(list.protocol).toBe("2026-07-28");
  });

  it("asks in the chat's question card and repeats the call with the answer", async () => {
    const { fetchImpl, calls } = fakeWorkspaceServer();
    const { tools } = await loadMcpTools([gmail], { fetchImpl, invokeImpl: noInvoke });
    const askUser = vi.fn(async (questions: { question: string; options: { label: string }[] }[]) => {
      expect(questions[0].question).toContain("Invoice March");
      expect(questions[0].options.map((o) => o.label)).toEqual(["Allow once", "Don't allow"]);
      return [{ question: questions[0].question, answer: "Allow once" }];
    });
    const out = await run(withMcpApproval(tools, askMcpApproval(askUser)));
    expect(out).toContain("thread body");
    const retry = calls.filter((c) => c.method === "tools/call")[1];
    expect(retry.params.requestState).toBe("state-1");
    expect(retry.name).toBe("get_thread");
    expect(retry.params.arguments).toEqual({ thread_id: "t1" });
    expect(retry.params.inputResponses).toEqual({ approval_choice: { action: "accept", content: { approval_choice: "ALLOW_ONCE" } } });
  });

  it("declines when the user dismisses it, and cancels when there's no chat to ask in", async () => {
    const declined = fakeWorkspaceServer();
    const loaded = await loadMcpTools([gmail], { fetchImpl: declined.fetchImpl, invokeImpl: noInvoke });
    const out = await run(withMcpApproval(loaded.tools, askMcpApproval(async () => null)));
    expect(out).toContain("declined");
    expect(declined.calls.filter((c) => c.method === "tools/call")[1].params.inputResponses).toEqual({ approval_choice: { action: "decline" } });

    clearMcpToolsCache();
    const unattended = fakeWorkspaceServer();
    const plain = await loadMcpTools([gmail], { fetchImpl: unattended.fetchImpl, invokeImpl: noInvoke });
    await run(plain.tools);
    expect(unattended.calls.filter((c) => c.method === "tools/call")[1].params.inputResponses).toEqual({ approval_choice: { action: "cancel" } });
  });

  it("leaves other servers' requests as they were", async () => {
    const { fetchImpl, calls } = fakeWorkspaceServer();
    await loadMcpTools([{ ...gmail, url: "https://mcp.example.test/mcp" }], { fetchImpl, invokeImpl: noInvoke });
    const list = calls.find((c) => c.method === "tools/list")!;
    expect(list.params._meta).toBeUndefined();
    expect(list.protocol).toBeNull();
  });
});

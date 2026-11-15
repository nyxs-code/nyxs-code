import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { addSessionTools, CREATE_SESSION_TOOL } from "@/tools/Sessions/tool";
import { reportMessage, setSessionBridge, type CreateOutcome, type SessionBridge } from "@/lib/sessionBridge";
import { resolveEffort, resolveSessionModel } from "@/lib/sessionModels";
import type { ModelInfo } from "@/lib/models";
import type { ToolContext } from "@/tools/context";
import { handleSessionsMcp } from "@/lib/browserMcp";

const created: CreateOutcome = { id: "brave-otter", model: "Claude Opus 4.5", effort: "high" };

function bridge(over: Partial<SessionBridge> = {}): SessionBridge {
  return {
    list: () => [],
    read: async () => null,
    send: async () => "sent",
    create: async () => created,
    rename: async () => true,
    archive: async () => true,
    ...over,
  };
}

async function run(name: string, input: Record<string, unknown>, sessionKey = "parent-chat") {
  const tools: ToolSet = {};
  addSessionTools(tools, { sessionKey, gate: undefined } as unknown as ToolContext);
  const t = tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<string> };
  return t.execute(input, { toolCallId: "1", messages: [] });
}

afterEach(() => setSessionBridge(null));

describe("CreateSession", () => {
  it("creates a session under the calling one, on its model and effort unless told otherwise", async () => {
    const create = vi.fn(async (): Promise<CreateOutcome> => created);
    setSessionBridge(bridge({ create }));
    const out = await run(CREATE_SESSION_TOOL, { title: " Saludo inicial ", message: "Di hola" });
    expect(create).toHaveBeenCalledWith("parent-chat", { title: "Saludo inicial", message: "Di hola", model: undefined, effort: undefined, reportBack: true });
    expect(out).toContain("brave-otter");
    expect(out).toContain("Claude Opus 4.5, high effort");
    expect(out).toContain("arrive here");
  });

  it("passes on the model and effort the user asked for", async () => {
    const create = vi.fn(async (): Promise<CreateOutcome> => created);
    setSessionBridge(bridge({ create }));
    await run(CREATE_SESSION_TOOL, { title: "x", message: "y", model: "opus", effort: "max" });
    expect(create).toHaveBeenCalledWith("parent-chat", expect.objectContaining({ model: "opus", effort: "max" }));
  });

  it("fails, so the chat shows no session card, when it can't create one", async () => {
    setSessionBridge(bridge({ create: async () => "no-project" }));
    await expect(run(CREATE_SESSION_TOOL, { title: "x", message: "y" })).rejects.toThrow(/project/);
    setSessionBridge(bridge({ create: async () => "unsupported" }));
    await expect(run(CREATE_SESSION_TOOL, { title: "x", message: "y" })).rejects.toThrow(/can't run/);
    setSessionBridge(bridge({ create: async () => ({ unknownModel: ["GPT-5 (openai:gpt-5)"] }) }));
    await expect(run(CREATE_SESSION_TOOL, { title: "x", message: "y", model: "gemini" })).rejects.toThrow("GPT-5 (openai:gpt-5)");
  });

  it("is served to Claude Code as the nyxs-sessions MCP server, for the chat it runs in", async () => {
    const create = vi.fn(async (): Promise<CreateOutcome> => created);
    setSessionBridge(bridge({ create }));
    const list = (await handleSessionsMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((x) => x.name)).toContain("create_session");
    const res = (await handleSessionsMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_session", arguments: { title: "Saludo", message: "Hola", model: "haiku 5.5", effort: "bajo" } } },
      "claude-chat",
    )) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(res.result.isError).toBeFalsy();
    expect(create).toHaveBeenCalledWith("claude-chat", expect.objectContaining({ model: "haiku 5.5", effort: "bajo" }));
  });
});

describe("resolveSessionModel", () => {
  const m = (id: string, name: string, provider = "anthropic"): ModelInfo =>
    ({ id, apiModel: id.split(":")[1], name, description: "", provider }) as ModelInfo;
  const models = [m("anthropic:claude-opus-4-5", "Claude Opus 4.5"), m("anthropic:claude-sonnet-4-5", "Claude Sonnet 4.5"), m("openai:gpt-5", "GPT-5", "openai")];

  it("finds a model by id, by name or by part of its name", () => {
    expect(resolveSessionModel("openai:gpt-5", models)?.id).toBe("openai:gpt-5");
    expect(resolveSessionModel("gpt 5", models)?.id).toBe("openai:gpt-5");
    expect(resolveSessionModel("sonnet", models)?.id).toBe("anthropic:claude-sonnet-4-5");
    expect(resolveSessionModel("gemini", models)).toBeUndefined();
  });

  it("matches another catalog's id to the same model under another provider", () => {
    const cc = [m("claude-code:haiku", "Haiku 5.5", "claude-code"), m("claude-code:opus", "Opus 5.5", "claude-code")];
    expect(resolveSessionModel("anthropic:claude-haiku-5-5", cc)?.id).toBe("claude-code:haiku");
    expect(resolveSessionModel("haiku 5.5", cc)?.id).toBe("claude-code:haiku");
  });

  it("reads effort levels in English and Spanish", () => {
    expect(resolveEffort("high")).toBe("high");
    expect(resolveEffort("Máximo")).toBe("max");
    expect(resolveEffort("bajo")).toBe("low");
    expect(resolveEffort("turbo")).toBeUndefined();
  });
});

describe("reportMessage", () => {
  it("names the session and quotes its reply, cut when long", () => {
    const msg = reportMessage("Saludo inicial", "brave-otter", "¡Hola!");
    expect(msg).toContain('"Saludo inicial" (brave-otter)');
    expect(msg).toContain("> ¡Hola!");
    expect(reportMessage("t", "i", "x".repeat(7000))).toContain("cut");
  });
});

import { describe, it, expect, vi } from "vitest";
import type { ChatMessage } from "@/components/Message";
import type { Chat } from "@/lib/chatStore";
import type { Settings } from "@/lib/settings";

vi.mock("@/lib/reports", () => ({
  buildDoctorReport: async () => ({ ok: true }),
  buildStatusReport: async (o: { messageCount?: number }) => ({ messages: o.messageCount }),
  buildMcpReport: () => ({}),
  buildSkillsReport: async () => ({}),
  formatStatusText: (r: { messages?: number }) => `status ${r.messages}`,
  formatMcpText: () => "mcp",
  formatSkillsText: () => "skills",
  toJsonBlock: (r: unknown) => `json ${JSON.stringify(r)}`,
}));
const compactChat = vi.hoisted(() => vi.fn(async (_o: { onStart?: () => void }): Promise<unknown> => "tooShort"));
vi.mock("@/lib/compactChat", () => ({ compactChat }));
vi.mock("@/lib/systemPrompt", () => ({ clearSystemPromptCache: () => {} }));

import { runBuiltinCommand, type BuiltinContext } from "@/lib/builtinCommands";
import { createCompactAborts } from "@/lib/compactAborts";

const msg = (id: string, role: "user" | "assistant", content: string): ChatMessage => ({ id, role, content, createdAt: 0 });

function ctx(over: Partial<BuiltinContext> = {}): BuiltinContext {
  return {
    chat: { id: "c1", title: "t", messages: [msg("u", "user", "hola"), msg("a", "assistant", "adiós")] } as Chat,
    modelId: "m",
    selectedModelId: "picked",
    settings: {} as Settings,
    workspace: null,
    permissionMode: "ask",
    allowPermissionBypass: false,
    effort: "high",
    startCompact: (chatId) => createCompactAborts().start(chatId),
    reply: vi.fn(),
    send: vi.fn(),
    patchChat: vi.fn(),
    setCompacting: vi.fn(),
    newChat: vi.fn(),
    openDialog: vi.fn(),
    openSettings: vi.fn(),
    openView: vi.fn(),
    setPermissionMode: vi.fn(),
    promptEnableBypass: vi.fn(),
    ...over,
  };
}

describe("runBuiltinCommand", () => {
  it("opens views, dialogs and settings", async () => {
    const c = ctx();
    await runBuiltinCommand("tasks", "", c);
    await runBuiltinCommand("doctor", "", c);
    await runBuiltinCommand("plugins", "", c);
    expect(c.openView).toHaveBeenCalledWith("background");
    expect(c.openDialog).toHaveBeenCalledWith("doctor");
    expect(c.openSettings).toHaveBeenCalledWith("extensiones");
  });

  it("answers the report commands in the chat, as JSON when asked", async () => {
    const c = ctx();
    await runBuiltinCommand("status", "", c);
    await runBuiltinCommand("doctor", " JSON ", c);
    expect(c.reply).toHaveBeenNthCalledWith(1, "status 2");
    expect(c.reply).toHaveBeenNthCalledWith(2, 'json {"ok":true}');
  });

  it("clears the open chat and resends its last message", async () => {
    const c = ctx();
    await runBuiltinCommand("clear", "", c);
    expect(c.patchChat).toHaveBeenCalledWith("c1", expect.objectContaining({ messages: [], plan: "" }));
    await runBuiltinCommand("retry", "", c);
    expect(c.send).toHaveBeenCalledWith(expect.objectContaining({ message: "hola", model: "m" }));
  });

  it("toggles plan mode, asking first when leaving it needs the bypass", async () => {
    const enter = ctx();
    await runBuiltinCommand("plan", "", enter);
    expect(enter.setPermissionMode).toHaveBeenCalledWith("plan");
    const leave = ctx({ permissionMode: "plan" });
    await runBuiltinCommand("plan", "", leave);
    expect(leave.promptEnableBypass).toHaveBeenCalled();
    expect(leave.setPermissionMode).not.toHaveBeenCalled();
    const allowed = ctx({ permissionMode: "plan", allowPermissionBypass: true });
    await runBuiltinCommand("plan", "", allowed);
    expect(allowed.setPermissionMode).toHaveBeenCalledWith("skip");
  });

  it("verifies a plan only when there is one, with the picked model", async () => {
    const none = ctx();
    await runBuiltinCommand("verify-plan", "", none);
    expect(none.send).not.toHaveBeenCalled();
    expect(none.reply).toHaveBeenCalled();
    const withPlan = ctx({ chat: { id: "c1", title: "t", messages: [], plan: "1. hacer algo" } });
    await runBuiltinCommand("verify-plan", "", withPlan);
    expect(withPlan.send).toHaveBeenCalledWith(expect.objectContaining({ model: "picked" }), "Verify plan execution");
    // The plan goes with the request: there's no plan.md in the project to read.
    const sent = vi.mocked(withPlan.send).mock.calls[0][0].message;
    expect(sent).toContain("1. hacer algo");
    expect(sent).not.toContain("plan.md");
  });

  it("says when there is too little to compact and always clears the spinner", async () => {
    const c = ctx();
    await runBuiltinCommand("compact", "", c);
    expect(c.reply).toHaveBeenCalledWith("No hay suficiente conversación para compactar todavía.");
    expect(c.setCompacting).toHaveBeenLastCalledWith("c1", false);
  });

  it("marks only the compacted chat, also when it fails", async () => {
    compactChat.mockImplementationOnce(async (o) => {
      o.onStart?.();
      return { summary: "s", compactedUpTo: 2 };
    });
    const c = ctx();
    await runBuiltinCommand("compact", "", c);
    expect(vi.mocked(c.setCompacting).mock.calls).toEqual([["c1", true], ["c1", false]]);
    expect(c.patchChat).toHaveBeenCalledWith("c1", {
      summary: "s",
      compactedUpTo: 2,
      compactions: [{ afterId: "a", ms: expect.any(Number), beforeTokens: undefined, afterTokens: undefined }],
    });

    compactChat.mockImplementationOnce(async (o) => {
      o.onStart?.();
      throw new Error("boom");
    });
    const failed = ctx();
    await runBuiltinCommand("compact", "", failed);
    expect(failed.setCompacting).toHaveBeenLastCalledWith("c1", false);
  });

  it("leaves a divider after the last message, with the context before and after", async () => {
    compactChat.mockImplementationOnce(async (o) => {
      o.onStart?.();
      return { contextTokens: 20_500 };
    });
    const base = ctx().chat!;
    const earlier = { afterId: "u", ms: 900 };
    const c = ctx({ chat: { ...base, contextTokens: 312_000, compactions: [earlier] } });
    await runBuiltinCommand("compact", "", c);
    expect(c.patchChat).toHaveBeenCalledWith("c1", {
      contextTokens: 20_500,
      compactions: [earlier, { afterId: "a", ms: expect.any(Number), beforeTokens: 312_000, afterTokens: 20_500 }],
    });
  });

  it("stops on its own signal, leaving the conversation as it was and saying nothing", async () => {
    const aborts = createCompactAborts();
    let seen: AbortSignal | undefined;
    compactChat.mockImplementationOnce(async (o) => {
      o.onStart?.();
      seen = (o as { signal?: AbortSignal }).signal;
      // What Esc or the stop button does mid-way (abortTurn → abortCompact).
      expect(aborts.abort("c1")).toBe(true);
      throw new DOMException("Aborted", "AbortError");
    });
    const c = ctx({ startCompact: aborts.start });
    await runBuiltinCommand("compact", "", c);
    expect(seen?.aborted).toBe(true);
    expect(c.patchChat).not.toHaveBeenCalled();
    expect(c.reply).not.toHaveBeenCalled();
    expect(vi.mocked(c.setCompacting).mock.calls).toEqual([["c1", true], ["c1", false]]);
    // Over, so there is nothing left to stop.
    expect(aborts.abort("c1")).toBe(false);
  });

  it("drops a summary that arrives after it was stopped", async () => {
    const aborts = createCompactAborts();
    compactChat.mockImplementationOnce(async (o) => {
      o.onStart?.();
      aborts.abort("c1");
      return { summary: "s", compactedUpTo: 2 };
    });
    const c = ctx({ startCompact: aborts.start });
    await runBuiltinCommand("compact", "", c);
    expect(c.patchChat).not.toHaveBeenCalled();
    expect(c.setCompacting).toHaveBeenLastCalledWith("c1", false);
  });

  it("marks no chat when none is open", async () => {
    const c = ctx({ chat: undefined });
    await runBuiltinCommand("compact", "", c);
    expect(c.setCompacting).not.toHaveBeenCalled();
    expect(c.reply).toHaveBeenCalled();
  });
});

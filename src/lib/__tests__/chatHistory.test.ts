import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import type { ChatMessage } from "@/components/Message";
import { chatHistory } from "@/lib/chatHistory";
import { forkChat, resendOf, userMessageBefore } from "@/lib/chatMessages";
import type { Chat } from "@/lib/chatStore";

const user = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: "user", content: `pide ${id}`, createdAt: 0, ...extra });
const reply = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: "assistant", content: `responde ${id}`, createdAt: 0, ...extra });

describe("chatHistory", () => {
  it("sends the model only the latest tool screenshots, as the saved chat keeps", () => {
    const shot = (n: number): ModelMessage => ({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: `c${n}`, toolName: "Computer", output: { type: "content", value: [{ type: "image-data", data: `img${n}`, mediaType: "image/jpeg" }] } }],
    } as ModelMessage);
    const turns = [1, 2, 3, 4, 5].flatMap((n) => [user(`u${n}`), reply(`a${n}`, { responseMessages: [shot(n)] })]);
    const { history } = chatHistory(turns);
    const sent = history.flatMap((t) => t.messages ?? []).map((m) => JSON.stringify(m));
    expect(sent.filter((m) => m.includes("img"))).toHaveLength(3);
    expect(sent.join()).not.toContain("img1");
    expect(sent.join()).toContain("img5");
    // What the chat itself holds isn't touched.
    expect(JSON.stringify(turns[1].responseMessages)).toContain("img1");
  });
  it("sends the whole chat when there is no summary", () => {
    const { history, compaction, summaryDropped } = chatHistory([user("u1"), reply("a1")]);
    expect(history.map((t) => [t.role, t.content])).toEqual([["user", "pide u1"], ["assistant", "responde a1"]]);
    expect(compaction).toEqual({ upTo: 0, hadSummary: false });
    expect(summaryDropped).toBe(false);
  });

  it("starts from the summary and skips what it covers", () => {
    const { history, compaction } = chatHistory([user("u1"), reply("a1"), user("u2")], "Resumen previo", 2);
    expect(history).toHaveLength(2);
    expect(history[0].content).toContain("Resumen previo");
    expect(history[1].content).toBe("pide u2");
    expect(compaction).toEqual({ upTo: 2, hadSummary: true });
  });

  it("drops a summary that points past the end of the chat", () => {
    const { history, summaryDropped } = chatHistory([user("u1")], "Viejo", 5);
    expect(summaryDropped).toBe(true);
    expect(history.map((t) => t.content)).toEqual(["pide u1"]);
  });

  it("keeps a reply's model messages and folds pasted text into the user's", () => {
    const responseMessages = [{ role: "assistant", content: "x" }] as ModelMessage[];
    const { history } = chatHistory([user("u1", { pasted: ["pegado"] }), reply("a1", { responseMessages })]);
    expect(history[0].content).toBe("pide u1\n\npegado");
    expect(history[1].messages).toBe(responseMessages);
  });

  it("sends a reply without model messages as plain text, without the chat's card markers", () => {
    const content = "\n\n⟦REASONING⟧r1⟦/REASONING⟧\n\nLeo el archivo.\n\n⟦TOOL⟧t1⟦SEP⟧Read⟦SEP⟧a.ts⟦/TOOL⟧\n\n⟦TOOLEND⟧t1⟦SEP⟧ok⟦/TOOLEND⟧Listo.\n\n⚠️ Error: sin conexión";
    const { history } = chatHistory([user("u1"), reply("a1", { content })]);
    expect(history[1].content).toBe("Leo el archivo.\n\nListo.\n\n⚠️ Error: sin conexión");
  });
});

describe("forkChat", () => {
  const chat: Chat = { id: "c", title: "Chat", messages: [user("u1"), reply("a1", { streaming: true }), user("u2")], summary: "S", compactedUpTo: 2 };

  it("copies the chat up to the message", () => {
    const fork = forkChat(chat, "a1", "f", "Chat (copia)")!;
    expect(fork.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(fork.messages[1].streaming).toBe(false);
    expect(fork).toMatchObject({ id: "f", title: "Chat (copia)", summary: "S", compactedUpTo: 2 });
  });

  it("leaves the summary behind when it covers messages the copy doesn't have", () => {
    const fork = forkChat(chat, "u1", "f", "x")!;
    expect(fork.summary).toBeUndefined();
    expect(fork.compactedUpTo).toBeUndefined();
    expect(forkChat(chat, "nope", "f", "x")).toBeNull();
  });
});

describe("resendOf", () => {
  it("goes back to before the message and sends it again, edited if asked", () => {
    const msgs = [user("u1"), reply("a1"), user("u2", { pasted: ["log"] }), reply("a2")];
    const again = resendOf(msgs, "u2", undefined, "m")!;
    expect(again.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(again.payload).toMatchObject({ message: "pide u2", model: "m" });
    expect(again.payload.pastedContent.map((p) => p.content)).toEqual(["log"]);
    expect(resendOf(msgs, "u2", "  otra cosa ", "m")!.payload.message).toBe("otra cosa");
  });

  it("refuses replies, messages with images and empty edits", () => {
    const msgs = [user("u1", { images: [{} as never] }), reply("a1")];
    expect(resendOf(msgs, "a1", undefined, "m")).toBeNull();
    expect(resendOf(msgs, "u1", undefined, "m")).toBeNull();
    expect(resendOf([user("u2")], "u2", "   ", "m")).toBeNull();
  });

  it("finds the message a reply answered", () => {
    expect(userMessageBefore([user("u1"), reply("a1"), reply("a2")], "a2")?.id).toBe("u1");
    expect(userMessageBefore([reply("a1")], "a1")).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@/components/Message";
import {
  canResendBefore,
  dropInterruptedReply,
  interruptedReply,
  stripToolMarkers,
  withNextSegment,
  withoutEmptyReply,
} from "@/lib/chatMessages";

const user = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: "user", content: id, createdAt: 0, ...extra });
const reply = (id: string, content = "", extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: "assistant", content, createdAt: 0, ...extra });

describe("chatMessages", () => {
  it("can resend a reply unless its user message had images", () => {
    expect(canResendBefore([user("u"), reply("a", "x")], 1)).toBe(true);
    expect(canResendBefore([user("u", { images: [{} as never] }), reply("a", "x")], 1)).toBe(false);
    expect(canResendBefore([reply("a", "x")], 0)).toBe(false);
  });

  it("drops the replies after the last user message", () => {
    const msgs = [user("u1"), reply("a1", "x"), user("u2"), reply("a2", "cortada")];
    expect(dropInterruptedReply(msgs).map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
    const whole = [user("u1")];
    expect(dropInterruptedReply(whole)).toBe(whole);
  });

  it("strips the tool, todo and plan markers", () => {
    expect(stripToolMarkers("Hecho ⟦TOOL⟧x⟦/TOOL⟧\n\n\n\nfin⟦PLAN⟧")).toBe("Hecho \n\nfin");
  });

  it("drops a reply only when it is empty", () => {
    const msgs = [user("u"), reply("a"), reply("b", "", { toolData: {} })];
    expect(withoutEmptyReply(msgs, "a").map((m) => m.id)).toEqual(["u", "b"]);
    expect(withoutEmptyReply(msgs, "b").map((m) => m.id)).toEqual(["u", "a", "b"]);
  });

  it("starts a new reply after messages delivered mid-turn", () => {
    const msgs = [user("u"), reply("a", "parcial", { streaming: true })];
    const next = withNextSegment(msgs, "a", [user("q")], "b", 5);
    expect(next.map((m) => m.id)).toEqual(["u", "a", "q", "b"]);
    expect(next[1].streaming).toBe(false);
    expect(next[3]).toMatchObject({ role: "assistant", content: "", streaming: true, startedAt: 5 });
    expect(withNextSegment([user("u"), reply("a")], "a", [], "b", 5).map((m) => m.id)).toEqual(["u", "b"]);
  });

  it("marks a stopped reply", () => {
    expect(interruptedReply(reply("a", "texto  ", { streaming: true }))).toMatchObject({
      content: "texto\n\n_⏹ Interrumpido por el usuario._",
      streaming: false,
    });
    expect(interruptedReply(reply("a")).content).toBe("_⏹ Interrumpido por el usuario._");
  });
});

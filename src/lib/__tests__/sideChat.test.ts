import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeSideChat,
  dockSideChat,
  minimizeSideChat,
  nearestCorner,
  openSideChat,
  setSideChatAvailable,
  setSideChatDocked,
  setSideChatFor,
  setSideChatHost,
  setSideCorner,
  setSideTurns,
  sideChatState,
  sideContext,
  sideSessionOf,
  takePendingQuestion,
  toggleSideChat,
} from "@/lib/sideChat";

describe("side chat", () => {
  // A session with messages, unless a test says otherwise.
  beforeEach(() => setSideChatAvailable(true));

  it("gives the model the chat without tool calls, reasoning or notices", () => {
    const ctx = sideContext([
      { role: "user", content: "Fix the login" },
      { role: "assistant", content: "On it.⟦TOOL⟧{\"name\":\"Read\"}⟦/TOOL⟧⟦REASONING⟧hmm⟦/REASONING⟧ Done ⟦TODO⟧" },
      { role: "system", content: "notice" },
    ]);
    expect(ctx).toBe("[User]: Fix the login\n\n[Agent]: On it. Done");
  });

  it("keeps only the newest part of a very long chat", () => {
    const long = Array.from({ length: 50 }, (_, i) => ({ role: "user", content: `${i} ${"x".repeat(2000)}` }));
    const ctx = sideContext(long);
    expect(ctx.startsWith("…")).toBe(true);
    expect(ctx.endsWith("x")).toBe(true);
    expect(ctx).toContain("[User]: 49 ");
  });

  it("opens in the panel with a /btw question once, and forgets the conversation when closed", () => {
    const host = { dock: vi.fn(), undock: vi.fn() };
    setSideChatHost(host);
    setSideChatFor("a");
    openSideChat("  what does this do?  ");
    expect(host.dock).toHaveBeenCalledTimes(1);
    expect(takePendingQuestion()).toBe("what does this do?");
    expect(takePendingQuestion()).toBe("");
    setSideTurns("a", [{ role: "user", content: "q" }], false);
    closeSideChat();
    expect(host.undock).toHaveBeenCalledTimes(1);
    expect(sideSessionOf("a").turns).toEqual([]);
    setSideChatHost(null);
  });

  it("keeps each session's own side chat, minimized or not", () => {
    const host = { dock: vi.fn(), undock: vi.fn() };
    setSideChatHost(host);
    setSideChatFor("a");
    setSideTurns("a", [{ role: "user", content: "about a" }], false);
    minimizeSideChat();
    expect(host.undock).toHaveBeenCalledTimes(1);
    expect(sideSessionOf("a")).toMatchObject({ floating: true, turns: [{ content: "about a" }] });
    // Another session has none of it; coming back finds it as it was.
    setSideChatFor("b");
    expect(sideSessionOf("b")).toMatchObject({ floating: false, turns: [] });
    setSideChatFor("a");
    expect(sideSessionOf("a").floating).toBe(true);
    // Minimized, the shortcut closes it; back in the panel it keeps its conversation.
    dockSideChat();
    expect(host.dock).toHaveBeenCalledTimes(1);
    expect(sideSessionOf("a")).toMatchObject({ floating: false, turns: [{ content: "about a" }] });
    setSideChatDocked(true);
    toggleSideChat();
    expect(sideSessionOf("a").turns).toEqual([]);
    setSideChatDocked(false);
    setSideChatHost(null);
  });

  it("doesn't open, by shortcut or /btw, in a session without messages", () => {
    const host = { dock: vi.fn(), undock: vi.fn() };
    setSideChatHost(host);
    setSideChatAvailable(false);
    setSideChatFor(null);
    openSideChat("too soon");
    toggleSideChat();
    expect(host.dock).not.toHaveBeenCalled();
    expect(takePendingQuestion()).toBe("");
    setSideChatAvailable(true);
    setSideChatHost(null);
  });

  it("puts the minimized card in the corner nearest to where it's let go", () => {
    expect(nearestCorner(10, 10, 1000, 800)).toBe("top-left");
    expect(nearestCorner(900, 100, 1000, 800)).toBe("top-right");
    expect(nearestCorner(100, 700, 1000, 800)).toBe("bottom-left");
    expect(nearestCorner(990, 790, 1000, 800)).toBe("bottom-right");
    setSideCorner("top-left");
    expect(sideChatState().corner).toBe("top-left");
  });
});

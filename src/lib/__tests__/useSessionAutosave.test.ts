// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Chat } from "@/lib/chatStore";

const saveSession = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/sessionStorage", () => ({ saveSession: (...args: unknown[]) => saveSession(...args) }));

const { useSessionAutosave } = await import("@/lib/useSessionAutosave");

const chatWith = (content: string): Chat => ({
  id: "s1",
  title: "t",
  workspace: "E:/repo",
  messages: [{ id: "m1", role: "assistant", content } as Chat["messages"][number]],
});

function setup() {
  const onSaved = vi.fn();
  const hook = renderHook(({ chat }: { chat: Chat }) =>
    useSessionAutosave({ ready: true, workspace: "E:/repo", activeChat: chat, restorableMsgIds: new Set(), withFileHistory: (cs) => cs, onSaved }),
  { initialProps: { chat: chatWith("") } });
  return { ...hook, onSaved };
}

afterEach(() => {
  vi.useRealTimers();
  saveSession.mockClear();
});

describe("useSessionAutosave", () => {
  it("saves the session once changes stop for a moment", async () => {
    vi.useFakeTimers();
    const { onSaved } = setup();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(saveSession).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("saves during a long reply, whose chunks keep putting the save off", async () => {
    vi.useFakeTimers();
    const { rerender } = setup();
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        rerender({ chat: chatWith("x".repeat(i + 1)) });
        await vi.advanceTimersByTimeAsync(200);
      });
    }
    expect(saveSession).toHaveBeenCalled();
    // The newest content of the reply when the save went out.
    const saved = saveSession.mock.calls[0][1] as Chat;
    expect(saved.messages[0].content.length).toBeGreaterThan(20);
  });
});

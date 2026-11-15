// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useMessageQueue } from "../useMessageQueue";
import type { QueuedMessage } from "../messageQueue";

type P = { message: string };
type Props = { activeId: string | null; busyIds: ReadonlySet<string> };

function mount(initial: Props) {
  const send = vi.fn(async (_item: QueuedMessage<P>, _chatId: string) => undefined);
  const hook = renderHook((p: Props) => useMessageQueue<P>({ ...p, send, abort: vi.fn(), prepare: async () => null }), {
    initialProps: initial,
  });
  return { ...hook, send };
}

afterEach(cleanup);

describe("a queued message leaving the queue", () => {
  it("is let go when the user deletes it or a running turn takes it in", async () => {
    const release = vi.fn();
    const send = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useMessageQueue<P>({ activeId: "A", busyIds: new Set(["A"]), send, abort: vi.fn(), prepare: async (item) => ({ id: item.id, text: item.payload.message }) as never, release }),
    );
    act(() => result.current.enqueue({ message: "borra esto" }));
    act(() => result.current.enqueue({ message: "tómalo" }));
    const [first, second] = result.current.items;
    act(() => result.current.remove(first.id));
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ id: first.id }));
    let taken: ReturnType<ReturnType<typeof result.current.inboxFor>["take"]> = [];
    await waitFor(() => {
      taken = result.current.inboxFor("A").take();
      expect(taken.length).toBe(1);
    });
    act(() => result.current.inboxFor("A").consumed(taken));
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ id: second.id }));
  });
});


describe("useMessageQueue", () => {
  it("sends a message queued in a chat when that chat's turn ends, even with another chat open", async () => {
    const { result, rerender, send } = mount({ activeId: "A", busyIds: new Set(["A"]) });
    act(() => result.current.enqueue({ message: "commit when done" }));
    rerender({ activeId: "B", busyIds: new Set(["A"]) });
    expect(send).not.toHaveBeenCalled();
    rerender({ activeId: "B", busyIds: new Set() });
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0][0].payload.message).toBe("commit when done");
    expect(send.mock.calls[0][1]).toBe("A");
  });

  it("waits while the chat it was queued in is busy, whichever chat is open", async () => {
    const { result, rerender, send } = mount({ activeId: "A", busyIds: new Set(["A"]) });
    act(() => result.current.enqueue({ message: "next" }));
    rerender({ activeId: "B", busyIds: new Set(["A"]) });
    rerender({ activeId: "A", busyIds: new Set(["A"]) });
    await new Promise((r) => setTimeout(r, 10));
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves a paused queue alone after the turn ends", async () => {
    const { result, rerender, send } = mount({ activeId: "A", busyIds: new Set(["A"]) });
    act(() => result.current.enqueue({ message: "next" }));
    act(() => result.current.pause("A"));
    rerender({ activeId: "B", busyIds: new Set() });
    await new Promise((r) => setTimeout(r, 10));
    expect(send).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import FindBar from "@/components/FindBar";
import type { ChatMessage } from "@/components/Message";
import { messagesToShowFor, useChatScroll } from "../useChatScroll";

afterEach(cleanup);

beforeAll(() => {
  // jsdom has neither of these; the find bar only scrolls to and paints what it found.
  Element.prototype.scrollIntoView = () => {};
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} disconnect() {} };
});

const chat = (n: number, special: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: i === special ? "the zebra was here" : `message ${i}` }) as ChatMessage);

describe("messagesToShowFor", () => {
  it("counts from the end back to the first message holding the words", () => {
    const messages = chat(200, 10);
    expect(messagesToShowFor(messages, "ZEBRA")).toBe(190);
    expect(messagesToShowFor(messages, "nowhere")).toBe(0);
    expect(messagesToShowFor(messages, "")).toBe(0);
  });
});

function Transcript({ messages }: { messages: ChatMessage[] }) {
  const { scrollRef, visibleCount, showAtLeast } = useChatScroll("c1", messages);
  return (
    <>
      <FindBar containerRef={scrollRef} onClose={() => {}} onQuery={(q) => showAtLeast(messagesToShowFor(messages, q))} />
      <div ref={scrollRef}>
        {messages.slice(-visibleCount).map((m) => (
          <p key={m.id}>{m.content}</p>
        ))}
      </div>
    </>
  );
}

describe("Find in a long chat", () => {
  it("finds a message older than the ones drawn, drawing back to it", () => {
    const view = render(<Transcript messages={chat(200, 10)} />);
    expect(view.queryByText("the zebra was here")).toBeNull();
    fireEvent.change(view.getByRole("textbox"), { target: { value: "zebra" } });
    expect(view.getByText("the zebra was here")).toBeTruthy();
    expect(view.getByText("1/1")).toBeTruthy();
  });

  it("starts the next chat with the usual number drawn again", () => {
    const { result, rerender } = renderHook(({ id }) => useChatScroll(id, chat(300, 0)), { initialProps: { id: "a" } });
    act(() => result.current.showAtLeast(250));
    expect(result.current.visibleCount).toBe(250);
    rerender({ id: "b" });
    expect(result.current.visibleCount).toBe(60);
  });
});

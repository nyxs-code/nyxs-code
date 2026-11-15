// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/components/Message";
import { useChatScroll } from "../useChatScroll";

const CLIENT_HEIGHT = 500;
const NO_MESSAGES: ChatMessage[] = [];

let resizeCallbacks: (() => void)[] = [];

/** jsdom has no layout: the test says how tall the chat is. */
function setContentHeight(el: HTMLElement, height: number) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: height });
}

function Chat({ id }: { id: string }) {
  const { scrollRef, handleChatScroll } = useChatScroll(id, NO_MESSAGES);
  return (
    <div ref={scrollRef} data-testid="scroller" onScroll={handleChatScroll}>
      <div>
        <button>details</button>
        <iframe title="visual" />
      </div>
    </div>
  );
}

function openChat() {
  const view = render(<Chat id="a" />);
  const el = view.getByTestId("scroller");
  Object.defineProperty(el, "clientHeight", { configurable: true, value: CLIENT_HEIGHT });
  setContentHeight(el, 800);
  return { ...view, el };
}

/** The content took a new height: what ResizeObserver reports after layout. */
function contentResizes(el: HTMLElement, height: number) {
  setContentHeight(el, height);
  act(() => resizeCallbacks.forEach((cb) => cb()));
}

function userScrollsTo(el: HTMLElement, top: number) {
  el.scrollTop = top;
  fireEvent.scroll(el);
}

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", class {
    private cb: () => void;
    constructor(cb: () => void) { this.cb = cb; resizeCallbacks.push(cb); }
    observe() {}
    disconnect() { resizeCallbacks = resizeCallbacks.filter((c) => c !== this.cb); }
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useChatScroll", () => {
  it("stays at the end when a visual takes its height after the chat opened", () => {
    const { el } = openChat();
    userScrollsTo(el, 300);
    contentResizes(el, 1900);
    expect(el.scrollTop).toBe(1900);
  });

  it("leaves a user reading above where they are", () => {
    const { el } = openChat();
    userScrollsTo(el, 300);
    userScrollsTo(el, 100);
    contentResizes(el, 1900);
    expect(el.scrollTop).toBe(100);
  });

  it("keeps following when a shrinking visual moves the scroll up to the new end", () => {
    const { el } = openChat();
    userScrollsTo(el, 300);
    // The browser clamps scrollTop by itself when the content gets shorter.
    setContentHeight(el, 700);
    userScrollsTo(el, 200);
    contentResizes(el, 1900);
    expect(el.scrollTop).toBe(1900);
  });

  it("doesn't scroll away from what the user just opened", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const { el, getByText } = openChat();
    userScrollsTo(el, 300);
    fireEvent.click(getByText("details"));
    contentResizes(el, 1200);
    expect(el.scrollTop).toBe(300);
    // Later growth isn't theirs any more.
    vi.advanceTimersByTime(1100);
    contentResizes(el, 1900);
    expect(el.scrollTop).toBe(1900);
  });

  it("doesn't scroll while the user is using a visual", () => {
    const { el, getByTitle } = openChat();
    userScrollsTo(el, 300);
    getByTitle("visual").focus();
    contentResizes(el, 1200);
    expect(el.scrollTop).toBe(300);
  });

  it("follows again in another chat, whatever happened in the previous one", () => {
    const { el, rerender, getByText } = openChat();
    userScrollsTo(el, 300);
    userScrollsTo(el, 100);
    fireEvent.click(getByText("details"));
    rerender(<Chat id="b" />);
    contentResizes(el, 1900);
    expect(el.scrollTop).toBe(1900);
  });
});

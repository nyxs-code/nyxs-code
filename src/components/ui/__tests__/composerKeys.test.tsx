// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeChatInput } from "@/components/ui/claude-style-chat-input";

const settings: { enterNewline?: boolean } = {};
vi.mock("@/lib/useSettings", () => ({ useSettings: () => ({ settings, update: vi.fn() }) }));

afterEach(cleanup);
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
beforeEach(() => {
  delete settings.enterNewline;
});

const models = [{ id: "m1", name: "Model" }] as never;
let draft = 0;

function composer(props: { history?: string[]; isStreaming?: boolean; onQueue?: () => void; onSteer?: () => void } = {}) {
  const onSendMessage = vi.fn();
  // Each test writes in its own session, so no draft carries over.
  const view = render(<ClaudeChatInput models={models} selectedModel="m1" onModelChange={() => {}} onSendMessage={onSendMessage} draftKey={`keys-${++draft}`} {...props} />);
  const box = view.container.querySelector("textarea")!;
  const key = (k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => fireEvent.keyDown(box, { key: k, ...mods });
  return { box, key, onSendMessage };
}

describe("↑ and ↓ in the chat box", () => {
  it("bring back the messages sent earlier, newest first, and return to the empty box", () => {
    const { box, key } = composer({ history: ["primero", "segundo", "tercero"] });
    key("ArrowUp");
    expect(box.value).toBe("tercero");
    key("ArrowUp");
    expect(box.value).toBe("segundo");
    key("ArrowDown");
    expect(box.value).toBe("tercero");
    key("ArrowDown");
    expect(box.value).toBe("");
  });

  it("stay at the oldest message", () => {
    const { box, key } = composer({ history: ["único"] });
    key("ArrowUp");
    key("ArrowUp");
    expect(box.value).toBe("único");
  });

  it("leave a box with text alone", () => {
    const { box, key } = composer({ history: ["antes"] });
    fireEvent.change(box, { target: { value: "escribiendo" } });
    key("ArrowUp");
    expect(box.value).toBe("escribiendo");
  });

  it("stop browsing once the recalled message is edited", () => {
    const { box, key } = composer({ history: ["uno", "dos"] });
    key("ArrowUp");
    fireEvent.change(box, { target: { value: "dos y más" } });
    key("ArrowUp");
    expect(box.value).toBe("dos y más");
  });

  it("skip a message sent twice in a row", () => {
    const { box, key } = composer({ history: ["a", "b", "b"] });
    key("ArrowUp");
    key("ArrowUp");
    expect(box.value).toBe("a");
  });
});

describe("Enter in the chat box", () => {
  it("sends by default, and Shift+Enter doesn't", () => {
    const { box, key, onSendMessage } = composer();
    fireEvent.change(box, { target: { value: "hola" } });
    key("Enter", { shiftKey: true });
    expect(onSendMessage).not.toHaveBeenCalled();
    key("Enter");
    expect(onSendMessage).toHaveBeenCalledOnce();
  });

  it("with \"Enter starts a new line\", only Ctrl+Enter sends", () => {
    settings.enterNewline = true;
    const { box, key, onSendMessage } = composer();
    fireEvent.change(box, { target: { value: "hola" } });
    const enter = key("Enter");
    // The key isn't taken, so the browser writes the line.
    expect(enter).toBe(true);
    expect(onSendMessage).not.toHaveBeenCalled();
    key("Enter", { ctrlKey: true });
    expect(onSendMessage).toHaveBeenCalledOnce();
  });

  it("with \"Enter starts a new line\", Ctrl+Enter queues during a reply and Ctrl+Shift+Enter interrupts", () => {
    settings.enterNewline = true;
    const onQueue = vi.fn();
    const onSteer = vi.fn();
    const { box, key } = composer({ isStreaming: true, onQueue, onSteer });
    fireEvent.change(box, { target: { value: "en cola" } });
    key("Enter", { ctrlKey: true });
    expect(onQueue).toHaveBeenCalledOnce();
    fireEvent.change(box, { target: { value: "ahora" } });
    key("Enter", { ctrlKey: true, shiftKey: true });
    expect(onSteer).toHaveBeenCalledOnce();
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { ClaudeChatInput, type SendPayload } from "@/components/ui/claude-style-chat-input";

afterEach(cleanup);
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});

const models = [{ id: "m1", name: "Model" }] as never;

function composer(onSendMessage: (p: SendPayload) => void | Promise<void>) {
  const fillRef = createRef<((value: string | SendPayload) => void) | null>() as { current: ((value: string | SendPayload) => void) | null };
  const view = render(<ClaudeChatInput models={models} selectedModel="m1" onModelChange={() => {}} onSendMessage={onSendMessage} fillRef={fillRef} draftKey="refill-test" />);
  const box = view.container.querySelector("textarea")!;
  return { view, box, fillRef };
}

describe("the chat box when a message isn't sent", () => {
  it("gets the message back when sending fails", async () => {
    let fail: (e: Error) => void = () => {};
    const { box } = composer(() => new Promise<void>((_, reject) => { fail = reject; }));
    fireEvent.change(box, { target: { value: "hola mundo" } });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 13 });
    expect(box.value).toBe("");
    await act(async () => fail(new Error("boom")));
    expect(box.value).toBe("hola mundo");
  });

  it("takes back a whole message from the app, not only its text", () => {
    const { box, fillRef, view } = composer(vi.fn());
    const pasted = { id: "p1", content: "pasted text that is long", timestamp: new Date() };
    act(() => fillRef.current?.({ message: "con pegado", files: [], pastedContent: [pasted] as never, model: "m1", isThinkingEnabled: false }));
    expect(box.value).toBe("con pegado");
    expect(view.container.textContent).toContain("pasted text");
  });
});

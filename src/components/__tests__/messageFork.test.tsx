// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Message, type ChatMessage } from "@/components/Message";
import { getTranslations } from "@/lib/i18n";

afterEach(cleanup);

const reply: ChatMessage = { id: "a1", role: "assistant", content: "Hecho." } as ChatMessage;
const forkLabel = getTranslations("en-US").chatUi.fork;
const hasFork = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].some((b) => b.getAttribute("aria-label") === forkLabel || b.textContent === forkLabel);

describe("Fork on an earlier reply", () => {
  it("comes back once the chat can fork again, though the message didn't change", () => {
    const onFork = vi.fn();
    const view = render(<Message message={reply} chatId="c1" onFork={onFork} canFork={false} />);
    expect(hasFork(view.container)).toBe(false);
    view.rerender(<Message message={reply} chatId="c1" onFork={onFork} canFork />);
    expect(hasFork(view.container)).toBe(true);
  });
});

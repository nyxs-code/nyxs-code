// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let asked: { signal: AbortSignal; onDelta: (d: string) => void } | null = null;
vi.mock("@/lib/sideChat", async (orig) => ({
  ...(await orig<typeof import("@/lib/sideChat")>()),
  askSideQuestion: (o: { signal: AbortSignal; onDelta: (d: string) => void }) => {
    asked = o;
    return new Promise<boolean>(() => {});
  },
}));

const { SideChatPane } = await import("@/components/SideChat");
const { closeSideChat, setSideChatFor, sideSessionOf } = await import("@/lib/sideChat");

afterEach(cleanup);
// jsdom lays nothing out, so elements can't scroll or change size.
Element.prototype.scrollTo = () => {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const props = {
  messages: [],
  modelId: "m",
  settings: {} as never,
  input: { models: [] },
  onToggleMaximize: () => {},
  maximized: false,
};

function askIn(chatId: string, question: string) {
  act(() => setSideChatFor(chatId));
  const view = render(<SideChatPane chatId={chatId} {...props} />);
  const box = view.container.querySelector("textarea")!;
  fireEvent.change(box, { target: { value: question } });
  fireEvent.keyDown(box, { key: "Enter", keyCode: 13 });
  return view;
}

describe("each session's side chat", () => {
  it("keeps its answer in its own session when another session opens", () => {
    const view = askIn("a", "¿qué hace esto?");
    expect(asked).not.toBeNull();
    view.unmount();
    act(() => setSideChatFor("b"));
    act(() => asked!.onDelta("la respuesta de a"));
    expect(sideSessionOf("b").turns).toEqual([]);
    expect(sideSessionOf("a").turns.at(-1)).toMatchObject({ role: "assistant", content: "la respuesta de a" });
  });

  it("stops its answer when it's closed, and doesn't bring the conversation back", () => {
    askIn("c", "¿y esto?");
    act(() => closeSideChat());
    expect(asked!.signal.aborted).toBe(true);
    act(() => asked!.onDelta("tarde"));
    expect(sideSessionOf("c").turns).toEqual([]);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";

const openChatLink = vi.fn();
vi.mock("@/lib/openExternal", () => ({ openChatLink: (url: string) => openChatLink(url) }));

const { useVisualBridge, VISUAL_PROMPT_EVENT } = await import("../visualBridge");

/** The gap the bridge keeps between two messages. */
const PROMPT_GAP = 2000;

function Visual({ onHeight }: { onHeight?: (h: number) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useVisualBridge(ref, onHeight);
  return (
    <>
      <iframe ref={ref} title="visual" />
      <button>chat</button>
    </>
  );
}

function mount(onHeight?: (h: number) => void) {
  const view = render(<Visual onHeight={onHeight} />);
  const frame = view.getByTitle("visual") as HTMLIFrameElement;
  const button = view.getByText("chat");
  const post = (data: Record<string, unknown>, source: Window | null = frame.contentWindow) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { source: "nyxs-mockup", ...data }, source }));
    });
  const prompt = (text = "Aplica la opción 2") => post({ type: "prompt", text });
  const link = (url = "https://example.com/") => post({ type: "link", url });
  const pointerIn = () => act(() => { frame.dispatchEvent(new Event("pointerover", { bubbles: true })); });
  const pointerOut = () => act(() => { frame.dispatchEvent(new Event("pointerout", { bubbles: true })); });
  const click = () => { pointerIn(); act(() => frame.focus()); };
  return { frame, button, post, prompt, link, pointerIn, pointerOut, click };
}

let prompts: string[] = [];
const onPrompt = (e: Event) => prompts.push((e as CustomEvent<string>).detail);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
  prompts = [];
  openChatLink.mockClear();
  window.addEventListener(VISUAL_PROMPT_EVENT, onPrompt);
});

afterEach(() => {
  window.removeEventListener(VISUAL_PROMPT_EVENT, onPrompt);
  cleanup();
  vi.useRealTimers();
});

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe("useVisualBridge", () => {
  it("ignores what a visual sends on its own, without the user in it", () => {
    const v = mount();
    v.prompt();
    v.link();
    // The pointer resting on it isn't enough: the user hasn't clicked into it.
    v.pointerIn();
    v.prompt();
    v.link();
    // Nor is the focus a visual could take, with the pointer elsewhere.
    v.pointerOut();
    later(1500);
    act(() => v.frame.focus());
    v.prompt();
    v.link();
    expect(prompts).toEqual([]);
    expect(openChatLink).not.toHaveBeenCalled();
  });

  it("sends a message and opens a link after a click in the visual", () => {
    const v = mount();
    v.click();
    v.prompt("  Aplica la opción 2  ");
    v.link("https://example.com/docs");
    expect(prompts).toEqual(["Aplica la opción 2"]);
    expect(openChatLink).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("still counts a click right before the pointer left", () => {
    const v = mount();
    v.click();
    v.pointerOut();
    later(300);
    v.prompt();
    expect(prompts).toHaveLength(1);
    later(PROMPT_GAP);
    v.prompt();
    expect(prompts).toHaveLength(1);
  });

  it("lets a keyboard user who tabbed into the visual use it", () => {
    const v = mount();
    act(() => v.button.focus());
    act(() => { v.button.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); });
    act(() => v.frame.focus());
    v.prompt();
    expect(prompts).toHaveLength(1);
    // Leaving it ends that.
    act(() => v.button.focus());
    later(PROMPT_GAP);
    v.prompt();
    expect(prompts).toHaveLength(1);
  });

  it("limits how often a visual can send", () => {
    const v = mount();
    v.click();
    for (let i = 0; i < 5; i++) v.prompt(`spam ${i}`);
    for (let i = 0; i < 5; i++) v.link(`https://example.com/${i}`);
    expect(prompts).toEqual(["spam 0"]);
    expect(openChatLink).toHaveBeenCalledTimes(1);
    later(PROMPT_GAP);
    v.prompt("second");
    v.link("https://example.com/later");
    expect(prompts).toEqual(["spam 0", "second"]);
    expect(openChatLink).toHaveBeenCalledTimes(2);
  });

  it("only listens to its own frame, and always takes its height", () => {
    const onHeight = vi.fn();
    const v = mount(onHeight);
    v.post({ type: "height", height: 120.2 });
    expect(onHeight).toHaveBeenCalledWith(121);
    v.click();
    v.post({ type: "prompt", text: "from elsewhere" }, window);
    expect(prompts).toEqual([]);
  });
});

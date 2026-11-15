// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { clearHighlights, paintHighlights, type TextHighlight } from "@/lib/chatHighlights";

/** jsdom has no CSS Custom Highlight API: a registry that keeps what each color holds. */
class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const registry = new Map<string, FakeHighlight>();

beforeAll(() => {
  (globalThis as { Highlight?: unknown }).Highlight = FakeHighlight;
  (globalThis as { CSS?: unknown }).CSS = { highlights: registry, escape: (s: string) => s };
});

function pane(messageId: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = `<div data-message-id="${messageId}"><div data-message-body>${text}</div></div>`;
  document.body.appendChild(el);
  return el;
}

const yellow = (quote: string): TextHighlight => ({ id: quote, color: "yellow", quote, prefix: "", suffix: "", createdAt: 1 });
const painted = () => (registry.get("nyxs-hl-yellow")?.ranges ?? []).map((r) => r.toString()).sort();

describe("highlights with two chats side by side", () => {
  it("keeps each pane's highlights when the other paints or closes", () => {
    const left = pane("a", "the left answer");
    const right = pane("b", "the right answer");
    paintHighlights(left, { a: [yellow("left")] });
    paintHighlights(right, { b: [yellow("right")] });
    expect(painted()).toEqual(["left", "right"]);
    clearHighlights(right);
    expect(painted()).toEqual(["left"]);
    clearHighlights(left);
    expect(registry.has("nyxs-hl-yellow")).toBe(false);
  });
});

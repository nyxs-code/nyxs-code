// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageQueue } from "@/components/MessageQueue";
import type { SendPayload } from "@/components/ui/claude-style-chat-input";
import { getTranslations } from "@/lib/i18n";

const t = getTranslations("en-US").queue;
afterEach(cleanup);

const item = (id: string) => ({ id, payload: { message: id, files: [], pastedContent: [], model: "m", isThinkingEnabled: false } as SendPayload });

function show(ids: string[], onMove = vi.fn()) {
  render(
    <MessageQueue
      items={ids.map(item)}
      delivering={[]}
      paused={false}
      onEdit={() => {}}
      onRemove={() => {}}
      onMove={onMove}
      onSendNow={() => {}}
      onResume={() => {}}
    />,
  );
  return onMove;
}

describe("reordering the queue", () => {
  it("moves a message with the arrow keys on its handle", () => {
    const onMove = show(["first", "second", "third"]);
    const handles = screen.getAllByRole("button", { name: t.reorder });
    expect(handles).toHaveLength(3);
    fireEvent.keyDown(handles[2], { key: "ArrowUp" });
    expect(onMove).toHaveBeenLastCalledWith("third", 1);
    fireEvent.keyDown(handles[0], { key: "ArrowDown" });
    expect(onMove).toHaveBeenLastCalledWith("first", 1);
  });

  it("moves a message dragged onto another one's place", () => {
    const onMove = show(["first", "second", "third"]);
    const handles = screen.getAllByRole("button", { name: t.reorder });
    const transfer = { effectAllowed: "", setData: () => {} };
    fireEvent.dragStart(handles[2], { dataTransfer: transfer });
    // jsdom gives drag events no pointer position, so this is the lower half of the first row:
    // the slot right after it.
    const firstRow = screen.getByText("first").closest("[class*='border-t-2']")!;
    fireEvent.dragOver(firstRow);
    fireEvent.drop(firstRow);
    expect(onMove).toHaveBeenCalledWith("third", 1);
  });

  it("has no handles with a single waiting message", () => {
    show(["only"]);
    expect(screen.queryByRole("button", { name: t.reorder })).toBeNull();
  });
});

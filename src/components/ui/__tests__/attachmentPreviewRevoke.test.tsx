// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerAttachments } from "@/components/ui/chat-input/Attachments";

afterEach(cleanup);

describe("an image taken off the chat box", () => {
  it("frees its thumbnail's object URL", () => {
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const file = { id: "f1", file: new File(["x"], "a.png", { type: "image/png" }), type: "image/png", preview: "blob:thumb-1", uploadStatus: "complete" } as never;
    const setFiles = vi.fn();
    const view = render(
      <ComposerAttachments attachedElements={[]} setAttachedElements={vi.fn()} files={[file]} setFiles={setFiles} pastedContent={[]} setPastedContent={vi.fn()} />,
    );
    const buttons = view.container.querySelectorAll("button");
    fireEvent.click(buttons[buttons.length - 1]);
    expect(setFiles).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:thumb-1");
  });
});

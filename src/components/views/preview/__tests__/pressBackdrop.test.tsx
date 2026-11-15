// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(async () => undefined) }));

const { Dialog } = await import("@/components/ui/dialog");
const { pressBackdrop } = await import("../webviewHoles");

afterEach(cleanup);

describe("pressBackdrop", () => {
  it("does what a press on the dialog's backdrop does", () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} label="Settings"><button type="button">x</button></Dialog>);
    expect(pressBackdrop()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("only closes the dialog in front", () => {
    const below = vi.fn();
    const front = vi.fn();
    render(
      <>
        <Dialog open onClose={below} label="Settings"><button type="button">x</button></Dialog>
        <Dialog open stacked onClose={front} label="Confirm"><button type="button">y</button></Dialog>
      </>,
    );
    pressBackdrop();
    expect(front).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
  });

  it("leaves a dialog that can't be dismissed open, and does nothing without one", () => {
    const onClose = vi.fn();
    render(<Dialog open dismissible={false} onClose={onClose} label="Required"><button type="button">x</button></Dialog>);
    pressBackdrop();
    expect(onClose).not.toHaveBeenCalled();
    cleanup();
    expect(pressBackdrop()).toBe(false);
  });
});

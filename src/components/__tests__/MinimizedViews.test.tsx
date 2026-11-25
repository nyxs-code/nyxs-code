// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MinimizedViews } from "@/components/MinimizedViews";
import { getTranslations } from "@/lib/i18n";
import { cornerAfterKey, forgetMinimized, minimizeView, setMinimizedCorner, useMinimizedViews } from "@/lib/minimizedViews";

const t = getTranslations("en-US").views;
afterEach(() => {
  cleanup();
  act(() => {
    forgetMinimized("preview");
    forgetMinimized("terminal");
    setMinimizedCorner("bottom-left");
  });
});

function Corner() {
  return <span data-testid="corner">{useMinimizedViews().corner}</span>;
}

describe("minimized panels", () => {
  it("show nothing until a panel is minimized, then a row to bring each back", () => {
    const onRestore = vi.fn();
    render(<MinimizedViews onRestore={onRestore} />);
    expect(screen.queryByRole("group", { name: t.minimizedPanels })).toBeNull();
    act(() => {
      minimizeView("preview");
      minimizeView("terminal");
    });
    fireEvent.click(screen.getByRole("button", { name: t.restorePanel.replace("{name}", t.preview) }));
    expect(onRestore).toHaveBeenCalledWith("preview");
    fireEvent.click(screen.getByRole("button", { name: t.hideMinimized.replace("{name}", t.terminal) }));
    expect(screen.queryByRole("button", { name: t.restorePanel.replace("{name}", t.terminal) })).toBeNull();
  });

  it("move to another corner with the arrow keys", () => {
    render(
      <>
        <MinimizedViews onRestore={() => {}} />
        <Corner />
      </>,
    );
    act(() => minimizeView("terminal"));
    const card = screen.getByRole("group", { name: t.minimizedPanels });
    fireEvent.keyDown(card, { key: "ArrowUp" });
    expect(screen.getByTestId("corner").textContent).toBe("top-left");
    fireEvent.keyDown(card, { key: "ArrowRight" });
    expect(screen.getByTestId("corner").textContent).toBe("top-right");
  });

  it("know which corner each arrow leads to", () => {
    expect(cornerAfterKey("bottom-left", "ArrowUp")).toBe("top-left");
    expect(cornerAfterKey("top-right", "ArrowDown")).toBe("bottom-right");
    expect(cornerAfterKey("top-right", "ArrowLeft")).toBe("top-left");
    expect(cornerAfterKey("top-right", "Enter")).toBeNull();
  });
});

// @vitest-environment jsdom
import { useRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useMenuTop } from "@/lib/useMenuTop";

/** A menu 200px tall opened from a button whose bottom is `below - 4` and top `above + 4`. */
function Menu({ below, above }: { below: number | null; above: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const top = useMenuTop(ref, below, above);
  return <div ref={ref} data-testid="menu" data-top={top ?? ""} />;
}

beforeEach(() => {
  Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { height: this.dataset.testid === "menu" ? 200 : 0 } as DOMRect;
  };
});
afterEach(cleanup);

const topOf = () => screen.getByTestId("menu").dataset.top;

describe("useMenuTop", () => {
  it("opens below the button when the menu fits", () => {
    render(<Menu below={100} above={70} />);
    expect(topOf()).toBe("100");
  });

  it("opens above the button when it doesn't fit below, as at the end of a list", () => {
    render(<Menu below={520} above={490} />);
    expect(topOf()).toBe("290");
  });

  it("stays inside the window when it fits neither way", () => {
    render(<Menu below={150} above={120} />);
    Object.defineProperty(window, "innerHeight", { value: 300, configurable: true });
    cleanup();
    render(<Menu below={150} above={120} />);
    expect(topOf()).toBe("4");
  });

  it("is nothing while the menu is closed", () => {
    render(<Menu below={null} above={0} />);
    expect(topOf()).toBe("");
  });
});

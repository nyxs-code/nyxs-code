// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { backdropAlpha, isClickCatcher } from "../webviewHoles";

describe("isClickCatcher", () => {
  const layer = (style: string, html = "") => {
    const el = document.createElement("div");
    el.setAttribute("style", `position: fixed; inset: 0; ${style}`);
    el.innerHTML = html;
    document.body.append(el);
    return el;
  };

  it("sees a menu's invisible click-outside layer as covering nothing", () => {
    expect(isClickCatcher(layer(""))).toBe(true);
    expect(isClickCatcher(layer("background-color: rgba(0, 0, 0, 0)"))).toBe(true);
  });

  it("keeps anything that draws over the page as covering it", () => {
    expect(isClickCatcher(layer("background-color: rgba(0, 0, 0, 0.3)"))).toBe(false);
    expect(isClickCatcher(layer("background-color: rgb(20, 20, 20)"))).toBe(false);
    expect(isClickCatcher(layer("", "<span>Settings</span>"))).toBe(false);
  });
});

describe("backdropAlpha", () => {
  it("reads the alpha in the forms a browser computes", () => {
    expect(backdropAlpha(["rgba(0, 0, 0, 0.3)"])).toBe(0.3);
    expect(backdropAlpha(["oklab(0 0 0 / 0.3)"])).toBe(0.3);
    expect(backdropAlpha(["color(srgb 0 0 0 / 30%)"])).toBe(0.3);
  });

  it("stacks dialogs opened over each other", () => {
    expect(backdropAlpha(["rgba(0, 0, 0, 0.3)", "rgba(0, 0, 0, 0.3)"])).toBe(0.51);
  });

  it("treats no dialog or a clear backdrop as no dimming", () => {
    expect(backdropAlpha([])).toBe(0);
    expect(backdropAlpha(["rgba(0, 0, 0, 0)", "transparent"])).toBe(0);
  });
});

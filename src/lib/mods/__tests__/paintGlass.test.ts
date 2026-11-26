// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { paintModTheme } from "../paint";
import type { StandingTheme } from "../types";

const snow = {
  plugin: "theme-examples",
  root: "",
  args: { backdrop: { scene: "snow-pines", glass: { blur: 16, tint: "#14143a", opacity: 0.5 } }, overrideColorScheme: "dark" },
} as unknown as StandingTheme;

describe("a theme's glass", () => {
  it("goes with the theme: the panels are solid again once it's taken off", () => {
    const root = document.documentElement;
    paintModTheme(snow);
    expect(root.classList.contains("mod-glass")).toBe(true);
    expect(root.style.getPropertyValue("--mod-glass-tint")).toBe("#14143a");
    paintModTheme(null);
    expect(root.classList.contains("mod-glass")).toBe(false);
    expect(root.classList.contains("mod-backdrop")).toBe(false);
  });
});

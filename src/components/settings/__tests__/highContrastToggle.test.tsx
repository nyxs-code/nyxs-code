// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { CodeAppearanceSettings } = await import("../CodeAppearanceSettings");
const { getTranslations, setLanguage } = await import("@/lib/i18n");
const { getThemePreference, setThemePreference } = await import("@/lib/theme");

let systemDark = false;

beforeAll(() => {
  setLanguage("en-US");
  window.matchMedia = ((query: string) => ({
    matches: query.includes("dark") && systemDark,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const label = () => getTranslations("en-US").codeSettings.highContrastTitle;

function flip(from: Parameters<typeof setThemePreference>[0]) {
  setThemePreference(from);
  const view = render(<CodeAppearanceSettings />);
  const toggle = () => view.getByRole("switch", { name: label() });
  act(() => fireEvent.click(toggle()));
  const on = getThemePreference();
  const checked = toggle().getAttribute("aria-checked");
  act(() => fireEvent.click(toggle()));
  const off = getThemePreference();
  cleanup();
  return { on, checked, off };
}

describe("the high contrast switch", () => {
  it("uses the high contrast theme of the light or dark one in use, and gives the previous theme back", () => {
    expect(flip("light")).toEqual({ on: "high-contrast-light", checked: "true", off: "light" });
    expect(flip("pink")).toEqual({ on: "high-contrast-light", checked: "true", off: "pink" });
    expect(flip("dark")).toEqual({ on: "high-contrast-dark", checked: "true", off: "dark" });
  });

  it("follows the system's mode on the automatic theme, and goes back to automatic", () => {
    systemDark = false;
    expect(flip("auto")).toEqual({ on: "high-contrast-light", checked: "true", off: "auto" });
    systemDark = true;
    expect(flip("auto")).toEqual({ on: "high-contrast-dark", checked: "true", off: "auto" });
  });
});

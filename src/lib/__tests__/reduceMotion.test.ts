// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_KEY, getAppearance, reducedMotion, setAppearance } from "@/lib/appearance";

const systemAsks = (reduce: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));

afterEach(() => {
  localStorage.removeItem(APPEARANCE_KEY);
  vi.unstubAllGlobals();
});

describe("Reduce motion", () => {
  it("follows the system by default", () => {
    expect(getAppearance().reduceMotion).toBe("system");
    systemAsks(true);
    expect(reducedMotion()).toBe(true);
    systemAsks(false);
    expect(reducedMotion()).toBe(false);
  });

  it("on or off wins over the system, and marks the page for the stylesheet", () => {
    systemAsks(false);
    setAppearance({ reduceMotion: "on" });
    expect(reducedMotion()).toBe(true);
    expect(document.documentElement.dataset.reduceMotion).toBe("on");
    systemAsks(true);
    setAppearance({ reduceMotion: "off" });
    expect(reducedMotion()).toBe(false);
    expect(document.documentElement.dataset.reduceMotion).toBe("off");
  });

  it("keeps popups only when asked", () => {
    expect(getAppearance().keepPopups).toBe(false);
    setAppearance({ keepPopups: true });
    expect(getAppearance().keepPopups).toBe(true);
  });
});

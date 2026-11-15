import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DARK_PRESETS, LIGHT_PRESETS, applyPreset, derivePalette, getThemeColors, mix, normalizeHex, setModeColor } from "@/lib/themeColors";

describe("normalizeHex", () => {
  it("accepts 3 or 6 digits with or without #, and rejects the rest", () => {
    expect(normalizeHex("f9f9f9")).toBe("#F9F9F9");
    expect(normalizeHex(" #abc ")).toBe("#AABBCC");
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex("zzzzzz")).toBeNull();
  });
});

describe("derivePalette", () => {
  it("keeps the three colors and steps the rest between background and text", () => {
    const { palette, extras } = derivePalette("dark", { background: "#282A36", foreground: "#F8F8F2", accent: "#BD93F9" });
    expect(palette["bg-0"]).toBe("#282A36");
    expect(palette["text-100"]).toBe("#F8F8F2");
    expect(palette.accent).toBe("#BD93F9");
    expect(palette["bg-300"]).toBe(mix("#282A36", "#F8F8F2", 0.2));
    expect(extras["--link"]).toBe("#BD93F9");
  });

  it("lifts light cards toward white", () => {
    expect(derivePalette("light", { background: "#EAECF0", foreground: "#4C4F69", accent: "#8839EF" }).palette["bg-100"]).toBe(mix("#EAECF0", "#FFFFFF", 0.6));
  });
});

describe("presets and edits", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
    vi.stubGlobal("window", { dispatchEvent: () => true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts on Nyxs, switches presets, and marks a hand edit as custom until it matches a preset again", () => {
    expect(getThemeColors().dark.preset).toBe("nyxs");
    applyPreset("dark", "dracula");
    expect(getThemeColors().dark).toMatchObject({ preset: "dracula", background: "#282A36" });
    setModeColor("dark", "accent", "#ff0000");
    expect(getThemeColors().dark).toMatchObject({ preset: "custom", accent: "#FF0000" });
    setModeColor("dark", "accent", "#BD93F9");
    expect(getThemeColors().dark.preset).toBe("dracula");
    expect(getThemeColors().light.preset).toBe("nyxs");
  });

  it("has every preset from the list, Nyxs first", () => {
    expect(LIGHT_PRESETS.map((p) => p.label)).toEqual(["Nyxs", "Default Light", "Catppuccin", "Gruvbox Material", "One Light", "Solarized Light"]);
    expect(DARK_PRESETS.map((p) => p.label)).toEqual(["Nyxs", "Default Dark", "Catppuccin", "Dracula", "Gruvbox Material", "Monokai", "One Dark Pro", "Tokyo Night", "Solarized Dark", "Vesper"]);
  });
});

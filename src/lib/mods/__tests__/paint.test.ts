import { describe, expect, it } from "vitest";
import { MODS_SKILL } from "../skill/modsSkill";
import { contrast, makeColors } from "../skill/make-colors.js";
import { paletteVars } from "../paint";
import type { ThemeColors } from "../types";

const LAGOON = {
  label: "Lagoon",
  roles: { accent: "#1f8a9e", danger: "#c0473a" },
  light: { gray: { anchors: { "surface-0": "#e3f1f2", "surface-2": "#f6fbfb", "text-primary": "#10292d", "text-secondary": "#2f4f54", "text-muted": "#4d6a6e" } } },
  dark: { gray: { anchors: { "surface-0": "#0d1d21", "surface-1": "#12262b", "surface-2": "#173036", "text-primary": "#e2f1f2", "text-muted": "#93b0b3" } } },
};

describe("a mod's colors", () => {
  it("makeColors writes the scale Nyxs and Claude Code read, and paint reads it back", () => {
    const { theme, problems } = makeColors(LAGOON);
    expect(theme.inputs.dark).toMatchObject({ "gray-900": "#0d1d21", "gray-850": "#12262b", "gray-50": "#e2f1f2", "role-accent-fill": "#1f8a9e" });
    expect(problems).toEqual([]);
    const dark = paletteVars(theme as ThemeColors, "dark");
    expect(dark).toMatchObject({ "--bg-0": "#0d1d21", "--bg-100": "#12262b", "--bg-200": "#173036", "--text-100": "#e2f1f2", "--text-400": "#93b0b3", "--accent": "#1f8a9e", "--danger": "#c0473a" });
    const light = paletteVars(theme as ThemeColors, "light");
    expect(light).toMatchObject({ "--bg-0": "#e3f1f2", "--bg-100": "#f6fbfb", "--text-300": "#2f4f54" });
  });

  it("paints nothing for a mode the palette doesn't give", () => {
    const { theme } = makeColors({ label: "Night", roles: { accent: "#7aa2f7" }, dark: LAGOON.dark });
    expect(paletteVars(theme as ThemeColors, "light")).toEqual({});
  });

  it("reports text that reads poorly, and refuses what isn't a color", () => {
    const { problems } = makeColors({ label: "Fog", light: { gray: { anchors: { "surface-0": "#dddddd", "text-primary": "#999999" } } } });
    expect(problems[0]).toMatch(/^text-primary on surface-0 is .*it needs 7:1/);
    expect(() => makeColors({ label: "X", light: { gray: { anchors: { "surface-0": "red", "text-primary": "#000000" } } } })).toThrow(/six-digit hex/);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
  });

  it("the skill carries the helper and the folder placeholder", () => {
    expect(MODS_SKILL.body).toContain("export function makeColors");
    expect(MODS_SKILL.body).toContain("${NYXS_DEV_MODS_DIR}/<mod-name>/");
    expect(MODS_SKILL.body).not.toContain("{{MAKE_COLORS}}");
  });
});

import { CODE_THEMES, codePaletteFor, type CodeTheme } from "@/lib/appearance";
import { applyTheme, effectiveTheme, setAfterApplyTheme, setSchemeOverride } from "@/lib/theme";
import { derivePalette, mix } from "@/lib/themeColors";
import type { StandingTheme, ThemeColors } from "./types";

/**
 * Puts the open session's mod theme on screen: the color scheme it asks for, its colors over
 * Nyxs' palette, its code theme, and the frosted panels over its backdrop. The colors come as
 * Claude Code's mods send them (the design system's scale, as `makeColors` writes it); the few
 * Nyxs paints with are read from it, and a mod may also give them by their plain names.
 */

const HEX = /^#[0-9a-f]{6}$/i;

/** Where each plain name sits on the scale, in light and in dark. */
const SCALE: Record<string, [string, string]> = {
  "surface-0": ["gray-20", "gray-900"],
  "surface-1": ["gray-10", "gray-850"],
  "surface-2": ["gray-0", "gray-830"],
  "text-primary": ["gray-900", "gray-50"],
  "text-secondary": ["gray-600", "gray-200"],
  "text-muted": ["gray-400", "gray-400"],
  accent: ["role-accent-fill", "role-accent-fill"],
  "accent-hover": ["role-accent-fill-hover", "role-accent-fill-hover"],
  danger: ["role-danger-600", "role-danger-300"],
  success: ["role-success-600", "role-success-400"],
  warning: ["role-warning-600", "role-warning-300"],
};

function pick(inputs: Record<string, string>, name: string, mode: "light" | "dark"): string | undefined {
  const own = inputs[name];
  if (typeof own === "string" && HEX.test(own)) return own;
  const scaled = inputs[SCALE[name]?.[mode === "light" ? 0 : 1] ?? ""];
  return typeof scaled === "string" && HEX.test(scaled) ? scaled : undefined;
}

/** The CSS variables a mod's palette sets in one mode; empty where it gives no page and text. */
export function paletteVars(colors: ThemeColors, mode: "light" | "dark"): Record<string, string> {
  const inputs = colors.inputs?.[mode];
  if (!inputs) return {};
  const bg = pick(inputs, "surface-0", mode);
  const fg = pick(inputs, "text-primary", mode);
  if (!bg || !fg) return {};
  const accent = pick(inputs, "accent", mode) ?? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const { palette, extras } = derivePalette(mode, { background: bg, foreground: fg, accent: HEX.test(accent) ? accent : mode === "light" ? "#2a78d6" : "#4a8fe4" });
  const s1 = pick(inputs, "surface-1", mode);
  const s2 = pick(inputs, "surface-2", mode);
  const fg2 = pick(inputs, "text-secondary", mode);
  const muted = pick(inputs, "text-muted", mode);
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(palette)) vars[`--${k}`] = v;
  Object.assign(vars, extras);
  // In Claude Code's scale the page is the darkest surface and cards sit lighter; Nyxs' cards are
  // bg-100 in both modes, and its fills (bg-200) step toward the text.
  if (mode === "light" && s2) vars["--bg-100"] = s2;
  if (mode === "dark" && s1) vars["--bg-100"] = s1;
  if (mode === "dark" && s2) vars["--bg-200"] = s2;
  if (fg2) {
    vars["--text-200"] = mix(fg, fg2, 0.5);
    vars["--text-300"] = fg2;
  }
  if (muted) {
    vars["--text-400"] = muted;
    vars["--text-500"] = mix(muted, bg, 0.25);
  }
  const hover = pick(inputs, "accent-hover", mode);
  if (hover) vars["--accent-hover"] = hover;
  for (const role of ["danger", "success", "warning"] as const) {
    const c = pick(inputs, role, mode);
    if (c) vars[`--${role}`] = c;
  }
  return vars;
}

let painted: string[] = [];
let standing: StandingTheme | null = null;

function paintColors(mode: "light" | "dark"): void {
  const root = document.documentElement;
  for (const v of painted) root.style.removeProperty(v);
  painted = [];
  const colors = standing?.args.colors;
  if (!colors) return;
  const vars = paletteVars(colors, mode);
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
    painted.push(k);
  }
  const code = colors.codeTheme?.[mode];
  if (code && CODE_THEMES.some((t) => t.id === code)) {
    for (const [role, color] of Object.entries(codePaletteFor(code as CodeTheme))) {
      root.style.setProperty(`--code-${role}`, color);
      painted.push(`--code-${role}`);
    }
  }
}

function schemeOf(t: StandingTheme | null): "light" | "dark" | null {
  if (!t) return null;
  const a = t.args;
  const b = a.backdrop || undefined;
  if (a.overrideColorScheme) return a.overrideColorScheme;
  if (b?.colorScheme) return b.colorScheme;
  // A palette made for one mode alone acts as if it named that mode.
  const inputs = a.colors?.inputs;
  if (inputs && !!inputs.light !== !!inputs.dark) return inputs.light ? "light" : "dark";
  return null;
}

function paintGlass(t: StandingTheme | null): void {
  const root = document.documentElement;
  const b = t?.args.backdrop || undefined;
  root.classList.toggle("mod-backdrop", !!b);
  const glass = b ? (b.glass === false ? null : { blur: 16, opacity: 0.6, ...(b.glass ?? {}) }) : null;
  root.classList.toggle("mod-glass", !!glass);
  if (glass) {
    root.style.setProperty("--mod-glass-blur", `${Math.max(0, Math.min(64, Number(glass.blur) || 0))}px`);
    root.style.setProperty("--mod-glass-opacity", String(Math.max(0, Math.min(1, Number(glass.opacity)))));
    if (typeof glass.tint === "string" && glass.tint) root.style.setProperty("--mod-glass-tint", glass.tint);
    else root.style.removeProperty("--mod-glass-tint");
  }
}

setAfterApplyTheme(paintColors);

/** Shows `theme` (or the app's own look, with null) as the open session's. */
export function paintModTheme(theme: StandingTheme | null): void {
  if (theme === standing) return;
  standing = theme;
  paintGlass(theme);
  const scheme = schemeOf(theme);
  // The override repaints when it changes; otherwise the palette is repainted here.
  const before = effectiveTheme();
  setSchemeOverride(scheme);
  if (effectiveTheme() === before) applyTheme(before);
}

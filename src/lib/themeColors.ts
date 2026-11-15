import { useEffect, useState } from "react";
import type { ThemePalette } from "@/lib/theme";

/** The light and dark themes the user can pick or tune: three colors each (background, text,
 *  accent), from which the rest of the palette is derived. "nyxs" is the app's own look and keeps
 *  its hand-tuned palette exactly; every other preset (and any edit) goes through `derivePalette`. */

export type ThemeMode = "light" | "dark";

export interface ThemeColors {
  background: string;
  foreground: string;
  accent: string;
}

export interface ThemePreset extends ThemeColors {
  id: string;
  label: string;
}

export const LIGHT_PRESETS: ThemePreset[] = [
  { id: "nyxs", label: "Nyxs", background: "#FAF9F5", foreground: "#1F1E1D", accent: "#2A78D6" },
  { id: "default", label: "Default Light", background: "#F9F9F9", foreground: "#101010", accent: "#007ACC" },
  { id: "catppuccin", label: "Catppuccin", background: "#EAECF0", foreground: "#4C4F69", accent: "#8839EF" },
  { id: "gruvbox-material", label: "Gruvbox Material", background: "#F9F5D7", foreground: "#4F3829", accent: "#C35E0A" },
  { id: "one-light", label: "One Light", background: "#F5F5F5", foreground: "#383A42", accent: "#4078F2" },
  { id: "solarized-light", label: "Solarized Light", background: "#FAF4E5", foreground: "#435155", accent: "#CB4B16" },
];

export const DARK_PRESETS: ThemePreset[] = [
  { id: "nyxs", label: "Nyxs", background: "#212121", foreground: "#ECECEC", accent: "#4A8FE4" },
  { id: "default", label: "Default Dark", background: "#101010", foreground: "#CCCCCC", accent: "#007ACC" },
  { id: "catppuccin", label: "Catppuccin", background: "#24273A", foreground: "#CAD3F5", accent: "#C6A0F6" },
  { id: "dracula", label: "Dracula", background: "#282A36", foreground: "#F8F8F2", accent: "#BD93F9" },
  { id: "gruvbox-material", label: "Gruvbox Material", background: "#141617", foreground: "#D4BE98", accent: "#E78A4E" },
  { id: "monokai", label: "Monokai", background: "#272822", foreground: "#F8F8F2", accent: "#F92672" },
  { id: "one-dark-pro", label: "One Dark Pro", background: "#282C34", foreground: "#ABB2BF", accent: "#61AFEF" },
  { id: "tokyo-night", label: "Tokyo Night", background: "#1A1B26", foreground: "#A9B1D6", accent: "#7AA2F7" },
  { id: "solarized-dark", label: "Solarized Dark", background: "#002B36", foreground: "#93A1A1", accent: "#268BD2" },
  { id: "vesper", label: "Vesper", background: "#101010", foreground: "#FFFFFF", accent: "#FFC799" },
];

export const PRESETS: Record<ThemeMode, ThemePreset[]> = { light: LIGHT_PRESETS, dark: DARK_PRESETS };

/** What is saved per mode: the preset it started from ("custom" once a color is edited) and the
 *  three colors in use. */
export interface ModeTheme extends ThemeColors {
  preset: string;
}

export interface ThemeColorPrefs {
  light: ModeTheme;
  dark: ModeTheme;
}

const fromPreset = (p: ThemePreset): ModeTheme => ({ preset: p.id, background: p.background, foreground: p.foreground, accent: p.accent });

export const DEFAULT_THEME_COLORS: ThemeColorPrefs = { light: fromPreset(LIGHT_PRESETS[0]), dark: fromPreset(DARK_PRESETS[0]) };

const HEX = /^#[0-9a-f]{6}$/i;

/** "#abc", "abc123", " #ABC123 " → "#ABC123"; null when it isn't a color. */
export function normalizeHex(input: string): string | null {
  let v = input.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(v)) v = v.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/i.test(v) ? `#${v.toUpperCase()}` : null;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `a` moved `t` of the way toward `b` (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

export interface DerivedTheme {
  palette: ThemePalette;
  /** Chat colors that otherwise come from the stylesheet. */
  extras: Record<"--link" | "--user-bubble" | "--inline-code-bg" | "--inline-code-border", string>;
}

/** The whole palette from three colors. Surfaces step from the background toward the text,
 *  muted text steps from the text toward the background; light themes lift cards toward white,
 *  dark ones toward the text, as the app's own themes do. */
export function derivePalette(mode: ThemeMode, c: ThemeColors): DerivedTheme {
  const { background: bg, foreground: fg, accent } = c;
  const light = mode === "light";
  return {
    palette: {
      "bg-0": bg,
      "bg-000": bg,
      "bg-100": light ? mix(bg, "#FFFFFF", 0.6) : mix(bg, fg, 0.035),
      "bg-200": mix(bg, fg, light ? 0.05 : 0.08),
      "bg-300": mix(bg, fg, light ? 0.14 : 0.2),
      "text-100": fg,
      "text-200": mix(fg, bg, 0.12),
      "text-300": mix(fg, bg, 0.38),
      "text-400": mix(fg, bg, 0.5),
      "text-500": mix(fg, bg, 0.6),
      accent,
      "accent-hover": light ? mix(accent, "#000000", 0.12) : mix(accent, "#FFFFFF", 0.15),
    },
    extras: {
      "--link": accent,
      "--user-bubble": mix(bg, fg, light ? 0.06 : 0.1),
      "--inline-code-bg": mix(bg, fg, light ? 0.045 : 0.08),
      "--inline-code-border": mix(bg, fg, light ? 0.12 : 0.16),
    },
  };
}

export const THEME_COLORS_KEY = "nyxs.themeColors.v1";
export const THEME_COLORS_EVENT = "nyxs:theme-colors-changed";

function validMode(raw: unknown, fallback: ModeTheme): ModeTheme {
  const r = (raw ?? {}) as Partial<ModeTheme>;
  const pick = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v) ? v.toUpperCase() : d);
  return {
    preset: typeof r.preset === "string" && r.preset ? r.preset : fallback.preset,
    background: pick(r.background, fallback.background),
    foreground: pick(r.foreground, fallback.foreground),
    accent: pick(r.accent, fallback.accent),
  };
}

export function getThemeColors(): ThemeColorPrefs {
  try {
    const raw = localStorage.getItem(THEME_COLORS_KEY);
    if (!raw) return DEFAULT_THEME_COLORS;
    const parsed = JSON.parse(raw) as Partial<ThemeColorPrefs>;
    return { light: validMode(parsed.light, DEFAULT_THEME_COLORS.light), dark: validMode(parsed.dark, DEFAULT_THEME_COLORS.dark) };
  } catch {
    return DEFAULT_THEME_COLORS;
  }
}

/** Saves one mode's theme; the theme module listens and repaints the app. */
export function setModeTheme(mode: ThemeMode, next: ModeTheme): void {
  const all = { ...getThemeColors(), [mode]: next };
  try {
    localStorage.setItem(THEME_COLORS_KEY, JSON.stringify(all));
  } catch { /* storage unavailable: it still applies for this session */ }
  window.dispatchEvent(new CustomEvent(THEME_COLORS_EVENT));
}

export function applyPreset(mode: ThemeMode, presetId: string): void {
  const p = PRESETS[mode].find((x) => x.id === presetId);
  if (p) setModeTheme(mode, fromPreset(p));
}

/** Changes one color. It stays on its preset while the colors still match one, else "custom". */
export function setModeColor(mode: ThemeMode, key: keyof ThemeColors, value: string): void {
  const cur = getThemeColors()[mode];
  const next = { ...cur, [key]: value.toUpperCase() };
  const match = PRESETS[mode].find((p) => p.background === next.background && p.foreground === next.foreground && p.accent === next.accent);
  setModeTheme(mode, { ...next, preset: match ? match.id : "custom" });
}

export function useThemeColors(): ThemeColorPrefs {
  const [prefs, setPrefs] = useState<ThemeColorPrefs>(getThemeColors);
  useEffect(() => {
    const sync = () => setPrefs(getThemeColors());
    window.addEventListener(THEME_COLORS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(THEME_COLORS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return prefs;
}

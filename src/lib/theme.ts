import { useEffect, useState } from "react";
import { applyCodePalette } from "@/lib/appearance";
import { accountKey } from "@/lib/accountScope";
import { getCurrentUserId } from "@/lib/auth";
import { browserFollowsTheme, browserReloadsOnTheme } from "@/lib/featureSettings";
import { subscribeSettings } from "@/lib/settingsRuntime";
import { THEME_COLORS_EVENT, THEME_COLORS_KEY, derivePalette, getThemeColors } from "@/lib/themeColors";

export interface ThemePalette {
  "bg-0": string;
  "bg-000": string;
  "bg-100": string;
  "bg-200": string;
  "bg-300": string;
  "text-100": string;
  "text-200": string;
  "text-300": string;
  "text-400": string;
  "text-500": string;
  accent: string;
  "accent-hover": string;
}

export type ThemeId = "light" | "dark" | "pink" | "high-contrast-light" | "high-contrast-dark";

export type ThemePreference = ThemeId | "auto";

export interface Theme {
  id: ThemeId;
  mode: "light" | "dark";
  palette: ThemePalette;
}

export const THEMES: Record<ThemeId, Theme> = {
  light: {
    id: "light",
    mode: "light",
    palette: {
      "bg-0": "#faf9f5",
      "bg-000": "#faf9f5",
      "bg-100": "#ffffff",
      "bg-200": "#f0eee6",
      "bg-300": "#dddddd",
      "text-100": "#1f1e1d",
      "text-200": "#3d3d3a",
      "text-300": "#73726c",
      "text-400": "#888888",
      "text-500": "#999999",
      accent: "#2a78d6",
      "accent-hover": "#1f66bd",
    },
  },
  dark: {
    id: "dark",
    mode: "dark",
    palette: {
      "bg-0": "#212121",
      "bg-000": "#212121",
      "bg-100": "#262624",
      "bg-200": "#30302e",
      "bg-300": "#454540",
      "text-100": "#ececec",
      "text-200": "#e1e1e0",
      "text-300": "#b4b4b4",
      "text-400": "#8a8a88",
      "text-500": "#6b6b65",
      accent: "#4a8fe4",
      "accent-hover": "#6aa4ec",
    },
  },
  pink: {
    id: "pink",
    mode: "light",
    palette: {
      "bg-0": "#fdf2f8",
      "bg-000": "#fdf2f8",
      "bg-100": "#ffffff",
      "bg-200": "#fce7f3",
      "bg-300": "#f3c6da",
      "text-100": "#500724",
      "text-200": "#831843",
      "text-300": "#9d496f",
      "text-400": "#b06b8a",
      "text-500": "#c98ba5",
      accent: "#db2777",
      "accent-hover": "#be185d",
    },
  },
  "high-contrast-light": {
    id: "high-contrast-light",
    mode: "light",
    palette: {
      "bg-0": "#ffffff",
      "bg-000": "#ffffff",
      "bg-100": "#ffffff",
      "bg-200": "#f2f2f2",
      "bg-300": "#3d3d3d",
      "text-100": "#000000",
      "text-200": "#0a0a0a",
      "text-300": "#1a1a1a",
      "text-400": "#2e2e2e",
      "text-500": "#454545",
      accent: "#0a4fb5",
      "accent-hover": "#083f91",
    },
  },
  "high-contrast-dark": {
    id: "high-contrast-dark",
    mode: "dark",
    palette: {
      "bg-0": "#000000",
      "bg-000": "#000000",
      "bg-100": "#0a0a0a",
      "bg-200": "#1a1a1a",
      "bg-300": "#5a5a5a",
      "text-100": "#ffffff",
      "text-200": "#f5f5f5",
      "text-300": "#e0e0e0",
      "text-400": "#c4c4c4",
      "text-500": "#a3a3a3",
      accent: "#7ab6ff",
      "accent-hover": "#9cc9ff",
    },
  },
};

export const THEME_ORDER: ThemePreference[] = [
  "auto",
  "light",
  "dark",
  "pink",
  "high-contrast-light",
  "high-contrast-dark",
];

export const THEME_KEY = "nyxs.theme.v1";
export const THEME_EVENT = "nyxs:theme-changed";
export const DEFAULT_PREFERENCE: ThemePreference = "auto";

const isThemeId = (v: string): v is ThemeId => v in THEMES;

export function getThemePreference(): ThemePreference {
  const uid = getCurrentUserId();
  const v = localStorage.getItem(uid ? accountKey(THEME_KEY) : THEME_KEY);
  if (v === "auto" || (v && isThemeId(v))) return v as ThemePreference;
  return DEFAULT_PREFERENCE;
}

function prefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

export function resolveTheme(pref: ThemePreference): ThemeId {
  if (pref === "auto") return prefersDark() ? "dark" : "light";
  return pref;
}

const EXTRA_VARS = ["--link", "--user-bubble", "--inline-code-bg", "--inline-code-border"] as const;

/** A mod's theme can ask for light or dark while it stands (`overrideColorScheme`); the user's
 *  own choice is kept and comes back when it goes. */
let schemeOverride: "light" | "dark" | null = null;
/** Paints over the palette once a theme is applied: a mod's colors (src/lib/mods/paint.ts). */
let afterApply: ((mode: "light" | "dark") => void) | null = null;

/** The theme on screen: the user's, unless a mod's theme asks for the other mode. */
export function effectiveTheme(): ThemeId {
  const id = resolveTheme(getThemePreference());
  if (!schemeOverride || THEMES[id].mode === schemeOverride) return id;
  return schemeOverride;
}

export function setSchemeOverride(mode: "light" | "dark" | null): void {
  if (mode === schemeOverride) return;
  schemeOverride = mode;
  applyTheme(effectiveTheme());
  window.dispatchEvent(new CustomEvent(THEME_EVENT));
}

export function setAfterApplyTheme(fn: ((mode: "light" | "dark") => void) | null): void {
  afterApply = fn;
}

/** The palette a theme paints with. Light and dark follow the user's preset or colors
 *  (themeColors.ts); "nyxs" keeps the hand-tuned palette above, as do pink and high contrast. */
function paletteOf(id: ThemeId): { palette: ThemePalette; extras: Partial<Record<(typeof EXTRA_VARS)[number], string>> } {
  const theme = THEMES[id];
  if (id !== "light" && id !== "dark") return { palette: theme.palette, extras: {} };
  const mine = getThemeColors()[id];
  if (mine.preset === "nyxs") return { palette: theme.palette, extras: {} };
  return derivePalette(id, mine);
}

export function applyTheme(id: ThemeId): void {
  const theme = THEMES[id];
  const root = document.documentElement;
  const { palette, extras } = paletteOf(id);
  for (const key of Object.keys(palette) as (keyof ThemePalette)[]) {
    root.style.setProperty(`--${key}`, palette[key]);
  }
  // Set inline they beat the stylesheet's .dark/.pink values, so they're cleared when unused.
  for (const v of EXTRA_VARS) {
    const value = extras[v];
    if (value) root.style.setProperty(v, value);
    else root.style.removeProperty(v);
  }
  root.classList.toggle("dark", theme.mode === "dark");
  root.classList.toggle("pink", id === "pink");
  root.style.colorScheme = theme.mode;
  applyCodePalette(theme.mode);
  syncNativeTheme(getThemePreference() === "auto" && !schemeOverride ? null : theme.mode);
  afterApply?.(theme.mode);
}

let nativeTheme: string | undefined;
let lastMode: "light" | "dark" | null = null;

/** Pages in the built-in browser, and local pages in the app's own webview, see the app's theme
 *  as `prefers-color-scheme`. On "auto" (null) everything follows the OS: switching to it reads
 *  the old scheme for a moment, and the matchMedia listener in initTheme repaints once it's let go.
 *  Settings can leave the pages on the system's theme, and keep pages that don't repaint from
 *  being reloaded. */
function syncNativeTheme(mode: "light" | "dark" | null): void {
  lastMode = mode;
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  const effective = browserFollowsTheme() ? mode : null;
  const reload = browserReloadsOnTheme();
  const key = `${effective}|${reload}`;
  if (key === nativeTheme) return;
  nativeTheme = key;
  void import("@/lib/ipc")
    .then(({ invoke }) => invoke("preview_set_theme", { mode: effective, reload }))
    .catch(() => {
      // Try again on the next theme change instead of believing it was applied.
      if (nativeTheme === key) nativeTheme = undefined;
    });
}

export function setThemePreference(pref: ThemePreference): void {
  localStorage.setItem(accountKey(THEME_KEY), pref);
  localStorage.setItem(THEME_KEY, pref);
  applyTheme(effectiveTheme());
  window.dispatchEvent(new CustomEvent(THEME_EVENT));
}

/** The theme in use before high contrast was turned on, which turning it off gives back. */
const BEFORE_HIGH_CONTRAST_KEY = "nyxs.theme.beforeHighContrast.v1";

export const isHighContrast = (pref: ThemePreference): boolean => pref === "high-contrast-light" || pref === "high-contrast-dark";

/** Settings' high contrast switch: on, the high contrast theme of the mode in use (light, pink or
 *  "auto" on a light system get the light one); off, the theme the user had before. */
export function setHighContrast(on: boolean): void {
  const current = getThemePreference();
  if (on) {
    if (isHighContrast(current)) return;
    localStorage.setItem(accountKey(BEFORE_HIGH_CONTRAST_KEY), current);
    setThemePreference(THEMES[resolveTheme(current)].mode === "light" ? "high-contrast-light" : "high-contrast-dark");
    return;
  }
  if (!isHighContrast(current)) return;
  const before = localStorage.getItem(accountKey(BEFORE_HIGH_CONTRAST_KEY));
  const fallback: ThemePreference = current === "high-contrast-light" ? "light" : "dark";
  const back = before === "auto" || (before && isThemeId(before) && !isHighContrast(before as ThemeId)) ? (before as ThemePreference) : fallback;
  localStorage.removeItem(accountKey(BEFORE_HIGH_CONTRAST_KEY));
  setThemePreference(back);
}

export function restorePersistedTheme(): void {
  applyTheme(effectiveTheme());
}

export function cycleThemePreference(): ThemePreference {
  const order = THEME_ORDER;
  const i = order.indexOf(getThemePreference());
  const next = order[(i + 1) % order.length];
  setThemePreference(next);
  return next;
}

export function initTheme(): void {
  applyTheme(effectiveTheme());
  if (typeof window === "undefined") return;
  // A preset or a color changed in Settings: repaint, and let the terminal and others re-read it.
  const repaint = () => {
    applyTheme(effectiveTheme());
    window.dispatchEvent(new CustomEvent(THEME_EVENT));
  };
  window.addEventListener(THEME_COLORS_EVENT, repaint);
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_COLORS_KEY) repaint();
  });
  // The browser's theme switches in Settings apply at once (and once settings.json is read).
  subscribeSettings(() => syncNativeTheme(lastMode));
  if (!window.matchMedia) return;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", () => {
    if (getThemePreference() === "auto") {
      applyTheme(effectiveTheme());
      window.dispatchEvent(new CustomEvent(THEME_EVENT));
    }
  });
}

export interface UseThemeResult {
  preference: ThemePreference;
  resolved: ThemeId;
  setPreference: (pref: ThemePreference) => void;
  preview: (pref: ThemePreference) => void;
  cancelPreview: () => void;
}

export function useTheme(): UseThemeResult {
  const [preference, setPref] = useState<ThemePreference>(getThemePreference);
  useEffect(() => {
    const sync = () => setPref(getThemePreference());
    window.addEventListener(THEME_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(THEME_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return {
    preference,
    resolved: resolveTheme(preference),
    setPreference: setThemePreference,
    preview: (pref) => applyTheme(resolveTheme(pref)),
    cancelPreview: restorePersistedTheme,
  };
}

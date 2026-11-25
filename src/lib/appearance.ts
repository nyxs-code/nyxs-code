import type { AmbientKind, AmbientVolume } from "@/lib/ambientSound";
import { useEffect, useState } from "react";

export type InterfaceFont = "sans" | "system";
export type TranscriptTextSize = "small" | "medium" | "large";
export type ChatWidth = "narrow" | "comfortable" | "wide";
export type CodeTheme =
  | "dark-plus"
  | "nyxs-dark"
  | "github-dark"
  | "monokai"
  | "dracula"
  | "nord"
  | "solarized-dark"
  | "github-light"
  | "one-light"
  | "solarized-light"
  | "catppuccin-latte"
  | "gruvbox-light"
  | "ayu-light";

export interface AppearancePrefs {
  interfaceFont: InterfaceFont;
  codeFont: string;
  transcriptTextSize: TranscriptTextSize;
  chatWidth: ChatWidth;
  codeThemeDark: CodeTheme;
  codeThemeLight: CodeTheme;
  requestAttention: boolean;
  /** Animations: as the system says, or always fewer (on) or always all (off). */
  reduceMotion: ReduceMotion;
  /** Popups (the mods' notices) stay until closed instead of going after a few seconds. */
  keepPopups: boolean;
  /** A background ambience while the app is on screen (ambientSound.ts). */
  themeSound: "off" | AmbientKind;
  themeSoundVolume: AmbientVolume;
  /** Older messages out of view aren't drawn (CSS content-visibility), so long chats stay smooth. */
  dynamicConversations: boolean;
}

export type ReduceMotion = "system" | "on" | "off";

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  interfaceFont: "sans",
  codeFont: "",
  transcriptTextSize: "medium",
  chatWidth: "comfortable",
  codeThemeDark: "dark-plus",
  codeThemeLight: "github-light",
  requestAttention: true,
  reduceMotion: "system",
  keepPopups: false,
  themeSound: "off",
  themeSoundVolume: "medium",
  dynamicConversations: true,
};

export interface CodePalette {
  comment: string;
  string: string;
  keyword: string;
  tag: string;
  attr: string;
  number: string;
  func: string;
  plain: string;
  bg: string;
  line: string;
  addBg: string;
  delBg: string;
}

export const CODE_THEMES: { id: CodeTheme; label: string; mode: "light" | "dark"; palette: CodePalette }[] = [
  {
    id: "dark-plus",
    label: "Dark+ (VS Code)",
    mode: "dark",
    palette: { comment: "#6A9955", string: "#CE9178", keyword: "#569CD6", tag: "#569CD6", attr: "#9CDCFE", number: "#B5CEA8", func: "#DCDCAA", plain: "#D4D4D4", bg: "#1E1E1E", line: "#858585", addBg: "rgba(46,160,67,0.15)", delBg: "rgba(248,81,73,0.15)" },
  },
  {
    id: "nyxs-dark",
    label: "Nyxs Dark",
    mode: "dark",
    palette: { comment: "#7E7A70", string: "#C7A56F", keyword: "#D97757", tag: "#D97757", attr: "#C9B79A", number: "#CC9B6A", func: "#E0BC85", plain: "#D7D3C8", bg: "#1E1D1B", line: "#6A665D", addBg: "rgba(122,162,99,0.16)", delBg: "rgba(204,108,92,0.18)" },
  },
  {
    id: "github-dark",
    label: "GitHub Dark",
    mode: "dark",
    palette: { comment: "#8B949E", string: "#A5D6FF", keyword: "#FF7B72", tag: "#7EE787", attr: "#79C0FF", number: "#79C0FF", func: "#D2A8FF", plain: "#C9D1D9", bg: "#0D1117", line: "#6E7681", addBg: "rgba(46,160,67,0.15)", delBg: "rgba(248,81,73,0.15)" },
  },
  {
    id: "monokai",
    label: "Monokai",
    mode: "dark",
    palette: { comment: "#88846F", string: "#E6DB74", keyword: "#F92672", tag: "#F92672", attr: "#A6E22E", number: "#AE81FF", func: "#A6E22E", plain: "#F8F8F2", bg: "#272822", line: "#90908A", addBg: "rgba(166,226,46,0.13)", delBg: "rgba(249,38,114,0.13)" },
  },
  {
    id: "dracula",
    label: "Dracula",
    mode: "dark",
    palette: { comment: "#6272A4", string: "#F1FA8C", keyword: "#FF79C6", tag: "#FF79C6", attr: "#50FA7B", number: "#BD93F9", func: "#50FA7B", plain: "#F8F8F2", bg: "#282A36", line: "#6272A4", addBg: "rgba(80,250,123,0.13)", delBg: "rgba(255,85,85,0.15)" },
  },
  {
    id: "nord",
    label: "Nord",
    mode: "dark",
    palette: { comment: "#616E88", string: "#A3BE8C", keyword: "#81A1C1", tag: "#81A1C1", attr: "#8FBCBB", number: "#B48EAD", func: "#88C0D0", plain: "#D8DEE9", bg: "#2E3440", line: "#4C566A", addBg: "rgba(163,190,140,0.15)", delBg: "rgba(191,97,106,0.17)" },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    mode: "dark",
    palette: { comment: "#586E75", string: "#2AA198", keyword: "#859900", tag: "#268BD2", attr: "#B58900", number: "#D33682", func: "#268BD2", plain: "#93A1A1", bg: "#002B36", line: "#586E75", addBg: "rgba(133,153,0,0.16)", delBg: "rgba(220,50,47,0.17)" },
  },
  {
    id: "github-light",
    label: "GitHub Light",
    mode: "light",
    palette: { comment: "#6E7781", string: "#0A3069", keyword: "#CF222E", tag: "#116329", attr: "#0550AE", number: "#0550AE", func: "#8250DF", plain: "#1F2328", bg: "#FFFFFF", line: "#8C959F", addBg: "rgba(31,136,61,0.15)", delBg: "rgba(207,34,46,0.12)" },
  },
  {
    id: "one-light",
    label: "One Light",
    mode: "light",
    palette: { comment: "#A0A1A7", string: "#50A14F", keyword: "#A626A4", tag: "#E45649", attr: "#4078F2", number: "#986801", func: "#4078F2", plain: "#383A42", bg: "#FAFAFA", line: "#9D9D9F", addBg: "rgba(80,161,79,0.13)", delBg: "rgba(228,86,73,0.12)" },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    mode: "light",
    palette: { comment: "#93A1A1", string: "#2AA198", keyword: "#859900", tag: "#268BD2", attr: "#B58900", number: "#D33682", func: "#268BD2", plain: "#657B83", bg: "#FDF6E3", line: "#93A1A1", addBg: "rgba(133,153,0,0.16)", delBg: "rgba(220,50,47,0.14)" },
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    mode: "light",
    palette: { comment: "#8C8FA1", string: "#40A02B", keyword: "#8839EF", tag: "#1E66F5", attr: "#DF8E1D", number: "#FE640B", func: "#1E66F5", plain: "#4C4F69", bg: "#EFF1F5", line: "#9CA0B0", addBg: "rgba(64,160,43,0.13)", delBg: "rgba(210,15,57,0.12)" },
  },
  {
    id: "gruvbox-light",
    label: "Gruvbox Light",
    mode: "light",
    palette: { comment: "#928374", string: "#79740E", keyword: "#9D0006", tag: "#B57614", attr: "#076678", number: "#8F3F71", func: "#427B58", plain: "#3C3836", bg: "#FBF1C7", line: "#A89984", addBg: "rgba(121,116,14,0.15)", delBg: "rgba(157,0,6,0.12)" },
  },
  {
    id: "ayu-light",
    label: "Ayu Light",
    mode: "light",
    palette: { comment: "#ABB0B6", string: "#86B300", keyword: "#FA8D3E", tag: "#55B4D4", attr: "#F2AE49", number: "#A37ACC", func: "#F2AE49", plain: "#5C6166", bg: "#FAFAFA", line: "#8A9199", addBg: "rgba(134,179,0,0.14)", delBg: "rgba(242,85,85,0.12)" },
  },
];

export function codePaletteFor(id: CodeTheme): CodePalette {
  return (CODE_THEMES.find((t) => t.id === id) ?? CODE_THEMES[0]).palette;
}

// "Inter Variable" is bundled (@fontsource-variable/inter); plain "Inter" stays for a locally installed copy.
const SANS_STACK = '"Inter Variable", "Inter", "Onest", system-ui, sans-serif';
const SYSTEM_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

export const APPEARANCE_KEY = "nyxs.appearance.v1";
export const APPEARANCE_EVENT = "nyxs:appearance-changed";

export function transcriptZoom(size: TranscriptTextSize): number {
  return size === "small" ? 0.9 : size === "large" ? 1.15 : 1;
}

export function chatWidthClass(width: ChatWidth): string {
  return width === "narrow" ? "max-w-2xl" : width === "wide" ? "max-w-6xl" : "max-w-3xl";
}

/** The CSS length of a `chatWidthClass` column, for styles that must line up with it. */
export function chatColumnMeasure(widthClass: string): string {
  return widthClass === "max-w-2xl" ? "42rem" : widthClass === "max-w-6xl" ? "72rem" : "48rem";
}

export function getAppearance(): AppearancePrefs {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const parsed = JSON.parse(raw) as Partial<AppearancePrefs>;
    return { ...DEFAULT_APPEARANCE, ...parsed };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function applyAppearance(prefs: AppearancePrefs): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty(
    "--ui-font",
    prefs.interfaceFont === "system" ? SYSTEM_STACK : SANS_STACK,
  );
  // index.css reads it: "on" stills the app like the system setting, "off" ignores the system's.
  root.dataset.reduceMotion = prefs.reduceMotion;
  const code = prefs.codeFont.trim();
  root.style.setProperty(
    "--code-font",
    code ? `"${code.replace(/"/g, "")}", ${MONO_STACK}` : MONO_STACK,
  );
}

let lastMode: "light" | "dark" = "dark";

export function applyCodePalette(mode: "light" | "dark"): void {
  if (typeof document === "undefined") return;
  lastMode = mode;
  const prefs = getAppearance();
  const id = mode === "light" ? prefs.codeThemeLight : prefs.codeThemeDark;
  const palette = codePaletteFor(id);
  const root = document.documentElement;
  for (const [role, color] of Object.entries(palette)) {
    root.style.setProperty(`--code-${role}`, color);
  }
}

/** Whether the app should keep still: the Reduce motion setting, or the system's when it follows it. */
export function reducedMotion(): boolean {
  const pref = getAppearance().reduceMotion;
  if (pref !== "system") return pref === "on";
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function setAppearance(patch: Partial<AppearancePrefs>): void {
  const next = { ...getAppearance(), ...patch };
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next));
  applyAppearance(next);
  applyCodePalette(lastMode);
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT));
}

export function initAppearance(): void {
  applyAppearance(getAppearance());
}

export function useAppearance(): AppearancePrefs {
  const [prefs, setPrefs] = useState<AppearancePrefs>(getAppearance);
  useEffect(() => {
    const sync = () => setPrefs(getAppearance());
    window.addEventListener(APPEARANCE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(APPEARANCE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return prefs;
}

/** A tree a mod drew (`ui.render`), as plain data: handler props are `{ $fn: id }`. */
export type RenderNode = string | RenderElement;

export interface RenderElement {
  $el: string;
  props: Record<string, unknown>;
  children: RenderNode[];
}

export interface FnRef {
  $fn: number;
}

export const isFnRef = (v: unknown): v is FnRef => !!v && typeof v === "object" && typeof (v as FnRef).$fn === "number";

export const isElement = (v: unknown): v is RenderElement => !!v && typeof v === "object" && typeof (v as RenderElement).$el === "string";

export interface Glass {
  blur?: number;
  tint?: string;
  opacity?: number;
}

/** `$.theme.set`'s argument, as Claude Code's mods send it. */
export interface ThemeArgs {
  backdrop?: Backdrop | false;
  overrideColorScheme?: "light" | "dark";
  colors?: ThemeColors;
}

export interface ThemeColors {
  v: 1;
  id?: string;
  label: string;
  inputs: { light?: Record<string, string>; dark?: Record<string, string> };
  codeTheme?: { light?: string; dark?: string };
  contrast?: "more";
}

export type ThemeColor = string;

export interface Gradient {
  stops: (ThemeColor | { at: number; color: ThemeColor })[];
  angle?: number;
  shape?: "linear" | "radial";
  size?: [number, number];
  repeat?: boolean;
}

export interface Backdrop {
  /** A live scene, drawn by the mod's `ui.render` hook on `Backdrop`. Older engines named it `id`. */
  scene?: string;
  id?: string;
  glass?: Glass | false;
  /** An older engine's place for `overrideColorScheme`. */
  colorScheme?: "light" | "dark";
  color?: ThemeColor;
  gradient?: Gradient;
  vector?: { viewBox: number | [number, number]; paths: (string | { d: string; strokeWidth?: number; color?: ThemeColor })[]; color?: ThemeColor; size?: [number, number]; repeat?: boolean };
  image?: { source: string; size?: [number, number]; repeat?: boolean };
}

/** The theme that stands in a session: the latest set, whichever mod set it. */
export interface StandingTheme {
  plugin: string;
  /** The mod's folder, where a still ground's image is read from. */
  root: string;
  args: ThemeArgs;
}

export interface ModToast {
  id: number;
  plugin: string;
  text: string;
  timeoutMs: number;
}

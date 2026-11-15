// Types for make-colors.js, the helper the mods skill hands the agent (src/lib/mods/skill/).

export interface Anchors {
  "surface-0": string;
  "text-primary": string;
  "surface-1"?: string;
  "surface-2"?: string;
  "surface-3"?: string;
  "text-secondary"?: string;
  "text-muted"?: string;
}

export type Roles = Partial<Record<"accent" | "danger" | "success" | "warning" | "pro", string>>;

export interface ModeSpec {
  gray: { anchors: Anchors };
  roles?: Roles;
  git?: Record<string, string>;
}

export interface ColorsSpec {
  label: string;
  roles?: Roles;
  light?: ModeSpec;
  dark?: ModeSpec;
  codeTheme?: { light?: string; dark?: string };
  contrast?: "more";
}

export interface MadeColors {
  theme: { v: 1; id: string; label: string; inputs: { light?: Record<string, string>; dark?: Record<string, string> }; codeTheme?: { light?: string; dark?: string }; contrast?: "more" };
  problems: string[];
}

export function makeColors(spec: ColorsSpec): MadeColors;
export function contrast(a: string, b: string): number;

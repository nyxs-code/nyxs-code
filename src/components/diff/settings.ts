// ── Settings ───────────────────────────────────────────────────────────────

export interface Settings {
  showFiles: boolean;
  groupByFolder: boolean;
  separateTests: boolean;
  sideBySide: boolean;
  wrap: boolean;
  wordHighlight: boolean;
  hideWhitespace: boolean;
}

export const SETTINGS_KEY = "nyxs.changesPanel.v1";
const DEFAULT_SETTINGS: Settings = {
  showFiles: true,
  groupByFolder: true,
  separateTests: false,
  sideBySide: false,
  wrap: true,
  wordHighlight: true,
  hideWhitespace: false,
};

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// Tests, build output and lock files: the noise that "separate" moves to the end.
export const TEST_OR_BUILD = /(^|\/)(__tests__|tests?|spec|dist|build|out|target)\/|\.(test|spec)\.[^/]+$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|bun\.lockb)$/i;

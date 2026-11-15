import { getSettingsForSource, updateSettingsForSource, type NyxsSettings } from "../settingsRuntime";
import type { Migration } from "./types";

const LEGACY = {
  language:    "nyxs.language.v1",
  outputStyle: "optimicer.outputStyle.v1",
} as const;

async function up(): Promise<void> {
  const hasLegacy = Object.values(LEGACY).some((k) => localStorage.getItem(k) !== null);
  if (!hasLegacy) return;

  const user = await getSettingsForSource("user");
  const patch: Partial<NyxsSettings> = {};

  const language = localStorage.getItem(LEGACY.language);
  if (language && language.trim() && user.language === undefined) {
    patch.language = language.trim();
  }

  const outputStyle = localStorage.getItem(LEGACY.outputStyle);
  if (outputStyle && outputStyle.trim() && user.outputStyle === undefined) {
    patch.outputStyle = outputStyle.trim();
  }

  if (Object.keys(patch).length > 0) {
    await updateSettingsForSource("user", patch);
  }
}

export const migration002: Migration = {
  id: 2,
  name: "seed language + outputStyle from localStorage to user settings.json",
  up,
};

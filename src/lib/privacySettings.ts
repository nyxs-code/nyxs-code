import { DEFAULT_SETTINGS, type Settings } from "@/lib/configSchema";
import { getSettingsForSource } from "@/lib/settingsRuntime";

export type PrivacySettings = Settings["privacy"];

/**
 * What the user lets go to the Nyxs service (Settings › Privacy). From their own settings only:
 * a project's settings can't turn a sending back on. It waits for the settings to load, so a
 * call at start-up doesn't take the defaults (everything on) for the user's answer.
 */
export async function privacySettings(): Promise<PrivacySettings> {
  const user = (await getSettingsForSource("user").catch(() => ({}))) as { privacy?: Partial<PrivacySettings> };
  return { ...DEFAULT_SETTINGS.privacy, ...(user.privacy ?? {}) };
}

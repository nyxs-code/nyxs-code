import { getSettingsForSource, isSettingsSourceUnreadable, updateSettingsForSource } from "../settingsRuntime";
import type { Migration } from "./types";
import { migration001 } from "./001-api-keys-to-keychain";
import { migration002 } from "./002-prefs-to-settings";
import { migration003 } from "./003-drop-browser-recent";

const MIGRATIONS: Migration[] = [migration001, migration002, migration003];

async function currentVersion(): Promise<number> {
  const user = await getSettingsForSource("user");
  const v = user.schemaVersion;
  return typeof v === "number" ? v : 0;
}

export async function runMigrations(): Promise<void> {
  // Its schemaVersion is unknown then: running every migration again and stamping the
  // version would write a near-empty settings.json over the user's.
  if (await isSettingsSourceUnreadable("user")) {
    console.warn("[migrations] skipped: the user's settings.json couldn't be read");
    return;
  }
  const current = await currentVersion();
  const pending = MIGRATIONS.filter((m) => m.id > current).sort((a, b) => a.id - b.id);
  if (pending.length === 0) return;

  for (const migration of pending) {
    try {
      await migration.up();
      await updateSettingsForSource("user", { schemaVersion: migration.id });
      console.info(`[migrations] applied #${migration.id} (${migration.name})`);
    } catch (err) {
      console.error(`[migrations] failed #${migration.id} (${migration.name}):`, err);
      break;
    }
  }
}

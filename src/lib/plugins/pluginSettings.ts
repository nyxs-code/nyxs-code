import {
  getSettingsForSource,
  saveSettingsForSource,
  loadMergedSettings,
} from "@/lib/configStore";

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

export async function getEnabledPlugins(): Promise<string[]> {
  return asStringArray((await loadMergedSettings(null)).enabledPlugins);
}

export async function setPluginEnabled(id: string, on: boolean): Promise<void> {
  const user = await getSettingsForSource("user", null);
  const set = new Set(asStringArray(user.enabledPlugins));
  if (on) set.add(id);
  else set.delete(id);
  await saveSettingsForSource("user", null, { ...user, enabledPlugins: [...set] });
}

export async function getDeclaredMarketplaces(): Promise<Record<string, string>> {
  const m = (await loadMergedSettings(null)).marketplaces;
  if (!m || typeof m !== "object" || Array.isArray(m)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

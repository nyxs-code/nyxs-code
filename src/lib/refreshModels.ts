import type { Dispatch, SetStateAction } from "react";
import { PROVIDERS, type ModelInfo, type ProviderId } from "./models";
import { fetchProviderModelsWithRetry } from "./providerModels";
import type { Settings } from "./settings";

/** The settings with a provider's freshly read models. An empty answer (a CLI that's signed out
 *  for a moment) keeps the list it had; models that are gone stop being enabled. */
export function withReadModels(prev: Settings, id: ProviderId, models: ModelInfo[]): Settings {
  if (models.length === 0 && (prev[id].models?.length ?? 0) > 0) return prev;
  const valid = new Set(models.map((m) => m.id));
  return { ...prev, [id]: { ...prev[id], models, enabled: (prev[id].enabled ?? []).filter((mid) => valid.has(mid)) } };
}

/** Reads a connected provider's models again (with a retry) and puts them in the settings, when
 *  `alive()` still says so once they arrive. Manage models does it for every provider on opening,
 *  Settings › Providers for the one shown when its list is old. Errors go to the caller. */
export async function refreshProviderModels(
  id: ProviderId,
  settings: Settings,
  onChange: Dispatch<SetStateAction<Settings>>,
  alive: () => boolean,
): Promise<void> {
  const models = await fetchProviderModelsWithRetry(PROVIDERS[id], settings[id]);
  if (!alive()) return;
  onChange((prev) => withReadModels(prev, id, models));
}

import { useCallback, useSyncExternalStore } from "react";
import {
  getMergedSnapshot,
  getPerSourceSnapshot,
  subscribeSettings,
  updateSettingsForSource,
  SOURCE_PRECEDENCE,
  type NyxsSettings,
  type SettingsSource,
} from "./settingsRuntime";

export interface UseSettingsResult {
  settings: NyxsSettings;
  perSource: Partial<Record<SettingsSource, NyxsSettings>>;
  update: (
    partial: Partial<NyxsSettings>,
    source?: SettingsSource,
  ) => Promise<NyxsSettings>;
  provenance: (key: keyof NyxsSettings) => SettingsSource | null;
}

export function useSettings(): UseSettingsResult {
  const settings = useSyncExternalStore(
    subscribeSettings,
    getMergedSnapshot,
    getMergedSnapshot,
  );
  const perSource = useSyncExternalStore(
    subscribeSettings,
    getPerSourceSnapshot,
    getPerSourceSnapshot,
  );

  const update = useCallback(
    (partial: Partial<NyxsSettings>, source: SettingsSource = "local") =>
      updateSettingsForSource(source, partial),
    [],
  );

  const provenance = useCallback(
    (key: keyof NyxsSettings): SettingsSource | null => {
      for (const source of [...SOURCE_PRECEDENCE].reverse()) {
        if (perSource[source]?.[key] !== undefined) return source;
      }
      return null;
    },
    [perSource],
  );

  return { settings, perSource, update, provenance };
}

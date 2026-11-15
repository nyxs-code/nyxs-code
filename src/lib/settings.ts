import { PROVIDERS, type ProviderId, type ModelInfo } from "./models";
import { getSecret, setSecret, deleteSecret, providerSecretAccount } from "./secureStore";
import { getToken, getCurrentUserId } from "./auth";
import { accountKey } from "./accountScope";

export interface ProviderSettings {
  apiKey: string;
  baseUrl?: string;
  /** Anthropic only: the workspace an organization-scoped key acts in. */
  workspaceId?: string;
  models?: ModelInfo[];
  enabled?: string[];
  /** Context windows the user set by model id (Manage models), over the detected ones. */
  contextWindows?: Record<string, number>;
}

export type Settings = Record<ProviderId, ProviderSettings>;

type ProviderConfig = Omit<ProviderSettings, "apiKey">;

const STORAGE_KEY = "optimicer.settings.v1";

const ADOPTED_FLAG = "optimicer.providers.adopted.v1";

let currentUserId: string | null = null;

function scopedStorageKey(): string {
  return currentUserId ? `${STORAGE_KEY}::${currentUserId}` : STORAGE_KEY;
}

function scopedAccount(id: ProviderId): string {
  return providerSecretAccount(id, currentUserId);
}

const keyCache: Partial<Record<ProviderId, string>> = {};

function providerIds(): ProviderId[] {
  return Object.keys(PROVIDERS) as ProviderId[];
}

function defaults(): Settings {
  const out = {} as Settings;
  for (const id of providerIds()) {
    out[id] = { apiKey: "", baseUrl: PROVIDERS[id].defaultBaseUrl };
  }
  return out;
}

function readStoredConfig(): Partial<Record<ProviderId, ProviderConfig>> {
  try {
    const raw = localStorage.getItem(scopedStorageKey());
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Record<ProviderId, ProviderSettings>>;
    const out: Partial<Record<ProviderId, ProviderConfig>> = {};
    for (const id of Object.keys(parsed) as ProviderId[]) {
      const { apiKey: _drop, ...rest } = parsed[id] ?? ({} as ProviderSettings);
      out[id] = rest;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStoredConfig(config: Partial<Record<ProviderId, ProviderConfig>>): void {
  localStorage.setItem(scopedStorageKey(), JSON.stringify(config));
}

export async function hydrateProviderKeys(): Promise<void> {
  await getToken();
  currentUserId = getCurrentUserId();
  for (const id of Object.keys(keyCache) as ProviderId[]) delete keyCache[id];

  if (!currentUserId) return;

  await adoptLegacyProviderData();

  await Promise.all(
    providerIds().map(async (id) => {
      const key = await getSecret(scopedAccount(id));
      if (key) keyCache[id] = key;
    }),
  );
}

async function adoptLegacyProviderData(): Promise<void> {
  if (localStorage.getItem(ADOPTED_FLAG)) return;

  await Promise.all(
    providerIds().map(async (id) => {
      const legacyKey = await getSecret(providerSecretAccount(id));
      if (!legacyKey) return;
      await setSecret(scopedAccount(id), legacyKey);
      await deleteSecret(providerSecretAccount(id));
    }),
  );

  const legacyBlob = localStorage.getItem(STORAGE_KEY);
  if (legacyBlob) {
    if (!localStorage.getItem(scopedStorageKey())) {
      localStorage.setItem(scopedStorageKey(), legacyBlob);
    }
    localStorage.removeItem(STORAGE_KEY);
  }

  localStorage.setItem(ADOPTED_FLAG, "1");
}

export function loadSettings(): Settings {
  const stored = readStoredConfig();
  const base = defaults();
  const out = {} as Settings;
  for (const id of providerIds()) {
    out[id] = {
      ...base[id],
      ...(stored[id] ?? {}),
      apiKey: keyCache[id] ?? "",
    };
  }
  return out;
}

export function saveSettings(settings: Settings): void {
  const config: Partial<Record<ProviderId, ProviderConfig>> = {};
  for (const id of Object.keys(settings) as ProviderId[]) {
    const { apiKey, ...rest } = settings[id];
    config[id] = rest;
    const next = (apiKey ?? "").trim();
    if (next !== (keyCache[id] ?? "")) {
      if (next) keyCache[id] = next;
      else delete keyCache[id];
      void setSecret(scopedAccount(id), next);
    }
  }
  writeStoredConfig(config);
}

export function hasKey(settings: Settings, provider: ProviderId): boolean {
  return Boolean(settings[provider]?.apiKey?.trim());
}

const SELECTED_MODEL_KEY = "optimicer.selectedModel.v1";

export function loadSelectedModel(): string {
  try {
    return localStorage.getItem(accountKey(SELECTED_MODEL_KEY)) ?? "";
  } catch {
    return "";
  }
}

export function saveSelectedModel(id: string): void {
  try {
    if (id) localStorage.setItem(accountKey(SELECTED_MODEL_KEY), id);
    else localStorage.removeItem(accountKey(SELECTED_MODEL_KEY));
  } catch {
    /* almacenamiento no disponible: se usará el primer modelo en la próxima apertura */
  }
}

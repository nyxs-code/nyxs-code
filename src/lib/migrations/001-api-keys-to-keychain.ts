import { setSecret, providerSecretAccount } from "../secureStore";
import type { Migration } from "./types";

const LEGACY_PROVIDERS_KEY = "optimicer.settings.v1";

interface LegacyProvider {
  apiKey?: string;
  [k: string]: unknown;
}

async function up(): Promise<void> {
  const raw = localStorage.getItem(LEGACY_PROVIDERS_KEY);
  if (!raw) return;

  let parsed: Record<string, LegacyProvider>;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;
    parsed = obj as Record<string, LegacyProvider>;
  } catch {
    return;
  }

  let movedAny = false;
  const sanitized: Record<string, Omit<LegacyProvider, "apiKey">> = {};
  for (const [id, cfg] of Object.entries(parsed)) {
    const { apiKey, ...rest } = cfg ?? {};
    if (typeof apiKey === "string" && apiKey.trim()) {
      await setSecret(providerSecretAccount(id), apiKey);
      movedAny = true;
    }
    sanitized[id] = rest;
  }

  if (movedAny) localStorage.setItem(LEGACY_PROVIDERS_KEY, JSON.stringify(sanitized));
}

export const migration001: Migration = {
  id: 1,
  name: "move API keys from localStorage to OS keychain",
  up,
};

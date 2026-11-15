import { invoke } from "@/lib/ipc";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DEV_PREFIX = "nyxs.secret.";

export async function getSecret(account: string): Promise<string | null> {
  if (!isTauri) {
    return localStorage.getItem(DEV_PREFIX + account);
  }
  try {
    return (await invoke<string | null>("nyxs_secret_get", { account })) ?? null;
  } catch (e) {
    console.warn(`No se pudo leer el secreto (${account}):`, e);
    return null;
  }
}

export async function setSecret(account: string, value: string): Promise<void> {
  if (!value.trim()) {
    await deleteSecret(account);
    return;
  }
  if (!isTauri) {
    localStorage.setItem(DEV_PREFIX + account, value);
    return;
  }
  try {
    await invoke("nyxs_secret_set", { account, secret: value });
  } catch (e) {
    console.error(`No se pudo guardar el secreto (${account}):`, e);
  }
}

export async function deleteSecret(account: string): Promise<void> {
  if (!isTauri) {
    localStorage.removeItem(DEV_PREFIX + account);
    return;
  }
  try {
    await invoke("nyxs_secret_delete", { account });
  } catch (e) {
    console.warn(`No se pudo borrar el secreto (${account}):`, e);
  }
}

export function providerSecretAccount(providerId: string, userId?: string | null): string {
  return userId ? `provider:${userId}:${providerId}` : `provider:${providerId}`;
}

import { invoke } from "@/lib/ipc";
import { getCurrentUserId } from "./auth";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function accountKey(base: string): string {
  const uid = getCurrentUserId();
  return uid ? `${base}::${uid}` : base;
}

const SCOPED_LS_KEYS = [
  "optimicer.effort.v1",
  "optimicer.hooks.v1",
  "optimicer.mcp.v1",
  "optimicer.permissionRules.v1",
  "optimicer.selectedModel.v1",
  "nyxs.events",
];

const THEME_KEY = "nyxs.theme.v1";

const ADOPTED_FLAG = "optimicer.account.adopted.v1";

export async function adoptLegacyAccountData(): Promise<void> {
  if (localStorage.getItem(ADOPTED_FLAG)) return;
  const uid = getCurrentUserId();
  if (!uid) return;

  for (const base of SCOPED_LS_KEYS) {
    const legacy = localStorage.getItem(base);
    if (legacy == null) continue;
    const scoped = `${base}::${uid}`;
    if (localStorage.getItem(scoped) == null) localStorage.setItem(scoped, legacy);
    localStorage.removeItem(base);
  }
  const themeVal = localStorage.getItem(THEME_KEY);
  if (themeVal != null && localStorage.getItem(`${THEME_KEY}::${uid}`) == null) {
    localStorage.setItem(`${THEME_KEY}::${uid}`, themeVal);
  }

  if (isTauri) {
    try {
      await invoke("nyxs_adopt_account_data", { account: uid });
    } catch (e) {
      console.error("No se pudo adoptar los datos legacy de la cuenta", e);
    }
  }

  localStorage.setItem(ADOPTED_FLAG, "1");
}

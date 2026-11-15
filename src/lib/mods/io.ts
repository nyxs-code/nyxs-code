import { accountKey } from "@/lib/accountScope";
import { invoke } from "@/lib/ipc";
import { resolveHome } from "@/lib/paths";
import { joinPath } from "@/lib/plugins/catalog";
import { listDir, pathExists } from "@/lib/plugins/paths";
import { loadPluginComponents, modEntryOf } from "@/lib/plugins/pluginLoader";
import type { ModRef } from "./compile";
import { devModsDir } from "./devModsDir";
import { ModHost, type ModIo, type SessionInfo } from "./host";
import { ModWorker } from "./modWorker";

const STORE_PREFIX = "nyxs.mods.store.v1:";
const CONSENT_KEY = "nyxs.mods.devConsent.v1";
const SAFE_ID = /^[\w-]{1,128}$/;

async function readText(path: string): Promise<string | null> {
  try {
    const text = await invoke<string>("nyxs_read_text", { path });
    // The command answers "" for a file it can't find or read: a module is never empty.
    return text ? text : null;
  } catch {
    return null;
  }
}

function readJson(key: string): Record<string, unknown> {
  try {
    const v = JSON.parse(localStorage.getItem(accountKey(key)) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Where Claude Code writes the mods of its own session, as its plugin-authoring skill says. */
async function claudeDevModsDir(cliSessionId: string): Promise<string | null> {
  if (!SAFE_ID.test(cliSessionId)) return null;
  return joinPath(await resolveHome(), ".claude/dev-mods", cliSessionId);
}

async function devMods(chatId: string, cliSessionId: string | null): Promise<ModRef[]> {
  const out: ModRef[] = [];
  for (const dir of [await devModsDir(chatId), cliSessionId ? await claudeDevModsDir(cliSessionId) : null]) {
    if (dir) out.push(...(await modsIn(dir)));
  }
  // One mod per name: the one written last in the list wins.
  return [...new Map(out.map((m) => [m.plugin, m])).values()];
}

async function modsIn(dir: string): Promise<ModRef[]> {
  const out: ModRef[] = [];
  for (const name of await listDir(dir)) {
    if (!SAFE_ID.test(name)) continue;
    const root = joinPath(dir, name);
    const manifest = await readText(joinPath(root, ".claude-plugin/plugin.json"));
    const hooks = await readText(joinPath(root, "hooks/hooks.json"));
    if (!manifest || !hooks) continue;
    let plugin = name;
    let entry: string | null;
    try {
      const m = JSON.parse(manifest) as { name?: unknown };
      if (typeof m.name === "string" && SAFE_ID.test(m.name)) plugin = m.name;
      entry = modEntryOf(JSON.parse(hooks), `${name}/hooks/hooks.json`, name, false);
    } catch {
      continue;
    }
    if (entry) out.push({ plugin, root, entry, options: {}, source: "dev" });
  }
  return out;
}

let reserved: (name: string) => boolean = () => false;
let infoSource: (key: string) => SessionInfo = () => ({ chatId: null, workspace: null, cwd: null, model: null, turns: 0 });

/** The app's own command names, which a mod can't register. */
export function setReservedCommands(check: (name: string) => boolean): void {
  reserved = check;
}

/** How the host reads a session's folder, model and turns when a mod asks. */
export function setSessionInfoSource(fn: (key: string) => SessionInfo): void {
  infoSource = fn;
}

const appIo: ModIo = {
  readText,
  stat: (path, resolve) => invoke("mods_fs_stat", { path, resolve }),
  exists: pathExists,
  list: listDir,
  installedMods: async () => (await loadPluginComponents()).mods,
  devMods,
  makeWorker: (plugin, script, onCall) => new ModWorker(plugin, script, onCall),
  loadStore: (plugin) => readJson(STORE_PREFIX + plugin),
  saveStore: (plugin, data) => localStorage.setItem(accountKey(STORE_PREFIX + plugin), JSON.stringify(data)),
  isReservedCommand: (name) => reserved(name),
  loadConsent: () => readJson(CONSENT_KEY) as Record<string, "on" | "off">,
  saveConsent: (data) => localStorage.setItem(accountKey(CONSENT_KEY), JSON.stringify(data)),
};

/** The app's one mod engine. */
export const modHost = new ModHost(appIo, (key) => infoSource(key));

import { invoke } from "@/lib/ipc";
import { DEFAULT_MARKETPLACES } from "./defaults";
import { readInstalled, setEnabled } from "./install";
import { installedPluginsPath, isTauri, pluginInstallDir, pluginsRoot, readJsonFile, writeJsonFile } from "./paths";
import { clearPluginLoaderCache } from "./pluginLoader";
import { pluginId } from "./schema";

/**
 * Plugins Nyxs ships installed: copies of plugins from a default marketplace, kept in
 * `resources/plugins/<name>/` as the marketplace has them. On the first start they are written
 * to the plugin cache and recorded as installed from that marketplace, so the Plugins panel shows
 * them, the user can turn them off or uninstall them, and updates come from the marketplace.
 * Each is installed once: one the user uninstalled stays uninstalled.
 */

const MARKETPLACE = DEFAULT_MARKETPLACES[0].name;
const BUNDLED = ["theme-examples"] as const;
const SEEDED_FILE = "bundled-seeded.json";

// Loaded only when a plugin is installed: they never reach the app's start.
const FILES = import.meta.glob("/resources/plugins/**/*", { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;
const MANIFESTS = import.meta.glob("/resources/plugins/*/.claude-plugin/plugin.json", { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;

/** A bundled plugin's files, relative to its folder. */
export function bundledFiles(name: string): Record<string, () => Promise<string>> {
  const prefix = `/resources/plugins/${name}/`;
  const out: Record<string, () => Promise<string>> = {};
  for (const [path, load] of Object.entries({ ...FILES, ...MANIFESTS })) {
    if (path.startsWith(prefix)) out[path.slice(prefix.length)] = load;
  }
  return out;
}

async function seededList(): Promise<string[]> {
  const v = await readJsonFile<{ seeded?: unknown }>(`${await pluginsRoot()}/${SEEDED_FILE}`);
  return Array.isArray(v?.seeded) ? v.seeded.filter((s): s is string => typeof s === "string") : [];
}

let running: Promise<void> | null = null;

/** Installs the bundled plugins this machine never had. Safe to call at every start. */
export function installBundledPlugins(): Promise<void> {
  if (!isTauri) return Promise.resolve();
  running ??= (async () => {
    const seeded = await seededList();
    let changed = false;
    for (const name of BUNDLED) {
      const id = pluginId(name, MARKETPLACE);
      if (seeded.includes(id)) continue;
      const installed = await readInstalled();
      if (!installed.plugins.some((p) => p.id === id)) {
        const files = bundledFiles(name);
        const manifest = JSON.parse(await files[".claude-plugin/plugin.json"]()) as { version?: string };
        const version = manifest.version ?? "0.0.0";
        const dest = await pluginInstallDir(MARKETPLACE, name, version);
        for (const [rel, load] of Object.entries(files)) {
          await invoke("agent_write_file", { path: `${dest}/${rel}`, content: await load() });
        }
        // Read again: another window may have written the list meanwhile.
        const file = await readInstalled();
        if (!file.plugins.some((p) => p.id === id)) {
          file.plugins.push({ id, plugin: name, marketplace: MARKETPLACE, version, installLocation: dest, installedAt: Date.now() });
          await writeJsonFile(await installedPluginsPath(), file);
        }
        await setEnabled(id, true);
        changed = true;
      }
      seeded.push(id);
      await writeJsonFile(`${await pluginsRoot()}/${SEEDED_FILE}`, { seeded });
    }
    if (changed) clearPluginLoaderCache();
  })().catch((e) => {
    // The next start tries again.
    running = null;
    console.warn("installing the bundled plugins failed", e);
  });
  return running;
}

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
/**
 * Versions earlier releases shipped. A copy still at one of them gets the one this release ships
 * (which carries Nyxs' changes, `+nyxs.N`); one the user updated from the marketplace stays.
 */
const SHIPPED_BEFORE: Record<string, string[]> = { "theme-examples": ["0.4.3"] };

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

/** Writes a bundled plugin into the cache; its version and folder. */
async function writeBundled(name: string): Promise<{ version: string; dest: string }> {
  const files = bundledFiles(name);
  const manifest = JSON.parse(await files[".claude-plugin/plugin.json"]()) as { version?: string };
  const version = manifest.version ?? "0.0.0";
  const dest = await pluginInstallDir(MARKETPLACE, name, version);
  for (const [rel, load] of Object.entries(files)) {
    await invoke("agent_write_file", { path: `${dest}/${rel}`, content: await load() });
  }
  return { version, dest };
}

/**
 * Installs the bundled plugins this machine never had, and brings a copy an earlier release
 * shipped up to this release's. Safe to call at every start.
 */
export function installBundledPlugins(): Promise<void> {
  if (!isTauri) return Promise.resolve();
  running ??= (async () => {
    const seeded = await seededList();
    let changed = false;
    for (const name of BUNDLED) {
      const id = pluginId(name, MARKETPLACE);
      if (seeded.includes(id)) {
        const entry = (await readInstalled()).plugins.find((p) => p.id === id);
        if (!entry || !SHIPPED_BEFORE[name]?.includes(entry.version ?? "")) continue;
        const { version, dest } = await writeBundled(name);
        const file = await readInstalled();
        const now = file.plugins.find((p) => p.id === id);
        if (now && now.version !== version) {
          now.version = version;
          now.installLocation = dest;
          await writeJsonFile(await installedPluginsPath(), file);
          changed = true;
        }
        continue;
      }
      const installed = await readInstalled();
      if (!installed.plugins.some((p) => p.id === id)) {
        const { version, dest } = await writeBundled(name);
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

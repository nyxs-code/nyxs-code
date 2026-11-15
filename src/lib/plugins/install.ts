import { invoke } from "@/lib/ipc";
import { LocalizedError } from "@/lib/localizedError";
import { getEnabledPlugins, setPluginEnabled } from "./pluginSettings";
import {
  copyDir,
  gitHeadSha,
  installedPluginsPath,
  isTauri,
  marketplaceCacheDir,
  pluginInstallDir,
  readJsonFile,
  removeDir,
  safeSegment,
  writeJsonFile,
} from "./paths";
import { ensureGitCheckout, extractNpmPackage, getCatalog, joinPath, marketplaceRepoDir } from "./catalog";
import { isSafeRepo, requireSafe, safeRelativePath } from "./sourceSafety";
import {
  installedPluginsFileSchema,
  pluginId,
  type CatalogPlugin,
  type InstalledPlugin,
  type InstalledPluginsFile,
  type KnownMarketplace,
} from "./schema";
import { getMarketplace } from "./marketplace";
import { clearPluginComponentsCache } from "./pluginSkills";

export async function readInstalled(): Promise<InstalledPluginsFile> {
  const raw = await readJsonFile<unknown>(await installedPluginsPath());
  const parsed = installedPluginsFileSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { version: 1, plugins: [] };
}

async function writeInstalled(file: InstalledPluginsFile): Promise<void> {
  await writeJsonFile(await installedPluginsPath(), file);
}

export async function listInstalled(): Promise<InstalledPlugin[]> {
  return (await readInstalled()).plugins;
}

export async function getInstalled(id: string): Promise<InstalledPlugin | null> {
  return (await readInstalled()).plugins.find((p) => p.id === id) ?? null;
}

export async function isInstalled(plugin: string, marketplace: string): Promise<boolean> {
  return Boolean(await getInstalled(pluginId(plugin, marketplace)));
}

export async function enabledPlugins(): Promise<string[]> {
  return getEnabledPlugins();
}

export async function isEnabled(id: string): Promise<boolean> {
  return (await getEnabledPlugins()).includes(id);
}

export async function setEnabled(id: string, on: boolean): Promise<void> {
  await setPluginEnabled(id, on);
  clearPluginComponentsCache();
}

export interface InstallResult {
  installed: InstalledPlugin;
  replaced: boolean;
}

export async function installPlugin(
  marketplace: string,
  pluginName: string,
  opts: { enable?: boolean } = {},
): Promise<InstallResult> {
  const mp = await getMarketplace(marketplace);
  if (!mp) throw new Error(`Unknown marketplace: ${marketplace}`);

  const catalog = await getCatalog(mp);
  const plugin = catalog.plugins.find((p) => p.name === pluginName);
  if (!plugin) throw new Error(`Plugin "${pluginName}" not found in marketplace "${marketplace}".`);

  const { contentDir, sha } = await materializePluginContent(mp, plugin);
  const dest = await pluginInstallDir(mp.name, plugin.name, plugin.version);

  // Replaces the previous copy only once the new one is complete.
  await copyDir(contentDir, dest);

  const id = pluginId(plugin.name, mp.name);
  const entry: InstalledPlugin = {
    id,
    plugin: plugin.name,
    marketplace: mp.name,
    version: plugin.version,
    installLocation: dest,
    installedAt: Date.now(),
    sha,
  };

  const file = await readInstalled();
  const idx = file.plugins.findIndex((p) => p.id === id);
  const replaced = idx >= 0;
  const previous = replaced ? file.plugins[idx].installLocation : null;
  if (replaced) file.plugins[idx] = entry;
  else file.plugins.push(entry);
  await writeInstalled(file);
  // Each version gets its own folder, so the old one would otherwise stay forever.
  if (previous && previous !== dest) await removeDir(previous);

  if (opts.enable !== false) await setEnabled(id, true);
  clearPluginComponentsCache();
  return { installed: entry, replaced };
}

export async function uninstallPlugin(id: string): Promise<void> {
  const file = await readInstalled();
  const entry = file.plugins.find((p) => p.id === id);
  if (entry) {
    await removeDir(entry.installLocation);
    await writeInstalled({ ...file, plugins: file.plugins.filter((p) => p.id !== id) });
  }
  await setEnabled(id, false);
  clearPluginComponentsCache();
}

/** A catalog path inside a checkout, refused when it is absolute or climbs out with `..`. */
function checkedSubPath(path: string, plugin: string): string {
  const rel = safeRelativePath(path);
  requireSafe(rel !== null, "pluginPath", path, plugin);
  return rel ?? "";
}

/** Lets the backend copy from a folder the user picked as a local marketplace. */
async function allowLocalFolder(path: string): Promise<void> {
  if (isTauri) await invoke("agent_allow_ui_path", { path });
}

async function materializePluginContent(
  mp: KnownMarketplace,
  plugin: CatalogPlugin,
): Promise<{ contentDir: string; sha?: string }> {
  const cacheDir = mp.installLocation || (await marketplaceCacheDir(safeSegment(mp.name)));
  const src = plugin.source;
  const localMarketplace = mp.source.source === "directory" || mp.source.source === "file";

  if (src && typeof src === "object") {
    const o = src as Record<string, unknown>;
    const str = (key: string) => (typeof o[key] === "string" ? (o[key] as string).trim() : "");
    const kind = str("source");
    const url = str("url");
    const repo = str("repo");
    const rawPath = str("path");

    if (kind === "directory" && rawPath) {
      // A downloaded catalog must not make Nyxs copy an arbitrary folder of this computer.
      if (!localMarketplace) {
        throw new LocalizedError(
          "localFolderOnly",
          { plugin: plugin.name },
          `Plugin "${plugin.name}" points to a local folder, which only a local marketplace may do.`,
        );
      }
      await allowLocalFolder(rawPath);
      return { contentDir: rawPath };
    }
    if (repo) requireSafe(isSafeRepo(repo), "repo", repo);
    const cloneUrl = url || (repo ? `https://github.com/${repo}.git` : "");
    if (cloneUrl) {
      const subPath = checkedSubPath(rawPath, plugin.name);
      const dir = joinPath(cacheDir, "_plugins", safeSegment(plugin.name));
      await ensureGitCheckout(dir, cloneUrl, { ref: str("ref") || undefined, sha: str("sha") || undefined });
      return { contentDir: subPath ? joinPath(dir, subPath) : dir, sha: await gitHeadSha(dir) };
    }
    // Unknown object shape: fall through to the marketplace-root resolution.
  }

  const root = await materializeMarketplaceRoot(mp, cacheDir);
  if (mp.source.source === "directory") await allowLocalFolder(root);
  const subPath = checkedSubPath(typeof src === "string" && src.trim() ? src : plugin.name, plugin.name);
  return { contentDir: subPath ? joinPath(root, subPath) : root, sha: await gitHeadSha(root) };
}

async function materializeMarketplaceRoot(mp: KnownMarketplace, cacheDir: string): Promise<string> {
  const s = mp.source;
  switch (s.source) {
    case "github": {
      requireSafe(isSafeRepo(s.repo), "repo", s.repo);
      const dir = await marketplaceRepoDir(cacheDir);
      await ensureGitCheckout(dir, `https://github.com/${s.repo}.git`);
      return dir;
    }
    case "git": {
      const dir = await marketplaceRepoDir(cacheDir);
      await ensureGitCheckout(dir, s.url);
      return dir;
    }
    case "directory":
      return s.path;
    case "npm":
      await extractNpmPackage(cacheDir, s.package);
      return joinPath(cacheDir, "package");
    case "url":
    case "file":
      throw new Error(
        `Marketplace "${mp.name}" (${s.source}) only provides a catalog; its plugins must declare their own source.`,
      );
  }
}

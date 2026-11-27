import { ensureDefaultMarketplaces, listMarketplaces, markRefreshed } from "./marketplace";
import { getCatalog, joinPath, marketplaceRepoDir, refreshCatalog } from "./catalog";
import { installPlugin, listInstalled } from "./install";
import { readManifest } from "./manifestFile";
import { fetchText } from "./paths";
import { parsePluginId, parsePluginManifest, type CatalogPlugin, type InstalledPlugin, type KnownMarketplace } from "./schema";
import { isSafeRepo, isSafeSha, safeRelativePath } from "./sourceSafety";

/** What a GitHub marketplace's plugin folder says its version is, by marketplace and folder. */
const remoteVersions = new Map<string, { at: number; version: string | null }>();
const REMOTE_VERSION_MS = 10 * 60_000;
const MANIFEST_RELS = [".nyxs-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"];

export async function refreshMarketplace(name: string): Promise<void> {
  await refreshCatalog(name);
  await markRefreshed(name, Date.now());
  for (const key of remoteVersions.keys()) if (key.startsWith(`${name}|`)) remoteVersions.delete(key);
}

/**
 * The version a plugin that lives inside its marketplace's repository has there now, from the
 * plugin.json of its folder. Refreshing a GitHub marketplace only downloads its catalog, so that
 * folder is read from GitHub itself (remembered a few minutes); a git or local marketplace has
 * it in its checkout. Null when the catalog places it elsewhere or its manifest has no version.
 */
async function inRepoVersion(mp: KnownMarketplace, entry: CatalogPlugin): Promise<string | null> {
  if (entry.source !== undefined && typeof entry.source !== "string") return null;
  const sub = safeRelativePath(typeof entry.source === "string" && entry.source.trim() ? entry.source : entry.name);
  if (sub === null) return null;
  const s = mp.source;
  if (s.source === "github") {
    if (!isSafeRepo(s.repo)) return null;
    const key = `${mp.name}|${sub}`;
    const hit = remoteVersions.get(key);
    if (hit && Date.now() - hit.at < REMOTE_VERSION_MS) return hit.version;
    let version: string | null = null;
    for (const rel of MANIFEST_RELS) {
      try {
        const raw = await fetchText(`https://raw.githubusercontent.com/${s.repo}/HEAD/${sub ? `${sub}/` : ""}${rel}`);
        version = parsePluginManifest(JSON.parse(raw)).manifest?.version?.trim() || null;
        break;
      } catch {
        /* not there (a 404 isn't JSON): try the next place */
      }
    }
    remoteVersions.set(key, { at: Date.now(), version });
    return version;
  }
  const root = s.source === "git" ? await marketplaceRepoDir(mp.installLocation) : s.source === "directory" ? s.path : null;
  if (!root) return null;
  return (await readManifest(sub ? joinPath(root, sub) : root))?.version?.trim() || null;
}

export async function refreshAllMarketplaces(
  opts: { autoOnly?: boolean } = {},
): Promise<{ refreshed: string[]; failed: { name: string; error: string }[] }> {
  const all = await listMarketplaces();
  const targets = opts.autoOnly ? all.filter((m) => m.autoUpdate) : all;

  const refreshed: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const m of targets) {
    try {
      await refreshMarketplace(m.name);
      refreshed.push(m.name);
    } catch (err) {
      failed.push({ name: m.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { refreshed, failed };
}

export interface PluginUpdate {
  id: string;
  plugin: string;
  marketplace: string;
  current: string;
  latest: string;
  /** "version": the catalog has a newer version number. "commit": same (or no) version, but the catalog now pins another reviewed commit. */
  kind: "version" | "commit";
  /** The commit the catalog pins, when it pins one. */
  latestSha?: string;
}

/** The reviewed commit a catalog entry pins (`source.sha`), if any. */
function catalogSha(entry: CatalogPlugin): string | undefined {
  const src = entry.source;
  if (!src || typeof src !== "object") return undefined;
  const sha = (src as Record<string, unknown>).sha;
  return typeof sha === "string" && isSafeSha(sha.trim()) ? sha.trim().toLowerCase() : undefined;
}

/** Older installs recorded an abbreviated sha, so either may be a prefix of the other. */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

export async function checkPluginUpdates(
  opts: { refresh?: boolean } = {},
): Promise<PluginUpdate[]> {
  if (opts.refresh) await refreshAllMarketplaces();
  const installed = await listInstalled();
  const updates: PluginUpdate[] = [];

  const catalogCache = new Map<string, Awaited<ReturnType<typeof getCatalog>> | null>();
  const marketplaces = await listMarketplaces().catch(() => [] as KnownMarketplace[]);

  for (const p of installed) {
    let catalog = catalogCache.get(p.marketplace);
    if (catalog === undefined) {
      catalog = await getCatalog(p.marketplace).catch(() => null);
      catalogCache.set(p.marketplace, catalog);
    }
    const entry = catalog?.plugins.find((c) => c.name === p.plugin);
    if (!entry) continue;
    const base = { id: p.id, plugin: p.plugin, marketplace: p.marketplace, current: p.version, latest: entry.version };
    const sha = catalogSha(entry);
    if (isNewer(entry.version, p.version)) {
      updates.push({ ...base, kind: "version", latestSha: sha });
    } else if (
      // Most catalog entries carry no version (read as 0.0.0); their reviewed commit is what moves.
      sha &&
      compareVersions(entry.version, p.version) === 0 &&
      !(p.sha && sameCommit(sha, p.sha))
    ) {
      updates.push({ ...base, kind: "commit", latestSha: sha });
    } else if (!sha && compareVersions(entry.version, "0.0.0") === 0) {
      // Neither a version nor a pinned commit in the catalog, as with the plugins kept inside
      // Anthropic's marketplace repository: their folder's own manifest says when they change.
      const mp = marketplaces.find((m) => m.name === p.marketplace);
      const [latest, current] = await Promise.all([
        mp ? inRepoVersion(mp, entry).catch(() => null) : null,
        readManifest(p.installLocation).then((m) => m?.version?.trim() || null).catch(() => null),
      ]);
      if (latest && current && isNewer(latest, current)) updates.push({ ...base, current, latest, kind: "version" });
    }
  }
  return updates;
}

export async function updatePlugin(id: string): Promise<InstalledPlugin> {
  const parts = parsePluginId(id);
  if (!parts) throw new Error(`Malformed plugin id: ${id}`);
  const { plugin, marketplace } = parts;
  await refreshCatalog(marketplace).catch(() => undefined);
  const { installed } = await installPlugin(marketplace, plugin, { enable: true });
  return installed;
}

export async function updateAllPlugins(): Promise<InstalledPlugin[]> {
  const updates = await checkPluginUpdates({ refresh: true });
  const out: InstalledPlugin[] = [];
  for (const u of updates) out.push(await updatePlugin(u.id));
  return out;
}

export async function runStartupAutoUpdate(): Promise<PluginUpdate[]> {
  try {
    await ensureDefaultMarketplaces();
    await refreshAllMarketplaces({ autoOnly: true });
    return await checkPluginUpdates();
  } catch {
    return [];
  }
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a === b ? 0 : a > b ? 1 : -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function parseVersion(v: string): number[] | null {
  const core = v.trim().replace(/^v/, "").split(/[-+]/)[0];
  const parts = core.split(".").map((n) => Number(n));
  return parts.every((n) => Number.isFinite(n)) && parts.length > 0 ? parts : null;
}

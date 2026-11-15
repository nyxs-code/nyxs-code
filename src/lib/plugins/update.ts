import { ensureDefaultMarketplaces, listMarketplaces, markRefreshed } from "./marketplace";
import { getCatalog, refreshCatalog } from "./catalog";
import { installPlugin, listInstalled } from "./install";
import { parsePluginId, type CatalogPlugin, type InstalledPlugin } from "./schema";
import { isSafeSha } from "./sourceSafety";

export async function refreshMarketplace(name: string): Promise<void> {
  await refreshCatalog(name);
  await markRefreshed(name, Date.now());
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

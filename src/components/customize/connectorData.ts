import { CONNECTOR_CATALOG, type ConnectorCatalogEntry } from "@/lib/mcp";

export type ConnectorKind = "all" | "trending" | "new" | "verified" | "noAuth";

export type ConnectorFilter = { category: string | null; kind: ConnectorKind };

export const NO_FILTER: ConnectorFilter = { category: null, kind: "all" };

const DAY = 86_400_000;

const newest = CONNECTOR_CATALOG.reduce((m, c) => (c.addedAt && c.addedAt > m ? c.addedAt : m), "");

/** Added in the last four months of the catalog: a "New" badge and filter. */
export function isNewConnector(c: ConnectorCatalogEntry): boolean {
  if (!c.addedAt || !newest) return false;
  return Date.parse(newest) - Date.parse(c.addedAt) <= 120 * DAY;
}

/** Published by the service itself, with its site: shown with a verified mark. */
export function isVerified(c: ConnectorCatalogEntry): boolean {
  return !!c.developer && !!c.developerUrl;
}

export const byPopularity = (list: ConnectorCatalogEntry[]) =>
  [...list].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || a.name.localeCompare(b.name));

export function matchesKind(c: ConnectorCatalogEntry, kind: ConnectorKind): boolean {
  switch (kind) {
    case "trending":
      return !!c.trending;
    case "new":
      return isNewConnector(c);
    case "verified":
      return isVerified(c);
    case "noAuth":
      return c.auth === "none";
    default:
      return true;
  }
}

export function filterConnectors(query: string, filter: ConnectorFilter): ConnectorCatalogEntry[] {
  const q = query.trim().toLowerCase();
  return byPopularity(
    CONNECTOR_CATALOG.filter(
      (c) =>
        (!q ||
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          (c.developer ?? "").toLowerCase().includes(q) ||
          (c.category ?? "").toLowerCase().includes(q)) &&
        (!filter.category || c.category === filter.category) &&
        matchesKind(c, filter.kind),
    ),
  );
}

/** Every category with how many connectors it has, the biggest first. */
export function connectorCategories(): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of CONNECTOR_CATALOG) if (c.category) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function kindCount(kind: ConnectorKind): number {
  return CONNECTOR_CATALOG.filter((c) => matchesKind(c, kind)).length;
}

/** Other connectors from the same developer first, then from the same category. */
export function relatedConnectors(entry: ConnectorCatalogEntry, max = 6): ConnectorCatalogEntry[] {
  const others = CONNECTOR_CATALOG.filter((c) => c.url !== entry.url);
  const sameDev = others.filter((c) => entry.developer && c.developer === entry.developer);
  const sameCat = byPopularity(others.filter((c) => c.category === entry.category && !sameDev.includes(c)));
  const rest = byPopularity(others.filter((c) => !sameDev.includes(c) && !sameCat.includes(c)));
  return [...sameDev, ...sameCat, ...rest].slice(0, max);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The catalog entry for a server the user added, matched by its address, then by name. */
export function catalogEntryFor(server: { url: string; name: string }): ConnectorCatalogEntry | undefined {
  return (
    CONNECTOR_CATALOG.find((c) => server.url && c.url === server.url) ??
    CONNECTOR_CATALOG.find((c) => norm(c.name) === norm(server.name))
  );
}

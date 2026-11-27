import { useEffect, useState } from "react";
import { ensureDefaultMarketplaces, getCatalog, listMarketplaces, type CatalogPlugin, type KnownMarketplace } from "@/lib/plugins";
import { PLUGINS_CHANGED_EVENT } from "./usePluginsData";

/** A plugin of some marketplace's catalog, with the marketplace it comes from. */
export type CatalogEntry = CatalogPlugin & { marketplace: string };

/** Every marketplace's catalog (read again when plugins or marketplaces change), and the
 *  marketplaces themselves. `entries` is null until the first read is done. */
export function usePluginCatalog() {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [marketplaces, setMarketplaces] = useState<KnownMarketplace[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      await ensureDefaultMarketplaces().catch(() => undefined);
      const mps = await listMarketplaces().catch(() => [] as KnownMarketplace[]);
      const all: CatalogEntry[] = [];
      await Promise.all(
        mps.map(async (m) => {
          try {
            for (const p of (await getCatalog(m)).plugins) all.push({ ...p, marketplace: m.name });
          } catch {
            /* a marketplace that can't be read just adds nothing */
          }
        }),
      );
      if (!alive) return;
      setMarketplaces(mps);
      setEntries(all);
    };
    void load();
    window.addEventListener(PLUGINS_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(PLUGINS_CHANGED_EVENT, load);
    };
  }, []);

  return { entries, marketplaces };
}

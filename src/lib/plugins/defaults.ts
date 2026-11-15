import { isTauri, marketplaceCacheDir, safeSegment } from "./paths";
import type { KnownMarketplace } from "./schema";

export const DEFAULT_MARKETPLACES = [
  {
    name: "claude-plugins-official",
    repo: "anthropics/claude-plugins-official",
    description: "Anthropic's official plugin catalog",
  },
] as const;

export type BuiltinMarketplaceName = (typeof DEFAULT_MARKETPLACES)[number]["name"];

export function isBuiltinMarketplace(name: string): boolean {
  return DEFAULT_MARKETPLACES.some((d) => d.name === name);
}

export async function builtinMarketplaceEntries(): Promise<KnownMarketplace[]> {
  const out: KnownMarketplace[] = [];
  for (const def of DEFAULT_MARKETPLACES) {
    out.push({
      name: def.name,
      source: { source: "github", repo: def.repo },
      installLocation: isTauri
        ? await marketplaceCacheDir(safeSegment(def.name))
        : "",
      autoUpdate: true,
    });
  }
  return out;
}

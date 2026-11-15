import { builtinMarketplaceEntries, DEFAULT_MARKETPLACES, isBuiltinMarketplace } from "./defaults";
import { getDeclaredMarketplaces } from "./pluginSettings";
import {
  isTauri,
  knownMarketplacesPath,
  marketplaceCacheDir,
  readJsonFile,
  writeJsonFile,
  safeSegment,
} from "./paths";
import {
  knownMarketplacesFileSchema,
  type KnownMarketplace,
  type KnownMarketplacesFile,
  type MarketplaceSource,
} from "./schema";

export function parseSource(input: string): MarketplaceSource {
  const s = input.trim();
  if (s.startsWith("npm:")) return { source: "npm", package: s.slice(4) };
  if (s.startsWith("file:")) return { source: "file", path: s.slice(5) };
  if (/^https?:\/\//.test(s)) {
    if (s.endsWith(".git")) return { source: "git", url: s };
    if (s.endsWith(".json")) return { source: "url", url: s };
    const gh = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(s);
    if (gh) return { source: "github", repo: gh[1] };
    return { source: "git", url: s };
  }
  if (s.startsWith("git@") || s.endsWith(".git")) return { source: "git", url: s };
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || /^[A-Za-z]:[\\/]/.test(s)) {
    return s.endsWith(".json") ? { source: "file", path: s } : { source: "directory", path: s };
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(s)) return { source: "github", repo: s };
  return { source: "npm", package: s };
}

export function describeSource(src: MarketplaceSource): string {
  switch (src.source) {
    case "github": return `github:${src.repo}`;
    case "git": return src.url;
    case "url": return src.url;
    case "npm": return `npm:${src.package}`;
    case "file": return src.path;
    case "directory": return src.path;
  }
}

export function deriveName(src: MarketplaceSource): string {
  switch (src.source) {
    case "github": return src.repo.split("/").pop() || src.repo;
    case "npm": return src.package.split("/").pop() || src.package;
    case "git": {
      const last = src.url.split("/").pop() || src.url;
      return last.replace(/\.git$/, "");
    }
    case "url": {
      const parts = src.url.split("/").filter(Boolean);
      return parts[parts.length - 2] || parts[parts.length - 1] || "marketplace";
    }
    case "file":
    case "directory":
      return src.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "local";
  }
}

async function readRegistry(): Promise<KnownMarketplacesFile> {
  const raw = await readJsonFile<unknown>(await knownMarketplacesPath());
  const parsed = knownMarketplacesFileSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { version: 1, marketplaces: [] };
}

async function writeRegistry(file: KnownMarketplacesFile): Promise<void> {
  await writeJsonFile(await knownMarketplacesPath(), file);
}

async function settingsMarketplaces(): Promise<KnownMarketplace[]> {
  const map = await getDeclaredMarketplaces();
  const out: KnownMarketplace[] = [];
  for (const [name, value] of Object.entries(map)) {
    out.push({
      name,
      source: parseSource(value),
      installLocation: isTauri
        ? await marketplaceCacheDir(safeSegment(name))
        : "",
      autoUpdate: false,
    });
  }
  return out;
}

export async function listMarketplaces(): Promise<
  (KnownMarketplace & { fromSettings?: boolean; builtin?: boolean })[]
> {
  const registry = (await readRegistry()).marketplaces ?? [];
  const names = new Set(registry.map((m) => m.name));
  const builtins = (await builtinMarketplaceEntries())
    .filter((m) => !names.has(m.name))
    .map((m) => ({ ...m, builtin: true as const }));
  const fromSettings = (await settingsMarketplaces())
    .filter((m) => !names.has(m.name))
    .map((m) => ({ ...m, fromSettings: true as const }));
  return [...builtins, ...registry, ...fromSettings];
}

export async function getMarketplace(name: string): Promise<KnownMarketplace | null> {
  return (await listMarketplaces()).find((m) => m.name === name) ?? null;
}

export async function addMarketplace(
  sourceInput: string | MarketplaceSource,
  opts: { name?: string; autoUpdate?: boolean } = {},
): Promise<KnownMarketplace> {
  const source = typeof sourceInput === "string" ? parseSource(sourceInput) : sourceInput;
  const name = (opts.name?.trim() || deriveName(source)).trim();
  const entry: KnownMarketplace = {
    name,
    source,
    installLocation: await marketplaceCacheDir(safeSegment(name)),
    autoUpdate: opts.autoUpdate ?? false,
  };

  const file = await readRegistry();
  const idx = file.marketplaces.findIndex((m) => m.name === name);
  if (idx >= 0) file.marketplaces[idx] = { ...file.marketplaces[idx], ...entry };
  else file.marketplaces.push(entry);
  await writeRegistry(file);
  return entry;
}

export async function removeMarketplace(name: string): Promise<void> {
  if (isBuiltinMarketplace(name)) return;
  const file = await readRegistry();
  const next = file.marketplaces.filter((m) => m.name !== name);
  if (next.length === file.marketplaces.length) return;
  await writeRegistry({ ...file, marketplaces: next });
}

export async function setAutoUpdate(name: string, autoUpdate: boolean): Promise<void> {
  const file = await readRegistry();
  const idx = file.marketplaces.findIndex((m) => m.name === name);
  if (idx < 0) return;
  file.marketplaces[idx] = { ...file.marketplaces[idx], autoUpdate };
  await writeRegistry(file);
}

export async function markRefreshed(name: string, when: number): Promise<void> {
  const file = await readRegistry();
  const idx = file.marketplaces.findIndex((m) => m.name === name);
  if (idx < 0) return;
  file.marketplaces[idx] = { ...file.marketplaces[idx], lastUpdated: when };
  await writeRegistry(file);
}

export async function ensureDefaultMarketplaces(): Promise<void> {
  if (!isTauri) return;
  const registered = new Set((await readRegistry()).marketplaces.map((m) => m.name));
  for (const def of DEFAULT_MARKETPLACES) {
    if (registered.has(def.name)) continue;
    await addMarketplace(def.repo, { name: def.name, autoUpdate: true });
  }
}

export { isBuiltinMarketplace } from "./defaults";

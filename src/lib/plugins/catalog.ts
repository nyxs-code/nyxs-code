import { invoke } from "@/lib/ipc";
import {
  copyDir,
  fetchText,
  git,
  listDir,
  marketplaceCacheDir,
  pathExists,
  readJsonFile,
  removeDir,
  run,
  safeSegment,
  shellQuote,
  writeJsonFile,
  isTauri,
} from "./paths";
import { LocalizedError } from "@/lib/localizedError";
import {
  isSafeGitUrl,
  isSafeNpmPackage,
  isSafeRef,
  isSafeRepo,
  isSafeSha,
  requireSafe,
} from "./sourceSafety";
import { marketplaceCatalogSchema, type KnownMarketplace, type MarketplaceCatalog } from "./schema";
import { getMarketplace } from "./marketplace";

export const CATALOG_RELS = [".nyxs-plugin/marketplace.json", ".claude-plugin/marketplace.json"];
export const CATALOG_REL = CATALOG_RELS[0];
const CACHED_COPY = "catalog.cached.json";

interface MemoEntry {
  catalog: MarketplaceCatalog;
  at: number;
}
const memo = new Map<string, MemoEntry>();

export function clearCatalogMemo(name?: string): void {
  if (name) memo.delete(name);
  else memo.clear();
}

export async function getCatalog(
  marketplace: string | KnownMarketplace,
  opts: { force?: boolean } = {},
): Promise<MarketplaceCatalog> {
  const mp = typeof marketplace === "string" ? await getMarketplace(marketplace) : marketplace;
  if (!mp) throw new Error(`Unknown marketplace: ${String(marketplace)}`);

  if (!opts.force) {
    const m = memo.get(mp.name);
    if (m) return m.catalog;
    const cached = await readCachedCopy(mp.name);
    if (cached) {
      memo.set(mp.name, { catalog: cached, at: Date.now() });
      return cached;
    }
  }
  return refreshCatalog(mp);
}

export async function refreshCatalog(
  marketplace: string | KnownMarketplace,
): Promise<MarketplaceCatalog> {
  const mp = typeof marketplace === "string" ? await getMarketplace(marketplace) : marketplace;
  if (!mp) throw new Error(`Unknown marketplace: ${String(marketplace)}`);

  const raw = await fetchRawCatalog(mp);
  const parsed = marketplaceCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid marketplace.json for "${mp.name}": ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
    );
  }
  const catalog = parsed.data;
  memo.set(mp.name, { catalog, at: Date.now() });
  await writeCachedCopy(mp.name, catalog);
  return catalog;
}

async function fetchRawCatalog(mp: KnownMarketplace): Promise<unknown> {
  const src = mp.source;
  switch (src.source) {
    case "url":
      return parseJson(await fetchText(src.url), src.url);

    case "github":
      return fetchGithubCatalog(src.repo);

    case "git":
      return cloneAndReadCatalog(mp, src.url);

    case "file":
      return readLocalJson(src.path);

    case "directory":
      return readLocalCatalog(src.path);

    case "npm":
      return npmPackAndReadCatalog(mp, src.package);
  }
}

async function readLocalCatalog(baseDir: string): Promise<unknown> {
  let lastErr: unknown;
  for (const rel of CATALOG_RELS) {
    try {
      return await readLocalJson(joinPath(baseDir, rel));
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `No marketplace.json found in "${baseDir}" (tried ${CATALOG_RELS.join(", ")}). ${lastErr instanceof Error ? lastErr.message : ""}`,
  );
}

async function fetchGithubCatalog(repo: string): Promise<unknown> {
  requireSafe(isSafeRepo(repo), "repo", repo);
  const refs = ["HEAD", "main", "master"];
  let lastErr: unknown;
  for (const ref of refs) {
    for (const rel of CATALOG_RELS) {
      const url = `https://raw.githubusercontent.com/${repo}/${ref}/${rel}`;
      try {
        return parseJson(await fetchText(url), url);
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw new Error(
    `Could not fetch a marketplace.json from github:${repo} (tried ${CATALOG_RELS.join(", ")} on ${refs.join("/")}; ${lastErr instanceof Error ? lastErr.message : lastErr}).`,
  );
}

async function cloneAndReadCatalog(mp: KnownMarketplace, url: string): Promise<unknown> {
  const dir = await marketplaceRepoDir(mp.installLocation || (await marketplaceCacheDir(safeSegment(mp.name))));
  await ensureGitCheckout(dir, url);
  return readLocalCatalog(dir);
}

/**
 * Where a git or GitHub marketplace's checkout lives. The cache folder itself also holds
 * `catalog.cached.json` and `_plugins/`, so cloning there fails once it isn't empty; the
 * checkout goes in `repo/`, except for older git marketplaces already cloned at the top.
 */
export async function marketplaceRepoDir(cacheDir: string): Promise<string> {
  if (await pathExists(joinPath(cacheDir, ".git"))) return cacheDir;
  return joinPath(cacheDir, "repo");
}

export interface GitTarget {
  /** Branch or tag to check out. */
  ref?: string;
  /** Exact commit the catalog reviewed; the checkout fails if it can't be reached. */
  sha?: string;
}

// Belt and braces next to `isSafeGitUrl`: never let a URL pick a command-running transport.
const NO_EXT = ["-c", "protocol.ext.allow=never"];

/**
 * Leaves `dir` as a shallow checkout of `url` at `target` (or the default branch's latest
 * commit). Every value goes to git as its own argument, never through a shell.
 */
export async function ensureGitCheckout(dir: string, url: string, target: GitTarget = {}): Promise<void> {
  requireSafe(isSafeGitUrl(url), "gitUrl", url);
  const ref = target.ref?.trim() || undefined;
  const sha = target.sha?.trim().toLowerCase() || undefined;
  if (ref) requireSafe(isSafeRef(ref), "gitRef", ref);
  if (sha) requireSafe(isSafeSha(sha), "sha", sha);

  const hasRepo = await pathExists(joinPath(dir, ".git"));
  if (hasRepo) {
    await git(["remote", "set-url", "origin", url], dir);
  } else {
    await removeDir(dir);
    await git([...NO_EXT, "clone", "--depth", "1", "--", url, dir]);
    if (!ref && !sha) return;
  }

  const fetchAndCheckout = async (rev: string) => {
    await git([...NO_EXT, "fetch", "--depth", "1", "origin", rev], dir);
    await git(["checkout", "--force", "--detach", "FETCH_HEAD"], dir);
  };
  // Servers only hand out a commit by its full id; a short one is checked after fetching the ref.
  const fullSha = sha && sha.length >= 40 ? sha : undefined;
  try {
    if (fullSha) {
      await fetchAndCheckout(fullSha).catch(() => fetchAndCheckout(ref ?? "HEAD"));
    } else {
      await fetchAndCheckout(ref ?? "HEAD");
    }
  } catch (err) {
    if (ref || sha) {
      const why = err instanceof Error ? err.message : String(err);
      throw new LocalizedError(
        sha ? "checkoutCommitFailed" : "checkoutRefFailed",
        { sha: sha ?? "", ref: ref ?? "", url, message: why },
        `Couldn't check out ${sha ? `commit ${sha}` : `"${ref}"`} of ${url}: ${why}`,
        { cause: err },
      );
    }
    // Without a pinned revision an offline refresh keeps the checkout it already has.
    return;
  }
  if (sha) {
    const head = (await git(["rev-parse", "HEAD"], dir)).stdout.trim().toLowerCase();
    if (!head.startsWith(sha)) {
      const at = head.slice(0, 12);
      throw new LocalizedError(
        "wrongCommit",
        { url, head: at, sha },
        `${url} is at commit ${at}, not the reviewed commit ${sha}.`,
      );
    }
  }
}

async function npmPackAndReadCatalog(mp: KnownMarketplace, pkg: string): Promise<unknown> {
  const dir = mp.installLocation || (await marketplaceCacheDir(safeSegment(mp.name)));
  await extractNpmPackage(dir, pkg);
  return readLocalCatalog(joinPath(dir, "package"));
}

/** The tarball `npm pack --json` reports, when it is a plain file name. */
function packedTarball(stdout: string): string | undefined {
  try {
    const name = (JSON.parse(stdout) as { filename?: unknown }[])[0]?.filename;
    return typeof name === "string" && /^[\w.@-]+\.tgz$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Leaves `<dir>/package` holding exactly the latest published `pkg`. It is packed and unpacked in
 * a fresh folder, so an older tarball is never the one picked, and then copied over the previous
 * extraction as a whole, so files the new version removed don't linger.
 */
export async function extractNpmPackage(dir: string, pkg: string): Promise<void> {
  requireSafe(isSafeNpmPackage(pkg), "npmPackage", pkg);
  const work = joinPath(dir, "npm-pack");
  await removeDir(work);
  // npm and tar need their folder to exist; writing a file creates it. Relative paths from it
  // also keep GNU tar from reading "C:/…" as a remote host.
  await invoke("agent_write_file", { path: joinPath(work, ".keep"), content: "" });
  try {
    const res = await run(`npm pack ${shellQuote(pkg)} --pack-destination . --json`, work);
    const tgz = packedTarball(res.stdout) ?? (await listDir(work)).find((e) => e.endsWith(".tgz"));
    if (!tgz) throw new Error(`npm pack produced no tarball for ${pkg}.`);
    await run(`tar -xzf ${shellQuote(tgz)}`, work);
    await copyDir(joinPath(work, "package"), joinPath(dir, "package"));
  } finally {
    await removeDir(work);
  }
  // Older versions packed straight into the cache folder and left every tarball there.
  for (const name of await listDir(dir)) {
    if (name.endsWith(".tgz")) await removeDir(joinPath(dir, name));
  }
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Response from ${where} was not valid JSON.`);
  }
}

async function readLocalJson(path: string): Promise<unknown> {
  if (!isTauri) throw new Error("Local sources require the desktop app.");
  await invoke("agent_allow_ui_path", { path });
  const raw = await invoke<string>("nyxs_read_text", { path });
  if (!raw.trim()) throw new Error(`File not found or empty: ${path}`);
  return parseJson(raw, path);
}

async function readCachedCopy(name: string): Promise<MarketplaceCatalog | null> {
  const dir = await marketplaceCacheDir(safeSegment(name));
  const raw = await readJsonFile<unknown>(joinPath(dir, CACHED_COPY));
  if (!raw) return null;
  const parsed = marketplaceCatalogSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function writeCachedCopy(name: string, catalog: MarketplaceCatalog): Promise<void> {
  const dir = await marketplaceCacheDir(safeSegment(name));
  await writeJsonFile(joinPath(dir, CACHED_COPY), catalog);
}

export function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .filter(Boolean)
    .join("/");
}

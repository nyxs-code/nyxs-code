import { joinPath } from "@/lib/plugins/catalog";
import { copyDir, git, isTauri, pathExists, removeDir } from "@/lib/plugins/paths";
import { isSafeRepo, isSafeSlug, requireSafe } from "@/lib/plugins/sourceSafety";
import { projectSkillsDir, userNyxsDir, userSkillsDir } from "@/lib/paths";
import { clearPreflightCache } from "@/lib/preflight";

export type SkillInstallScope = "user" | "project";

function safeCacheSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function checkoutSkillPaths(cacheDir: string, url: string, sparsePaths: string[]): Promise<void> {
  await removeDir(cacheDir);
  try {
    await git(["clone", "--depth", "1", "--filter=blob:none", "--sparse", "--", url, cacheDir]);
    await git(["sparse-checkout", "set", ...sparsePaths], cacheDir);
    return;
  } catch {
    await removeDir(cacheDir);
    await git(["clone", "--depth", "1", "--", url, cacheDir]);
  }
}

async function skillInstallCacheDir(owner: string, repo: string, slug: string): Promise<string> {
  const root = joinPath(await userNyxsDir(), "skill-install-cache");
  return joinPath(root, `${safeCacheSegment(owner)}_${safeCacheSegment(repo)}__${safeCacheSegment(slug)}`);
}

export async function installSkillFromGithub(
  source: string,
  slug: string,
  opts: { scope?: SkillInstallScope; workspace?: string | null } = {},
): Promise<string> {
  if (!isTauri) throw new Error("Installing skills requires the Nyxs desktop app.");

  requireSafe(isSafeRepo(source), "skillSource", source);
  // The slug is a folder name from the repo's listing: it becomes the install folder's name.
  requireSafe(isSafeSlug(slug), "skillName", slug);
  const [owner, repo] = source.split("/");

  const scope = opts.scope ?? "user";
  if (scope === "project" && !opts.workspace?.trim()) {
    throw new Error("Open a project folder to install skills for this project only.");
  }
  const destRoot =
    scope === "project"
      ? projectSkillsDir(opts.workspace!.trim())
      : await userSkillsDir();
  const dest = joinPath(destRoot, slug);

  const cacheDir = await skillInstallCacheDir(owner, repo, slug);
  const url = `https://github.com/${owner}/${repo}.git`;

  const candidates = [
    joinPath(cacheDir, "skills", slug),
    joinPath(cacheDir, slug),
  ];
  let srcDir: string | null = null;
  for (const sparse of [`skills/${slug}`, slug]) {
    await checkoutSkillPaths(cacheDir, url, [sparse]);
    for (const c of candidates) {
      if (await pathExists(joinPath(c, "SKILL.md"))) {
        srcDir = c;
        break;
      }
    }
    if (srcDir) break;
  }
  if (!srcDir) {
    throw new Error(`SKILL.md not found for "${slug}" in ${source} (tried skills/${slug} and ${slug}).`);
  }

  await copyDir(srcDir, dest);
  clearPreflightCache();
  return dest;
}

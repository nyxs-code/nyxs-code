import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { fetchText, isTauri } from "@/lib/plugins/paths";
import { isSafeSlug } from "@/lib/plugins/sourceSafety";

const http: typeof fetch = isTauri ? (tauriFetch as unknown as typeof fetch) : fetch;

export const SKILLS_SH_FEATURED_SOURCES = [
  "anthropics/skills",
  "vercel-labs/agent-skills",
  "vercel-labs/skills",
  "obra/superpowers",
  "mattpocock/skills",
  "supabase/agent-skills",
  "microsoft/azure-skills",
] as const;

export interface SkillsShEntry {
  id: string;
  slug: string;
  name: string;
  source: string;
  description: string;
  installs?: number;
  sourceType: "github" | "well-known";
  installUrl: string | null;
  url: string;
}

function skillsShPageUrl(source: string, slug: string): string {
  return `https://skills.sh/${source}/${slug}`;
}

interface GhTreeItem {
  path: string;
  type: string;
}

async function githubTree(owner: string, repo: string): Promise<GhTreeItem[]> {
  const res = await http(`https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Nyxs" },
  });
  if (!res.ok) {
    const resMaster = await http(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/master?recursive=1`,
      { headers: { Accept: "application/vnd.github+json", "User-Agent": "Nyxs" } },
    );
    if (!resMaster.ok) throw new Error(`GitHub tree ${owner}/${repo}: HTTP ${res.status}`);
    const j = (await resMaster.json()) as { tree?: GhTreeItem[] };
    return j.tree ?? [];
  }
  const j = (await res.json()) as { tree?: GhTreeItem[] };
  return j.tree ?? [];
}

function parseSkillMeta(text: string): { name: string; description: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ""));
  if (!m) return { name: "", description: "" };
  let name = "";
  let description = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === "name") name = val;
    if (key === "description") description = val;
  }
  return { name, description };
}

async function fetchSkillMdMeta(
  owner: string,
  repo: string,
  skillPath: string,
): Promise<{ name: string; description: string }> {
  const refs = ["main", "master"];
  for (const ref of refs) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${skillPath}`;
    try {
      const text = isTauri ? await fetchText(url) : await (await fetch(url)).text();
      return parseSkillMeta(text);
    } catch {
      /* try next ref */
    }
  }
  return { name: "", description: "" };
}

export async function listSkillsInGithubRepo(source: string): Promise<SkillsShEntry[]> {
  const [owner, repo] = source.split("/");
  if (!owner || !repo) return [];
  const tree = await githubTree(owner, repo);
  const skillPaths = tree
    .filter((t) => t.type === "blob" && /^skills\/[^/]+\/SKILL\.md$/.test(t.path))
    .map((t) => t.path);

  const out: SkillsShEntry[] = [];
  for (const skillPath of skillPaths) {
    const slug = skillPath.split("/")[1];
    // The folder name becomes a local folder and a git path when installing.
    if (!isSafeSlug(slug)) continue;
    const meta = await fetchSkillMdMeta(owner, repo, skillPath);
    out.push({
      id: `${source}/${slug}`,
      slug,
      name: meta.name || slug,
      source,
      description: meta.description || "",
      sourceType: "github",
      installUrl: `https://github.com/${source}`,
      url: skillsShPageUrl(source, slug),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

let featuredCache: { at: number; skills: SkillsShEntry[] } | null = null;
const FEATURED_TTL_MS = 10 * 60 * 1000;

export async function fetchFeaturedSkillsCatalog(force = false): Promise<SkillsShEntry[]> {
  if (!force && featuredCache && Date.now() - featuredCache.at < FEATURED_TTL_MS) {
    return featuredCache.skills;
  }
  const all: SkillsShEntry[] = [];
  const seen = new Set<string>();
  for (const source of SKILLS_SH_FEATURED_SOURCES) {
    try {
      for (const s of await listSkillsInGithubRepo(source)) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        all.push(s);
      }
    } catch (err) {
      console.warn(`skills catalog: could not list ${source}`, err);
    }
  }
  featuredCache = { at: Date.now(), skills: all };
  return all;
}

export async function browseSkills(opts: {
  query?: string;
  force?: boolean;
}): Promise<SkillsShEntry[]> {
  const q = opts.query?.trim() ?? "";
  const catalog = await fetchFeaturedSkillsCatalog(opts.force);
  if (!q) return catalog;
  const lower = q.toLowerCase();
  return catalog.filter((s) => {
    const hay = `${s.name} ${s.slug} ${s.source} ${s.description}`.toLowerCase();
    return hay.includes(lower);
  });
}

import { runGit } from "@/lib/gitErrors";
import { isRemotePath } from "@/lib/remote";

const GITHUB = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
const SHORT = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;

/** `owner/repo` of a GitHub remote or URL, or of `owner/repo` typed as is. */
export function githubRepoOf(text: string): string | null {
  const t = text.trim();
  const m = GITHUB.exec(t) ?? (t.includes(":") ? null : SHORT.exec(t));
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The URL a repository typed in the dialog is kept as: GitHub's for `owner/repo`, else as
 *  typed (another host's URL). Null when it isn't one. */
export function repoUrlOf(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const gh = githubRepoOf(t);
  if (gh) return `https://github.com/${gh}`;
  return /^(https?:\/\/|git@)\S+$/.test(t) ? t : null;
}

/** How a repository shows in the dialog and the header: `owner/repo` for GitHub. */
export function repoLabel(url: string): string {
  return githubRepoOf(url) ?? url.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "");
}

/** The user's GitHub repositories, from the `origin` of their recent folders: newest folder
 *  first, each repo once, at most `max`. */
export async function suggestedRepos(folders: string[], max = 3): Promise<string[]> {
  const out: string[] = [];
  for (const folder of folders.slice(0, 10)) {
    if (out.length >= max) break;
    if (!folder || isRemotePath(folder)) continue;
    const r = await runGit(folder, ["remote", "get-url", "origin"], 5_000).catch(() => null);
    const repo = r?.code === 0 ? githubRepoOf(r.stdout) : null;
    if (repo && !out.some((x) => x.toLowerCase() === repo.toLowerCase())) out.push(repo);
  }
  return out;
}

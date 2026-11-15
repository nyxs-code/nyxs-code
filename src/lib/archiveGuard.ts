import { runGit } from "@/lib/gitErrors";
import { sessionTrackedFiles } from "@/lib/sessionStorage";

/** `git status --porcelain=v1 -z`: "XY path\0", plus the old path after a rename or copy. */
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return paths;
}

/** The first few files, for a warning that names them. */
export function shortFileList(files: string[]): string {
  return files.slice(0, 5).join(", ") + (files.length > 5 ? ", …" : "");
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** A session's own worktree is all its work: any uncommitted change there counts. */
export async function uncommittedWorktreeFiles(worktreePath: string): Promise<string[]> {
  const res = await runGit(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).catch(() => null);
  return res && res.code === 0 ? parsePorcelainZ(res.stdout) : [];
}

/** The files this session edited that still have changes git hasn't committed, relative to the
 *  repo. Like Claude Code Desktop warns before archiving a session with uncommitted work. In
 *  Nyxs a session shares the project folder, so only its own files count, not the whole tree.
 *  Nothing when the folder isn't a git repo or git can't be asked. */
export async function uncommittedSessionFiles(workspace: string, sessionId: string, known: string[] = []): Promise<string[]> {
  const root = norm(workspace);
  const files = [...new Set([...known, ...(await sessionTrackedFiles(workspace, sessionId))])]
    // git refuses the whole command for a path outside the repository.
    .filter((f) => norm(f).startsWith(`${root}/`));
  if (!files.length) return [];
  const dirty: string[] = [];
  for (let i = 0; i < files.length; i += 100) {
    const res = await runGit(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...files.slice(i, i + 100)]).catch(() => null);
    if (!res || res.code !== 0) return [];
    dirty.push(...parsePorcelainZ(res.stdout));
  }
  return [...new Set(dirty)];
}

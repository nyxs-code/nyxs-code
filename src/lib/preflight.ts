import { classifyGitFailure, runGit, untrustedRepoContext } from "./gitErrors";
import { loadSkills, loadProjectMemory, loadProjectMemoryBundle, loadClaudeMemory, type MemoryFileInfo } from "./skills";
import { loadAgentFiles } from "./agentFiles";
import { loadPluginComponents } from "./plugins/pluginLoader";
import { subscribeFsChange } from "./fsWatch";
import { staleBranchFinding, formatRecoveryHint } from "./recovery";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const GIT_CONTEXT_TTL_MS = 20_000;
const PREFLIGHT_TTL_MS = 60_000;

export interface PreflightBundle {
  skills: Awaited<ReturnType<typeof loadSkills>>;
  plugins: Awaited<ReturnType<typeof loadPluginComponents>> | null;
  agents: Awaited<ReturnType<typeof loadAgentFiles>>;
  memory: string;
  /** Claude Code's memory index for this project, so other providers follow it too. */
  claudeMemory: string;
  /** Each file that makes up `memory`, with its size, for the context panel. */
  memoryFiles: MemoryFileInfo[];
}

export const EMPTY_PREFLIGHT: PreflightBundle = {
  skills: [],
  plugins: null,
  agents: [],
  memory: "",
  claudeMemory: "",
  memoryFiles: [],
};

const gitContextCache = new Map<string, { value: string; at: number }>();
const preflightCache = new Map<string, { value: PreflightBundle; at: number }>();
const nyxsMemoryCache = new Map<string, { value: string; at: number }>();

/** How many projects' caches are kept fresh by a watcher: the one on screen and a few chats
 *  working in the background, without one watcher per project ever opened. */
const MAX_WATCHED = 4;
/** The watched projects, the most recently used last, with what stops each watch. */
const watched = new Map<string, () => void>();

function forget(workspace: string): void {
  gitContextCache.delete(workspace);
  preflightCache.delete(workspace);
  nyxsMemoryCache.delete(workspace);
}

/** Keeps the project's caches until its files change. A project that falls out of the watched
 *  ones loses its caches too: nothing would tell them apart from the files any more. */
function watchWorkspaceInvalidation(workspace: string): void {
  if (!isTauri) return;
  const off = watched.get(workspace);
  watched.delete(workspace);
  watched.set(workspace, off ?? subscribeFsChange(workspace, () => forget(workspace)));
  for (const [oldest, stop] of watched) {
    if (watched.size <= MAX_WATCHED) break;
    watched.delete(oldest);
    stop();
    forget(oldest);
  }
}

export function clearPreflightCache(): void {
  preflightCache.clear();
  nyxsMemoryCache.clear();
}

async function gatherGitContext(workspace: string): Promise<string> {
  try {
    const run = (args: string[]) => runGit(workspace, ["--no-optional-locks", ...args], 10_000);
    const [branchRes, statusRes, logRes, behindRes] = await Promise.all([
      run(["rev-parse", "--abbrev-ref", "HEAD"]),
      run(["status", "--short"]),
      run(["log", "-5", "--pretty=format:%h %s"]),
      run(["rev-list", "--count", "HEAD..@{u}"]),
    ]);
    let branch = branchRes.code === 0 ? branchRes.stdout.trim() : "";
    if (branchRes.code !== 0) {
      const failure = classifyGitFailure(branchRes.stderr);
      if (failure.kind === "untrusted") return untrustedRepoContext(failure.path);
      if (failure.kind !== "no-commits") return "";
      const sym = await run(["symbolic-ref", "--short", "HEAD"]);
      branch = sym.code === 0 ? `${sym.stdout.trim()} (no commits yet)` : "";
    }
    if (!branch) return "";
    const status = statusRes.stdout.trim();
    const log = logRes.stdout.trim();
    const parts = [`Branch: ${branch}`];
    parts.push(status ? `Changed files:\n${status}` : "Working tree clean.");
    if (log) parts.push(`Recent commits:\n${log}`);
    const behind = behindRes.code === 0 ? parseInt(behindRes.stdout.trim(), 10) : NaN;
    const stale = staleBranchFinding(Number.isFinite(behind) ? behind : 0, "upstream");
    if (stale) parts.push(`⚠️ ${formatRecoveryHint(stale)}`);
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

export async function cachedGitContext(workspace: string): Promise<string> {
  watchWorkspaceInvalidation(workspace);
  const hit = gitContextCache.get(workspace);
  if (hit && Date.now() - hit.at < GIT_CONTEXT_TTL_MS) return hit.value;
  const value = await gatherGitContext(workspace);
  gitContextCache.set(workspace, { value, at: Date.now() });
  return value;
}

export async function cachedPreflight(workspace: string): Promise<PreflightBundle> {
  watchWorkspaceInvalidation(workspace);
  const hit = preflightCache.get(workspace);
  if (hit && Date.now() - hit.at < PREFLIGHT_TTL_MS) return hit.value;
  const [skills, plugins, agents, memoryBundle, claudeMemory] = await Promise.all([
    loadSkills(workspace),
    loadPluginComponents(),
    loadAgentFiles(workspace),
    loadProjectMemoryBundle(workspace),
    loadClaudeMemory(workspace),
  ]);
  const value: PreflightBundle = {
    skills,
    plugins,
    agents,
    memory: memoryBundle.text,
    claudeMemory,
    memoryFiles: memoryBundle.files,
  };
  preflightCache.set(workspace, { value, at: Date.now() });
  return value;
}

/** Nyxs' own project instructions, for Claude Code: it loads CLAUDE.md and AGENTS.md itself. */
export async function cachedNyxsMemory(workspace: string): Promise<string> {
  watchWorkspaceInvalidation(workspace);
  const hit = nyxsMemoryCache.get(workspace);
  if (hit && Date.now() - hit.at < PREFLIGHT_TTL_MS) return hit.value;
  const value = await loadProjectMemory(workspace, { nyxsOnly: true });
  nyxsMemoryCache.set(workspace, { value, at: Date.now() });
  return value;
}

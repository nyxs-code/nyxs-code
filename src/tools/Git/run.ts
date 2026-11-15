import { invoke } from "@/lib/ipc";
import { classifyGitFailure, untrustedRepoContext } from "@/lib/gitErrors";
import type { RunResult } from "@/tools/Bash/format";
import { TOOL_OUTPUT_LIMITS, truncateMiddle } from "@/tools/limits";

export async function runGit(args: string[], workspace: string): Promise<string> {
  const res = await invoke<RunResult>("agent_git", {
    args,
    cwd: workspace,
    timeoutMs: 30_000,
  });
  const parts: string[] = [];
  if (res.stdout.trim()) parts.push(res.stdout.trimEnd());
  if (res.stderr.trim() && (res.code !== 0 || !res.stdout.trim())) {
    parts.push(res.stderr.trimEnd());
  }
  if (res.code !== 0) {
    parts.push(`[git exited with code ${res.code}]`);
    const failure = classifyGitFailure(res.stderr);
    if (failure.kind === "untrusted") parts.push(untrustedRepoContext(failure.path));
  }
  return truncateMiddle(parts.length ? parts.join("\n") : "(no output)", TOOL_OUTPUT_LIMITS.default, 2 / 3);
}

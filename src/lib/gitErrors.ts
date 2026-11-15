import { invoke } from "@/lib/ipc";

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
  timed_out: boolean;
}

export type GitFailure =
  | { kind: "not-repo" }
  | { kind: "no-commits" }
  | { kind: "untrusted"; path: string }
  | { kind: "missing-git" }
  | { kind: "other"; message: string };

export function classifyGitFailure(stderr: string): GitFailure {
  const text = stderr.trim();
  const dubious = /dubious ownership in repository at '([^']+)'/i.exec(text);
  if (dubious) return { kind: "untrusted", path: dubious[1] };
  if (/not a git repository/i.test(text)) return { kind: "not-repo" };
  if (/ambiguous argument 'HEAD'|unknown revision|does not have any commits/i.test(text)) return { kind: "no-commits" };
  if (/program not found|cannot find the file|no such file or directory|not recognized as|Couldn't start the command/i.test(text)) {
    return { kind: "missing-git" };
  }
  return { kind: "other", message: text.split("\n").slice(0, 6).join("\n") || "git failed" };
}

export function untrustedRepoContext(path: string): string {
  return (
    `Git refuses to work in this repository: it is owned by another Windows user ("dubious ownership" at ${path}). ` +
    `Every plain git command will fail. Ask the user to trust it (the Changes panel has a button), ` +
    `or pass \`-c safe.directory=${path}\` to read-only git commands you need.`
  );
}

export function runGit(cwd: string, args: string[], timeoutMs = 20_000): Promise<GitRunResult> {
  return invoke<GitRunResult>("agent_git", { args, cwd, timeoutMs });
}

export async function trustRepository(path: string): Promise<GitRunResult> {
  return runGit(path, ["config", "--global", "--add", "safe.directory", path]);
}

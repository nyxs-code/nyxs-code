export type RecoveryKind = "retryable" | "escalate";
export type RecoverySeverity = "info" | "warning" | "error";

export interface RecoveryFinding {
  id: string;
  severity: RecoverySeverity;
  cause: string;
  detail?: string;
  remedyCommand?: string;
  autoApplicable: boolean;
  kind: RecoveryKind;
}

export function staleBranchFinding(behind: number, base = "main"): RecoveryFinding | null {
  if (!Number.isFinite(behind) || behind <= 0) return null;
  return {
    id: "stale-branch",
    severity: behind >= 20 ? "warning" : "info",
    cause: `The current branch is ${behind} commit(s) behind ${base}.`,
    detail: "Rebasing or merging keeps the working base current and avoids stale-base conflicts later.",
    remedyCommand: `git merge ${base}`,
    autoApplicable: false,
    kind: "retryable",
  };
}

const ERROR_PATTERNS: { id: string; re: RegExp; build: (text: string) => RecoveryFinding }[] = [
  {
    id: "mcp-timeout",
    re: /\b(timed?\s*out|timeout|etimedout|handshake)\b/i,
    build: () => ({
      id: "mcp-timeout",
      severity: "warning",
      cause: "An MCP server timed out during connection or a request.",
      detail: "Usually transient (cold start or a slow network). A retry often succeeds.",
      autoApplicable: true,
      kind: "retryable",
    }),
  },
  {
    id: "connection-refused",
    re: /\b(econnrefused|connection refused|enotfound|fetch failed|network ?error)\b/i,
    build: () => ({
      id: "connection-refused",
      severity: "error",
      cause: "Could not reach the server (connection refused / host not found).",
      detail: "Check the server URL and that it's running, then reconnect.",
      autoApplicable: false,
      kind: "escalate",
    }),
  },
  {
    id: "base-missing",
    re: /\b(unknown revision|bad revision|ambiguous argument|fatal: your current branch.*does not have any commits)\b/i,
    build: () => ({
      id: "base-missing",
      severity: "warning",
      cause: "A referenced git revision/base does not exist locally.",
      detail: "Fetch from the remote so the missing ref is available.",
      remedyCommand: "git fetch --all",
      autoApplicable: true,
      kind: "retryable",
    }),
  },
  {
    id: "file-missing",
    re: /\b(enoent|no such file|cannot find the file|does not exist|file not found)\b/i,
    build: () => ({
      id: "file-missing",
      severity: "warning",
      cause: "A referenced file no longer exists.",
      detail: "It may have been moved or deleted; re-check the path (Glob/Grep) before using it.",
      autoApplicable: false,
      kind: "retryable",
    }),
  },
  {
    id: "plugin-corrupt",
    re: /\b(invalid plugin|corrupt|malformed|failed to parse)\b/i,
    build: () => ({
      id: "plugin-corrupt",
      severity: "error",
      cause: "A plugin or config file is corrupt or malformed.",
      detail: "Reinstall the plugin or restore the file from a backup.",
      autoApplicable: false,
      kind: "escalate",
    }),
  },
  {
    id: "permission-denied",
    re: /\b(eacces|permission denied|access is denied|operation not permitted)\b/i,
    build: () => ({
      id: "permission-denied",
      severity: "error",
      cause: "The operation was denied by the filesystem/OS permissions.",
      autoApplicable: false,
      kind: "escalate",
    }),
  },
];

export function classifyFailure(errorText: string): RecoveryFinding | null {
  const text = (errorText ?? "").toString();
  if (!text.trim()) return null;
  for (const p of ERROR_PATTERNS) {
    if (p.re.test(text)) return p.build(text);
  }
  return null;
}

export function formatRecoveryHint(f: RecoveryFinding): string {
  const remedy = f.remedyCommand
    ? ` Suggested fix: \`${f.remedyCommand}\`${f.autoApplicable ? "" : " (confirm before running)"}.`
    : "";
  return `${f.cause}${remedy}`;
}

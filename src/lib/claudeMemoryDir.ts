/** The folder of Claude Code's memory for each project (~/.claude/projects/<slug>/memory), as
 *  loadClaudeMemory found it. The prompt tells the built-in models to open its files with Read,
 *  so their read tools allow it; writing there stays Claude Code's. */
const dirs = new Map<string, string>();

const key = (workspace: string) => workspace.replace(/[\\/]+$/, "");

export function rememberClaudeMemoryDir(workspace: string, dir: string): void {
  dirs.set(key(workspace), dir);
}

export function claudeMemoryDir(workspace: string): string | undefined {
  return dirs.get(key(workspace));
}

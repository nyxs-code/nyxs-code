import { BASH_TOOL_NAME, GIT_DIFF_TOOL_NAME } from "../toolNames";

export function getGitStatusDescription(): string {
  return `Shows the working-tree status of the git repository (current branch plus staged, unstaged and untracked files), like \`git status --short --branch\`.

Usage:
- Use this to see what has changed before diffing or committing. Read-only.
- For the actual content of the changes, follow up with ${GIT_DIFF_TOOL_NAME}.
- To stage, commit, push or run any other git command, use the ${BASH_TOOL_NAME} tool.`;
}

export function getGitDiffDescription(): string {
  return `Shows changes in the git repository as a unified diff.

Usage:
- With no arguments, shows unstaged working-tree changes (\`git diff\`).
- Set \`staged: true\` to show what's staged for commit (\`git diff --staged\`).
- Pass \`commit\` to diff against a commit or range (e.g. "HEAD~3", "main..HEAD").
- Pass \`path\` to limit the diff to one file or directory.
- Set \`stat: true\` for a compact summary (files changed + insertions/deletions) instead of the full diff. Read-only.`;
}

export function getGitLogDescription(): string {
  return `Shows the commit history of the git repository (\`git log\`).

Usage:
- Returns the most recent commits (default 20) as "<hash> <author> <date> <subject>".
- Pass \`count\` to change how many commits are shown, \`path\` to only show commits touching a file/directory, and \`author\` to filter by author. Read-only.`;
}

export function getGitBlameDescription(): string {
  return `Shows, for each line of a file, the commit and author that last changed it (\`git blame\`).

Usage:
- \`file_path\` is required (relative to the repository).
- Pass \`start_line\` (and optionally \`end_line\`) to blame only a range of lines — recommended for large files. Read-only.`;
}

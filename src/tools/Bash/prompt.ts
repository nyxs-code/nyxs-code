import type { ToolPromptEnv } from "../env";
import {
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../toolNames";

function gitInstructions(): string {
  return `# Git operations

Only create commits when the user asks for one. If unclear, ask first. Follow this safety protocol:
- NEVER update the git config.
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests them — they can lose work.
- NEVER skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user explicitly asks. If a hook fails, investigate and fix the underlying issue.
- NEVER force-push to main/master; warn the user if they request it.
- ALWAYS create a NEW commit rather than amending, unless the user explicitly asks for an amend. If a pre-commit hook fails, the commit did NOT happen — fix the issue, re-stage, and create a new commit.
- When staging, add specific files by name rather than \`git add -A\`/\`git add .\`, which can include secrets (.env, credentials) or large binaries.
- Interactive flags are not supported in this shell (no \`git rebase -i\`, \`git add -i\`).
- Use the \`gh\` CLI for GitHub tasks (issues, PRs, checks, releases). If given a GitHub URL, use \`gh\` to fetch what you need.`;
}

function sandboxSection(env: ToolPromptEnv): string {
  if (!env.sandbox) return "";
  return `
## Command sandbox
Your command runs in a sandbox that restricts which directories and network hosts it may access. If a command fails due to sandbox restrictions ("Operation not permitted", access denied to a path, blocked host), work with the user to adjust the sandbox settings instead of disabling it.`;
}

function detachedAdvice(shell: string): string {
  if (!shell.startsWith("PowerShell")) return "";
  return "\n- Everything a command starts (including `Start-Process`) is closed when the app closes. To open an app, document or URL that must stay open afterwards, use `Start-Detached <program-or-path> [-ArgumentList a,b] [-Hidden]`; it returns the new ProcessId.\n- A console program started with `Start-Process` runs hidden; pass `-WindowStyle Normal` only when the user should see its window (e.g. a terminal they asked you to open). To launch one in the background without a console flashing, call `Start-Process` directly (never `cmd /c start`), use `start /b` inside cmd, or `-WindowStyle Hidden` on a `Start-Process` inside a script.";
}

function chainingAdvice(shell: string): string {
  if (shell === "PowerShell 7") return "PowerShell 7: `&&` to stop at the first failure, `;` to continue regardless";
  return shell === "PowerShell"
    ? "PowerShell: `;` or `if ($?) { … }`; pipeline chain operators `&&`/`||` are not available in Windows PowerShell 5.1"
    : "bash: `&&` to stop at the first failure, `;` to continue regardless";
}

export function getBashDescription(env: ToolPromptEnv): string {
  const avoid = env.embeddedSearchTools
    ? "`cat`, `head`, `tail`, `sed`, `awk`, or `echo`"
    : "`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or PowerShell equivalents (`Get-ChildItem -Recurse`, `Select-String`, `Get-Content`)";

  const toolPreference = [
    ...(env.embeddedSearchTools
      ? []
      : [
          `- File search: Use ${GLOB_TOOL_NAME} (NOT find or Get-ChildItem -Recurse)`,
          `- Content search: Use ${GREP_TOOL_NAME} (NOT grep, rg or Select-String)`,
        ]),
    `- Read files: Use ${READ_TOOL_NAME} (NOT cat/head/tail or Get-Content)`,
    `- Edit files: Use ${EDIT_TOOL_NAME} (NOT sed/awk or shell editing)`,
    `- Write files: Use ${WRITE_TOOL_NAME} (NOT \`>\` redirection or here-strings)`,
  ].join("\n");

  const background = env.backgroundTasks
    ? `\n- \`run_in_background\` is ONLY for processes that don't terminate on their own — dev servers, watchers, \`--watch\` test runners, tail -f. For these it returns a shell ID immediately; read output with BashOutput and stop it with KillShell. You do NOT need to append '&'.
- Do NOT background a command that finishes on its own (\`npm install\`, \`npm run build\`, a one-shot test run, migrations, git operations). Run those in the FOREGROUND with a generous \`timeout_ms\` (up to ${env.maxBashTimeoutMs}ms) and wait for the result in one call — backgrounding them forces you into a polling loop, which wastes turns and is exactly what you must avoid.
- To wait on a background process, call BashOutput ONCE: it blocks until there's new output or the process exits (default ~30s), then call again if still running. Never poll BashOutput in a tight loop.`
    : "";

  return `Executes a given command and returns its output. The shell is ${env.shell}.

- Each call starts a fresh shell in the workspace root (or in \`cwd\` if you pass it). Neither \`cd\` nor shell state (variables, functions) carries over to the next call.
- The output starts with \`[exit code: N]\`. Very long output keeps its beginning and its end; the middle is replaced by a note saying how much was omitted.
- IMPORTANT: Avoid using this tool to run ${avoid} commands, unless explicitly instructed or after you have verified a dedicated tool cannot do the task. Prefer the dedicated tools — they give the user a better, reviewable experience:
${toolPreference}

# Instructions
- If the command will create new directories or files, first run \`ls\` (or \`Get-ChildItem\`) to verify the parent directory exists and is the correct location.
- Always quote file paths that contain spaces with double quotes (e.g. \`cd "path with spaces/file.txt"\`).
- Try to maintain your current working directory by using absolute paths and avoiding \`cd\`. Use \`cd\` only if the user explicitly requests it.
- You may specify an optional timeout in milliseconds (up to ${env.maxBashTimeoutMs}ms / ${Math.round(env.maxBashTimeoutMs / 60000)} minutes). By default a command times out after ${env.defaultBashTimeoutMs}ms (${Math.round(env.defaultBashTimeoutMs / 60000)} minutes).${background}${detachedAdvice(env.shell)}
- When issuing multiple commands:
  - If they are independent, make multiple ${BASH_TOOL_NAME} tool calls in a single message so they run in parallel.
  - If they depend on each other, chain them in one call (${chainingAdvice(env.shell)}).
  - Do NOT use newlines to separate commands (newlines are fine inside quoted strings).
- Avoid unnecessary sleeps: don't sleep between commands that can run immediately; if a command is long-running and you want to be notified, use \`run_in_background\`; don't retry failing commands in a sleep loop — diagnose the root cause.
${sandboxSection(env)}
${env.git ? `\n${gitInstructions()}` : ""}`.trim();
}

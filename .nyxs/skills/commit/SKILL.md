---
name: commit
description: Create a git commit with the current changes
when_to_use: When the user asks to commit, save changes, or "make a commit"
---

# Create a git commit

Follow these steps using the Bash tool:

1. Run `git status` to see modified and untracked files.
2. Run `git diff HEAD` to see the actual changes.
3. Run `git log -5 --oneline` to match the repo's commit message style.
4. Draft a concise message (1-2 sentences) focused on the "why", not the "what".
5. Stage the relevant files with `git add <files>` (avoid `git add -A`; never include secrets or large binaries).
6. Create the commit. Pass the message via a here-string to preserve formatting.
7. Run `git status` to confirm the commit succeeded.

Safety rules:
- ALWAYS create a new commit; do not use `--amend` unless the user asks.
- NEVER use `--no-verify` or skip hooks.
- If a hook fails, fix the issue and commit again (do not amend).
- Do not `push` unless the user explicitly asks.

If arguments are provided ($ARGUMENTS), use them as a hint for the commit message.

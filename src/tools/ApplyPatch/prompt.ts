import { READ_TOOL_NAME } from "../toolNames";

export function getApplyPatchDescription(): string {
  return `Creates, edits, moves and deletes files with a patch. This is your only way to change files: there is no Edit or Write tool.

The patch goes in \`input\`, in this format:

*** Begin Patch
*** Add File: path/to/new.ts
+every line of the new file, each prefixed with "+"
*** Update File: path/to/existing.ts
@@ a line near the change, e.g. a function signature (optional)
 an unchanged line, prefixed with a space
-a line to remove
+a line to add
 another unchanged line
*** Delete File: path/to/old.ts
*** End Patch

Rules:
- You must use the ${READ_TOOL_NAME} tool on a file before updating it, and copy its lines exactly as they appear AFTER the line-number prefix (never include the prefix).
- Give each hunk about 3 unchanged lines before and after the change, so its place in the file is unique. Start each further hunk of the same file with "@@".
- To rename a file, put "*** Move to: new/path" right after its "*** Update File:" line.
- Paths are relative to the working directory (or absolute).
- Several files can go in one patch. Each file is applied all-or-nothing, in order; if one fails, the error says which files were already changed.
- If a hunk doesn't apply, ${READ_TOOL_NAME} the file again and resend that hunk with its current text. Don't rewrite the whole file to get around it.
- Only use emojis if the user explicitly requests it; avoid adding emojis to files unless asked.`;
}

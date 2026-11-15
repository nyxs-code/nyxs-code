import { EDIT_TOOL_NAME, READ_TOOL_NAME } from "../toolNames";

export function getWriteDescription(): string {
  return `Writes a file to the local filesystem.

Usage:
- ALWAYS provide BOTH arguments: \`file_path\` first, then \`content\`. Emit \`file_path\` BEFORE \`content\` so the destination is never lost if a long file is cut off. A call without \`file_path\` is invalid.
- This tool overwrites the existing file if there is one at the given path.
- If the file already exists, you MUST use the ${READ_TOOL_NAME} tool first to read it. This tool will fail if you have not read an existing file first.
- Prefer the ${EDIT_TOOL_NAME} tool for modifying existing files — it only sends the diff. Use Write only to create new files or for complete rewrites. To change PART of an existing file, do NOT rewrite the whole thing with Write: a long Write can be cut off by the provider's token limit and corrupt the file. Edit the specific part instead.
- NEVER create documentation files (*.md) or README files unless the user explicitly asks.
- Only use emojis if the user explicitly requests it; avoid writing emojis to files unless asked.
- Missing parent folders are created automatically.`;
}

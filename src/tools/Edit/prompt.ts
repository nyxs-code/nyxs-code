import { EDIT_TOOL_NAME, READ_TOOL_NAME } from "../toolNames";

export function getEditDescription(): string {
  return `Performs exact string replacements in files.

Usage:
- You must use the ${READ_TOOL_NAME} tool on the file at least once in this conversation before editing it. This tool errors if you attempt an edit without having read the file.
- Preserve the exact indentation (tabs/spaces) as it appears AFTER the line-number prefix in Read output. The prefix is "line number + tab"; everything after the tab is the actual file content to match. NEVER include any part of the line-number prefix in old_string or new_string.
- ALWAYS prefer editing an existing file over creating a new one. NEVER write new files unless explicitly required.
- The edit FAILS if old_string is not unique in the file. Either provide more surrounding context to make it unique, or use replace_all to change every instance.
- Use the smallest old_string that's clearly unique — usually 2-4 adjacent lines. Avoid pasting 10+ lines of context when less identifies the target uniquely.
- Use replace_all to rename a variable or string throughout the file.
- Only use emojis if the user explicitly requests it; avoid adding emojis to files unless asked.`;
}

export function getMultiEditDescription(): string {
  return `Applies multiple exact string replacements to a SINGLE file in one atomic call.

Usage:
- Prefer this over multiple ${EDIT_TOOL_NAME} calls when making several changes to the same file.
- You must have used ${READ_TOOL_NAME} on the file at least once before editing it.
- The edits are applied in order; each operates on the result of the previous one.
- It is atomic: if ANY edit fails (old_string not found, or not unique without replace_all), NO change is written.
- Each edit follows the same rules as ${EDIT_TOOL_NAME}: a unique old_string (unless replace_all), exact indentation, and never include the line-number prefix.`;
}

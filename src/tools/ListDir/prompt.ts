import { GLOB_TOOL_NAME, READ_TOOL_NAME } from "../toolNames";

export function getListDirDescription(): string {
  return `Lists the contents of a directory (non-recursive), like ls. Directories end with "/".

Usage:
- Use this to inspect a folder instead of running \`ls\`/\`Get-ChildItem\` via Bash.
- For recursive name matching use ${GLOB_TOOL_NAME}; to read a file's contents use ${READ_TOOL_NAME}.`;
}

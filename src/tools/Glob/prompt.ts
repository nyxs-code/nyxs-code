import { AGENT_TOOL_NAME } from "../toolNames";

export function getGlobDescription(): string {
  return `- Fast file pattern matching tool that works with any codebase size.
- Supports glob patterns like "**/*.js" or "src/**/*.ts".
- Returns matching file paths sorted by modification time.
- Pass the optional path parameter to scope the search to a subdirectory (faster on large repos); the pattern is then matched relative to it.
- Use this tool when you need to find files by name patterns (NOT \`find\` or \`Get-ChildItem -Recurse\` via Bash).
- When doing an open-ended search that may require multiple rounds of globbing and grepping, use the ${AGENT_TOOL_NAME} tool instead.`;
}

import { AGENT_TOOL_NAME, BASH_TOOL_NAME, GREP_TOOL_NAME } from "../toolNames";

export function getGrepDescription(): string {
  return `A fast content search tool.

Usage:
- ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\`, \`rg\` or \`Select-String\` as a ${BASH_TOOL_NAME} command — the ${GREP_TOOL_NAME} tool is optimized for correct permissions and access.
- Regex engine is Rust \`regex\`: supports the common syntax (e.g. "log.*Error", "function\\s+\\w+", "\\bword\\b") but NOT lookahead/lookbehind or backreferences. Matching is line-by-line unless multiline is set.
- Filter files with the glob parameter (e.g. "*.ts", "**/*.tsx"). Literal regex metacharacters must be escaped (use \`interface\\{\\}\` to find \`interface{}\`).
- Output modes: "content" shows matching lines as file:line:text, "files_with_matches" shows only file paths (default), "count" shows how many files matched.
- In "content" mode, set context_lines (like grep -C) to also see N lines around each match — context lines show as file-line-text. Use head_limit to cap how many matches/files come back (default 500; a notice is appended if reached).
- For patterns that span multiple lines (e.g. \`struct \\w+ \\{[\\s\\S]*?field\`), set multiline: true so \`.\` crosses newlines and the search runs over the whole file.
- Use the ${AGENT_TOOL_NAME} tool for open-ended searches that require multiple rounds.`;
}

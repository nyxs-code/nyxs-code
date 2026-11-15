import { RETRIEVE_CONTEXT_TOOL_NAME } from "../toolNames";

export function getRetrieveContextDescription(): string {
  return `${RETRIEVE_CONTEXT_TOOL_NAME} — Semantic search over the current codebase.

Use this BEFORE blindly reading files when you need to find where something is implemented, used, or defined and you don't already know the exact path. It returns the most relevant code fragments (path, line range, snippet) ranked by semantic similarity to your query — not just literal keyword matches like Grep.

When to use:
- "Where is authentication handled?" / "How are settings loaded?" — conceptual questions.
- Locating the right files in a large repo before diving in with Read.
- Complementary to Grep: Grep finds exact strings; this finds semantically related code.

When NOT to use:
- You already know the file path → just Read it.
- You need every exact occurrence of a literal token → use Grep.

Input: a natural-language \`query\` and optional \`topK\` (default from settings). Returns ranked fragments; follow up with Read on the most promising paths.`;
}

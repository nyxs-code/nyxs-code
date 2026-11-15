import { LSP_TOOL_NAME } from "../toolNames";

export function getLspDescription(): string {
  return `${LSP_TOOL_NAME} — Semantic code intelligence backed by a real Language Server (typescript-language-server, rust-analyzer, pyright, and more).

Gives you the SAME understanding an IDE has: real type-aware diagnostics, go-to-definition, find-references, hover docs and document symbols — not text guessing. Supported languages: TypeScript/JavaScript (.ts/.tsx/.js/.jsx), Rust (.rs), Python (.py), JSON (.json), HTML (.html), CSS/SCSS/LESS (.css/.scss/.less), YAML (.yaml/.yml), Bash (.sh).

Provide \`action\` plus a \`file_path\` (relative to the workspace or absolute). Positions are 1-based (\`line\`, \`character\`), the same line numbers Read shows; positions in the results are 1-based too.

Actions:
- "diagnostics": real errors/warnings for \`file_path\`. Use to verify a file is clean after edits, or to understand a reported error precisely. (Edits already auto-attach diagnostics; use this for an on-demand check.)
- "hover": type/signature/docs at (\`line\`, \`character\`). Use to learn a symbol's type or a function's signature before calling it.
- "definition": jump to where the symbol at (\`line\`, \`character\`) is defined. Use to find the source of an imported/used symbol instead of grepping.
- "references": every place the symbol at (\`line\`, \`character\`) is used. Set \`includeDeclaration\` to also include the definition. Use before renaming/refactoring to gauge blast radius.
- "symbols": the outline (functions, classes, methods) of \`file_path\`. Use to map a file's structure quickly.

When to use vs alternatives:
- Prefer this over Grep when you need semantic truth (the actual definition, the real type, all true references) rather than textual matches.
- Use Grep for literal strings or non-code files.

Notes:
- The first call for a language starts its server; rust-analyzer may take time to index — empty results right after opening a large Rust project can mean "still indexing", not "nothing found".
- If the language server isn't installed (and auto-install is off), this returns a clear error; fall back to Grep/Read.`;
}

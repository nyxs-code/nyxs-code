import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { relativeTo, isDependencyResolutionNoise, isJsxEnvironmentNoise } from "@/lib/diagnostics";
import { lspConfig, extToLanguage, ensureServerForFile, syncFile, lspDiagnosticsWait, lspHover, lspDefinition, lspReferences, lspDocumentSymbols, pathToUri, pickForFile, formatDiagnostic } from "@/lib/lsp";
import { formatLspResult } from "@/tools/Lsp/format";
import { toOneBasedPositions } from "@/tools/Lsp/positions";
import { getLspDescription } from "@/tools/Lsp/prompt";
import type { ToolContext } from "@/tools/context";
import { truncateForTool } from "@/tools/limits";
import * as Names from "@/tools/toolNames";

export function addLspTools(tools: ToolSet, ctx: ToolContext): void {
  const { workspace, resolve } = ctx;
  tools.Lsp = tool({
    description: getLspDescription(),
    inputSchema: z.object({
      action: z
        .enum(["diagnostics", "hover", "definition", "references", "symbols"])
        .describe("Which language-server query to run."),
      file_path: z.string().describe("File to query (relative to workspace or absolute)."),
      line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based line, as shown by Read (required for hover/definition/references)."),
      character: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based column of the symbol on that line (required for hover/definition/references)."),
      includeDeclaration: z
        .boolean()
        .optional()
        .describe("references only: also include the declaration (default false)."),
    }),
    execute: async ({ action, file_path, line, character, includeDeclaration }) => {
      try {
        const abs = resolve(file_path);
        const language = extToLanguage(abs);
        if (!language) {
          return `${Names.LSP_TOOL_NAME}: unsupported file type for "${file_path}". Supported: TypeScript/JavaScript, Rust, Python. Use Grep/Read instead.`;
        }
        const ready = await ensureServerForFile(workspace, abs);
        if (!ready) {
          return `${Names.LSP_TOOL_NAME}: no usable language server for ${language} (not installed, still starting, or crashed). Fall back to Grep/Read.`;
        }
        await syncFile(workspace, language, abs);
        const uri = pathToUri(abs);

        const needsPos = action === "hover" || action === "definition" || action === "references";
        if (needsPos && (line === undefined || character === undefined)) {
          return `${Names.LSP_TOOL_NAME}: action "${action}" requires both \`line\` and \`character\` (1-based).`;
        }

        let result: unknown;
        switch (action) {
          case "diagnostics": {
            const map = await lspDiagnosticsWait(workspace, language, lspConfig().diagnosticsWaitMs);
            const display = relativeTo(workspace, abs) ?? abs;
            const found = pickForFile(map, abs).filter(
              (d) => !isDependencyResolutionNoise(d.message) && !isJsxEnvironmentNoise(d.message),
            );
            if (found.length === 0) return `${Names.LSP_TOOL_NAME} diagnostics: no errors or warnings in ${file_path}.`;
            return truncateForTool(
              Names.LSP_TOOL_NAME,
              `${found.length} diagnostic(s):\n${found.map((d) => formatDiagnostic(display, d)).join("\n")}`,
            );
          }
          case "hover":
            result = await lspHover(workspace, language, uri, line! - 1, character! - 1);
            break;
          case "definition":
            result = await lspDefinition(workspace, language, uri, line! - 1, character! - 1);
            break;
          case "references":
            result = await lspReferences(
              workspace,
              language,
              uri,
              line! - 1,
              character! - 1,
              includeDeclaration ?? false,
            );
            break;
          case "symbols":
            result = await lspDocumentSymbols(workspace, language, uri);
            break;
        }

        if (result === null || result === undefined || (Array.isArray(result) && result.length === 0)) {
          return `${Names.LSP_TOOL_NAME} ${action}: no result for ${file_path}${needsPos ? `:${line}:${character}` : ""}.`;
        }
        const out =
          formatLspResult(action, result, workspace) ??
          `${Names.LSP_TOOL_NAME} ${action} — ${file_path}\n${JSON.stringify(toOneBasedPositions(result), null, 2)}`;
        return truncateForTool(Names.LSP_TOOL_NAME, out);
      } catch (e) {
        return `${Names.LSP_TOOL_NAME} failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
}

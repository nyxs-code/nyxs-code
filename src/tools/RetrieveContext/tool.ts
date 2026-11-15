import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { ragQuery, ragStats } from "@/lib/rag";
import { getRetrieveContextDescription } from "@/tools/RetrieveContext/prompt";
import type { ToolContext } from "@/tools/context";
import { truncateForTool } from "@/tools/limits";
import * as Names from "@/tools/toolNames";

export function addRetrieveContextTools(tools: ToolSet, ctx: ToolContext): void {
  const { workspace } = ctx;
  tools.retrieve_context = tool({
    description: getRetrieveContextDescription(),
    inputSchema: z.object({
      query: z.string().describe("Natural-language description of what you're looking for."),
      topK: z.number().int().min(1).max(50).optional().describe("How many fragments to return (default from settings)."),
    }),
    execute: async ({ query, topK }) => {
      try {
        const stats = await ragStats(workspace);
        if (stats.chunks === 0) {
          return `The semantic index isn't ready yet for this workspace (it builds automatically in the background). Use Grep or Glob to search the code meanwhile.`;
        }
        const hits = await ragQuery(workspace, query, topK);
        if (hits.length === 0) {
          return `No relevant fragments found for: "${query}". The index may be empty or the codebase may not cover this. Try Grep or Glob instead.`;
        }
        const out = hits
          .map(
            (h, i) =>
              `## ${i + 1}. ${h.path}:${h.startLine}-${h.endLine}  (score ${h.score.toFixed(3)})\n${h.snippet}`,
          )
          .join("\n\n");
        return truncateForTool(Names.RETRIEVE_CONTEXT_TOOL_NAME, out);
      } catch (e) {
        return `retrieve_context failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
}

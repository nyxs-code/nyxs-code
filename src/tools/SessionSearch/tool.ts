import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/tools/context";
import { truncateForTool } from "@/tools/limits";

export const SESSION_SEARCH_TOOL_NAME = "SessionSearch";

export function addSessionSearchTools(tools: ToolSet, ctx: ToolContext): void {
  const { recall } = ctx;
  if (!recall) return;
  tools[SESSION_SEARCH_TOOL_NAME] = tool({
    description: `Search the full history of this conversation, including the parts that were summarized to save context. Use it when the summary mentions something (a file, an error, a decision, a command and its output) and you need the exact details instead of guessing. Returns matching excerpts with their message numbers.`,
    inputSchema: z.object({
      query: z.string().describe("Exact text to look for (file name, error message, function, command) or a few keywords."),
      max_results: z.number().int().min(1).max(20).optional().describe("Maximum excerpts to return (default 8)."),
    }),
    execute: async ({ query, max_results }) => truncateForTool(SESSION_SEARCH_TOOL_NAME, await recall(query, max_results ?? 8)),
  });
}

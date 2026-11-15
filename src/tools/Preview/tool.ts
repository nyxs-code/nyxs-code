import { tool } from "ai";
import { z } from "zod";
import { getPreviewDescription } from "@/tools/Preview/prompt";

export function createPreviewTool() {
  return tool({
    description: getPreviewDescription(),
    inputSchema: z.object({
      path: z.string().optional().describe("HTML file to preview, relative to the workspace. Defaults to the project's index.html."),
    }),
    execute: async ({ path }) => `Opened preview in the built-in browser${path ? `: ${path}` : ""}.`,
  });
}

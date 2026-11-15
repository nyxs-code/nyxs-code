import { invoke } from "@/lib/ipc";
import { tool } from "ai";
import { z } from "zod";
import { getGlobDescription } from "@/tools/Glob/prompt";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";
import { truncateForTool } from "@/tools/limits";
import * as Names from "@/tools/toolNames";

export function createGlobTool(ctx: ToolContext) {
  const { workspace, scope, resolveRead, gate, gateRead, readDenied } = ctx;
  return tool({
    description: getGlobDescription(),
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern, e.g. "**/*.ts" or "src/**/*.tsx".'),
      path: z
        .string()
        .optional()
        .describe("Optional subdirectory to scope the search to (faster on big repos). The pattern is matched relative to it. Defaults to the whole workspace."),
    }),
    execute: async ({ pattern, path }) => {
      const abs = path ? resolveRead(path) : undefined;
      const denied = (await checkGate(gate, "Glob", { pattern, path })) ?? (path && abs ? await gateRead(path, abs, true) : null);
      if (denied) return denied;
      const found = await invoke<string[]>("agent_glob", {
        pattern,
        cwd: workspace,
        path: abs,
        scope,
      });
      const hits = found.filter((hit) => !readDenied(hit));
      if (hits.length === 0) return "No matches.";
      return truncateForTool(Names.GLOB_TOOL_NAME, hits.join("\n"));
    },
  });
}

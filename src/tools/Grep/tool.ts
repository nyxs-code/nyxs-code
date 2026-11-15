import { invoke } from "@/lib/ipc";
import { tool } from "ai";
import { z } from "zod";
import { getGrepDescription } from "@/tools/Grep/prompt";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";
import { withoutDeniedFiles } from "@/tools/Grep/filter";
import { truncateForTool } from "@/tools/limits";
import * as Names from "@/tools/toolNames";

export function createGrepTool(ctx: ToolContext) {
  const { workspace, scope, resolveRead, gate, gateRead, readDenied } = ctx;
  return tool({
    description: getGrepDescription(),
    inputSchema: z.object({
      pattern: z.string().describe("Regular expression to search for (Rust regex syntax: no lookahead/backreferences)."),
      glob: z.string().optional().describe('File filter, e.g. "*.ts" or "**/*.tsx".'),
      output_mode: z
        .enum(["content", "files_with_matches", "count"])
        .optional()
        .describe("Output mode (default files_with_matches)."),
      case_insensitive: z.boolean().optional().describe("Case-insensitive search."),
      context_lines: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe("In content mode, show N lines of context around each match (like grep -C). Default 0."),
      head_limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Cap the number of matches (content mode) or files (other modes). Default 500; a notice is added if hit."),
      multiline: z
        .boolean()
        .optional()
        .describe("Match across line boundaries (. spans newlines, ^/$ match per line). Use for patterns that cross lines, e.g. a multi-line function signature. Default false (line-by-line)."),
      path: z
        .string()
        .optional()
        .describe("File or directory to search in (absolute or relative to the workspace). Defaults to the whole workspace."),
    }),
    execute: async ({ pattern, glob, output_mode, case_insensitive, context_lines, head_limit, multiline, path }) => {
      const abs = path ? resolveRead(path) : undefined;
      const denied = (await checkGate(gate, "Grep", { pattern, path })) ?? (path && abs ? await gateRead(path, abs, true) : null);
      if (denied) return denied;
      const found = await invoke<string>("agent_grep", {
        pattern,
        cwd: abs ?? workspace,
        glob,
        outputMode: output_mode,
        caseInsensitive: case_insensitive,
        contextLines: context_lines,
        headLimit: head_limit,
        multiline,
        scope,
      });
      return truncateForTool(Names.GREP_TOOL_NAME, withoutDeniedFiles(found, output_mode, readDenied));
    },
  });
}

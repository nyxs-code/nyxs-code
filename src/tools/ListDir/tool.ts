import { invoke } from "@/lib/ipc";
import { tool } from "ai";
import { z } from "zod";
import { getListDirDescription } from "@/tools/ListDir/prompt";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";
import { truncateForTool } from "@/tools/limits";
import * as Names from "@/tools/toolNames";

export function createListDirTool(ctx: ToolContext) {
  const { scope, resolveRead, gate, pathInput, gateRead } = ctx;
  return tool({
    description: getListDirDescription(),
    inputSchema: z.object({
      path: z.string().describe("Path of the directory to list."),
    }),
    execute: async ({ path }) => {
      const abs = resolveRead(path);
      const denied = (await checkGate(gate, "ListDir", { ...pathInput(path, abs, true), path })) ?? (await gateRead(path, abs, true));
      if (denied) return denied;
      const entries = await invoke<string[]>("agent_list_dir", {
        path: abs,
        scope,
      });
      if (entries.length === 0) return "(empty directory)";
      return truncateForTool(Names.LIST_DIR_TOOL_NAME, entries.join("\n"));
    },
  });
}

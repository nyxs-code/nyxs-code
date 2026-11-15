import { invoke } from "@/lib/ipc";
import { tool } from "ai";
import { z } from "zod";
import { isProtectedConfigPath } from "@/lib/permissions";
import { getWriteDescription } from "@/tools/Write/prompt";
import { truncatedToolCalls, truncatedWriteMessage } from "@/tools/Write/truncated";
import type { ToolContext } from "@/tools/context";
import { withFileLock } from "@/tools/fileLock";
import { checkGate } from "@/tools/gate";

export function createWriteTool(ctx: ToolContext) {
  const { gate, scope, resolve, pathInput, trackEdit, guardStaleEdit, recordWrite, withDiagnostics } = ctx;
  return tool({
    description: getWriteDescription(),
    inputSchema: z.object({
      file_path: z.string().describe("Path of the file to write."),
      content: z.string().describe("Full contents of the file."),
    }),
    execute: async ({ file_path, content }, { toolCallId }) => {
      if (truncatedToolCalls.delete(toolCallId)) return truncatedWriteMessage(file_path);
      const resolved = resolve(file_path);
      const denied = await checkGate(gate, "Write", pathInput(file_path, resolved));
      if (denied) return denied;
      return withFileLock(resolved, async () => {
        const stale = await guardStaleEdit(resolved, "Write");
        if ("blocked" in stale) return stale.blocked;
        await trackEdit(resolved);
        const result = await invoke<string>("agent_write_file", {
          path: resolved,
          content,
          scope,
          allowConfig: Boolean(gate) && isProtectedConfigPath(resolved),
          expectedMtime: stale.expectedMtime,
        });
        await recordWrite(resolved, content.length);
        return await withDiagnostics(result, resolved);
      });
    },
  });
}

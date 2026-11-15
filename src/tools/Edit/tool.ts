import { invoke } from "@/lib/ipc";
import { tool } from "ai";
import { z } from "zod";
import { isProtectedConfigPath } from "@/lib/permissions";
import { getEditDescription, getMultiEditDescription } from "@/tools/Edit/prompt";
import { truncatedToolCalls, truncatedWriteMessage } from "@/tools/Write/truncated";
import type { ToolContext } from "@/tools/context";
import { withFileLock } from "@/tools/fileLock";
import { checkGate } from "@/tools/gate";

export function createEditTool(ctx: ToolContext) {
  const { gate, scope, resolve, pathInput, trackEdit, guardStaleEdit, recordWrite, withDiagnostics } = ctx;
  return tool({
    description: getEditDescription(),
    inputSchema: z.object({
      file_path: z.string().describe("Path of the file to edit."),
      old_string: z.string().describe("Exact text to replace."),
      new_string: z.string().describe("Replacement text (must differ from old_string)."),
      replace_all: z.boolean().optional().describe("Replace all occurrences (default false)."),
      expected_count: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Assert old_string appears exactly this many times; the edit fails (changing nothing) if it doesn't. Use with replace_all to safely replace a known number of occurrences."),
    }),
    execute: async ({ file_path, old_string, new_string, replace_all, expected_count }, { toolCallId }) => {
      if (truncatedToolCalls.delete(toolCallId)) return truncatedWriteMessage(file_path);
      const resolved = resolve(file_path);
      const denied = await checkGate(gate, "Edit", pathInput(file_path, resolved));
      if (denied) return denied;
      return withFileLock(resolved, async () => {
        const stale = await guardStaleEdit(resolved, "Edit");
        if ("blocked" in stale) return stale.blocked;
        await trackEdit(resolved);
        const result = await invoke<string>("agent_edit_file", {
          path: resolved,
          oldString: old_string,
          newString: new_string,
          replaceAll: replace_all,
          scope,
          expectedCount: expected_count,
          allowConfig: Boolean(gate) && isProtectedConfigPath(resolved),
          expectedMtime: stale.expectedMtime,
        });
        await recordWrite(resolved, new_string.length);
        return await withDiagnostics(result, resolved);
      });
    },
  });
}

export function createMultiEditTool(ctx: ToolContext) {
  const { gate, scope, resolve, pathInput, trackEdit, guardStaleEdit, recordWrite, withDiagnostics } = ctx;
  return tool({
    description: getMultiEditDescription(),
    inputSchema: z.object({
      file_path: z.string().describe("Path of the file to edit."),
      edits: z
        .array(
          z.object({
            old_string: z.string().describe("Exact text to replace."),
            new_string: z.string().describe("Replacement text."),
            replace_all: z.boolean().optional().describe("Replace all occurrences (default false)."),
          }),
        )
        .min(1)
        .describe("Ordered list of edits to apply."),
    }),
    execute: async ({ file_path, edits }, { toolCallId }) => {
      if (truncatedToolCalls.delete(toolCallId)) return truncatedWriteMessage(file_path);
      const resolved = resolve(file_path);
      const denied = await checkGate(gate, "MultiEdit", pathInput(file_path, resolved));
      if (denied) return denied;
      return withFileLock(resolved, async () => {
        const stale = await guardStaleEdit(resolved, "MultiEdit");
        if ("blocked" in stale) return stale.blocked;
        await trackEdit(resolved);
        const result = await invoke<string>("agent_multi_edit", {
          path: resolved,
          edits: edits.map((e) => ({ oldString: e.old_string, newString: e.new_string, replaceAll: e.replace_all })),
          scope,
          allowConfig: Boolean(gate) && isProtectedConfigPath(resolved),
          expectedMtime: stale.expectedMtime,
        });
        await recordWrite(resolved, 0);
        return await withDiagnostics(result, resolved);
      });
    },
  });
}

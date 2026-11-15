import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";

export function addRequestPermissionTools(tools: ToolSet, ctx: ToolContext): void {
  const { gate } = ctx;
  tools.RequestPermission = tool({
    description: `Ask the user to approve an action BEFORE you carry it out. Send only a short summary of what you intend to do — never the file contents or the full command.

When to use:
- BEFORE creating or modifying files, or running shell commands, when you are unsure whether you have permission. Calling this first avoids generating code the user may reject.
- Group related changes into ONE request (e.g. "create index.html + styles.css for a landing page") instead of asking per file.

Returns "granted" (proceed with exactly what you described) or "denied" (do NOT proceed; stop and ask the user how to continue). If it returns granted, go ahead and use Write/Edit/Bash without asking again for the same work.`,
    inputSchema: z.object({
      summary: z.string().describe("One-line summary of the action(s) you want to perform (no code, no full command)."),
    }),
    execute: async ({ summary }) => {
      const denied = await checkGate(gate, "RequestPermission", { summary });
      if (denied) {
        return "The user DENIED permission. Do not proceed with the action. Stop and ask the user how they would like to continue.";
      }
      return "Permission granted. Proceed with exactly the action(s) you described, using the appropriate tools — you do not need to ask again for this same work.";
    },
  });
}

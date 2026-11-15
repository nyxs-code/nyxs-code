import type { ToolSet } from "ai";
import { emitEvent } from "@/lib/events";

export async function checkGate(
  gate: PermissionGate | undefined,
  toolName: string,
  input: unknown,
): Promise<string | null> {
  if (!gate) return null;
  const allowed = await gate(toolName, input);
  if (allowed) return null;
  emitEvent({ type: "tool.denied", tool: toolName });
  return `Permission denied by the user for this ${toolName} action.`;
}

export function gateToolSet(tools: ToolSet, gate?: PermissionGate): ToolSet {
  if (!gate) return tools;
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const run = t.execute;
    out[name] = run
      ? {
          ...t,
          execute: async (input: unknown, options: Parameters<typeof run>[1]) => {
            const denied = await checkGate(gate, name, input);
            return denied ?? run(input, options);
          },
        }
      : t;
  }
  return out;
}

export type PermissionGate = (toolName: string, input: unknown) => Promise<boolean>;

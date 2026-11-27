import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";
import { sessionBridge } from "@/lib/sessionBridge";
import { sessionToolsFor } from "@/lib/sessionTools";

export const LIST_SESSIONS_TOOL = "ListSessions";
export const CREATE_SESSION_TOOL = "CreateSession";

/** The user's other sessions for the built-in models (see src/lib/sessionTools.ts), and a
 *  project's tools in its coordinator and threads (src/lib/projects/projectTools.ts). */
export function addSessionTools(tools: ToolSet, ctx: ToolContext): void {
  const { gate, sessionKey } = ctx;
  if (!sessionBridge()) return;
  const defs = sessionToolsFor(sessionKey);
  // The definitions name the other tools as MCP does; these models know them in PascalCase.
  const names = defs.map((d) => [new RegExp(`\\b${d.mcpName}\\b`, "g"), d.name] as const);
  const local = (text: string) => names.reduce((t, [re, name]) => t.replace(re, name), text);
  for (const def of defs) {
    tools[def.name] = tool({
      description: local(def.description),
      inputSchema: jsonSchema<Record<string, unknown>>(JSON.parse(local(JSON.stringify(def.inputSchema))) as JSONSchema7),
      execute: (input) => def.run(input ?? {}, { chat: sessionKey, gate: (name, i) => checkGate(gate, name, i) }),
    });
  }
}

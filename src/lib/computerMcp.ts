import { z } from "zod";
import { antigravityTurnFor } from "@/lib/chatMcp";
import { chatInPlanMode } from "@/lib/video/videoControl";
import { COMPUTER_LOOK_ACTIONS, COMPUTER_MCP_SERVER, COMPUTER_MCP_TOOL } from "@/tools/Computer/actions";
import { getComputerDescription } from "@/tools/Computer/prompt";
import { computerInputSchema, computerPlanModeMessage, runComputer } from "@/tools/Computer/tool";

// The Computer tool as an MCP server Nyxs hosts, so the CLI agents (Claude Code, Codex, Grok,
// the ACP ones) drive the desktop with the same code, frame, Esc and lock as the built-in models.
// Their own permission prompts (answered through Nyxs) cover each call, except plan mode and
// headless Antigravity, which are checked here.

type Json = Record<string, unknown>;

const PROTOCOL_VERSION = "2025-06-18";

const INSTRUCTIONS =
  "This computer's desktop: read windows' controls, take screenshots and use the mouse and keyboard to work in desktop apps. " +
  "Use it only when a task needs a desktop app (not for files, commands or web pages). Prefer get_window_state and acting on controls by number over coordinates. " +
  "When the user asks you to use, control or look at an app or the screen, use this server instead of shell scripts that capture the screen or send keystrokes.";

let schema: Json | null = null;
const inputSchema = (): Json => (schema ??= z.toJSONSchema(computerInputSchema, { io: "input", unrepresentable: "any" }) as Json);

/** Answers one JSON-RPC message for the computer MCP server, from the agent of `chat`. */
export async function handleComputerMcp(message: Json, chat?: string): Promise<Json> {
  const { id, method } = message;
  const params = (message.params ?? {}) as Json;
  if (id === undefined || id === null) return { jsonrpc: "2.0", id: 0, result: {} };
  const reply = (result: Json): Json => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: COMPUTER_MCP_SERVER, version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: [
          {
            name: COMPUTER_MCP_TOOL,
            description: getComputerDescription("your shell tool"),
            inputSchema: inputSchema(),
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
          },
        ],
      });
    case "tools/call": {
      if (params.name !== COMPUTER_MCP_TOOL) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } };
      }
      const parsed = computerInputSchema.safeParse(params.arguments ?? {});
      if (!parsed.success) {
        return reply({ content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true });
      }
      const refuse = (text: string) => reply({ content: [{ type: "text", text }], isError: true });
      const agy = antigravityTurnFor(params);
      const asking = chat ?? agy?.chatKey;
      const looks = COMPUTER_LOOK_ACTIONS.has(parsed.data.action);
      // Not every CLI's plan mode reaches its MCP tools, so it is checked here as well.
      if (!looks && chatInPlanMode(asking)) return refuse(computerPlanModeMessage(parsed.data.action));
      // Headless Antigravity is let through to every call (it can't ask), so the chat's own
      // permission mode decides here, as for the browser.
      if (agy?.gate && !(await agy.gate(`mcp__${COMPUTER_MCP_SERVER}__${COMPUTER_MCP_TOOL}`, parsed.data))) {
        return refuse(`Permission denied by the user for this ${parsed.data.action} action.`);
      }
      // The CLI agents' models all see images.
      const out = await runComputer(parsed.data, { allowImages: true, chat: asking });
      if (out.kind === "error") return reply({ content: [{ type: "text", text: out.message }], isError: true });
      if (out.kind === "text") return reply({ content: [{ type: "text", text: out.text }] });
      return reply({
        content: [
          { type: "text", text: out.text || "Screenshot:" },
          { type: "image", data: out.data, mimeType: out.mediaType },
        ],
      });
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(method)}` } };
  }
}


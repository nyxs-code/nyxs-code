import { z } from "zod";
import { MUSIC_DESCRIPTION, MUSIC_MCP_SERVER, MUSIC_MCP_TOOL, musicInputSchema, runMusic } from "@/tools/Music/tool";

// The Music tool as an MCP server Nyxs hosts, so the CLI agents (Claude Code, Codex, Grok, the
// ACP ones) play music in the same player as the built-in models.

type Json = Record<string, unknown>;

const PROTOCOL_VERSION = "2025-06-18";

const INSTRUCTIONS = "Nyxs' music player. When the user asks to play, pause or skip music, or to change its volume, use this server instead of the browser or the desktop.";

let schema: Json | null = null;
const inputSchema = (): Json => (schema ??= z.toJSONSchema(musicInputSchema, { io: "input", unrepresentable: "any" }) as Json);

/** Answers one JSON-RPC message for the music MCP server. */
export async function handleMusicMcp(message: Json): Promise<Json> {
  const { id, method } = message;
  const params = (message.params ?? {}) as Json;
  if (id === undefined || id === null) return { jsonrpc: "2.0", id: 0, result: {} };
  const reply = (result: Json): Json => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MUSIC_MCP_SERVER, version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: [
          {
            name: MUSIC_MCP_TOOL,
            description: MUSIC_DESCRIPTION,
            inputSchema: inputSchema(),
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
          },
        ],
      });
    case "tools/call": {
      if (params.name !== MUSIC_MCP_TOOL) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } };
      }
      const parsed = musicInputSchema.safeParse(params.arguments ?? {});
      if (!parsed.success) {
        return reply({ content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true });
      }
      const out = await runMusic(parsed.data);
      return reply({ content: [{ type: "text", text: out.text }], ...(out.ok ? {} : { isError: true }) });
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(method)}` } };
  }
}

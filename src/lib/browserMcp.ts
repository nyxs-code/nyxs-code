import { BROWSER_MCP_SERVER, BROWSER_TOOLS, type BrowserStepGate } from "@/lib/browserTools";
import { SESSION_TOOLS, SESSIONS_MCP_SERVER } from "@/lib/sessionTools";
import { antigravityTurnFor, CHAT_MCP_SERVER, handleChatMcp } from "@/lib/chatMcp";
import { handleComputerMcp } from "@/lib/computerMcp";
import { COMPUTER_MCP_SERVER } from "@/tools/Computer/actions";
import { chatInPlanMode } from "@/lib/video/videoControl";
import { VIDEO_MCP_SERVER, VIDEO_RULES, VIDEO_TOOLS, videoCallReadOnly } from "@/lib/videoTools";
import { handleMusicMcp } from "@/lib/musicMcp";
import { MUSIC_MCP_SERVER } from "@/tools/Music/tool";
import { connectorMcpHandler } from "@/lib/connectorsMcp";

// The built-in browser as an MCP server that Nyxs hosts itself, for Claude Code. The CLI is
// started with `--mcp-config {"mcpServers":{"nyxs-browser":{"type":"sdk",...}}}` and sends each
// JSON-RPC message to us in an `mcp_message` control request; the answer goes back the same way.

type Json = Record<string, unknown>;

const PROTOCOL_VERSION = "2025-06-18";

const INSTRUCTIONS =
  "Nyxs' built-in browser, the Preview panel the user sees next to the chat. Use it for websites and to check your work in the running app: " +
  "navigate to a site or to the dev server (start it first if needed; it returns what the page shows), snapshot or find to read the page, " +
  "click/fill/fill_form/press_key to use it (each reports what changed), upload to send files from this computer to a file field or drop area, batch to run several steps in one call, " +
  "console_logs for runtime errors and screenshot/zoom for visuals. Both local pages (localhost, HTML files) and websites can be read and driven.";

function reply(id: unknown, result: Json): Json {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: unknown, code: number, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Answers one JSON-RPC message for the browser MCP server, from the agent of `chat`. */
export async function handleBrowserMcp(message: Json, chat?: string): Promise<Json> {
  const { id, method } = message;
  const params = (message.params ?? {}) as Json;
  // Notifications ("notifications/initialized") get no answer of their own; the CLI only
  // needs the control request acknowledged.
  if (id === undefined || id === null) return { jsonrpc: "2.0", id: 0, result: {} };
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: BROWSER_MCP_SERVER, version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: BROWSER_TOOLS.map((def) => ({
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema,
          annotations: { readOnlyHint: def.readOnly },
        })),
      });
    case "tools/call": {
      const def = BROWSER_TOOLS.find((d) => d.name === params.name);
      if (!def) return failure(id, -32602, `Unknown tool: ${String(params.name)}`);
      const args = (params.arguments ?? {}) as Json;
      // Headless Antigravity is let through to every call (it can't ask), so the chat's own
      // permission mode decides here: reading the page goes, acting on it may ask.
      const agy = antigravityTurnFor(params);
      const agyGate = agy?.gate;
      const denial = (name: string) => `Permission denied by the user for this ${name} action.`;
      // A batch is asked for step by step, under each step's own name.
      if (agyGate && def.name !== "batch" && !(await agyGate(`mcp__${BROWSER_MCP_SERVER}__${def.name}`, args))) {
        return reply(id, { content: [{ type: "text", text: denial(def.name) }], isError: true });
      }
      const stepGate: BrowserStepGate | undefined = agyGate
        ? async (step, input) => ((await agyGate(`mcp__${BROWSER_MCP_SERVER}__${step.name}`, input)) ? null : denial(step.name))
        : undefined;
      try {
        const out = await def.run(args, chat ?? agy?.chatKey, stepGate);
        const content: Json[] = [{ type: "text", text: out.text }];
        if (out.image) content.push({ type: "image", data: out.image.data, mimeType: out.image.mediaType });
        return reply(id, { content });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${String(method)}`);
  }
}

const SESSIONS_INSTRUCTIONS =
  "The user's sessions in Nyxs: the other conversations listed in its Recents, each with its own agent. " +
  "When the user asks to create, start or open a new session (\"nueva sesión\", often typed \"sesion\" or \"secion\"), use create_session straight away: " +
  "it makes a real session the user sees nested under this one, unlike your own sub-agents, and its first reply comes back here as a message. " +
  "list_sessions, read_session, send_to_session, rename_session and archive_session act on the existing ones.";

/** Answers one JSON-RPC message for the sessions MCP server, from the agent of `chat`. */
export async function handleSessionsMcp(message: Json, chat?: string): Promise<Json> {
  const { id, method } = message;
  const params = (message.params ?? {}) as Json;
  if (id === undefined || id === null) return { jsonrpc: "2.0", id: 0, result: {} };
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SESSIONS_MCP_SERVER, version: "1.0.0" },
        instructions: SESSIONS_INSTRUCTIONS,
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: SESSION_TOOLS.map((def) => ({
          name: def.mcpName,
          description: def.description,
          inputSchema: def.inputSchema,
          annotations: { readOnlyHint: def.readOnly },
        })),
      });
    case "tools/call": {
      const def = SESSION_TOOLS.find((d) => d.mcpName === params.name);
      if (!def) return failure(id, -32602, `Unknown tool: ${String(params.name)}`);
      // The CLI asked the user already, through its own permission prompt.
      try {
        const text = await def.run((params.arguments ?? {}) as Json, { chat });
        return reply(id, { content: [{ type: "text", text }] });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${String(method)}`);
  }
}

const VIDEO_INSTRUCTIONS =
  "Nyxs' video editor, the Video view the user sees next to the chat, with its timeline, inspector and player. Use it to make and edit videos: " +
  "list_projects, open_project or create_project to start (the view opens by itself), snapshot or find to read the project, screenshot to SEE a frame, and the edit tools " +
  "(add_clip, update_clip, split_clips, track, keyframe, captions, remove_silences…), each of which reports what changed and is one step of the undo the user also has. " +
  "apply lays out a whole edit or changes many clips in one call and one undo step, and guide has the schema and how to make it look good. Render only when the user wants the file. " +
  VIDEO_RULES;

/** Answers one JSON-RPC message for the video MCP server, from the agent of `chat`. */
export async function handleVideoMcp(message: Json, chat?: string): Promise<Json> {
  const { id, method } = message;
  const params = (message.params ?? {}) as Json;
  if (id === undefined || id === null) return { jsonrpc: "2.0", id: 0, result: {} };
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: VIDEO_MCP_SERVER, version: "1.0.0" },
        instructions: VIDEO_INSTRUCTIONS,
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: VIDEO_TOOLS.map((def) => ({
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema,
          annotations: { readOnlyHint: def.readOnly },
        })),
      });
    case "tools/call": {
      const def = VIDEO_TOOLS.find((d) => d.name === params.name);
      if (!def) return failure(id, -32602, `Unknown tool: ${String(params.name)}`);
      const args = (params.arguments ?? {}) as Json;
      const refuse = (text: string) => reply(id, { content: [{ type: "text", text }], isError: true });
      const agy = antigravityTurnFor(params);
      const asking = chat ?? agy?.chatKey;
      const readOnly = videoCallReadOnly(def, args);
      // Not every CLI's plan mode reaches its MCP tools, so it is checked here as well.
      if (!readOnly && chatInPlanMode(asking)) return refuse(`${def.name} is blocked: plan mode is active, so nothing in the project may change yet. You can still read the project and look at frames.`);
      if (!readOnly && agy?.gate && !(await agy.gate(`mcp__${VIDEO_MCP_SERVER}__${def.name}`, args))) {
        return refuse(`Permission denied by the user for this ${def.name} action.`);
      }
      try {
        const out = await def.run(args, { chat: asking });
        const content: Json[] = [{ type: "text", text: out.text }];
        if (out.image) content.push({ type: "image", data: out.image.data, mimeType: out.image.mediaType });
        return reply(id, { content });
      } catch (e) {
        return refuse(e instanceof Error ? e.message : String(e));
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${String(method)}`);
  }
}

/** The MCP servers Nyxs hosts for an agent's chat. `chat` is the chat the agent runs in, so its
 *  tools act on that chat alone (unset for an agent with one config for every chat). */
export const HOSTED_MCP_SERVERS: Record<string, (message: Json, chat?: string) => Promise<Json>> = {
  [BROWSER_MCP_SERVER]: handleBrowserMcp,
  [SESSIONS_MCP_SERVER]: handleSessionsMcp,
  [CHAT_MCP_SERVER]: handleChatMcp,
  [COMPUTER_MCP_SERVER]: handleComputerMcp,
  [VIDEO_MCP_SERVER]: handleVideoMcp,
  [MUSIC_MCP_SERVER]: handleMusicMcp,
};

/** The handler of a hosted server: one of Nyxs' own, else one of the user's connectors. */
export function hostedMcpHandler(name: string): ((message: Json, chat?: string) => Promise<Json>) | undefined {
  return Object.hasOwn(HOSTED_MCP_SERVERS, name) ? HOSTED_MCP_SERVERS[name] : connectorMcpHandler(name);
}

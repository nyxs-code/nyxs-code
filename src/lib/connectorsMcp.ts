import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { AskUserFn } from "./agentTools";
import { CONNECTOR_CATALOG, isMcpServerConfigured, loadMcpServers, loadMergedMcpServers, loadMcpTools, mcpToolName, normalizeNameForMCP, parseMcpToolName, type McpContentOutput, type McpServer } from "./mcp";
import { askMcpApproval, isGoogleWorkspaceMcp, MCP_CALL, type McpApprovalAsk } from "./mcpElicitation";

/**
 * The user's connectors (Customize › Connectors: Gmail, Google Calendar…) for Claude Code. The
 * CLI only knows its own MCP servers and the claude.ai account's, so each connector is hosted by
 * Nyxs as one more `sdk` server named after it, as the built-in browser is: the CLI sees
 * `mcp__Gmail__search_threads` as the other models do, and every call goes through Nyxs' own
 * client, with its sign-in, Google's headers and the confirmations Google asks for.
 */

type Json = Record<string, unknown>;

const PROTOCOL_VERSION = "2025-06-18";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The connectors to host, by the server name the CLI gets. Names Nyxs uses for its own servers
 *  (`nyxs-…`) are left out, and of two connectors with the same name, the first. */
export function hostedConnectors(reserved: readonly string[] = []): Map<string, McpServer> {
  const out = new Map<string, McpServer>();
  for (const server of loadMcpServers()) {
    if (!server.enabled || !isMcpServerConfigured(server)) continue;
    const name = normalizeNameForMCP(server.name);
    if (!name || name.startsWith("nyxs-") || reserved.includes(name) || out.has(name)) continue;
    out.set(name, server);
  }
  return out;
}

/** The names Google Workspace connectors (Gmail, Calendar…) take in a chat's tool markers: the
 *  ones set up now and the catalog's, so a chat keeps counting after its connector is removed. */
function googleConnectorNames(): Set<string> {
  let servers: { name: string; url: string }[] = CONNECTOR_CATALOG;
  try {
    servers = [...servers, ...loadMergedMcpServers()];
  } catch {
    // Settings not read yet: the catalog's names still apply.
  }
  return new Set(servers.filter((s) => isGoogleWorkspaceMcp(s.url)).map((s) => normalizeNameForMCP(s.name)));
}

/**
 * Whether a chat called a Google Workspace connector. Google's user data policy (Limited Use)
 * lets that data go only where the user's request needs it, so features that send the chat to
 * Nyxs' own services (the next-message suggestion) leave such a chat out. The whole chat counts:
 * a later reply can repeat what an earlier tool read.
 */
export function chatUsedGoogleData(contents: string[]): boolean {
  const names = googleConnectorNames();
  if (!names.size) return false;
  const marker = /⟦SEP⟧([^⟦]*?) \(MCP\)⟦\/TOOL⟧/g;
  return contents.some((text) => [...text.matchAll(marker)].some((m) => names.has(m[1])));
}

/** Tells Claude Code which tools are the user's connectors: its claude.ai account may have a
 *  connector of the same name, which isn't the one the user connected in Nyxs. */
export function connectorsPrompt(names: string[]): string {
  const list = names.map((n) => `- ${n}: \`mcp__${n}__*\``).join("\n");
  return `# Connectors\nThe user connected these services in Nyxs. Use these tools for them, not a claude.ai connector of the same service:\n${list}`;
}

const asks = new Map<string, AskUserFn[]>();

/** Lends a running turn's question card to its chat's connectors, for the confirmations a server
 *  asks for (see mcpElicitation.ts); returns how to take it back. */
export function lendConnectorAsk(chat: string | undefined, askUser: AskUserFn | undefined): () => void {
  if (!chat || !askUser) return () => undefined;
  const list = asks.get(chat) ?? [];
  list.push(askUser);
  asks.set(chat, list);
  return () => {
    const i = list.indexOf(askUser);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) asks.delete(chat);
  };
}

function askFor(chat: string | undefined): McpApprovalAsk | undefined {
  const list = chat ? asks.get(chat) : undefined;
  return list?.length ? askMcpApproval(list[list.length - 1]) : undefined;
}

function reply(id: unknown, result: Json): Json {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: unknown, code: number, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function connectorTools(server: McpServer) {
  return loadMcpTools([server], { fetchImpl: (isTauri ? tauriFetch : fetch) as typeof fetch, toolImages: true });
}

function content(output: unknown): Json[] {
  if (typeof output === "string") return [{ type: "text", text: output }];
  const out = output as McpContentOutput;
  return [
    ...(out.text ? [{ type: "text", text: out.text }] : []),
    ...out.images.map((img) => ({ type: "image", data: img.data, mimeType: img.mediaType })),
  ];
}

/** The handler of the hosted server `name`, when it is one of the user's connectors. */
export function connectorMcpHandler(name: string): ((message: Json, chat?: string) => Promise<Json>) | undefined {
  if (!hostedConnectors().has(name)) return undefined;
  return (message, chat) => handleConnectorMcp(name, message, chat);
}

/** Answers one JSON-RPC message for the connector hosted as `name`, from the agent of `chat`. */
export async function handleConnectorMcp(name: string, message: Json, chat?: string): Promise<Json> {
  const { id, method } = message;
  const params = (message.params ?? {}) as Json;
  if (id === undefined || id === null) return { jsonrpc: "2.0", id: 0, result: {} };
  // Read again on every message: a connector turned off or removed stops answering at once.
  const server = hostedConnectors().get(name);
  if (!server) return failure(id, -32601, `The ${name} connector is no longer connected in Nyxs.`);
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name, version: "1.0.0" },
        instructions: `The user's ${server.name} connector, connected in Nyxs. Use its tools for anything about ${server.name}.`,
      });
    case "ping":
      return reply(id, {});
    case "tools/list": {
      const { tools, errors } = await connectorTools(server);
      if (errors.length && !Object.keys(tools).length) return failure(id, -32603, errors.join("\n"));
      return reply(id, {
        tools: Object.entries(tools).map(([key, def]) => {
          const d = def as { description?: string; inputSchema?: { jsonSchema?: unknown } };
          return {
            name: parseMcpToolName(key)?.tool ?? key,
            description: d.description ?? "",
            inputSchema: d.inputSchema?.jsonSchema ?? { type: "object", properties: {} },
          };
        }),
      });
    }
    case "tools/call": {
      const { tools } = await connectorTools(server);
      const tool = tools[mcpToolName(server.name, String(params.name))] as { [MCP_CALL]?: (args: unknown, ask?: McpApprovalAsk) => Promise<unknown> } | undefined;
      const call = tool?.[MCP_CALL];
      if (!call) return failure(id, -32602, `Unknown tool: ${String(params.name)}`);
      // The CLI asked for permission already, through its own prompt.
      try {
        return reply(id, { content: content(await call(params.arguments ?? {}, askFor(chat))) });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${String(method)}`);
  }
}

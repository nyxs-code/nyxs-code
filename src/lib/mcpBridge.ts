import { invoke } from "@/lib/ipc";
import { listen } from "@tauri-apps/api/event";
import { HOSTED_MCP_SERVERS } from "./browserMcp";
import { BROWSER_MCP_SERVER } from "./browserTools";
import { SESSIONS_MCP_SERVER } from "./sessionTools";
import { CHAT_MCP_SERVER } from "./chatMcp";
import { getMergedSnapshot } from "./settingsRuntime";
import { computerUseEnabled, musicToolEnabled } from "./featureSettings";
import { COMPUTER_MCP_SERVER } from "@/tools/Computer/actions";
import { VIDEO_MCP_SERVER } from "./videoTools";
import { MUSIC_MCP_SERVER } from "@/tools/Music/tool";

/**
 * The MCP servers Nyxs hosts in this page (the built-in browser), published over HTTP on
 * 127.0.0.1 by the Rust side (`agent/mcp_bridge.rs`) for agents that take MCP servers only by
 * address: Grok CLI gets them in each session, Antigravity CLI through a stdio proxy named in
 * its own config. Each request
 * comes here as a `hosted-mcp-request` event and is answered with `hosted_mcp_reply`.
 */

type Json = Record<string, unknown>;

export interface McpBridgeInfo {
  port: number;
  token: string;
}

let started: Promise<McpBridgeInfo> | null = null;
let listening = false;

/** This page's side of the bridge. Always on: a request nobody hears would wait an hour. */
export function listenForRequests(): void {
  if (listening) return;
  listening = true;
  void listen<{ id: number; server: string; message: string }>("hosted-mcp-request", async ({ payload }) => {
    let response: Json;
    let id: unknown = null;
    try {
      const message = JSON.parse(payload.message) as Json;
      id = message.id ?? null;
      // `/mcp/<server>/<chat>`: the chat whose agent is asking (see bridgeUrl).
      const [server, chat] = splitServer(payload.server);
      const handler = HOSTED_MCP_SERVERS[server];
      response = handler
        ? await handler(message, chat)
        : { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown MCP server: ${payload.server}` } };
    } catch (err) {
      response = { jsonrpc: "2.0", id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
    }
    await invoke("hosted_mcp_reply", { id: payload.id, response: JSON.stringify(response) }).catch(() => undefined);
  }).catch(() => {
    listening = false;
  });
}

/** Starts the bridge (once) and this page's side of it. Called when the app starts, so a
 *  request from a CLI finds the page listening even right after a reload. */
export function startMcpBridge(): Promise<McpBridgeInfo> {
  listenForRequests();
  started ??= invoke<McpBridgeInfo>("mcp_bridge_start").catch((err: unknown) => {
    started = null;
    throw err;
  });
  return started;
}

/** A server's address for the agent of `chat`, so its tools act on that chat alone (its own
 *  browser). Without one (an `agy` started outside Nyxs) the conversation a call names tells
 *  the chat (see antigravityTurnFor), else they act on the chat on screen. */
export function bridgeUrl(info: McpBridgeInfo, server: string, chat?: string): string {
  const base = `http://127.0.0.1:${info.port}/mcp/${server}`;
  return chat ? `${base}/${encodeURIComponent(chat)}` : base;
}

function splitServer(path: string): [string, string | undefined] {
  const slash = path.indexOf("/");
  if (slash < 0) return [path, undefined];
  let chat: string | undefined;
  try {
    chat = decodeURIComponent(path.slice(slash + 1)) || undefined;
  } catch {
    chat = undefined;
  }
  return [path.slice(0, slash), chat];
}

/** The hosted servers a CLI turn should get: the built-in browser when the chat has a folder
 *  and the browser setting allows it, as for Claude Code. */
export function hostedServersFor(workspace: string | null | undefined, chat?: string): string[] {
  const allowPreview = (getMergedSnapshot() as { allowPreview?: boolean }).allowPreview !== false;
  // Music needs no folder: a chat without one can ask for a song too.
  const music = musicToolEnabled() ? [MUSIC_MCP_SERVER] : [];
  if (!workspace) return music;
  // The sessions tools act for one chat, so an agent that can't say which one doesn't get them.
  return [
    ...(allowPreview ? [BROWSER_MCP_SERVER] : []),
    ...(chat ? [SESSIONS_MCP_SERVER] : []),
    ...(computerUseEnabled() ? [COMPUTER_MCP_SERVER] : []),
    ...((getMergedSnapshot() as { allowVideoTools?: boolean }).allowVideoTools !== false ? [VIDEO_MCP_SERVER] : []),
    ...music,
  ];
}

/** The hosted servers as ACP `mcpServers` entries (HTTP, with the bridge's token). `chatTools`:
 *  also Nyxs' questions and plan review (see chatMcp.ts), for a chat with or without a folder. */
export async function acpMcpServers(workspace: string | null | undefined, chat?: string, opts: { chatTools?: boolean } = {}): Promise<Json[]> {
  const names = [...hostedServersFor(workspace, chat), ...(opts.chatTools && chat ? [CHAT_MCP_SERVER] : [])];
  if (!names.length) return [];
  const info = await startMcpBridge().catch(() => null);
  if (!info) return [];
  return names.map((name) => ({
    type: "http",
    name,
    url: bridgeUrl(info, name, chat),
    headers: [{ name: "Authorization", value: `Bearer ${info.token}` }],
  }));
}

// The browser keeps its original key, so an existing registration is still known after updating.
const AGY_REGISTRATION_KEYS: Record<string, string> = {
  [BROWSER_MCP_SERVER]: "nyxs.antigravityMcp.v1",
  [CHAT_MCP_SERVER]: "nyxs.antigravityMcp.chat.v1",
  [VIDEO_MCP_SERVER]: "nyxs.antigravityMcp.video.v1",
};

function savedRegistration(server: string): string {
  try {
    return localStorage.getItem(AGY_REGISTRATION_KEYS[server]) ?? "";
  } catch {
    return "";
  }
}

function saveRegistration(server: string, value: string): void {
  try {
    if (value) localStorage.setItem(AGY_REGISTRATION_KEYS[server], value);
    else localStorage.removeItem(AGY_REGISTRATION_KEYS[server]);
  } catch {
    /* storage unavailable: it is registered again next time, which is harmless */
  }
}

async function syncAntigravityServer(server: string, enabled: boolean): Promise<void> {
  if (!enabled) {
    if (!savedRegistration(server)) return;
    await invoke("agent_cli_register_mcp", { cli: "antigravity", name: server, remove: true });
    saveRegistration(server, "");
    return;
  }
  // The proxy it runs reaches the bridge, so the bridge must be up for the turn.
  await startMcpBridge();
  await invoke("agent_cli_register_mcp", { cli: "antigravity", name: server, remove: false });
  saveRegistration(server, "stdio");
}

/**
 * Keeps Nyxs' servers in Antigravity CLI's own MCP config, which is the only place it reads MCP
 * servers from: the built-in browser (while the browser setting allows it) and the chat tools
 * (questions, plan review), added while Antigravity is connected and removed when they're
 * turned off. Each entry runs Nyxs' executable as a stdio proxy (`--nyxs-mcp-proxy`, see
 * `agent/mcp_bridge.rs`), which the run's environment points at this Nyxs and chat
 * (antigravityMcpEnv). The config is global and another Nyxs (an installed one next to a dev
 * build) may name its own executable there: it is checked before every turn, and `agy mcp`
 * only runs when it differs. Resolves to the servers that are in place.
 */
export async function syncAntigravityMcp(o: { browser: boolean; chatTools: boolean; video: boolean }): Promise<{ browser: boolean; chatTools: boolean; video: boolean }> {
  const [browser, chatTools, video] = await Promise.all([
    syncAntigravityServer(BROWSER_MCP_SERVER, o.browser).then(() => o.browser, () => false),
    syncAntigravityServer(CHAT_MCP_SERVER, o.chatTools).then(() => o.chatTools, () => false),
    syncAntigravityServer(VIDEO_MCP_SERVER, o.video).then(() => o.video, () => false),
  ]);
  return { browser, chatTools, video };
}

/** The environment of an Antigravity run, read by the proxy its MCP entries run: which bridge
 *  (this Nyxs' port and token, whatever another Nyxs open alongside got) and which chat. */
export async function antigravityMcpEnv(chat?: string): Promise<Record<string, string>> {
  const info = await startMcpBridge().catch(() => null);
  if (!info) return {};
  return { NYXS_MCP_PORT: String(info.port), NYXS_MCP_TOKEN: info.token, ...(chat ? { NYXS_MCP_CHAT: chat } : {}) };
}

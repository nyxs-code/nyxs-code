import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { invoke } from "@/lib/ipc";
import { accountKey } from "@/lib/accountScope";
import { SOURCE_PRECEDENCE, getPerSourceSnapshot, settingsSnapshotFor } from "@/lib/settingsRuntime";
import { getCachedPluginComponents } from "@/lib/plugins/pluginLoader";
import { connectorAccessToken, renewConnectorToken } from "@/lib/connectorTokens";
import { getSecret, setSecret } from "@/lib/secureStore";

export type McpTransportKind = "http" | "stdio";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  transport?: McpTransportKind;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  oauthClientId?: string;
  oauthClientSecret?: string;
  /** Signed in with OAuth: its tokens are in the keychain (connectorTokens), not in `headers`. */
  oauth?: boolean;
  enabled: boolean;
  source?: string;
}

export interface ConnectorCatalogEntry {
  name: string;
  url: string;
  description: string;
  auth: "none" | "token" | "oauth";
  logo?: string;
  color?: string;
  developer?: string;
  developerUrl?: string;
  docsUrl?: string;
  longDescription?: string;
  category?: string;
  type?: "interactive" | "desktop" | "web";
  popularity?: number;
  trending?: boolean;
  addedAt?: string;
  oauthScopes?: string[];
  oauthManualClient?: boolean;
  oauthClientId?: string;
  oauthClientSecret?: string;
}

const GOOGLE_OAUTH = {
  clientId: "", // ← pega aquí tu Client ID (…apps.googleusercontent.com)
  clientSecret: "", // ← pega aquí tu Client Secret
};

const OAUTH_CLIENTS_KEY = "optimicer.oauthClients.v1";

/** A manual OAuth client's secret is kept in the keychain; its id stays in localStorage. */
const clientSecretAccount = (name: string) => accountKey(`mcp-oauth-client:${name}`);

function loadOAuthClients(): Record<string, { clientId?: string; clientSecret?: string }> {
  try {
    const map = JSON.parse(localStorage.getItem(accountKey(OAUTH_CLIENTS_KEY)) || "{}");
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

function saveOAuthClients(map: Record<string, { clientId?: string; clientSecret?: string }>): void {
  try {
    localStorage.setItem(accountKey(OAUTH_CLIENTS_KEY), JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}

export function getOAuthClient(name: string): { clientId: string } {
  return { clientId: loadOAuthClients()[name]?.clientId || "" };
}

/** The secret of a manual OAuth client. One an earlier version left in localStorage moves to
 *  the keychain on the way. */
export async function getOAuthClientSecret(name: string): Promise<string> {
  const map = loadOAuthClients();
  const legacy = map[name]?.clientSecret;
  if (legacy) {
    await setSecret(clientSecretAccount(name), legacy);
    delete map[name].clientSecret;
    saveOAuthClients(map);
    return legacy;
  }
  return (await getSecret(clientSecretAccount(name))) ?? "";
}

export function setOAuthClient(name: string, v: { clientId: string; clientSecret: string }): void {
  const map = loadOAuthClients();
  map[name] = { clientId: v.clientId };
  saveOAuthClients(map);
  void setSecret(clientSecretAccount(name), v.clientSecret);
}

const CN_ICON = "/connector-icons";

export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
  { name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp", description: "Search and read documentation for any public GitHub repository.", auth: "none", color: "#6b7280", developer: "DeepWiki", developerUrl: "https://deepwiki.com", longDescription: "Connect DeepWiki to search and read the documentation of any public GitHub repository. Useful for quickly understanding unfamiliar codebases, APIs and libraries without leaving the chat.", category: "Código", type: "web", popularity: 60, addedAt: "2024-11-01" },
  { name: "Cloudflare-Docs", url: "https://docs.mcp.cloudflare.com/mcp", description: "Search the Cloudflare developer documentation.", auth: "none", logo: `${CN_ICON}/cloudflare.svg`, color: "#f38020", developer: "Cloudflare", developerUrl: "https://developers.cloudflare.com", docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/", category: "Código", type: "web", popularity: 50, addedAt: "2024-12-01" },
  { name: "Hugging Face", url: "https://huggingface.co/mcp", description: "Explore models, datasets and Spaces on Hugging Face.", auth: "token", logo: `${CN_ICON}/huggingface.svg`, color: "#ff9d00", developer: "Hugging Face", developerUrl: "https://huggingface.co", docsUrl: "https://huggingface.co/settings/mcp", category: "Datos", type: "web", popularity: 70, trending: true, addedAt: "2025-01-15" },
  { name: "GitHub", url: "https://api.githubcopilot.com/mcp/", description: "Repos, issues, pull requests and code search on GitHub.", auth: "oauth", logo: `${CN_ICON}/github.svg`, color: "#e5e5e5", developer: "GitHub", developerUrl: "https://github.com", docsUrl: "https://docs.github.com", category: "Código", type: "web", popularity: 100, trending: true, addedAt: "2024-10-01" },
  { name: "Linear", url: "https://mcp.linear.app/mcp", description: "Create and search issues, projects and cycles in Linear.", auth: "oauth", logo: `${CN_ICON}/linear.svg`, color: "#5e6ad2", developer: "Linear", developerUrl: "https://linear.app", docsUrl: "https://linear.app/docs", category: "Productividad", type: "web", popularity: 80, addedAt: "2025-02-01" },
  { name: "Notion", url: "https://mcp.notion.com/mcp", description: "Search, read and update pages in your Notion workspace.", auth: "oauth", logo: `${CN_ICON}/notion.svg`, color: "#e5e5e5", developer: "Notion", developerUrl: "https://notion.so", docsUrl: "https://developers.notion.com", category: "Productividad", type: "web", popularity: 85, trending: true, addedAt: "2025-03-01" },
  { name: "Sentry", url: "https://mcp.sentry.dev/mcp", description: "Inspect errors, issues and releases tracked in Sentry.", auth: "oauth", logo: `${CN_ICON}/sentry.svg`, color: "#8d5494", developer: "Sentry", developerUrl: "https://sentry.io", docsUrl: "https://docs.sentry.io", category: "Estado", type: "web", popularity: 55, addedAt: "2025-04-01" },
  { name: "Stripe", url: "https://mcp.stripe.com", description: "Query payments, customers and invoices in Stripe.", auth: "token", logo: `${CN_ICON}/stripe.svg`, color: "#635bff", developer: "Stripe", developerUrl: "https://stripe.com", docsUrl: "https://docs.stripe.com", category: "Servicios financieros", type: "web", popularity: 75, addedAt: "2025-05-01" },
  { name: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", description: "Draft replies, summarize threads and search your inbox.", auth: "oauth", logo: `${CN_ICON}/gmail.svg`, color: "#ea4335", developer: "Google", developerUrl: "https://google.com", docsUrl: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server", longDescription: "Connect Gmail so the agent can find important emails, read whole threads for context, draft replies and stay on top of your inbox — all from the chat. Official Google Workspace remote MCP server.", category: "Productividad", type: "web", popularity: 95, trending: true, addedAt: "2025-05-20", oauthScopes: ["https://www.googleapis.com/auth/gmail.modify"], oauthManualClient: true, oauthClientId: GOOGLE_OAUTH.clientId, oauthClientSecret: GOOGLE_OAUTH.clientSecret },
  { name: "Google Calendar", url: "https://calendarmcp.googleapis.com/mcp/v1", description: "Manage your schedule and coordinate meetings.", auth: "oauth", logo: `${CN_ICON}/googlecalendar.svg`, color: "#4285f4", developer: "Google", developerUrl: "https://google.com", docsUrl: "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server", longDescription: "Connect Google Calendar so the agent can check your availability, create and update events, and coordinate meetings effortlessly. Official Google Workspace remote MCP server.", category: "Productividad", type: "web", popularity: 90, trending: true, addedAt: "2025-05-20", oauthScopes: ["https://www.googleapis.com/auth/calendar.events"], oauthManualClient: true, oauthClientId: GOOGLE_OAUTH.clientId, oauthClientSecret: GOOGLE_OAUTH.clientSecret },
];

const STORAGE_KEY = "optimicer.mcp.v1";

export function loadMcpServers(): McpServer[] {
  try {
    const raw = localStorage.getItem(accountKey(STORAGE_KEY));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as McpServer[]) : [];
  } catch {
    return [];
  }
}

export function saveMcpServers(servers: McpServer[]): void {
  localStorage.setItem(accountKey(STORAGE_KEY), JSON.stringify(servers));
  clearMcpToolsCache();
}

interface McpServerConfigLike {
  type?: string;
  command?: string;
  args?: unknown[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauthClientId?: string;
  enabled?: boolean;
}

export function isStdioServer(server: McpServer): boolean {
  return server.transport === "stdio" || (!server.url?.trim() && !!server.command?.trim());
}

export function isMcpServerConfigured(server: McpServer): boolean {
  return isStdioServer(server) ? !!server.command?.trim() : !!server.url?.trim();
}

export function mcpServerTarget(server: McpServer): string {
  return isStdioServer(server) ? [server.command ?? "", ...(server.args ?? [])].join(" ").trim() : server.url;
}

export function configToServer(source: string, name: string, cfg: McpServerConfigLike): McpServer | null {
  const base = { id: `file:${source}:${name}`, name, source, enabled: cfg.enabled !== false };
  if (cfg.type === "stdio" || (cfg.command && !cfg.url)) {
    if (!cfg.command?.trim()) return null;
    return {
      ...base,
      url: "",
      transport: "stdio",
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: cfg.env,
      cwd: cfg.cwd,
    };
  }
  return {
    ...base,
    url: String(cfg.url ?? ""),
    transport: "http",
    headers: cfg.headers,
    oauthClientId: cfg.oauthClientId,
  };
}

/** The MCP servers of the settings, the plugins and the app. Of `workspace`'s settings when given
 *  (a turn's own folder, which may not be the one open in the app; load it first with
 *  settingsFor), else of the open folder's, as Settings shows them. */
export function loadMergedMcpServers(workspace?: string | null): McpServer[] {
  const snap = workspace === undefined ? getPerSourceSnapshot() : settingsSnapshotFor(workspace).perSource;
  const byName = new Map<string, McpServer>();
  for (const source of SOURCE_PRECEDENCE) {
    const rec = (snap[source]?.mcpServers ?? {}) as Record<string, McpServerConfigLike>;
    for (const [name, cfg] of Object.entries(rec)) {
      const server = configToServer(source, name, cfg);
      if (server) byName.set(name, server);
    }
  }
  const pluginServers = getCachedPluginComponents().mcpServers;
  for (const [name, cfg] of Object.entries(pluginServers)) {
    const server = configToServer("plugin", name, cfg as McpServerConfigLike);
    if (server) byName.set(name, server);
  }
  for (const server of loadMcpServers()) byName.set(server.name, server);
  return [...byName.values()];
}

export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

export function parseEnvLines(text: string): Record<string, string> | null {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return null;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__${normalizeNameForMCP(toolName)}`;
}

export function parseMcpToolName(full: string): { server: string; tool: string } | null {
  const parts = full.split("__");
  if (parts[0] !== "mcp" || parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

type FetchImpl = typeof fetch;

export type InvokeImpl = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface McpDeps {
  fetchImpl?: FetchImpl;
  invokeImpl?: InvokeImpl;
  toolImages?: boolean;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpClient {
  initialize(): Promise<void>;
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
}

const PROTOCOL_VERSION = "2025-06-18";

const INITIALIZE_PARAMS = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "Nyxs", version: "0.1.0" },
};

export const MCP_TIMEOUTS = { initialize: 60_000, list: 30_000, call: 300_000 };

const HOST_ERROR_PREFIX = /^(NOT_RUNNING|EXITED|TIMEOUT): /;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function hostError(e: unknown): Error {
  return new Error(errorText(e).replace(HOST_ERROR_PREFIX, ""));
}

export function withTimeout<T>(work: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(label));
    }, ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

async function collectTools(fetchPage: (cursor?: string) => Promise<unknown>): Promise<McpToolDef[]> {
  const tools: McpToolDef[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = (await fetchPage(cursor)) as { tools?: McpToolDef[]; nextCursor?: string } | undefined;
    tools.push(...(result?.tools ?? []));
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

const SESSION_EXPIRED = Symbol("mcp-session-expired");

interface RpcOptions {
  notification?: boolean;
  timeoutMs?: number;
  retried?: boolean;
}

/** Where an OAuth connector's access token comes from, and how a rejected one is renewed. */
interface McpHttpAuth {
  token: () => Promise<string | null>;
  renew: () => Promise<string | null>;
}

class McpHttpClient implements McpClient {
  private sessionId: string | undefined;
  private nextId = 1;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchImpl;
  private readonly auth: McpHttpAuth | undefined;

  constructor(url: string, headers: Record<string, string>, fetchImpl: FetchImpl, auth?: McpHttpAuth) {
    this.url = url;
    this.headers = headers;
    this.fetchImpl = fetchImpl;
    this.auth = auth;
  }

  private async send(method: string, params: unknown, notification: boolean, signal: AbortSignal, mayRenew = true): Promise<unknown> {
    const id = this.nextId++;
    const hadSession = this.sessionId !== undefined;
    const body = notification
      ? { jsonrpc: "2.0" as const, method, ...(params !== undefined ? { params } : {}) }
      : { jsonrpc: "2.0" as const, id, method, ...(params !== undefined ? { params } : {}) };

    const token = this.auth ? await this.auth.token() : null;
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...this.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });

    // The access token expired or was revoked: renewed once, and the request goes again.
    if (res.status === 401 && this.auth && mayRenew && (await this.auth.renew())) {
      return this.send(method, params, notification, signal, false);
    }

    const sid = res.headers.get("Mcp-Session-Id") ?? res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (notification) return undefined;

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const expired = res.status === 404 || (res.status === 400 && /session/i.test(detail));
      if (hadSession && expired && method !== "initialize") return SESSION_EXPIRED;
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const message = contentType.includes("text/event-stream")
      ? parseSseForId(await res.text(), id)
      : ((await res.json()) as JsonRpcMessage);

    if (!message) throw new Error("no JSON-RPC response from server");
    if (message.error) throw new Error(`${message.error.message} (code ${message.error.code})`);
    return message.result;
  }

  private async rpc(method: string, params: unknown, opts: RpcOptions = {}): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? MCP_TIMEOUTS.list;
    const controller = new AbortController();
    const outcome = await withTimeout(
      this.send(method, params, !!opts.notification, controller.signal),
      timeoutMs,
      `MCP request "${method}" timed out after ${timeoutMs} ms`,
      () => controller.abort(),
    );
    if (outcome !== SESSION_EXPIRED) return outcome;
    if (opts.retried) throw new Error("the MCP session expired and could not be renewed");
    this.sessionId = undefined;
    await this.initialize();
    return this.rpc(method, params, { ...opts, retried: true });
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", INITIALIZE_PARAMS, { timeoutMs: MCP_TIMEOUTS.initialize });
    await this.rpc("notifications/initialized", undefined, { notification: true });
  }

  listTools(): Promise<McpToolDef[]> {
    return collectTools((cursor) => this.rpc("tools/list", cursor ? { cursor } : {}, { timeoutMs: MCP_TIMEOUTS.list }));
  }

  callTool(name: string, args: unknown): Promise<unknown> {
    return this.rpc("tools/call", { name, arguments: args ?? {} }, { timeoutMs: MCP_TIMEOUTS.call });
  }
}

function parseSseForId(text: string, id: number): JsonRpcMessage | null {
  const messages: JsonRpcMessage[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data) as JsonRpcMessage);
    } catch {
      continue;
    }
  }
  return messages.find((m) => m.id === id) ?? messages.find((m) => m.result !== undefined || m.error) ?? null;
}

class McpStdioClient implements McpClient {
  private readonly server: McpServer;
  private readonly invokeImpl: InvokeImpl;

  constructor(server: McpServer, invokeImpl: InvokeImpl) {
    this.server = server;
    this.invokeImpl = invokeImpl;
  }

  async initialize(): Promise<void> {
    const config = {
      command: this.server.command ?? "",
      args: this.server.args ?? [],
      env: this.server.env ?? {},
      cwd: this.server.cwd?.trim() ? this.server.cwd : null,
    };
    try {
      await this.invokeImpl("mcp_stdio_start", { id: this.server.id, config, timeoutMs: MCP_TIMEOUTS.initialize });
    } catch (e) {
      throw hostError(e);
    }
  }

  private async request(method: string, params: unknown, timeoutMs: number, retried = false): Promise<unknown> {
    try {
      return await this.invokeImpl("mcp_stdio_request", { id: this.server.id, method, params, timeoutMs });
    } catch (e) {
      if (retried || !errorText(e).startsWith("NOT_RUNNING")) throw hostError(e);
      await this.initialize();
      return this.request(method, params, timeoutMs, true);
    }
  }

  listTools(): Promise<McpToolDef[]> {
    return collectTools((cursor) => this.request("tools/list", cursor ? { cursor } : {}, MCP_TIMEOUTS.list));
  }

  callTool(name: string, args: unknown): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args ?? {} }, MCP_TIMEOUTS.call);
  }
}

export function createMcpClient(server: McpServer, deps: McpDeps = {}): McpClient {
  if (isStdioServer(server)) {
    return new McpStdioClient(server, deps.invokeImpl ?? invoke);
  }
  const auth = server.oauth ? { token: () => connectorAccessToken(server.id), renew: () => renewConnectorToken(server.id) } : undefined;
  return new McpHttpClient(server.url, server.headers ?? {}, deps.fetchImpl ?? fetch, auth);
}

export async function stopMcpServer(server: McpServer, deps: McpDeps = {}): Promise<void> {
  if (!isStdioServer(server)) return;
  await (deps.invokeImpl ?? invoke)<boolean>("mcp_stdio_stop", { id: server.id }).catch(() => false);
}

export interface McpImage {
  data: string;
  mediaType: string;
}

export interface McpToolOutput {
  text: string;
  images: McpImage[];
  isError: boolean;
}

export interface McpContentOutput {
  __mcpContent: true;
  text: string;
  images: McpImage[];
}

const MAX_MCP_OUTPUT = 30_000;

const MAX_MCP_IMAGE_BASE64 = 7_000_000;

function approxKb(base64: unknown): number {
  return typeof base64 === "string" ? Math.round((base64.length * 3) / 4 / 1024) : 0;
}

function resourceText(resource: unknown, images: McpImage[]): string {
  const res = (resource ?? {}) as { uri?: string; mimeType?: string; text?: string; blob?: string };
  const uri = res.uri ?? "resource";
  if (typeof res.text === "string") return `[resource ${uri}]\n${res.text}`;
  if (typeof res.blob === "string" && res.mimeType?.startsWith("image/")) {
    images.push({ data: res.blob, mediaType: res.mimeType });
    return `[resource ${uri}: image attached]`;
  }
  return `[resource ${uri}${res.mimeType ? ` (${res.mimeType})` : ""}]`;
}

export function convertMcpResult(result: unknown): McpToolOutput {
  const r = result as
    | { content?: Array<Record<string, unknown>>; structuredContent?: unknown; isError?: boolean }
    | undefined;
  if (!r) return { text: "(no result)", images: [], isError: false };
  const texts: string[] = [];
  const images: McpImage[] = [];
  if (Array.isArray(r.content)) {
    for (const part of r.content) {
      const kind = String(part.type);
      if (kind === "text") {
        texts.push(String(part.text ?? ""));
      } else if (kind === "image" && typeof part.data === "string") {
        images.push({ data: part.data, mediaType: String(part.mimeType ?? "image/png") });
      } else if (kind === "audio") {
        texts.push(`[audio content: ${String(part.mimeType ?? "audio")}, ${approxKb(part.data)} KB]`);
      } else if (kind === "resource") {
        texts.push(resourceText(part.resource, images));
      } else if (kind === "resource_link") {
        texts.push(`[resource link: ${String(part.name ?? part.uri ?? "")} ${String(part.uri ?? "")}]`);
      } else {
        texts.push(`[${kind} content]`);
      }
    }
  } else if (r.structuredContent !== undefined) {
    texts.push(JSON.stringify(r.structuredContent, null, 2));
  } else {
    texts.push(JSON.stringify(r));
  }
  return { text: texts.filter(Boolean).join("\n"), images, isError: !!r.isError };
}

function imageNote(image: McpImage, reason: string): string {
  return `[image: ${image.mediaType}, ${approxKb(image.data)} KB — ${reason}]`;
}

export function formatMcpOutput(out: McpToolOutput, toolImages: boolean): string | McpContentOutput {
  const sendable = toolImages ? out.images.filter((img) => img.data.length <= MAX_MCP_IMAGE_BASE64) : [];
  const notes = out.images
    .filter((img) => !sendable.includes(img))
    .map((img) => imageNote(img, toolImages ? "too large to attach" : "the current model can't view images"));
  let text = [out.text, ...notes].filter(Boolean).join("\n");
  if (!text && sendable.length === 0) text = "(empty result)";
  if (out.isError) text = `Tool reported an error:\n${text}`;
  if (text.length > MAX_MCP_OUTPUT) {
    text = text.slice(0, MAX_MCP_OUTPUT) + `\n… [output truncated to ${MAX_MCP_OUTPUT} characters]`;
  }
  return sendable.length > 0 ? { __mcpContent: true, text, images: sendable } : text;
}

function isMcpContent(output: unknown): output is McpContentOutput {
  return !!output && typeof output === "object" && "__mcpContent" in output;
}

export function mcpToolModelOutput(output: unknown) {
  if (!isMcpContent(output)) return { type: "text" as const, value: String(output) };
  return {
    type: "content" as const,
    value: [
      ...(output.text ? [{ type: "text" as const, text: output.text }] : []),
      ...output.images.map((img) => ({ type: "image-data" as const, data: img.data, mediaType: img.mediaType })),
    ],
  };
}

export type McpServerState = "connecting" | "connected" | "error";

export interface McpServerStatus {
  state: McpServerState;
  toolCount: number;
  error?: string;
  at: number;
}

let statusSnapshot: Record<string, McpServerStatus> = {};
const statusListeners = new Set<() => void>();

function setMcpStatus(id: string, status: McpServerStatus): void {
  statusSnapshot = { ...statusSnapshot, [id]: status };
  for (const listener of statusListeners) listener();
}

export function getMcpStatuses(): Record<string, McpServerStatus> {
  return statusSnapshot;
}

export function subscribeMcpStatuses(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

const MCP_TOOLS_TTL_MS = 60_000;

interface McpCacheEntry {
  at: number;
  tools: ToolSet;
  error?: string;
}

const mcpToolsCache = new Map<string, McpCacheEntry>();

function mcpCacheKey(server: McpServer, deps: McpDeps): string {
  return JSON.stringify([
    server.id,
    server.name,
    server.url,
    server.headers ?? {},
    server.command ?? "",
    server.args ?? [],
    server.env ?? {},
    server.cwd ?? "",
    !!deps.toolImages,
  ]);
}

export function clearMcpToolsCache(): void {
  mcpToolsCache.clear();
}

/** Same measure as turnSupport's toolSchemaChars, kept local so mcp.ts doesn't pull the tool
 *  catalog into its import graph (toolDetail.ts already imports this module). */
function schemaChars(tools: ToolSet): number {
  let n = 0;
  for (const [name, def] of Object.entries(tools)) {
    const d = def as { description?: string; inputSchema?: unknown };
    n += name.length + (d.description?.length ?? 0);
    try {
      const schema = d.inputSchema as { jsonSchema?: unknown } | undefined;
      n += JSON.stringify(schema?.jsonSchema ?? schema ?? {}).length;
    } catch {
      n += 200;
    }
  }
  return n;
}

export interface CachedMcpTool {
  /** The tool's full model name (`mcp__server__tool`). */
  id: string;
  /** Server and tool as the user sees them. */
  server: string;
  name: string;
  chars: number;
}

/** Every MCP tool read last, with its own schema size, for the context panel's per-tool rows.
 *  Reads only the cache: opening the panel never connects to a server. */
export function cachedMcpTools(servers: McpServer[], toolImages: boolean): CachedMcpTool[] {
  const out: CachedMcpTool[] = [];
  for (const server of servers) {
    const cached = mcpToolsCache.get(mcpCacheKey(server, { toolImages }));
    if (!cached) continue;
    for (const [id, def] of Object.entries(cached.tools)) {
      out.push({
        id,
        server: server.name,
        name: parseMcpToolName(id)?.tool ?? id,
        chars: schemaChars({ [id]: def }),
      });
    }
  }
  return out;
}

function buildMcpTool(server: McpServer, def: McpToolDef, client: McpClient, toolImages: boolean) {
  return dynamicTool({
    description: def.description ?? `Tool "${def.name}" from MCP server "${server.name}".`,
    inputSchema: jsonSchema(def.inputSchema ?? { type: "object", properties: {} }),
    execute: async (args: unknown) => formatMcpOutput(convertMcpResult(await client.callTool(def.name, args)), toolImages),
    toModelOutput: ({ output }) => mcpToolModelOutput(output),
  });
}

export async function loadMcpTools(
  servers: McpServer[],
  deps: McpDeps = {},
): Promise<{ tools: ToolSet; errors: string[] }> {
  const tools: ToolSet = {};
  const errors: string[] = [];

  await Promise.all(
    servers.map(async (server) => {
      const cacheKey = mcpCacheKey(server, deps);
      const cached = mcpToolsCache.get(cacheKey);
      if (cached && Date.now() - cached.at < MCP_TOOLS_TTL_MS) {
        Object.assign(tools, cached.tools);
        if (cached.error) errors.push(cached.error);
        return;
      }
      if (statusSnapshot[server.id]?.state !== "connected") {
        setMcpStatus(server.id, { state: "connecting", toolCount: 0, at: Date.now() });
      }
      const serverTools: ToolSet = {};
      try {
        const client = createMcpClient(server, deps);
        await client.initialize();
        const defs = await client.listTools();
        for (const def of defs) {
          serverTools[mcpToolName(server.name, def.name)] = buildMcpTool(server, def, client, !!deps.toolImages);
        }
        Object.assign(tools, serverTools);
        mcpToolsCache.set(cacheKey, { at: Date.now(), tools: serverTools });
        setMcpStatus(server.id, { state: "connected", toolCount: defs.length, at: Date.now() });
      } catch (e) {
        const reason = errorText(e);
        const message = `${server.name}: ${reason}`;
        errors.push(message);
        mcpToolsCache.set(cacheKey, { at: Date.now(), tools: {}, error: message });
        setMcpStatus(server.id, { state: "error", toolCount: 0, error: reason, at: Date.now() });
      }
    }),
  );

  return { tools, errors };
}

export async function probeMcpServers(servers: McpServer[], deps: McpDeps = {}, force = false): Promise<void> {
  if (force) clearMcpToolsCache();
  await loadMcpTools(
    servers.filter((s) => s.enabled && isMcpServerConfigured(s)),
    deps,
  );
}

import type { ToolSet } from "ai";
import type { AskUserFn } from "./agentTools";

/**
 * Confirmations an MCP server asks for before acting (MCP "elicitation", form mode), as Google
 * Workspace's servers (Gmail, Calendar…) do. They are stateless: the client says on every
 * `tools/list` and `tools/call` that it can show a form, a call that needs approval answers
 * `resultType: "input_required"` with the question, and the client repeats the same call with
 * the user's answer. A client that doesn't say so gets mail it didn't send hidden
 * (DATA_PROTECTION_POLICY) and "This action requires user confirmation, which this client does
 * not support". https://developers.google.com/workspace/guides/mcp-elicitation
 */

type Json = Record<string, unknown>;

/** The protocol Google's Workspace servers speak; sent only to them. */
export const GOOGLE_MCP_PROTOCOL = "2026-07-28";

/** Google Workspace's remote MCP servers (gmailmcp.googleapis.com, calendarmcp…). */
export function isGoogleWorkspaceMcp(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".googleapis.com") && /mcp/.test(host);
  } catch {
    return false;
  }
}

/** The headers such a server checks against the body: without them it answers "Header missing",
 *  and with a method or tool that doesn't match, "Header mismatch" (-32020). */
export function workspaceHeaders(method: string, params: unknown): Record<string, string> {
  const name = (params as { name?: unknown } | undefined)?.name;
  return {
    "MCP-Protocol-Version": GOOGLE_MCP_PROTOCOL,
    "Mcp-Method": method,
    ...(method === "tools/call" && typeof name === "string" ? { "Mcp-Name": name } : {}),
  };
}

/** What goes in `params._meta` of every `tools/list` and `tools/call` to such a server. */
export function workspaceMcpMeta(version: string): Json {
  return {
    "io.modelcontextprotocol/protocolVersion": GOOGLE_MCP_PROTOCOL,
    "io.modelcontextprotocol/clientInfo": { name: "Nyxs", version },
    "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
  };
}

/** One choice the server offers (Allow once, Don't allow, Always allow…). */
export interface McpApprovalOption {
  value: string;
  label: string;
}

export interface McpApprovalRequest {
  /** The connector, as the user named it ("Gmail"). */
  server: string;
  tool: string;
  /** The question above the choices. */
  title: string;
  /** The server's Markdown preview of what the call would do. */
  message: string;
  options: McpApprovalOption[];
}

/** Asks the user; the chosen option's `value`, or null when they dismiss it. */
export type McpApprovalAsk = (request: McpApprovalRequest) => Promise<string | null>;

/** A tools/call result that waits for the user. */
export interface InputRequiredResult {
  resultType: "input_required";
  inputRequests: Record<string, unknown>;
  requestState?: unknown;
}

export function isInputRequired(result: unknown): result is InputRequiredResult {
  const r = result as Partial<InputRequiredResult> | null | undefined;
  return !!r && r.resultType === "input_required" && !!r.inputRequests && typeof r.inputRequests === "object";
}

/** The choice field of a form: one string property with an enum, as Google sends it. */
function choiceField(params: Json): { key: string; title: string; options: McpApprovalOption[] } | null {
  const schema = (params.requestedSchema ?? {}) as Json;
  const properties = (schema.properties ?? {}) as Record<string, Json>;
  const entries = Object.entries(properties).filter(([, p]) => Array.isArray(p.enum) && (p.enum as unknown[]).length > 0);
  if (entries.length !== 1) return null;
  const [key, prop] = entries[0];
  const values = (prop.enum as unknown[]).map(String);
  const names = Array.isArray(prop.enumNames) ? (prop.enumNames as unknown[]).map(String) : [];
  return {
    key,
    title: typeof prop.title === "string" ? prop.title : "",
    // The server decides the choices: they're shown as it sends them, never assumed.
    options: values.map((value, i) => ({ value, label: names[i] || value })),
  };
}

/**
 * The answers to send back for each request, keyed as the server keyed them. Without a way to
 * ask (no chat to show it in) or a form this client can't show, the request is cancelled: the
 * server then answers the call as declined instead of waiting.
 */
export async function answerInputRequests(
  inputRequests: Record<string, unknown>,
  ask: McpApprovalAsk | undefined,
  context: { server: string; tool: string },
): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  for (const [key, raw] of Object.entries(inputRequests)) {
    const req = (raw ?? {}) as Json;
    const params = (req.params ?? {}) as Json;
    const field = req.method === "elicitation/create" && (params.mode ?? "form") === "form" ? choiceField(params) : null;
    if (!field || !ask) {
      out[key] = { action: "cancel" };
      continue;
    }
    const choice = await ask({
      ...context,
      title: field.title,
      message: typeof params.message === "string" ? params.message : "",
      options: field.options,
    });
    out[key] = choice === null || !field.options.some((o) => o.value === choice) ? { action: "decline" } : { action: "accept", content: { [field.key]: choice } };
  }
  return out;
}

/** A server's confirmation as one question of the chat's card: its question and preview as the
 *  text, its choices as the options. The answer is matched back to the choice's value. */
export function askMcpApproval(askUser: AskUserFn): McpApprovalAsk {
  return async ({ server, title, message, options }) => {
    const question = [title, message].filter((s) => s.trim()).join("\n\n") || server;
    const answers = await askUser([{ question, header: server.slice(0, 12), options: options.map((o) => ({ label: o.label })) }]);
    const label = answers?.[0]?.answer;
    return options.find((o) => o.label === label)?.value ?? null;
  };
}

/** How a cached MCP tool runs with a turn's way of asking the user. */
export const MCP_CALL = Symbol("mcp-call");

type McpCallable = { [MCP_CALL]?: (args: unknown, ask?: McpApprovalAsk) => Promise<unknown> };

/**
 * The turn's copy of its MCP tools, whose confirmations are asked in its own chat. The tools
 * are cached for every chat, so they are copied here rather than changed.
 */
export function withMcpApproval(tools: ToolSet, ask: McpApprovalAsk | undefined): ToolSet {
  if (!ask) return tools;
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const call = (tool as McpCallable)[MCP_CALL];
    out[name] = call ? ({ ...tool, execute: (args: unknown) => call(args, ask) } as typeof tool) : tool;
  }
  return out;
}

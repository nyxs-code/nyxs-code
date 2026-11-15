import { beforeEach, describe, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/secureStore", () => ({
  getSecret: vi.fn(async (k: string) => keychain.get(k) ?? null),
  setSecret: vi.fn(async (k: string, v: string) => void keychain.set(k, v)),
  deleteSecret: vi.fn(async (k: string) => void keychain.delete(k)),
}));
const tokenEndpoint = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: tokenEndpoint }));
vi.mock("@/lib/ipc", () => ({ invoke: vi.fn() }));

/** localStorage for the connector list and the manual OAuth clients. */
const local = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => local.get(k) ?? null,
  setItem: (k: string, v: string) => void local.set(k, String(v)),
  removeItem: (k: string) => void local.delete(k),
});

const { saveConnectorTokens, forgetConnectorTokens } = await import("@/lib/connectorTokens");
const { loadMcpTools, clearMcpToolsCache, getOAuthClientSecret, setOAuthClient } = await import("@/lib/mcp");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An MCP server that takes one access token, and answers 401 to any other. */
function mcpServer(valid: () => string) {
  const seen: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    seen.push(auth);
    if (auth !== `Bearer ${valid()}`) return new Response("expired", { status: 401 });
    const msg = JSON.parse(String(init?.body));
    if (msg.method === "initialize") return json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {} } });
    if (msg.method === "tools/list") return json({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] } });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const connector = { id: "c1", name: "Linear", url: "https://mcp.linear.app/mcp", oauth: true, enabled: true };
const refreshData = { tokenEndpoint: "https://auth.linear.app/token", clientId: "cid", clientSecret: "shh", resource: connector.url };

beforeEach(() => {
  keychain.clear();
  local.clear();
  tokenEndpoint.mockReset();
  clearMcpToolsCache();
});

describe("connector OAuth tokens", () => {
  it("live in the keychain, and an expired one is renewed with the refresh token", async () => {
    await saveConnectorTokens("c1", { accessToken: "old", refreshToken: "r1", expiresIn: -10, ...refreshData });
    expect(JSON.stringify([...local.values()])).not.toContain("old");
    expect(keychain.get("mcp-oauth:c1")).toContain("r1");
    tokenEndpoint.mockResolvedValueOnce(json({ access_token: "new", expires_in: 3600 }));
    const { fetchImpl, seen } = mcpServer(() => "new");
    const { tools, errors } = await loadMcpTools([connector], { fetchImpl });
    expect(errors).toEqual([]);
    expect(Object.keys(tools)).toHaveLength(1);
    expect(seen.every((h) => h === "Bearer new")).toBe(true);
    const body = new URLSearchParams(String(tokenEndpoint.mock.calls[0][1].body));
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: "refresh_token", refresh_token: "r1", client_id: "cid", client_secret: "shh", resource: connector.url });
    // The server didn't send a new refresh token: the old one is kept.
    expect(JSON.parse(keychain.get("mcp-oauth:c1")!)).toMatchObject({ accessToken: "new", refreshToken: "r1" });
  });

  it("renews once on a 401 and retries the request", async () => {
    await saveConnectorTokens("c1", { accessToken: "revoked", refreshToken: "r1", expiresIn: 3600, ...refreshData });
    tokenEndpoint.mockResolvedValueOnce(json({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 }));
    const { fetchImpl, seen } = mcpServer(() => "fresh");
    const { errors } = await loadMcpTools([connector], { fetchImpl });
    expect(errors).toEqual([]);
    expect(seen[0]).toBe("Bearer revoked");
    expect(seen.slice(1).every((h) => h === "Bearer fresh")).toBe(true);
    expect(tokenEndpoint).toHaveBeenCalledTimes(1);
    expect(JSON.parse(keychain.get("mcp-oauth:c1")!).refreshToken).toBe("r2");
  });

  it("is forgotten with its connector", async () => {
    await saveConnectorTokens("c1", { accessToken: "a", ...refreshData });
    await forgetConnectorTokens("c1");
    expect(keychain.has("mcp-oauth:c1")).toBe(false);
  });
});

describe("a manual OAuth client", () => {
  it("keeps its secret in the keychain, and moves an old one there", async () => {
    setOAuthClient("Gmail", { clientId: "id-1", clientSecret: "s-1" });
    await vi.waitFor(() => expect([...keychain.values()]).toContain("s-1"));
    expect(JSON.stringify([...local.values()])).not.toContain("s-1");
    expect(await getOAuthClientSecret("Gmail")).toBe("s-1");
    // Saved by an earlier version, in localStorage.
    local.set("optimicer.oauthClients.v1", JSON.stringify({ Calendar: { clientId: "id-2", clientSecret: "s-2" } }));
    expect(await getOAuthClientSecret("Calendar")).toBe("s-2");
    expect(local.get("optimicer.oauthClients.v1")).not.toContain("s-2");
    expect(await getOAuthClientSecret("Calendar")).toBe("s-2");
  });
});

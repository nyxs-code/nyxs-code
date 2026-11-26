import { invoke } from "@/lib/ipc";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { closeOAuthPort } from "@/lib/auth";
import { oauthCallbackPage } from "@/lib/oauthPage";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

/** What renewing a connector's token takes, besides its refresh token. */
export interface OAuthRenewal {
  tokenEndpoint: string;
  clientId?: string;
  clientSecret?: string;
  /** The MCP server the token is bound to (RFC 8707). */
  resource: string;
}

interface AuthServerMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  resourceScopes?: string[];
}

export interface OAuthOptions {
  scopes?: string[];
  clientId?: string;
  clientSecret?: string;
}

/**
 * The scopes to ask for: the ones the connector chose come first. A server lists every scope it
 * accepts (Gmail's include deleting the whole mailbox), and asking for all of them asks the user
 * for far more than the connector uses, and Google for scopes the app never declared.
 */
export function oauthScopesFor(
  chosen: string[] | undefined,
  meta: Pick<AuthServerMeta, "resourceScopes" | "scopes_supported">,
): string[] | undefined {
  if (chosen?.length) return chosen;
  if (meta.resourceScopes?.length) return meta.resourceScopes;
  return meta.scopes_supported;
}

async function httpJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await (tauriFetch as unknown as typeof fetch)(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url} → HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLen: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLen)));
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

async function tryWellKnown(base: string, path: string): Promise<Record<string, unknown> | null> {
  try {
    const obj = (await httpJson(`${base.replace(/\/$/, "")}${path}`)) as Record<string, unknown>;
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

async function discover(mcpUrl: string): Promise<AuthServerMeta> {
  const u = new URL(mcpUrl);
  const origin = u.origin;
  const resPath = u.pathname.replace(/\/+$/, "");

  let authBase = origin;
  const prm =
    (resPath ? await tryWellKnown(origin, `/.well-known/oauth-protected-resource${resPath}`) : null) ??
    (await tryWellKnown(origin, "/.well-known/oauth-protected-resource")) ??
    (await tryWellKnown(origin, "/.well-known/oauth-protected-resource/mcp"));
  const servers = prm?.authorization_servers;
  if (Array.isArray(servers) && typeof servers[0] === "string") authBase = servers[0];
  const resourceScopes = Array.isArray(prm?.scopes_supported) ? (prm!.scopes_supported as string[]) : undefined;

  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    const meta = await tryWellKnown(authBase, path);
    if (meta && typeof meta.authorization_endpoint === "string" && typeof meta.token_endpoint === "string") {
      return {
        authorization_endpoint: meta.authorization_endpoint,
        token_endpoint: meta.token_endpoint,
        registration_endpoint: typeof meta.registration_endpoint === "string" ? meta.registration_endpoint : undefined,
        scopes_supported: Array.isArray(meta.scopes_supported) ? (meta.scopes_supported as string[]) : undefined,
        code_challenge_methods_supported: Array.isArray(meta.code_challenge_methods_supported)
          ? (meta.code_challenge_methods_supported as string[])
          : undefined,
        resourceScopes,
      };
    }
  }

  const base = authBase.replace(/\/$/, "");
  return {
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    resourceScopes,
  };
}

async function registerClient(
  meta: AuthServerMeta,
  redirectUri: string,
  clientName: string,
): Promise<{ clientId?: string; clientSecret?: string }> {
  if (!meta.registration_endpoint) return {};
  try {
    const data = (await httpJson(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      }),
    })) as Record<string, unknown>;
    return {
      clientId: typeof data.client_id === "string" ? data.client_id : undefined,
      clientSecret: typeof data.client_secret === "string" ? data.client_secret : undefined,
    };
  } catch {
    return {};
  }
}

export async function runMcpOAuth(
  mcpUrl: string,
  connectorName: string,
  opts: OAuthOptions = {},
): Promise<OAuthTokens & OAuthRenewal> {
  const port = await invoke<number>("oauth_reserve");
  const waiting = { started: false };
  try {
    return await authorize(port, mcpUrl, connectorName, opts, waiting);
  } catch (e) {
    // The wait closes the port itself; one that never started leaves it to be closed here.
    if (!waiting.started) await closeOAuthPort(port);
    throw e;
  }
}

async function authorize(
  port: number,
  mcpUrl: string,
  connectorName: string,
  opts: OAuthOptions,
  waiting: { started: boolean },
): Promise<OAuthTokens & OAuthRenewal> {
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const meta = await discover(mcpUrl);
  let clientId = opts.clientId;
  let clientSecret = opts.clientSecret;
  if (!clientId) {
    const reg = await registerClient(meta, redirectUri, `Nyxs — ${connectorName}`);
    clientId = reg.clientId;
    clientSecret = clientSecret ?? reg.clientSecret;
  }
  const { verifier, challenge } = await pkce();
  const state = randomString(16);

  const scopes = oauthScopesFor(opts.scopes, meta);

  const authParams = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource: mcpUrl, // RFC 8707 — bind the token to this MCP resource.
    access_type: "offline", // ask for a refresh token (Google)
    prompt: "consent",
  });
  if (clientId) authParams.set("client_id", clientId);
  if (scopes?.length) authParams.set("scope", scopes.join(" "));
  const authorizeUrl = `${meta.authorization_endpoint}?${authParams.toString()}`;
  await invoke("agent_open_external", { url: authorizeUrl });

  // Only the callback carrying this state is taken: another local connection to the port isn't.
  waiting.started = true;
  const query = await invoke<string>("oauth_wait", { port, timeoutMs: 300_000, state, page: oauthCallbackPage() });
  const cb = new URLSearchParams(query);
  if (cb.get("error")) throw new Error(cb.get("error_description") || cb.get("error") || "OAuth error");
  if (cb.get("state") !== state) throw new Error("OAuth state mismatch (posible intento de fijación).");
  const code = cb.get("code");
  if (!code) throw new Error("El callback OAuth no trajo un código de autorización.");

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: mcpUrl,
  });
  if (clientId) tokenBody.set("client_id", clientId);
  if (clientSecret) tokenBody.set("client_secret", clientSecret);

  const tokens = await requestTokens(meta.token_endpoint, tokenBody);
  return { ...tokens, tokenEndpoint: meta.token_endpoint, clientId, clientSecret, resource: mcpUrl };
}

async function requestTokens(tokenEndpoint: string, body: URLSearchParams): Promise<OAuthTokens> {
  const tok = (await httpJson(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  })) as Record<string, unknown>;

  const accessToken = typeof tok.access_token === "string" ? tok.access_token : "";
  if (!accessToken) throw new Error("El servidor no devolvió un access_token.");
  return {
    accessToken,
    refreshToken: typeof tok.refresh_token === "string" ? tok.refresh_token : undefined,
    expiresIn: typeof tok.expires_in === "number" ? tok.expires_in : undefined,
  };
}

/** A new access token for a connector, from its refresh token. The server may hand a new
 *  refresh token too; when it doesn't, the old one stays valid. */
export function refreshMcpToken(refreshToken: string, r: OAuthRenewal): Promise<OAuthTokens> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, resource: r.resource });
  if (r.clientId) body.set("client_id", r.clientId);
  if (r.clientSecret) body.set("client_secret", r.clientSecret);
  return requestTokens(r.tokenEndpoint, body);
}

import { deleteSecret, getSecret, setSecret } from "@/lib/secureStore";
import { refreshMcpToken, type OAuthRenewal, type OAuthTokens } from "@/lib/mcpOAuth";

// The tokens of a connector signed in with OAuth live in the keychain, not with the connector
// in localStorage, and are renewed with the refresh token when they expire or the server
// answers 401, instead of making the user remove the connector and connect it again.

interface Stored extends OAuthRenewal {
  accessToken: string;
  refreshToken?: string;
  /** When the access token stops working, in ms. */
  expiresAt?: number;
}

/** Renewed a bit before it expires, so a request doesn't go out with a token about to lapse. */
const EARLY_MS = 60_000;

const account = (connectorId: string) => `mcp-oauth:${connectorId}`;

async function load(connectorId: string): Promise<Stored | null> {
  const raw = await getSecret(account(connectorId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Stored;
    return typeof parsed?.accessToken === "string" ? parsed : null;
  } catch {
    return null;
  }
}

const store = (connectorId: string, s: Stored) => setSecret(account(connectorId), JSON.stringify(s));

export function saveConnectorTokens(connectorId: string, t: OAuthTokens & OAuthRenewal): Promise<void> {
  const { expiresIn, ...rest } = t;
  return store(connectorId, { ...rest, expiresAt: expiresIn != null ? Date.now() + expiresIn * 1000 : undefined });
}

export const forgetConnectorTokens = (connectorId: string) => deleteSecret(account(connectorId));

// One renewal at a time per connector: requests made meanwhile share it, so a refresh token the
// server rotates isn't spent twice.
const renewing = new Map<string, Promise<string | null>>();

/** A new access token from the refresh token, or null when there's none or the server said no. */
export function renewConnectorToken(connectorId: string): Promise<string | null> {
  let pending = renewing.get(connectorId);
  if (!pending) {
    pending = (async () => {
      const saved = await load(connectorId);
      if (!saved?.refreshToken) return null;
      try {
        const t = await refreshMcpToken(saved.refreshToken, saved);
        await store(connectorId, {
          ...saved,
          accessToken: t.accessToken,
          refreshToken: t.refreshToken ?? saved.refreshToken,
          expiresAt: t.expiresIn != null ? Date.now() + t.expiresIn * 1000 : undefined,
        });
        return t.accessToken;
      } catch {
        return null;
      }
    })().finally(() => renewing.delete(connectorId));
    renewing.set(connectorId, pending);
  }
  return pending;
}

/** The connector's access token, renewed first when it's about to expire. */
export async function connectorAccessToken(connectorId: string): Promise<string | null> {
  const saved = await load(connectorId);
  if (!saved) return null;
  if (saved.expiresAt != null && saved.expiresAt - EARLY_MS <= Date.now() && saved.refreshToken) {
    return (await renewConnectorToken(connectorId)) ?? saved.accessToken;
  }
  return saved.accessToken;
}

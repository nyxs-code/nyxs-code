import { invoke } from "@/lib/ipc";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getSecret, setSecret, deleteSecret } from "./secureStore";
import { signInCallbackPage } from "./oauthPage";

/** The Nyxs backend. A build for the native end-to-end tests points it at their local scripted
 *  server instead (VITE_NYXS_API_BASE, set only by e2e-native/build.mjs). */
export const AUTH_BASE = import.meta.env.VITE_NYXS_API_BASE || "https://api.nyxs.dev";

const SESSION_ACCOUNT = "auth:session";

let authSnapshot: { token: string; email: string; uid: string } | null = null;

export function getAuthSnapshot(): { token: string; email: string; uid: string } | null {
  return authSnapshot;
}

export function getCurrentUserId(): string | null {
  return authSnapshot?.uid || null;
}

export interface AuthUser {
  id: number;
  email: string;
  name?: string;
  picture?: string;
  orgId?: string;
  createdAt?: string;
}

export interface AuthSession {
  id: string;
  device: string | null;
  location: string | null;
  createdAt: string;
  updatedAt: string;
  current: boolean;
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isExpired(token: string): boolean {
  const exp = decodeJwt(token)?.exp;
  return typeof exp !== "number" || Date.now() / 1000 >= exp;
}

function userFromToken(token: string): AuthUser | null {
  const p = decodeJwt(token);
  if (!p || typeof p.uid === "undefined") return null;
  return { id: Number(p.uid), email: String(p.email ?? ""), orgId: p.org ? String(p.org) : undefined };
}

export async function getToken(): Promise<string | null> {
  const tok = await getSecret(SESSION_ACCOUNT);
  if (!tok || isExpired(tok)) {
    authSnapshot = null;
    return null;
  }
  const payload = decodeJwt(tok);
  const email = String(payload?.email ?? "");
  const uid = payload?.uid != null ? String(payload.uid) : "";
  authSnapshot = { token: tok, email, uid };
  return tok;
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  if (!token) throw new Error("Unauthorized");
  const res = await (tauriFetch as unknown as typeof fetch)(`${AUTH_BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new Error("Unauthorized");
  return res;
}

export async function getSession(): Promise<AuthUser | null> {
  const token = await getToken();
  if (!token) return null;
  try {
    const res = await (tauriFetch as unknown as typeof fetch)(`${AUTH_BASE}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return (await res.json()) as AuthUser;
    if (res.status === 401) {
      await signOut();
      return null;
    }
    return userFromToken(token);
  } catch {
    return userFromToken(token);
  }
}

export const AUTH_CHANGED_EVENT = "nyxs:auth-changed";
function emitAuthChanged(): void {
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

export function userInitials(user: { name?: string; email: string }): string {
  const base = (user.name?.trim() || user.email.split("@")[0] || "").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : base.slice(0, 2);
  return letters.toUpperCase() || "?";
}

export async function getMe(): Promise<AuthUser> {
  const res = await authedFetch("/api/me");
  if (!res.ok) throw new Error(`me_failed_${res.status}`);
  return (await res.json()) as AuthUser;
}

export async function updateName(name: string): Promise<AuthUser> {
  const res = await authedFetch("/api/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`update_failed_${res.status}`);
  const user = (await res.json()) as AuthUser;
  emitAuthChanged();
  return user;
}

export async function listSessions(): Promise<AuthSession[]> {
  const res = await authedFetch("/api/sessions");
  if (!res.ok) throw new Error(`sessions_failed_${res.status}`);
  // Settings › Account maps over this; an unexpected body (an object, null) must not crash it.
  const body: unknown = await res.json();
  return Array.isArray(body) ? (body as AuthSession[]) : [];
}

export async function finishSession(id: string): Promise<void> {
  await authedFetch(`/api/sessions/${id}/finish`, { method: "POST" });
}

export async function logoutAll(keepCurrent = false): Promise<void> {
  await authedFetch(`/api/sessions/logout-all${keepCurrent ? "?keepCurrent=1" : ""}`, { method: "POST" });
}

export async function deleteAccount(): Promise<void> {
  await authedFetch("/api/account", { method: "DELETE" });
}

/** Whether api.nyxs.dev hands the `state` it gets back on the callback. Until it does, the
 *  callback port takes the first callback with a token, which a local process could send; once
 *  it does, turning this on sends a random `state` and only that callback is taken. Off for now:
 *  the backend isn't in this repo, and sending a `state` it doesn't return would break sign-in. */
const BACKEND_RETURNS_STATE = false;

/** Closes a reserved callback port whose wait won't come (a wait of 0 just closes it). */
export const closeOAuthPort = (port: number) => invoke("oauth_wait", { port, timeoutMs: 0 }).catch(() => {});

function randomState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signInWithGoogle(): Promise<AuthUser> {
  const port = await invoke<number>("oauth_reserve");
  const state = BACKEND_RETURNS_STATE ? randomState() : null;
  try {
    const returnUrl = `http://127.0.0.1:${port}/callback`;
    const device = encodeURIComponent(appDeviceLabel());
    const stateParam = state ? `&state=${state}` : "";
    await invoke("agent_open_external", {
      url: `${AUTH_BASE}/auth/google?return=${encodeURIComponent(returnUrl)}&device=${device}${stateParam}`,
    });
  } catch (e) {
    await closeOAuthPort(port);
    throw e;
  }

  const page = signInCallbackPage();
  const query = await invoke<string>("oauth_wait", state ? { port, timeoutMs: 300_000, state, page } : { port, timeoutMs: 300_000, page });
  const params = new URLSearchParams(query);
  if (params.get("error")) throw new Error(params.get("error") || "auth_failed");
  const token = params.get("token");
  if (!token) throw new Error("El servidor no devolvió un token de sesión.");

  await setSecret(SESSION_ACCOUNT, token);
  return (await getMe().catch(() => null)) ?? userFromToken(token) ?? { id: 0, email: "" };
}

export async function signOut(): Promise<void> {
  authSnapshot = null;
  await deleteSecret(SESSION_ACCOUNT);
}

function appDeviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(ua)
      ? "macOS"
      : /Linux/.test(ua)
        ? "Linux"
        : "";
  return os ? `Nyxs Desktop (${os})` : "Nyxs Desktop";
}

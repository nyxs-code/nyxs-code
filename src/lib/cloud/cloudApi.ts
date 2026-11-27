import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { AUTH_BASE, getToken } from "@/lib/auth";

// The app's side of the Nyxs cloud (docs/proyectos-nube-spec.md, "API"): threads that run in an
// isolated container on Nyxs's servers and keep working with the computer off.

const http = tauriFetch as unknown as typeof fetch;

export type CloudThreadStatus = "queued" | "working" | "needs_input" | "review" | "resolved" | "failed" | "stopped";

export interface CloudThread {
  id: string;
  projectId: string;
  title: string;
  status: CloudThreadStatus;
  updatedAt: string;
  preview?: string;
  prUrl?: string;
}

/** One line of a cloud turn: the events `nyxs --headless --format json` prints, plus status,
 *  report and done (spec, "Runner ↔ worker contract"). */
export interface CloudEvent {
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
}

export interface NewCloudThread {
  projectId: string;
  title: string;
  instructions: string;
  repo: { url: string; branch?: string };
  model: { id: string; provider: string; effort?: string };
  /** The user's Nyxs settings without any secret: providers and models. */
  settings: Record<string, unknown>;
  projectInstructions?: string;
  memory?: string;
}

/** Raised for an answer the cloud refused: `status` is the HTTP status, `code` the API's own. */
export class CloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CloudError";
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const token = await getToken();
  if (!token) throw new CloudError("Sign in to Nyxs to use the cloud.", 401, "not_signed_in");
  const res = await http(`${AUTH_BASE}/api/cloud${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; message?: string };
    throw new CloudError(err.message || err.error || `The cloud answered ${res.status}.`, res.status, err.error);
  }
  return data as T;
}

/** Stores the user's credentials on the server, encrypted, for their cloud threads. */
export function putCloudSecrets(items: { key: string; value: string }[]): Promise<{ ok: true }> {
  return call("/secrets", { method: "PUT", body: { items } });
}

/** The names of the credentials stored in the cloud (never their values). */
export async function listCloudSecrets(): Promise<string[]> {
  const out = await call<{ keys: string[] }>("/secrets");
  return out.keys ?? [];
}

export function deleteCloudSecret(key: string): Promise<{ ok: true }> {
  return call(`/secrets/${encodeURIComponent(key)}`, { method: "DELETE" });
}

export function createCloudThread(input: NewCloudThread): Promise<{ id: string; status: CloudThreadStatus }> {
  return call("/threads", { method: "POST", body: input });
}

export async function listCloudThreads(projectId?: string): Promise<CloudThread[]> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const out = await call<CloudThread[] | { threads: CloudThread[] }>(`/threads${q}`);
  return Array.isArray(out) ? out : (out.threads ?? []);
}

/** The thread's events after `after`; waits up to `waitSeconds` for new ones (long poll). */
export async function cloudThreadEvents(id: string, after: number, waitSeconds = 25, signal?: AbortSignal): Promise<CloudEvent[]> {
  const out = await call<{ events: CloudEvent[] }>(
    `/threads/${encodeURIComponent(id)}/events?after=${after}&wait=${waitSeconds}`,
    { signal },
  );
  return out.events ?? [];
}

/** The user's follow-up: the thread runs another turn from where it was. */
export function sendCloudMessage(id: string, text: string): Promise<{ ok: true }> {
  return call(`/threads/${encodeURIComponent(id)}/messages`, { method: "POST", body: { text } });
}

export function stopCloudThread(id: string): Promise<{ ok: true }> {
  return call(`/threads/${encodeURIComponent(id)}/stop`, { method: "POST" });
}

export function deleteCloudThread(id: string): Promise<{ ok: true }> {
  return call(`/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Follows a thread's events until `signal` aborts or a `done` event arrives, starting after
 * `after`. A failed poll waits and tries again (the app may be offline a moment); the cloud keeps
 * the events, so nothing is lost. Resolves with the last sequence number seen.
 */
export async function followCloudThread(
  id: string,
  after: number,
  onEvent: (e: CloudEvent) => void,
  signal: AbortSignal,
  retryMs = 5000,
): Promise<number> {
  let last = after;
  while (!signal.aborted) {
    let events: CloudEvent[];
    try {
      events = await cloudThreadEvents(id, last, 25, signal);
    } catch (e) {
      if (signal.aborted) break;
      // Signed out, or the thread is gone: nothing to wait for.
      if (e instanceof CloudError && (e.status === 401 || e.status === 403 || e.status === 404)) throw e;
      await new Promise((r) => setTimeout(r, retryMs));
      continue;
    }
    for (const ev of events) {
      if (ev.seq <= last) continue;
      last = ev.seq;
      onEvent(ev);
      if (ev.type === "done") return last;
    }
  }
  return last;
}

// Where each Claude Code session Nyxs drove last stood: the uuid of the last message of its
// latest reply, and the chat that reply went to. A chat resuming the session from any other
// point (an edited, rewound or forked chat) has to cut the session there instead of carrying
// on from turns it no longer shows. Kept across restarts: a session outlives the app.

const STORAGE_KEY = "nyxs.claudeCodeHeads.v1";
const MAX_SESSIONS = 300;

export interface SessionHead {
  at: string;
  chatKey?: string;
}

let heads: Map<string, SessionHead> | null = null;

function load(): Map<string, SessionHead> {
  if (heads) return heads;
  heads = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as [string, SessionHead][];
    if (Array.isArray(saved)) for (const [id, head] of saved) if (typeof head?.at === "string") heads.set(id, head);
  } catch {
    // Unreadable: every session counts as unknown, which resumes them as before.
  }
  return heads;
}

/** Forgets the heads held in memory, for tests that reuse session ids (storage is left as is). */
export function resetSessionHeadsForTest(): void {
  heads = new Map();
}

export function sessionHead(sessionId: string): SessionHead | undefined {
  return load().get(sessionId);
}

export function setSessionHead(sessionId: string, head: SessionHead): void {
  const map = load();
  // Re-inserted last, so the oldest sessions are the ones dropped.
  map.delete(sessionId);
  map.set(sessionId, head);
  while (map.size > MAX_SESSIONS) map.delete(map.keys().next().value!);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...map]));
  } catch {
    // Storage full or unavailable: the head still holds for this run.
  }
}

/** Forgets where a session stood, unless another chat has taken it over since (a fork's turn). */
export function forgetSessionHead(sessionId: string, chatKey: string): void {
  const map = load();
  const head = map.get(sessionId);
  if (!head || (head.chatKey && head.chatKey !== chatKey)) return;
  map.delete(sessionId);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...map]));
  } catch {
    // Storage unavailable: the head goes with this run.
  }
}

/**
 * Whether resuming `sessionId` from the reply whose last message is `at` would carry on from a
 * history the chat no longer has: the session went on past `at`, or another chat owns it now.
 * An unknown session (from before this was kept, or imported with /resume) resumes as is.
 */
export function sessionMovedOn(sessionId: string, at: string | undefined, chatKey: string | undefined): boolean {
  const head = sessionHead(sessionId);
  if (!head) return false;
  if (head.at !== at) return true;
  return !!head.chatKey && !!chatKey && head.chatKey !== chatKey;
}

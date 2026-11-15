import { accountKey } from "./accountScope";

export type NyxsEvent =
  | { type: "session.started"; ts: number; workspace?: string; model?: string }
  | { type: "turn.started"; ts: number; workspace?: string; model?: string }
  | { type: "tool.executed"; ts: number; tool: string; ok: boolean; durationMs?: number }
  | { type: "tool.denied"; ts: number; tool: string }
  | { type: "compaction.triggered"; ts: number; kind: "micro" | "summary" | "turn"; clearedTokens?: number; clearedCount?: number }
  | { type: "mcp.connected"; ts: number; server: string }
  | { type: "mcp.server_failed"; ts: number; server: string; error?: string };

type EventInput = NyxsEvent extends infer E ? (E extends NyxsEvent ? Omit<E, "ts"> : never) : never;

const MAX_EVENTS = 500;
const STORAGE_KEY = "nyxs.events";

const hasWindow = typeof window !== "undefined";

function load(): NyxsEvent[] {
  if (!hasWindow) return [];
  try {
    const raw = window.localStorage.getItem(accountKey(STORAGE_KEY));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as NyxsEvent[]) : [];
  } catch {
    return [];
  }
}

let ring: NyxsEvent[] = load();

let flushTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleFlush(): void {
  if (!hasWindow || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      window.localStorage.setItem(accountKey(STORAGE_KEY), JSON.stringify(ring));
    } catch {
      /* storage blocked — keep the in-memory ring */
    }
  }, 1000);
}

export function emitEvent(ev: EventInput): void {
  const full = { ...ev, ts: Date.now() } as NyxsEvent;
  ring.push(full);
  if (ring.length > MAX_EVENTS) ring = ring.slice(-MAX_EVENTS);
  scheduleFlush();
}

/** What a sub-agent is doing, reported as it happens. */
export type ActivityEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool-call"; callId: string; name: string; detail: string }
  | { kind: "tool-result"; callId: string; ok: boolean };

export type ActivityEntry =
  | { kind: "text"; text: string }
  | { kind: "tool"; callId: string; name: string; detail: string; status: "running" | "ok" | "error" | "stopped" };

const MAX_ENTRIES = 400;
const MAX_TEXT = 12_000;

/** `list` with `e` applied: text deltas join the text entry before them, results settle their call. */
export function appendActivity(list: ActivityEntry[], e: ActivityEvent): ActivityEntry[] {
  if (e.kind === "text") {
    if (!e.delta) return list;
    const last = list[list.length - 1];
    if (last?.kind === "text") {
      const text = last.text + e.delta;
      return [...list.slice(0, -1), { kind: "text", text: text.length > MAX_TEXT ? `…${text.slice(-MAX_TEXT)}` : text }];
    }
    return cap([...list, { kind: "text", text: e.delta }]);
  }
  if (e.kind === "tool-call") {
    return cap([...list, { kind: "tool", callId: e.callId, name: e.name, detail: e.detail, status: "running" }]);
  }
  const i = list.findIndex((a) => a.kind === "tool" && a.callId === e.callId);
  if (i < 0) return list;
  const next = list.slice();
  next[i] = { ...(list[i] as Extract<ActivityEntry, { kind: "tool" }>), status: e.ok ? "ok" : "error" };
  return next;
}

/** Calls still marked running once their agent ended will never get a result: they were cut
 *  off (the agent was stopped or ended), not failed. */
export function settleActivity(list: ActivityEntry[]): ActivityEntry[] {
  if (!list.some((a) => a.kind === "tool" && a.status === "running")) return list;
  return list.map((a) => (a.kind === "tool" && a.status === "running" ? { ...a, status: "stopped" } : a));
}

function cap(list: ActivityEntry[]): ActivityEntry[] {
  return list.length > MAX_ENTRIES ? list.slice(-MAX_ENTRIES) : list;
}

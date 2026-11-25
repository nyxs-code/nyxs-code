/** Keeps sessions that message each other (SendToSession) from running away, like Claude's
 *  "Not delivered: …" refusals: two agents answering each other forever, one agent flooding
 *  others, or a pile of messages waiting in a busy session. */

/** Messages between the same two sessions, both ways, within LOOP_WINDOW_MS that count as a loop. */
const LOOP_LIMIT = 8;
const LOOP_WINDOW_MS = 3 * 60_000;
/** Messages one session may send in RATE_WINDOW_MS. */
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
/** Messages that may wait in a session's queue at once. */
const BACKLOG_LIMIT = 5;

interface Sent {
  from: string;
  to: string;
  at: number;
}

let sent: Sent[] = [];
const waiting = new Map<string, number>();

export type Refusal = "loop" | "rate" | "backlog";

/** Why this message shouldn't go, or null when it can. */
export function refuseMessage(from: string, to: string, now = Date.now()): Refusal | null {
  sent = sent.filter((s) => now - s.at < Math.max(LOOP_WINDOW_MS, RATE_WINDOW_MS));
  const between = sent.filter((s) => now - s.at < LOOP_WINDOW_MS && ((s.from === from && s.to === to) || (s.from === to && s.to === from)));
  // Both have to be talking: one session briefing another many times isn't a loop.
  if (between.length >= LOOP_LIMIT && between.some((s) => s.from === to)) return "loop";
  if (sent.filter((s) => s.from === from && now - s.at < RATE_WINDOW_MS).length >= RATE_LIMIT) return "rate";
  if ((waiting.get(to) ?? 0) >= BACKLOG_LIMIT) return "backlog";
  return null;
}

/** Notes a message that went out; `queued` when it waits for the session's turn to end. */
export function noteMessageSent(from: string, to: string, queued: boolean, now = Date.now()): void {
  sent.push({ from, to, at: now });
  if (queued) waiting.set(to, (waiting.get(to) ?? 0) + 1);
}

/** The user wrote in a session: what the agents said to each other before doesn't make a loop now. */
export function userSpokeIn(sessionId: string): void {
  sent = sent.filter((s) => s.from !== sessionId && s.to !== sessionId);
}

/** A session's turn started: the messages waiting for it went in. */
export function sessionTookMessages(sessionId: string): void {
  waiting.delete(sessionId);
}

/** What the sending agent reads when a message isn't delivered. */
export function refusalText(why: Refusal, to: string): string {
  switch (why) {
    case "loop":
      return `Not delivered: this session and ${to} were messaging each other in a loop. Stop sending messages back and forth; finish the work here, or ask the user.`;
    case "rate":
      return "Not delivered: too many messages in a short time. Wait a minute, and send fewer, fuller messages.";
    case "backlog":
      return `Not delivered: ${to} has too many messages waiting. Wait until it has worked through them (read it with read_session).`;
  }
}

export function resetMessageGuardForTests(): void {
  sent = [];
  waiting.clear();
}

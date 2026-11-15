import { DEFAULT_OUTPUT_STYLE } from "./outputStyles";
import type { ToolAccessMode } from "./configSchema";

/**
 * Settings that only apply to new conversations. Each session keeps the values
 * it started with, so changing them mid-conversation doesn't rewrite the
 * system prompt or tool list and throw away the cached prompt prefix.
 * Pins live in memory: after a restart the cache is cold anyway, so an older
 * conversation simply picks up the current values.
 */
export interface SessionSettings {
  outputStyle: string;
  toolAccessMode: ToolAccessMode;
}

const MAX_PINNED_SESSIONS = 200;
const pinned = new Map<string, SessionSettings>();

export function sessionSettingsFor(
  sessionKey: string | undefined,
  current: { outputStyle?: string; toolAccessMode?: ToolAccessMode },
): SessionSettings {
  const fresh: SessionSettings = {
    outputStyle: current.outputStyle ?? DEFAULT_OUTPUT_STYLE,
    toolAccessMode: current.toolAccessMode ?? "onDemand",
  };
  if (!sessionKey) return fresh;
  const existing = pinned.get(sessionKey);
  if (existing) return existing;
  pinned.set(sessionKey, fresh);
  while (pinned.size > MAX_PINNED_SESSIONS) {
    const oldest = pinned.keys().next().value;
    if (oldest === undefined) break;
    pinned.delete(oldest);
  }
  return fresh;
}

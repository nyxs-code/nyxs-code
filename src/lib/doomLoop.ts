export const DOOM_LOOP_THRESHOLD = 3;

const POLLING_TOOLS = /Output$|^TaskList$|^Browser|^Preview$|^AskUserQuestion$|^TodoWrite$/;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export class DoomLoopGuard {
  private lastKey = "";
  private repeats = 0;

  check(toolName: string, input: unknown): string | null {
    if (POLLING_TOOLS.test(toolName)) return null;
    const key = `${toolName}:${stableStringify(input)}`;
    if (key === this.lastKey) this.repeats++;
    else {
      this.lastKey = key;
      this.repeats = 1;
    }
    if (this.repeats < DOOM_LOOP_THRESHOLD) return null;
    return (
      `Not run: this is call number ${this.repeats} in a row to ${toolName} with exactly the same input, ` +
      `so it would only repeat the previous result. Change the input, try a different approach, ` +
      `or stop and tell the user what is blocking you.`
    );
  }

  /** How many identical calls in a row the last check saw. */
  get count(): number {
    return this.repeats;
  }

  /** The user let the repeated call run: count again from it, so they're asked again only after
   *  another full run of identical calls. */
  allow(): void {
    this.repeats = 1;
  }
}

/** What the user chose when asked about a repeated call: run it, or stop (with their own words
 *  when they typed an answer instead of picking an option). */
export type LoopDecision = { run: true } | { run: false; note?: string };

/** The tool result the model gets when the user stops a repeated call. */
export function loopStoppedMessage(toolName: string, note?: string): string {
  const said = note ? ` They said: "${note}".` : "";
  return (
    `Not run: you called ${toolName} several times in a row with exactly the same input, and the user ` +
    `chose to stop it.${said} Don't call it again with this input; follow what the user said, or tell ` +
    `them what is blocking you.`
  );
}

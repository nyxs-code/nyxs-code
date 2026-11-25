import { invoke } from "@/lib/ipc";
import { shellOwner } from "@/lib/shellOwners";

// Which sessions are open or working now. The app knows (the one on screen, those with a turn
// running); Settings and the timers ask here instead of reaching into App's state.

let check: (id: string) => boolean = () => false;

/** Set by the session list with what App says is open or working. */
export function setSessionInUseCheck(fn: (id: string) => boolean): void {
  check = fn;
}

/** The session is on screen or has a turn running. */
export function sessionInUse(id: string): boolean {
  return check(id);
}

/** The sessions whose agent started a command still running in the background. */
export async function sessionsWithBackgroundWork(): Promise<Set<string>> {
  const shells = await invoke<{ id: string; status: string }[]>("agent_bg_list").catch(() => []);
  const out = new Set<string>();
  for (const s of shells) {
    if (s.status !== "running") continue;
    const owner = shellOwner(s.id);
    if (owner) out.add(owner);
  }
  return out;
}

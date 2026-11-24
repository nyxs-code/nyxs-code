import type { ToolSet } from "ai";
import { movedIn } from "./commandBackground";

export type BackgroundShellEvent =
  /** `monitor`: started by the Monitor tool, so its new lines wake the agent too. */
  | { kind: "started"; id: string; command: string; description: string; monitor?: boolean }
  | { kind: "settled"; id: string };

/** A monitor's new lines are gathered this long before they wake the agent. */
export const MONITOR_BATCH_MS = 3000;
const MONITOR_MAX_LINES = 200;

const SHELL_ID_RE = /^Shell ID: (\S+)$/m;
const OUTPUT_STATUS_RE = /^\[status: ([a-z]+)/;
const TAIL_CHARS = 3000;

export const WAKE_HINT =
  "When it finishes you'll get a <task-notification> in this chat automatically, even after this turn ends, so don't poll it just to wait for it.";

function wrap(tools: ToolSet, name: string, after: (input: Record<string, unknown>, result: unknown) => unknown): void {
  const t = tools[name];
  const run = t?.execute;
  if (!t || !run) return;
  tools[name] = {
    ...t,
    execute: async (input: unknown, options: Parameters<typeof run>[1]) => {
      const result = await run(input, options);
      try {
        return after((input ?? {}) as Record<string, unknown>, result) ?? result;
      } catch {
        return result;
      }
    },
  };
}

export function trackBackgroundShells(tools: ToolSet, emit: (event: BackgroundShellEvent) => void): void {
  wrap(tools, "Bash", (input, result) => {
    if (typeof result !== "string") return;
    // Moved to the background while it ran (Ctrl+B, or its time limit): followed like one
    // started there; its result already says the agent will be told when it ends.
    const moved = movedIn(result);
    if (moved) {
      emit({ kind: "started", id: moved.shellId, command: String(input.command ?? ""), description: String(input.description ?? "") });
      return undefined;
    }
    if (input.run_in_background !== true) return;
    const id = SHELL_ID_RE.exec(result)?.[1];
    if (!id) return;
    emit({ kind: "started", id, command: String(input.command ?? ""), description: String(input.description ?? "") });
    return `${result}\n${WAKE_HINT}`;
  });
  wrap(tools, "Monitor", (input, result) => {
    const id = typeof result === "string" ? SHELL_ID_RE.exec(result)?.[1] : undefined;
    if (id) emit({ kind: "started", id, command: String(input.command ?? ""), description: String(input.description ?? ""), monitor: true });
    return undefined;
  });
  wrap(tools, "BashOutput", (input, result) => {
    const status = typeof result === "string" ? OUTPUT_STATUS_RE.exec(result)?.[1] : undefined;
    if (status && status !== "running") emit({ kind: "settled", id: String(input.shell_id ?? "") });
    return undefined;
  });
  wrap(tools, "KillShell", (input) => {
    emit({ kind: "settled", id: String(input.shell_id ?? "") });
    return undefined;
  });
}

export interface FinishedShell {
  id: string;
  title: string;
  command: string;
  /** "output" for a monitor's new lines (it keeps running); else how the shell ended. */
  status: string;
  code: number | null;
  tail: string;
  /** How many new lines a monitor printed (status "output"). */
  lines?: number;
}

export interface BackgroundWakerDeps {
  isTurnRunning: (chatId: string) => boolean;
  readTail: (shellId: string) => Promise<string>;
  wake: (chatId: string, shells: FinishedShell[]) => void;
}

interface Watched {
  chatId: string;
  command: string;
  description: string;
  monitor: boolean;
  /** A monitor's lines since it last woke the agent. */
  fresh: string[];
  finished?: FinishedShell;
}

const titleOf = (w: Watched) => w.description.trim() || w.command.split(/\r?\n/)[0].slice(0, 120);

export class BackgroundWaker {
  private shells = new Map<string, Watched>();
  private deps: BackgroundWakerDeps;
  private batches = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: BackgroundWakerDeps) {
    this.deps = deps;
  }

  onEvent(chatId: string, event: BackgroundShellEvent): void {
    if (event.kind === "started") {
      this.shells.set(event.id, { chatId, command: event.command, description: event.description, monitor: !!event.monitor, fresh: [] });
    } else {
      this.shells.delete(event.id);
    }
  }

  /** New output of a background shell (`bg-shell-output`); only a monitor's wakes the agent,
   *  once the lines of a few seconds are in. */
  output(id: string, text: string): void {
    const watched = this.shells.get(id);
    if (!watched?.monitor || watched.finished) return;
    watched.fresh.push(...text.split(/\r?\n/).filter((l) => l.length));
    if (watched.fresh.length > MONITOR_MAX_LINES) watched.fresh.splice(0, watched.fresh.length - MONITOR_MAX_LINES);
    if (this.batches.has(watched.chatId)) return;
    this.batches.set(
      watched.chatId,
      setTimeout(() => {
        this.batches.delete(watched.chatId);
        this.flush(watched.chatId);
      }, MONITOR_BATCH_MS),
    );
  }

  async exited(id: string, status: string, code: number | null): Promise<void> {
    const watched = this.shells.get(id);
    if (!watched || watched.finished) return;
    const tail = await this.deps.readTail(id).catch(() => "");
    if (!this.shells.has(id)) return;
    // Its last lines are in the tail the notice of its end carries.
    watched.fresh = [];
    watched.finished = {
      id,
      title: titleOf(watched),
      command: watched.command,
      status,
      code,
      tail: tail.length > TAIL_CHARS ? `…${tail.slice(-TAIL_CHARS)}` : tail,
    };
    this.flush(watched.chatId);
  }

  turnEnded(chatId: string): void {
    this.flush(chatId);
  }

  private flush(chatId: string): void {
    if (this.deps.isTurnRunning(chatId)) return;
    const ready: FinishedShell[] = [];
    for (const [id, w] of this.shells) {
      if (w.chatId !== chatId) continue;
      if (w.finished) {
        ready.push(w.finished);
        this.shells.delete(id);
      } else if (w.monitor && w.fresh.length) {
        const text = w.fresh.join("\n");
        ready.push({
          id,
          title: titleOf(w),
          command: w.command,
          status: "output",
          code: null,
          tail: text.length > TAIL_CHARS ? `…${text.slice(-TAIL_CHARS)}` : text,
          lines: w.fresh.length,
        });
        w.fresh = [];
      }
    }
    if (ready.length) this.deps.wake(chatId, ready);
  }
}

export function backgroundNotice(shells: FinishedShell[]): string {
  const blocks = shells.map((s) =>
    s.status === "output"
      ? `<monitor-event>\n<shell-id>${s.id}</shell-id>\n<description>${s.title}</description>\n<new-lines count="${s.lines ?? 0}">\n${s.tail.trimEnd()}\n</new-lines>\n</monitor-event>`
      : `<task-notification>\n<shell-id>${s.id}</shell-id>\n<description>${s.title}</description>\n<status>${s.status}</status>\n<exit-code>${s.code ?? "unknown"}</exit-code>\n<output-tail>\n${s.tail.trimEnd() || "(no output)"}\n</output-tail>\n</task-notification>`,
  );
  const events = shells.filter((s) => s.status === "output").length;
  const ended = shells.length - events;
  const leads: string[] = [];
  if (events) {
    leads.push(
      `${events === 1 ? "A monitor you started printed new lines" : `${events} monitors you started printed new lines`}. ` +
        "React to them if they matter for what the user asked; otherwise end your turn without a reply. " +
        "Monitors keep running: stop one with KillShell once you no longer need it.",
    );
  }
  if (ended) {
    leads.push(
      `${ended === 1 ? "A background command you started has finished" : `${ended} background commands you started have finished`}. ` +
        "Carry on with what you planned for when it finished. If nothing was planned, tell the user briefly what happened.",
    );
  }
  return `${blocks.join("\n")}\n\n${leads.join("\n")}`;
}

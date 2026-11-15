import type { ToolSet } from "ai";

export type BackgroundShellEvent =
  | { kind: "started"; id: string; command: string; description: string }
  | { kind: "settled"; id: string };

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
    if (input.run_in_background !== true || typeof result !== "string") return;
    const id = SHELL_ID_RE.exec(result)?.[1];
    if (!id) return;
    emit({ kind: "started", id, command: String(input.command ?? ""), description: String(input.description ?? "") });
    return `${result}\n${WAKE_HINT}`;
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
  status: string;
  code: number | null;
  tail: string;
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
  finished?: FinishedShell;
}

export class BackgroundWaker {
  private shells = new Map<string, Watched>();
  private deps: BackgroundWakerDeps;

  constructor(deps: BackgroundWakerDeps) {
    this.deps = deps;
  }

  onEvent(chatId: string, event: BackgroundShellEvent): void {
    if (event.kind === "started") {
      this.shells.set(event.id, { chatId, command: event.command, description: event.description });
    } else {
      this.shells.delete(event.id);
    }
  }

  async exited(id: string, status: string, code: number | null): Promise<void> {
    const watched = this.shells.get(id);
    if (!watched || watched.finished) return;
    const tail = await this.deps.readTail(id).catch(() => "");
    if (!this.shells.has(id)) return;
    watched.finished = {
      id,
      title: watched.description.trim() || watched.command.split(/\r?\n/)[0].slice(0, 120),
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
      if (w.chatId !== chatId || !w.finished) continue;
      ready.push(w.finished);
      this.shells.delete(id);
    }
    if (ready.length) this.deps.wake(chatId, ready);
  }
}

export function backgroundNotice(shells: FinishedShell[]): string {
  const blocks = shells.map(
    (s) =>
      `<task-notification>\n<shell-id>${s.id}</shell-id>\n<description>${s.title}</description>\n<status>${s.status}</status>\n<exit-code>${s.code ?? "unknown"}</exit-code>\n<output-tail>\n${s.tail.trimEnd() || "(no output)"}\n</output-tail>\n</task-notification>`,
  );
  const lead =
    shells.length === 1
      ? "A background command you started has finished."
      : `${shells.length} background commands you started have finished.`;
  return `${blocks.join("\n")}\n\n${lead} Carry on with what you planned for when it finished. If nothing was planned, tell the user briefly what happened.`;
}

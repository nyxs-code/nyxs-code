import { stripAnsi } from "@/lib/ansi";

/** Run buttons in the chat start their command in a shell of their own, without opening the
 *  Terminal panel. "Open in terminal" hands that shell to the panel, which shows it as a tab
 *  (with everything it printed so far). The panel may not be mounted yet when that is clicked,
 *  so the request waits here until the visible TerminalView takes it. */

let adoptQueue: string[] = [];
const listeners = new Set<() => void>();

/** Asks the Terminal panel to show this shell: its tab if it already has one, a new tab if not. */
export function showInTerminal(termId: string): void {
  adoptQueue.push(termId);
  listeners.forEach((l) => l());
}

export function takeTerminalAdoptions(): string[] {
  const taken = adoptQueue;
  adoptQueue = [];
  return taken;
}

export function subscribeTerminalAdoptions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the chat shows of a terminal run: the shell's raw stream from the line where it echoed
 *  the command (startup noise and the prompt before it are dropped) and, once it is done, without
 *  the fresh prompt it printed after (the last, unterminated line). */
export function terminalRunOutput(raw: string, command: string, done: boolean): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const echo = command.split("\n")[0].trim();
  let at = echo ? lines.findIndex((l) => stripAnsi(l.slice(l.lastIndexOf("\r") + 1)).includes(echo)) : -1;
  // No echo found: the shell's own first line still isn't output.
  if (at < 0) at = 0;
  // Until the echo's line is finished nothing after it exists yet.
  if (at === lines.length - 1) return "";
  let body = lines.slice(at + 1);
  if (done) body = body.slice(0, -1);
  return body.join("\n").replace(/\n+$/, "");
}

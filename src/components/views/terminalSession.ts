/** A terminal's output around the moment its id becomes known: the shell can print (its prompt)
 *  before term_open answers, and that output would be dropped as nobody's. It is kept until the
 *  id is known, then only that terminal's output goes through. */
export class TerminalOutputGate {
  private id = "";
  private early: { id: string; data: string }[] = [];
  private readonly write: (data: string) => void;
  private readonly max: number;

  constructor(write: (data: string) => void, max = 256) {
    this.write = write;
    this.max = max;
  }

  receive(id: string, data: string): void {
    if (this.id) {
      if (id === this.id) this.write(data);
      return;
    }
    if (this.early.length < this.max) this.early.push({ id, data });
  }

  start(id: string): void {
    this.id = id;
    for (const e of this.early) if (e.id === id) this.write(e.data);
    this.early = [];
  }
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Opens a shell, or closes it again and answers null when the terminal was closed while it
 *  opened: nothing would close it later, and it would run on unseen. */
export async function openTerminal(
  invoke: Invoke,
  args: { cwd: string | null; rows: number; cols: number },
  isDisposed: () => boolean,
): Promise<string | null> {
  const id = (await invoke("term_open", args)) as string;
  if (!isDisposed()) return id;
  void invoke("term_close", { id });
  return null;
}

/** Keeps a listener to drop at cleanup, or drops it now when cleanup already ran (it was still
 *  being registered then). */
export function keepUnless(isDisposed: () => boolean, kept: (() => void)[], unlisten: () => void): void {
  if (isDisposed()) unlisten();
  else kept.push(unlisten);
}

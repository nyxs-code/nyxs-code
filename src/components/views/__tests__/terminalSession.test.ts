import { describe, expect, it, vi } from "vitest";
import { keepUnless, openTerminal, TerminalOutputGate } from "@/components/views/terminalSession";

describe("a terminal being opened", () => {
  it("keeps what the shell printed before its id was known, and only its own", () => {
    const written: string[] = [];
    const gate = new TerminalOutputGate((d) => written.push(d));
    gate.receive("t1", "prompt> ");
    gate.receive("other", "not mine");
    gate.start("t1");
    gate.receive("t1", "ls");
    gate.receive("other", "still not mine");
    expect(written).toEqual(["prompt> ", "ls"]);
  });

  it("closes the shell it opened when the terminal was closed meanwhile", async () => {
    let closed = false;
    const invoke = vi.fn(async (cmd: string) => (cmd === "term_open" ? "t9" : undefined));
    expect(await openTerminal(invoke, { cwd: null, rows: 24, cols: 80 }, () => closed)).toBe("t9");
    closed = true;
    expect(await openTerminal(invoke, { cwd: null, rows: 24, cols: 80 }, () => closed)).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("term_close", { id: "t9" });
  });

  it("drops a listener that arrives after the terminal closed", () => {
    const kept: (() => void)[] = [];
    const unlisten = vi.fn();
    keepUnless(() => true, kept, unlisten);
    expect(unlisten).toHaveBeenCalled();
    expect(kept).toEqual([]);
    keepUnless(() => false, kept, unlisten);
    expect(kept).toEqual([unlisten]);
  });
});

import { describe, it, expect, vi } from "vitest";
import type { ToolSet } from "ai";
import {
  BackgroundWaker,
  MONITOR_BATCH_MS,
  WAKE_HINT,
  backgroundNotice,
  trackBackgroundShells,
  type BackgroundShellEvent,
  type FinishedShell,
} from "@/lib/backgroundWake";

const opts = { toolCallId: "c", messages: [] };
type Exec = (input: unknown, o: typeof opts) => Promise<unknown>;
const call = (tools: ToolSet, name: string, input: unknown) => (tools[name].execute as unknown as Exec)(input, opts);

function shellTools(): ToolSet {
  return {
    Bash: {
      inputSchema: {},
      execute: async (input: { run_in_background?: boolean }) =>
        input.run_in_background ? "Command started in the background.\nShell ID: sh-1\nUse BashOutput to read it." : "[exit code: 0]\nok",
    },
    BashOutput: { inputSchema: {}, execute: async (input: { shell_id: string }) => (input.shell_id === "done" ? "[status: done, exit code: 0]\nbye" : "[status: running]\n(no new output)") },
    KillShell: { inputSchema: {}, execute: async () => "killed" },
  } as unknown as ToolSet;
}

describe("trackBackgroundShells", () => {
  it("reports started shells and tells the model it will be notified", async () => {
    const tools = shellTools();
    const events: BackgroundShellEvent[] = [];
    trackBackgroundShells(tools, (e) => events.push(e));
    const out = await call(tools, "Bash", { command: "npm run build", description: "Build", run_in_background: true });
    expect(events).toEqual([{ kind: "started", id: "sh-1", command: "npm run build", description: "Build" }]);
    expect(String(out)).toContain("Shell ID: sh-1");
    expect(String(out)).toContain(WAKE_HINT);
    expect(await call(tools, "Bash", { command: "ls" })).toBe("[exit code: 0]\nok");
    expect(events).toHaveLength(1);
  });

  it("follows a command moved to the background, and a monitor, as started shells", async () => {
    const tools = {
      ...shellTools(),
      Bash: { inputSchema: {}, execute: async () => "[moved to the background: bash_7, by the user]\nIt keeps running." },
      Monitor: { inputSchema: {}, execute: async () => "Monitor started.\nShell ID: bash_8\n…" },
    } as unknown as ToolSet;
    const events: BackgroundShellEvent[] = [];
    trackBackgroundShells(tools, (e) => events.push(e));
    await call(tools, "Bash", { command: "npm run build", description: "Build" });
    await call(tools, "Monitor", { command: "tail -f app.log", description: "Errors" });
    expect(events).toEqual([
      { kind: "started", id: "bash_7", command: "npm run build", description: "Build" },
      { kind: "started", id: "bash_8", command: "tail -f app.log", description: "Errors", monitor: true },
    ]);
  });

  it("marks a shell as seen when the model reads its final status or stops it", async () => {
    const tools = shellTools();
    const events: BackgroundShellEvent[] = [];
    trackBackgroundShells(tools, (e) => events.push(e));
    await call(tools, "BashOutput", { shell_id: "still" });
    await call(tools, "BashOutput", { shell_id: "done" });
    await call(tools, "KillShell", { shell_id: "k" });
    expect(events).toEqual([{ kind: "settled", id: "done" }, { kind: "settled", id: "k" }]);
  });
});

function waker(running = new Set<string>()) {
  const wakes: Array<{ chatId: string; shells: FinishedShell[] }> = [];
  const w = new BackgroundWaker({
    isTurnRunning: (chatId) => running.has(chatId),
    readTail: async (id) => `output of ${id}`,
    wake: (chatId, shells) => wakes.push({ chatId, shells }),
  });
  return { w, wakes, running };
}

const started = (id: string, description = ""): BackgroundShellEvent => ({ kind: "started", id, command: `cmd ${id}`, description });

describe("BackgroundWaker", () => {
  it("wakes the chat that started a shell once it exits", async () => {
    const { w, wakes } = waker();
    w.onEvent("chat-a", started("s1", "Watch CI"));
    await w.exited("s1", "done", 0);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].chatId).toBe("chat-a");
    expect(wakes[0].shells[0]).toMatchObject({ id: "s1", title: "Watch CI", status: "done", code: 0, tail: "output of s1" });
  });

  it("waits for a running turn to end, then wakes once with every finished shell", async () => {
    const { w, wakes, running } = waker(new Set(["chat-a"]));
    w.onEvent("chat-a", started("s1"));
    w.onEvent("chat-a", started("s2"));
    await w.exited("s1", "done", 0);
    await w.exited("s2", "done", 1);
    expect(wakes).toHaveLength(0);
    running.delete("chat-a");
    w.turnEnded("chat-a");
    expect(wakes).toHaveLength(1);
    expect(wakes[0].shells.map((s) => s.id)).toEqual(["s1", "s2"]);
    w.turnEnded("chat-a");
    expect(wakes).toHaveLength(1);
  });

  it("does not wake when the model already saw the shell finish, or for shells it didn't start", async () => {
    const { w, wakes } = waker();
    w.onEvent("chat-a", started("s1"));
    w.onEvent("chat-a", { kind: "settled", id: "s1" });
    await w.exited("s1", "done", 0);
    await w.exited("unknown", "done", 0);
    expect(wakes).toHaveLength(0);
  });

  it("keeps shells of different chats apart", async () => {
    const { w, wakes, running } = waker(new Set(["chat-a"]));
    w.onEvent("chat-a", started("a1"));
    w.onEvent("chat-b", started("b1"));
    await w.exited("a1", "done", 0);
    await w.exited("b1", "killed", null);
    expect(wakes.map((x) => x.chatId)).toEqual(["chat-b"]);
    running.clear();
    w.turnEnded("chat-a");
    expect(wakes.map((x) => x.chatId)).toEqual(["chat-b", "chat-a"]);
  });

  it("uses the first line of the command when there is no description and clips long output", async () => {
    const wakes: FinishedShell[][] = [];
    const w = new BackgroundWaker({ isTurnRunning: () => false, readTail: async () => "x".repeat(5000), wake: (_c, s) => wakes.push(s) });
    w.onEvent("c", { kind: "started", id: "s", command: "npm test\necho done", description: "" });
    await w.exited("s", "done", 0);
    expect(wakes[0][0].title).toBe("npm test");
    expect(wakes[0][0].tail.length).toBeLessThanOrEqual(3001);
  });
});

describe("a monitor", () => {
  it("wakes its chat with the lines of a few seconds at once, and goes on watching", async () => {
    vi.useFakeTimers();
    try {
      const { w, wakes } = waker();
      w.onEvent("chat-a", { kind: "started", id: "m1", command: "tail -f app.log", description: "Errors", monitor: true });
      w.output("m1", "ERROR one");
      w.output("m1", "ERROR two\nERROR three");
      expect(wakes).toHaveLength(0);
      vi.advanceTimersByTime(MONITOR_BATCH_MS);
      expect(wakes).toHaveLength(1);
      expect(wakes[0].shells[0]).toMatchObject({ id: "m1", status: "output", lines: 3, tail: "ERROR one\nERROR two\nERROR three" });
      // Still watched: the next lines wake it again.
      w.output("m1", "ERROR four");
      vi.advanceTimersByTime(MONITOR_BATCH_MS);
      expect(wakes).toHaveLength(2);
      expect(wakes[1].shells[0].lines).toBe(1);
      // A plain background shell's output wakes nothing.
      w.onEvent("chat-a", started("s1"));
      w.output("s1", "building…");
      vi.advanceTimersByTime(MONITOR_BATCH_MS);
      expect(wakes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a running reply to end before it wakes", () => {
    vi.useFakeTimers();
    try {
      const { w, wakes, running } = waker(new Set(["chat-a"]));
      w.onEvent("chat-a", { kind: "started", id: "m1", command: "watch", description: "", monitor: true });
      w.output("m1", "event");
      vi.advanceTimersByTime(MONITOR_BATCH_MS);
      expect(wakes).toHaveLength(0);
      running.clear();
      w.turnEnded("chat-a");
      expect(wakes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the model its new lines and says it keeps running", () => {
    const text = backgroundNotice([{ id: "m1", title: "Errors", command: "tail -f", status: "output", code: null, tail: "ERROR 500", lines: 1 }]);
    expect(text).toContain("<monitor-event>");
    expect(text).toContain('<new-lines count="1">\nERROR 500');
    expect(text).toContain("KillShell");
    expect(text).not.toContain("<task-notification>");
  });
});

describe("backgroundNotice", () => {
  it("gives the model the status, exit code and output of each shell", () => {
    const text = backgroundNotice([
      { id: "s1", title: "Build", command: "npm run build", status: "done", code: 0, tail: "built ok\n" },
      { id: "s2", title: "Tests", command: "npm test", status: "done", code: 1, tail: "" },
    ]);
    expect(text).toContain("<shell-id>s1</shell-id>");
    expect(text).toContain("<exit-code>1</exit-code>");
    expect(text).toContain("built ok");
    expect(text).toContain("(no output)");
    expect(text).toContain("2 background commands you started have finished.");
  });
});

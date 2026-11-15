import { describe, it, expect, vi } from "vitest";
import type { ToolSet } from "ai";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { trackShellChanges } = await import("@/lib/shellChanges");
const { planShellRestore, restoreShellChanges, fileHistoryRecordShellChange, fileHistoryRewindPreview, fileHistoryRewind, emptyFileHistoryState } =
  await import("@/lib/fileHistory");
const { invoke } = await import("@tauri-apps/api/core");
const { createFileActivityLog, contestedShellFiles, noteToolActivity } = await import("@/lib/fileActivity");

type Disk = Map<string, string>;

function fakeShadow(disk: Disk) {
  const trees = new Map<string, Disk>();
  let seq = 0;
  const snapshot = vi.fn(async () => {
    const key = `t${seq++}`;
    trees.set(key, new Map(disk));
    for (const [k, v] of trees) if (k !== key && sameDisk(v, disk)) {
      trees.delete(key);
      seq--;
      return k;
    }
    return key;
  });
  const diff = vi.fn(async (_ws: string, from: string, to: string) => {
    const a = trees.get(from)!;
    const b = trees.get(to)!;
    const names = new Set([...a.keys(), ...b.keys()]);
    return [...names].filter((n) => a.get(n) !== b.get(n)).sort();
  });
  const restore = vi.fn(async (tree: string, files: string[]) => {
    const t = trees.get(tree)!;
    for (const f of files) {
      const v = t.get(f);
      if (v === undefined) disk.delete(f);
      else disk.set(f, v);
    }
    return files.length;
  });
  const readAt = vi.fn(async (_ws: string, tree: string, file: string) => trees.get(tree)?.get(file) ?? null);
  return { snapshot, diff, restore, readAt };
}

function sameDisk(a: Disk, b: Disk) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

const opts = { toolCallId: "c", messages: [] };
type Exec = (input: unknown, o: typeof opts) => Promise<unknown>;

function fakeShells() {
  const statuses = new Map<string, string>();
  let handler: ((id: string, status?: string) => void) | undefined;
  let seq = 0;
  const unlisten = vi.fn();
  return {
    statuses,
    launchStatus: "running",
    nextId: () => `bash_${seq++}`,
    status: vi.fn(async (id: string) => statuses.get(id)),
    onExit: vi.fn(async (h: (id: string, status?: string) => void) => {
      handler = h;
      return unlisten;
    }),
    exit(id: string, status = "done") {
      statuses.set(id, status);
      handler?.(id, status);
    },
    unlisten,
  };
}

function bashTool(disk: Disk, shells = fakeShells()) {
  return {
    Bash: {
      description: "bash",
      inputSchema: {},
      execute: async (input: { command: string; run_in_background?: boolean }) => {
        const m = /^write (\S+) (.*)$/.exec(input.command);
        if (m) disk.set(m[1], m[2]);
        const rm = /^rm (\S+)$/.exec(input.command);
        if (rm) disk.delete(rm[1]);
        if (!input.run_in_background) return "ok";
        const id = shells.nextId();
        shells.statuses.set(id, shells.launchStatus);
        return `Command started in the background.\nShell ID: ${id}\nIts output streams live in the Terminal view.`;
      },
    },
  } as unknown as ToolSet;
}

describe("trackShellChanges", () => {
  it("records the files a command changed, between snapshots taken around it", async () => {
    const disk: Disk = new Map([["a.txt", "1"]]);
    const shadow = fakeShadow(disk);
    const tools = bashTool(disk);
    const changes: unknown[] = [];
    let clock = 1000;
    trackShellChanges(tools, "ws", (c) => changes.push(c), { ...shadow, now: () => (clock += 5) });
    await (tools.Bash.execute as unknown as Exec)({ command: "write gen.txt hi" }, opts);
    expect(changes).toEqual([{ before: "t0", after: "t1", files: ["gen.txt"], startedAt: 1005, endedAt: 1010 }]);
  });

  it("skips read-only commands and commands that change nothing", async () => {
    const disk: Disk = new Map([["a.txt", "1"]]);
    const shadow = fakeShadow(disk);
    const tools = bashTool(disk);
    const changes: unknown[] = [];
    trackShellChanges(tools, "ws", (c) => changes.push(c), shadow);
    await (tools.Bash.execute as unknown as Exec)({ command: "git status" }, opts);
    expect(shadow.snapshot).not.toHaveBeenCalled();
    await (tools.Bash.execute as unknown as Exec)({ command: "echo nothing > NUL" }, opts);
    expect(changes).toEqual([]);
  });

  it("closes a background command's window when its process exits", async () => {
    const disk: Disk = new Map();
    const shadow = fakeShadow(disk);
    const shells = fakeShells();
    const tools = bashTool(disk, shells);
    const changes: Array<{ files: string[] }> = [];
    const tracker = trackShellChanges(tools, "ws", (c) => changes.push(c), { ...shadow, ...shells });
    await (tools.Bash.execute as unknown as Exec)({ command: "npm run build", run_in_background: true }, opts);
    disk.set("dist/out.js", "built");
    shells.exit("bash_0");
    disk.set("notes.txt", "another session, after the build ended");
    await tracker.finish();
    expect(changes.map((c) => c.files)).toEqual([["dist/out.js"]]);
    expect(shells.unlisten).toHaveBeenCalledOnce();
  });

  it("attributes a background command that ends on its own shortly after its turn", async () => {
    const disk: Disk = new Map([["src/a.ts", "1"]]);
    const shadow = fakeShadow(disk);
    const shells = fakeShells();
    const tools = bashTool(disk, shells);
    const changes: Array<{ files: string[] }> = [];
    const tracker = trackShellChanges(tools, "ws", (c) => changes.push(c), { ...shadow, ...shells });
    await (tools.Bash.execute as unknown as Exec)({ command: "npm run build", run_in_background: true }, opts);
    await tracker.finish();
    expect(shells.unlisten).not.toHaveBeenCalled();
    disk.set("dist/out.js", "built");
    shells.exit("bash_0");
    await vi.waitFor(() => expect(changes.map((c) => c.files)).toEqual([["dist/out.js"]]));
    expect(shells.unlisten).toHaveBeenCalledOnce();
  });

  it("records nothing for a server stopped by hand after its turn", async () => {
    const disk: Disk = new Map();
    const shadow = fakeShadow(disk);
    const shells = fakeShells();
    const tools = bashTool(disk, shells);
    const changes: unknown[] = [];
    const tracker = trackShellChanges(tools, "ws", (c) => changes.push(c), { ...shadow, ...shells });
    await (tools.Bash.execute as unknown as Exec)({ command: "npm run dev", run_in_background: true }, opts);
    disk.set("src/config.ts", "edited by the user while the server ran");
    await tracker.finish();
    shells.exit("bash_0", "killed");
    await tracker.finish();
    expect(changes).toEqual([]);
    expect(shadow.snapshot).toHaveBeenCalledOnce();
    expect(shells.unlisten).toHaveBeenCalledOnce();
  });

  it("records nothing for a background command that outlives the late window", async () => {
    vi.useFakeTimers();
    try {
      const disk: Disk = new Map();
      const shadow = fakeShadow(disk);
      const shells = fakeShells();
      const tools = bashTool(disk, shells);
      const changes: unknown[] = [];
      const tracker = trackShellChanges(tools, "ws", (c) => changes.push(c), { ...shadow, ...shells, lateExitWindowMs: 1000 });
      await (tools.Bash.execute as unknown as Exec)({ command: "npm run watch", run_in_background: true }, opts);
      await tracker.finish();
      disk.set("src/config.ts", "edited by another session meanwhile");
      await vi.advanceTimersByTimeAsync(1001);
      expect(shells.unlisten).toHaveBeenCalledOnce();
      shells.exit("bash_0");
      await vi.runAllTimersAsync();
      expect(changes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a background command that exited before it was watched, or whose exit event is late", async () => {
    const disk: Disk = new Map();
    const shadow = fakeShadow(disk);
    const shells = fakeShells();
    shells.launchStatus = "done";
    const tools = bashTool(disk, shells);
    const changes: Array<{ files: string[] }> = [];
    const tracker = trackShellChanges(tools, "ws", (c) => changes.push(c), { ...shadow, ...shells });
    await (tools.Bash.execute as unknown as Exec)({ command: "write quick.txt x", run_in_background: true }, opts);
    shells.launchStatus = "running";
    await (tools.Bash.execute as unknown as Exec)({ command: "write slow.txt y", run_in_background: true }, opts);
    shells.statuses.set("bash_1", "done");
    await tracker.finish();
    expect(changes.map((c) => c.files)).toEqual([["quick.txt"], ["slow.txt"]]);
  });
});

describe("reverting shell changes", () => {
  it("restores what the agent's commands did and keeps a third party's concurrent edits", async () => {
    const disk: Disk = new Map([["agent.txt", "v1"], ["shared.txt", "orig"], ["other.txt", "orig"]]);
    const shadow = fakeShadow(disk);
    const tools = bashTool(disk);
    let state = emptyFileHistoryState();
    state = { ...state, snapshots: [{ messageId: "m1", trackedFileBackups: {}, timestamp: 0 }] };
    const update = (fn: (s: typeof state) => typeof state) => {
      state = fn(state);
    };
    trackShellChanges(tools, "ws", (c) => fileHistoryRecordShellChange(update, "m1", c), shadow);

    disk.set("other.txt", "edited by another session before the command");
    await (tools.Bash.execute as unknown as Exec)({ command: "write agent.txt v2" }, opts);
    await (tools.Bash.execute as unknown as Exec)({ command: "write shared.txt agent" }, opts);
    disk.set("other.txt", "edited by another session after the command");
    disk.set("shared.txt", "edited by the user afterwards");
    await (tools.Bash.execute as unknown as Exec)({ command: "write created.txt new" }, opts);

    const items = planShellRestore(state.snapshots, 0, [], "ws");
    expect(items.map((i) => i.file).sort()).toEqual(["agent.txt", "created.txt", "shared.txt"]);

    const restored = await restoreShellChanges("ws", items, shadow.snapshot, shadow.diff, shadow.restore);
    expect(restored).toBe(2);
    expect(disk.get("agent.txt")).toBe("v1");
    expect(disk.has("created.txt")).toBe(false);
    expect(disk.get("shared.txt")).toBe("edited by the user afterwards");
    expect(disk.get("other.txt")).toBe("edited by another session after the command");
  });

  it("previews the files a rewind restores, shell ones included, each counted once", async () => {
    const disk: Disk = new Map([["agent.txt", "v1"], ["shared.txt", "orig"], ["edited.txt", "e1"]]);
    const shadow = fakeShadow(disk);
    const tools = bashTool(disk);
    let state = emptyFileHistoryState();
    state = {
      ...state,
      snapshots: [{ messageId: "m1", trackedFileBackups: { "ws/edited.txt": { backupFileName: "b1", version: 1 } }, timestamp: 0 }],
      trackedFiles: new Set(["ws/edited.txt"]),
    };
    const update = (fn: (s: typeof state) => typeof state) => {
      state = fn(state);
    };
    trackShellChanges(tools, "ws", (c) => fileHistoryRecordShellChange(update, "m1", c), shadow);
    const bash = (command: string) => (tools.Bash.execute as unknown as Exec)({ command }, opts);

    await bash("write agent.txt v2");
    await bash("write shared.txt agent");
    // Also edited with Edit/Write: its backup covers it, so the shell side must not count it again.
    await bash("write edited.txt from-shell");
    await bash("write created.txt new");
    // Created and removed again: nothing left to restore.
    await bash("write gone.txt x");
    await bash("rm gone.txt");
    disk.set("shared.txt", "edited by the user afterwards");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "agent_fh_origin_changed") return true;
      if (cmd === "agent_read_text") return "edited\n";
      if (cmd === "agent_fh_read_backup") return "orig\n";
      return null;
    });
    const readNow = async (path: string) => disk.get(path.replace(/^ws\//, "")) ?? null;
    const preview = await fileHistoryRewindPreview(state, "ws", "s1", "m1", { ...shadow, readNow });
    vi.mocked(invoke).mockReset();

    // shared.txt changed after the command, so a rewind keeps the user's version: not listed.
    expect(preview.paths).toEqual(["agent.txt", "created.txt", "edited.txt"]);
    expect(preview.files).toBe(3);
    // agent.txt v2→v1 (+1 −1), created.txt deleted (−1), edited.txt edited→orig (+1 −1).
    expect(preview).toMatchObject({ added: 2, removed: 3 });

    const items = planShellRestore(state.snapshots, 0, state.trackedFiles, "ws");
    const restored = await restoreShellChanges("ws", items, shadow.snapshot, shadow.diff, shadow.restore);
    // gone.txt is put back to "absent" as well (a no-op), the preview leaves it out.
    expect(restored).toBe(3);
    expect(disk.get("agent.txt")).toBe("v1");
    expect(disk.has("created.txt")).toBe(false);
  });

  /** A turn of session "me" whose commands are judged against a shared activity log, on a clock
   *  that moves 10 s per command so the windows don't touch. */
  function contestedTurn(disk: Disk) {
    const shadow = fakeShadow(disk);
    let clock = 100_000;
    const now = () => clock;
    const log = createFileActivityLog(now);
    let during: (() => void) | undefined;
    const tools = {
      Bash: {
        description: "bash",
        inputSchema: {},
        execute: async (input: { command: string }) => {
          clock += 5_000;
          for (const part of input.command.split(" && ")) {
            const m = /^write (\S+) (.*)$/.exec(part);
            if (m) disk.set(m[1], m[2]);
          }
          during?.();
          during = undefined;
          clock += 5_000;
          return "ok";
        },
      },
    } as unknown as ToolSet;
    let state = emptyFileHistoryState();
    state = { ...state, snapshots: [{ messageId: "m1", trackedFileBackups: {}, timestamp: 0 }] };
    const update = (fn: (s: typeof state) => typeof state) => {
      state = fn(state);
    };
    // What assistantTurn does with each change.
    trackShellChanges(tools, "ws", (c) => {
      const contested = contestedShellFiles(log, "me", "ws", c);
      fileHistoryRecordShellChange(update, "m1", contested.length ? { ...c, contested } : c);
    }, { ...shadow, now });
    return {
      shadow,
      log,
      tick: (ms: number) => (clock += ms),
      bash: (command: string, meanwhile?: () => void) => {
        during = meanwhile;
        return (tools.Bash.execute as unknown as Exec)({ command }, opts);
      },
      plan: () => planShellRestore(state.snapshots, 0, [], "ws"),
      preview: () =>
        fileHistoryRewindPreview(state, "ws", "me", "m1", { ...shadow, readNow: async (p) => disk.get(p.replace(/^ws\//, "")) ?? null }),
      restore: () => restoreShellChanges("ws", planShellRestore(state.snapshots, 0, [], "ws"), shadow.snapshot, shadow.diff, shadow.restore),
    };
  }

  it("leaves a file another session edited while the agent's command ran", async () => {
    const disk: Disk = new Map([["notes.md", "orig"]]);
    const turn = contestedTurn(disk);
    // Another session's Edit lands in the middle of the command: both changes are in its "after".
    await turn.bash("write gen.txt built", () => {
      turn.log.editing("other", "ws/notes.md");
      disk.set("notes.md", "written by the other session");
      turn.log.end("other");
    });
    expect(turn.plan().find((i) => i.file === "notes.md")?.contested).toBe(true);

    const preview = await turn.preview();
    expect(preview.paths).toEqual(["gen.txt"]);
    expect(preview.kept).toEqual(["notes.md"]);
    expect(await turn.restore()).toBe(1);
    expect(disk.has("gen.txt")).toBe(false);
    expect(disk.get("notes.md")).toBe("written by the other session");
  });

  it("leaves everything when another session ran a command at the same time, its files being unknown", async () => {
    const disk: Disk = new Map();
    const turn = contestedTurn(disk);
    noteToolActivity(turn.log, "other", "call1", { name: "Bash", detail: "cargo fmt" });
    await turn.bash("write a.txt 1 && write b.txt 2");
    noteToolActivity(turn.log, "other", "call1", { name: "Bash", detail: "cargo fmt", endedAt: 1 });
    // Later commands of this turn don't overlap it any more.
    turn.tick(10_000);
    await turn.bash("write c.txt 3");
    expect((await turn.preview()).kept).toEqual(["a.txt", "b.txt"]);
    expect(await turn.restore()).toBe(1);
    expect([...disk.keys()].sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("doesn't take a read-only command of another session, or edits outside the command, for a clash", async () => {
    const disk: Disk = new Map([["notes.md", "orig"]]);
    const turn = contestedTurn(disk);
    noteToolActivity(turn.log, "other", "call1", { name: "Bash", detail: "git status" });
    turn.log.editing("other", "ws/notes.md");
    disk.set("notes.md", "the other session, before the command");
    turn.log.end("other");
    turn.tick(10_000);
    await turn.bash("write gen.txt built");
    // The same session editing its own files meanwhile isn't someone else.
    turn.log.editing("me", "ws/gen.txt");
    expect(turn.plan()).toEqual([{ file: "gen.txt", before: "t0", after: "t1" }]);
    expect(await turn.restore()).toBe(1);
    expect(disk.get("notes.md")).toBe("the other session, before the command");
  });

  it("leaves a file changed after the turn, and says so", async () => {
    const disk: Disk = new Map([["src/a.ts", "v1"]]);
    const turn = contestedTurn(disk);
    await turn.bash("write src/a.ts v2 && write gen.txt built");
    turn.tick(60_000);
    disk.set("src/a.ts", "the user, after the turn");
    const preview = await turn.preview();
    expect(preview.paths).toEqual(["gen.txt"]);
    expect(preview.kept).toEqual(["src/a.ts"]);
    expect(await turn.restore()).toBe(1);
    expect(disk.get("src/a.ts")).toBe("the user, after the turn");
  });

  it("keeps a file the agent's command and another session both changed, and restores the agent's other files", async () => {
    const disk: Disk = new Map([["src/shared.ts", "orig"], ["src/own.ts", "orig"]]);
    const turn = contestedTurn(disk);
    await turn.bash("write src/own.ts agent && write src/shared.ts agent", () => {
      turn.log.editing("other", "ws/src/shared.ts");
      disk.set("src/shared.ts", "agent + other session");
    });
    turn.log.end("other");
    const preview = await turn.preview();
    expect(preview.paths).toEqual(["src/own.ts"]);
    expect(preview.kept).toEqual(["src/shared.ts"]);
    expect(await turn.restore()).toBe(1);
    expect(disk.get("src/own.ts")).toBe("orig");
    expect(disk.get("src/shared.ts")).toBe("agent + other session");
  });

  it("doesn't list a kept file that is back as it was anyway", async () => {
    const disk: Disk = new Map([["notes.md", "orig"]]);
    const turn = contestedTurn(disk);
    await turn.bash("write gen.txt built", () => turn.log.wrote("user", "ws/notes.md"));
    await turn.bash("write notes.md changed");
    turn.tick(60_000);
    disk.set("notes.md", "orig");
    expect((await turn.preview()).kept).toEqual([]);
  });

  it("leaves the files as they are when it can't tell whether they changed since the command", async () => {
    const disk: Disk = new Map([["agent.txt", "v1"]]);
    const turn = contestedTurn(disk);
    await turn.bash("write agent.txt v2 && write gen.txt built");
    disk.set("agent.txt", "the user, after the turn");
    // The snapshots repository lost the command's tree: the comparison fails.
    turn.shadow.diff.mockImplementation(async () => undefined as unknown as string[]);
    const preview = await turn.preview();
    expect(preview.paths).toEqual([]);
    expect(preview.kept).toEqual(["agent.txt", "gen.txt"]);
    expect(await turn.restore()).toBe(0);
    expect(turn.shadow.restore).not.toHaveBeenCalled();
    expect(disk.get("agent.txt")).toBe("the user, after the turn");
    expect(disk.get("gen.txt")).toBe("built");
  });

  it("records nothing for a command whose changes can't be listed", async () => {
    const disk: Disk = new Map();
    const shadow = fakeShadow(disk);
    shadow.diff.mockImplementation(async () => undefined as unknown as string[]);
    const tools = bashTool(disk);
    const changes: unknown[] = [];
    trackShellChanges(tools, "ws", (c) => changes.push(c), shadow);
    await (tools.Bash.execute as unknown as Exec)({ command: "write gen.txt hi" }, opts);
    expect(changes).toEqual([]);
  });

  it("reports the files a rewind couldn't put back and restores the others", async () => {
    let state = emptyFileHistoryState();
    state = {
      ...state,
      snapshots: [{
        messageId: "m1",
        trackedFileBackups: { "ws/a.ts": { backupFileName: "a1", version: 1 }, "ws/b.ts": { backupFileName: "b1", version: 1 } },
        timestamp: 0,
      }],
      trackedFiles: new Set(["ws/a.ts", "ws/b.ts"]),
    };
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "agent_fh_restore") return null;
      if ((args as { path: string }).path === "ws/a.ts") throw new Error("Backup not found");
      return { restored: true, kept: false, hash: "h" };
    });
    const result = await fileHistoryRewind((fn) => void (state = fn(state)), "ws", "s1", "m1");
    vi.mocked(invoke).mockReset();
    expect(result).toEqual({ changed: 1, kept: [], failed: ["a.ts"] });
  });

  it("does nothing when the current state can't be read", async () => {
    const restore = vi.fn();
    const n = await restoreShellChanges("ws", [{ file: "a", before: "t0", after: "t1" }], async () => undefined, async () => [], restore);
    expect(n).toBe(0);
    expect(restore).not.toHaveBeenCalled();
  });
});

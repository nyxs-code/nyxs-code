import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { invoke } = await import("@tauri-apps/api/core");
const { trackAgentWrites } = await import("@/lib/agentWrites");
const { createFileActivityLog } = await import("@/lib/fileActivity");
const fh = await import("@/lib/fileHistory");
type State = import("@/lib/fileHistory").FileHistoryState;

const WS = "C:/ws";
const A = `${WS}/a.ts`;

/** The backend as far as the file history goes: files on disk, backups, and agent_fh_restore's
 *  rule (with an expected hash, only a file still holding it is put back). */
function fakeBackend() {
  const disk = new Map<string, string>();
  const backups = new Map<string, string>();
  const hashOf = (p: string) => (disk.has(p) ? `h:${disk.get(p)}` : "absent");
  const differs = (path: string, backup: string | null) =>
    backup === null ? disk.has(path) : disk.get(path) !== backups.get(backup);
  vi.mocked(invoke).mockImplementation((async (cmd: string, a: Record<string, unknown> = {}) => {
    const path = a.path as string;
    const backup = a.backupFileName as string | null;
    switch (cmd) {
      case "agent_fh_backup": {
        if (!disk.has(path)) return { backupFileName: null };
        const name = `${path}@v${a.version}`;
        backups.set(name, disk.get(path)!);
        return { backupFileName: name };
      }
      case "agent_fh_origin_changed":
        return differs(path, backup);
      case "agent_fh_hash":
        return hashOf(path);
      case "agent_fh_restore": {
        const now = hashOf(path);
        if (a.expectedHash != null && a.expectedHash !== now) return { restored: false, kept: true, hash: now };
        if (!differs(path, backup)) return { restored: false, kept: false, hash: now };
        if (backup === null) disk.delete(path);
        else disk.set(path, backups.get(backup)!);
        return { restored: true, kept: false, hash: hashOf(path) };
      }
      case "agent_read_text":
        return disk.get(path) ?? null;
      case "agent_fh_read_backup":
        return backups.get(backup!) ?? null;
      default:
        // No shadow snapshots: these tests are about the edit tools' side.
        return null;
    }
  }) as typeof invoke);
  return { disk };
}

/** One session ("me") whose turns edit files with the tools, next to other writers in the same
 *  activity log, on a clock that moves a second per step. */
function session() {
  const backend = fakeBackend();
  let clock = 1_000_000;
  const now = () => (clock += 1_000);
  const log = createFileActivityLog(now);
  let state: State = fh.emptyFileHistoryState();
  const update = (fn: (s: State) => State) => {
    state = fn(state);
  };
  let turns = 0;
  const turn = async () => {
    const id = `m${++turns}`;
    await fh.fileHistoryMakeSnapshot(update, WS, "me", id);
    const writes = trackAgentWrites("me", WS, id, update, { log, now });
    return {
      id,
      /** An Edit call: onFileEdit (backup), the write, the tool's end. `announce: false` is a
       *  CLI's second edit of the file in a turn, which onFileEdit doesn't report again. */
      edit: async (path: string, text: string, { announce = true } = {}) => {
        if (announce) {
          writes.willWrite(path);
          await fh.fileHistoryTrackEdit(update, WS, "me", path);
        }
        backend.disk.set(path, text);
        writes.tool({ name: "Edit", detail: path, endedAt: clock });
      },
      end: () => writes.finish().then(() => log.end("me")),
    };
  };
  return {
    disk: backend.disk,
    log,
    turn,
    state: () => state,
    preview: (messageId: string) => fh.fileHistoryRewindPreview(state, WS, "me", messageId),
    rewind: (messageId: string) => fh.fileHistoryRewind(update, WS, "me", messageId),
  };
}

beforeEach(() => vi.mocked(invoke).mockReset());

describe("rewinding files the agent edited", () => {
  it("restores a file nobody else touched", async () => {
    const s = session();
    s.disk.set(A, "orig");
    const t = await s.turn();
    await t.edit(A, "agent");
    await t.end();
    expect(s.state().snapshots[0].leftAs).toEqual({ [A]: { hash: "h:agent" } });
    expect(await s.preview(t.id)).toMatchObject({ files: 1, kept: [] });
    expect(await s.rewind(t.id)).toEqual({ changed: 1, kept: [] });
    expect(s.disk.get(A)).toBe("orig");
  });

  it("leaves a file another session edited after the agent, and says so", async () => {
    const s = session();
    s.disk.set(A, "orig");
    const t = await s.turn();
    await t.edit(A, "agent");
    await t.end();
    s.log.editing("other", A);
    s.disk.set(A, "agent + other session");
    s.log.end("other");
    expect(await s.preview(t.id)).toMatchObject({ files: 0, paths: [], kept: ["a.ts"] });
    expect(await s.rewind(t.id)).toEqual({ changed: 0, kept: ["a.ts"] });
    expect(s.disk.get(A)).toBe("agent + other session");
  });

  it("leaves a file another session wrote in the middle of the agent's turn", async () => {
    const s = session();
    s.disk.set(A, "orig");
    const t = await s.turn();
    await t.edit(A, "agent");
    s.log.editing("other", A);
    s.disk.set(A, "agent + other session");
    s.log.end("other");
    // The agent goes on from the other session's version: the hash alone would match.
    await t.edit(A, "agent + other session + agent again");
    await t.end();
    expect(s.state().snapshots[0].leftAs?.[A]).toEqual({ contested: true });
    expect(await s.rewind(t.id)).toEqual({ changed: 0, kept: ["a.ts"] });
    expect(s.disk.get(A)).toBe("agent + other session + agent again");
  });

  it("leaves a file the user saved in Nyxs' editor after the agent", async () => {
    const s = session();
    s.disk.set(A, "orig");
    const t = await s.turn();
    await t.edit(A, "agent");
    await t.end();
    s.log.wrote("user", A);
    s.disk.set(A, "agent + the user's fix");
    expect((await s.preview(t.id)).kept).toEqual(["a.ts"]);
    await s.rewind(t.id);
    expect(s.disk.get(A)).toBe("agent + the user's fix");
  });

  it("takes the hash of the agent's last write when it edits a file twice in a turn", async () => {
    const s = session();
    s.disk.set(A, "orig");
    const t = await s.turn();
    await t.edit(A, "first");
    // A CLI reports a file once per turn; the tool's end still names it.
    await t.edit(A, "second", { announce: false });
    await t.end();
    expect(s.state().snapshots[0].leftAs?.[A]).toEqual({ hash: "h:second" });
    expect(await s.rewind(t.id)).toEqual({ changed: 1, kept: [] });
    expect(s.disk.get(A)).toBe("orig");
  });

  it("leaves a file the agent didn't touch since the turn rewound to, if someone changed it", async () => {
    const s = session();
    s.disk.set(A, "orig");
    const t1 = await s.turn();
    await t1.edit(A, "agent");
    await t1.end();
    const t2 = await s.turn();
    await t2.end();
    s.disk.set(A, "the user, during turn 2");
    expect(await s.rewind(t2.id)).toEqual({ changed: 0, kept: ["a.ts"] });
    expect(s.disk.get(A)).toBe("the user, during turn 2");
  });

  it("can rewind again further back after a rewind put a file back", async () => {
    const s = session();
    s.disk.set(A, "orig");
    const t1 = await s.turn();
    await t1.edit(A, "turn 1");
    await t1.end();
    const t2 = await s.turn();
    await t2.edit(A, "turn 2");
    await t2.end();
    expect(await s.rewind(t2.id)).toEqual({ changed: 1, kept: [] });
    expect(s.disk.get(A)).toBe("turn 1");
    expect(await s.rewind(t1.id)).toEqual({ changed: 1, kept: [] });
    expect(s.disk.get(A)).toBe("orig");
  });

  it("restores a file of a turn saved before the hashes as it always did", async () => {
    const s = session();
    s.disk.set(A, "orig");
    const t = await s.turn();
    await t.edit(A, "agent");
    await t.end();
    // As an older Nyxs saved it: no leftAs.
    const old = s.state();
    old.snapshots = old.snapshots.map(({ leftAs: _, ...snap }) => snap);
    s.disk.set(A, "changed by someone");
    expect(await s.rewind(t.id)).toEqual({ changed: 1, kept: [] });
    expect(s.disk.get(A)).toBe("orig");
  });
});

describe("planEditRestore", () => {
  const snap = (leftAs?: Record<string, import("@/lib/fileHistory").LeftAs>) => ({ messageId: "m", trackedFileBackups: {}, timestamp: 0, leftAs });
  it("checks against the latest hash, keeps a contested file, and falls back for old turns", () => {
    expect(fh.planEditRestore([snap({ [A]: { hash: "1" } }), snap({ "c:\\WS\\a.ts": { hash: "2" } })], 0, A)).toEqual({ kind: "check", expected: "2" });
    expect(fh.planEditRestore([snap({ [A]: { contested: true } }), snap({ [A]: { hash: "2" } })], 0, A)).toEqual({ kind: "keep" });
    expect(fh.planEditRestore([snap({ [A]: { contested: true } }), snap({})], 1, A)).toEqual({ kind: "untouched" });
    expect(fh.planEditRestore([snap({ [A]: { hash: "1" } }), snap()], 0, A)).toEqual({ kind: "legacy" });
  });
});

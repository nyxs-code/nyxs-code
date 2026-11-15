import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  /** The folders `nyxs_list_sessions` was asked about, in order. */
  listed: [] as string[],
  metas: {} as Record<string, string>,
}));

vi.mock("@/lib/ipc", () => ({
  invoke: async (cmd: string, a: { workspace: string; sessionId: string }) => {
    if (cmd === "nyxs_list_sessions") {
      fake.listed.push(a.workspace);
      return [
        { id: `${a.workspace}-live`, meta: JSON.stringify({ title: "a", createdAt: 1 }), modifiedAt: 20, messageCount: 2 },
        { id: `${a.workspace}-old`, meta: JSON.stringify({ title: "b", createdAt: 1, archived: true }), modifiedAt: 10, messageCount: 1 },
      ];
    }
    if (cmd === "nyxs_session_read_meta") return { transcript: "", meta: fake.metas[a.sessionId] ?? "", error: null };
    throw new Error(`unexpected command ${cmd}`);
  },
}));

const rewind = vi.hoisted(() => ({ calls: [] as string[], failed: undefined as string[] | undefined }));
vi.mock("@/lib/fileHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fileHistory")>()),
  fileHistoryRewind: async (_u: unknown, workspace: string) => {
    rewind.calls.push(workspace);
    return { changed: 1, kept: [], ...(rewind.failed ? { failed: rewind.failed } : {}) };
  },
}));

type Storage = typeof import("@/lib/sessionStorage");
let storage: Storage;
let notices: typeof import("@/lib/fileNotices");

beforeAll(async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  storage = await import("@/lib/sessionStorage");
  notices = await import("@/lib/fileNotices");
});

afterEach(() => {
  fake.listed = [];
  rewind.calls = [];
  rewind.failed = undefined;
  notices.dismissFileNotice();
});

describe("listing sessions", () => {
  it("lists each folder once and splits the active from the archived", async () => {
    const { active, archived } = await storage.listSessionsByState(["E:/a", "E:/b", "E:/a", null]);
    expect(fake.listed).toEqual(["E:/a", "E:/b"]);
    expect(active.map((s) => s.id)).toEqual(["E:/a-live", "E:/b-live"]);
    expect(archived.map((s) => s.id)).toEqual(["E:/a-old", "E:/b-old"]);
    expect(active[0].workspace).toBe("E:/a");
  });
});

describe("rewinding a saved session", () => {
  const fileHistory = {
    snapshots: [{ messageId: "m1", trackedFileBackups: { "E:/a/x.ts": { backupFileName: "b", version: 1 } }, timestamp: 0 }],
    trackedFiles: ["E:/a/x.ts"],
    snapshotSequence: 1,
  };

  it("shows the corner card with the files it couldn't put back", async () => {
    rewind.failed = ["x.ts"];
    const res = await storage.rewindSessionFiles("E:/a", "s1", fileHistory);
    expect(res?.failed).toEqual(["x.ts"]);
    expect(notices.currentFileNotice()).toEqual({ kind: "rewindFailed", files: ["x.ts"] });
  });

  it("shows nothing when every file came back", async () => {
    await storage.rewindSessionFiles("E:/a", "s1", fileHistory);
    expect(notices.currentFileNotice()).toBeNull();
  });

  it("rewinds a worktree session in its worktree, where its turns kept their backups", async () => {
    fake.metas.s2 = JSON.stringify({ title: "t", createdAt: 1, worktree: { path: "E:/wt/a/s2", branch: "Nyxs/s2" } });
    await storage.rewindSessionFiles("E:/a", "s2", fileHistory);
    expect(rewind.calls).toEqual(["E:/wt/a/s2"]);
  });
});

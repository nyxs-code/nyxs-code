import { describe, expect, it, vi } from "vitest";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const s = (id: string, daysIdle: number, path: string | undefined, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Session ${id}`,
  createdAt: 0,
  modifiedAt: now - daysIdle * DAY,
  messageCount: 2,
  workspace: "D:/shop",
  worktree: path ? { path, branch: `Nyxs/${id}` } : undefined,
  ...extra,
});

vi.mock("@/lib/sessionStorage", () => ({
  listSessionsByState: async () => ({
    active: [s("a", 30, "W/a"), s("open", 40, "W/open"), s("plain", 50, undefined), s("remote", 60, "W/r", { workspace: "ssh://box/srv" })],
    archived: [s("b", 3, "W/b"), s("gone", 90, "W/gone")],
  }),
}));
vi.mock("@/lib/ipc", () => ({
  invoke: async (cmd: string, args: { paths: string[] }) => {
    if (cmd === "agent_bg_list") return [];
    return args.paths.map((p) => ({ path: p, exists: p !== "W/gone", bytes: p === "W/a" ? 2048 : 100, uncommitted: p === "W/b" ? 2 : 0 }));
  },
}));
vi.mock("@/lib/workspace", () => ({ loadRecentWorkspaces: () => ["D:/shop"] }));
vi.mock("@/lib/worktree", () => ({ removeSessionWorktree: vi.fn() }));

const { formatBytes, readSessionWorktrees, removeWorktrees, unusedFor } = await import("@/lib/worktreeCleanup");
const { setSessionInUseCheck } = await import("@/lib/sessionsInUse");

describe("the sessions' worktrees", () => {
  it("lists those on this computer, oldest first, and only counts the ones in use", async () => {
    setSessionInUseCheck((id) => id === "open");
    const { items, inUse } = await readSessionWorktrees();
    expect(items.map((i) => i.sessionId)).toEqual(["a", "b"]);
    expect(inUse).toBe(1);
    expect(items[0]).toMatchObject({ path: "W/a", branch: "Nyxs/a", bytes: 2048, uncommitted: 0 });
    expect(items[1].uncommitted).toBe(2);
    expect(unusedFor(items, 14, now).map((i) => i.sessionId)).toEqual(["a"]);
    expect(unusedFor(items, 0, now)).toHaveLength(2);
  });

  it("are removed one by one, skipping a session opened meanwhile", async () => {
    const { items } = await readSessionWorktrees();
    setSessionInUseCheck((id) => id === "b");
    const remove = vi.fn(async () => {});
    const steps: number[] = [];
    const out = await removeWorktrees(items, (d) => steps.push(d), remove);
    expect(remove).toHaveBeenCalledWith("D:/shop", "W/a");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ removed: ["a"], failed: ["b"] });
    expect(steps).toEqual([1, 2]);
    setSessionInUseCheck(() => false);
  });

  it("have their size written for people", () => {
    expect(formatBytes(512, "en-US")).toBe("512 B");
    expect(formatBytes(820 * 1024 * 1024, "en-US")).toBe("820 MB");
    expect(formatBytes(4.14 * 1024 ** 3, "es-ES")).toBe("4,1 GB");
  });
});

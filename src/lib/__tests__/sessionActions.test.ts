import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SetStateAction } from "react";
import type { ChatMessage } from "@/components/Message";
import type { Chat } from "@/lib/chatStore";
import type { SessionSummary } from "@/lib/sessionStorage";
import { getTranslations } from "@/lib/i18n";

const fake = vi.hoisted(() => ({
  warn: true,
  dirty: [] as string[],
  calls: [] as string[],
  rewindable: true,
  changed: 2 as number | null,
  kept: [] as string[],
  failDelete: false,
}));

vi.mock("@/lib/featureSettings", () => ({ warnUncommittedArchive: () => fake.warn }));
vi.mock("@/lib/archiveGuard", () => ({
  shortFileList: (f: string[]) => f.join(", "),
  uncommittedWorktreeFiles: async (tree: string) => { fake.calls.push(`tree ${tree}`); return fake.dirty; },
  uncommittedSessionFiles: async (ws: string, id: string, live: string[]) => { fake.calls.push(`session ${ws} ${id} ${live.join("+")}`); return fake.dirty; },
}));
vi.mock("@/lib/chatStore", () => ({ deleteChatFile: async (id: string) => { fake.calls.push(`deleteFile ${id}`); } }));
vi.mock("@/lib/claudeCode", () => ({ closeClaudeCodeChat: (id: string) => { fake.calls.push(`close ${id}`); } }));
vi.mock("@/lib/sessionStorage", () => ({
  setSessionArchived: async (ws: string | null, id: string, on: boolean) => { fake.calls.push(`archive ${ws} ${id} ${on}`); },
  sessionFamilyIds: (id: string, withNested: boolean) => (withNested ? [id, "child"] : [id]),
  deleteSessionFamily: async (id: string) => {
    fake.calls.push(`deleteFamily ${id}`);
    if (fake.failDelete) throw new Error("disk");
  },
  readSession: async () => ({ fileHistory: { snapshots: [] } }),
  canRewindSession: () => fake.rewindable,
  sessionRewindPoints: () => [{ fileCount: 3 }],
  rewindSessionFiles: async () => (fake.changed === null ? null : { changed: fake.changed, kept: fake.kept }),
  saveSession: async (ws: string, chat: Chat) => { fake.calls.push(`save ${ws} ${chat.id}`); },
}));

import * as actions from "@/lib/sessionActions";
import type { SessionActionsEnv } from "@/lib/sessionActions";

const t = getTranslations("en-US");
const msg = (id: string, role: "user" | "assistant"): ChatMessage => ({ id, role, content: id, createdAt: 0 });

function setup(over: Partial<SessionActionsEnv> = {}, chatList?: Chat[]) {
  let chats: Chat[] = chatList ?? [
    { id: "a", title: "A", workspace: "/ws", messages: [msg("u1", "user"), msg("r1", "assistant"), msg("u2", "user")] },
    { id: "child", title: "C", workspace: "/ws", parentId: "a", messages: [] },
    { id: "grand", title: "G", workspace: "/ws", parentId: "child", messages: [] },
  ];
  const setChats = (action: SetStateAction<Chat[]>) => {
    chats = typeof action === "function" ? action(chats) : action;
  };
  const sessions: SessionSummary[] = [{ id: "a", title: "A", workspace: "/other", parentId: "root" } as SessionSummary];
  const env: SessionActionsEnv = {
    t,
    workspace: "/ws",
    sessions,
    chats,
    liveChats: () => chats,
    activeId: "a",
    liveFileHistory: () => undefined,
    confirm: vi.fn(async () => true),
    setChats,
    setActiveId: vi.fn(),
    refreshSessions: vi.fn(),
    dropSessions: vi.fn(),
    hydrated: new Set(["a", "child"]),
    dropChatViews: vi.fn(),
    streaming: () => false,
    abortTurn: vi.fn(),
    ...over,
  };
  return { env, chats: () => chats };
}

beforeEach(() => {
  fake.warn = true;
  fake.dirty = [];
  fake.calls = [];
  fake.rewindable = true;
  fake.changed = 2;
  fake.kept = [];
  fake.failDelete = false;
});

describe("archiveSession", () => {
  it("archives right away when nothing is left uncommitted", async () => {
    const { env } = setup();
    await actions.archiveSession("a", env);
    expect(env.confirm).not.toHaveBeenCalled();
    expect(fake.calls).toContain("archive /other a true");
    expect(env.refreshSessions).toHaveBeenCalled();
  });

  it("asks first when files are uncommitted, and keeps the session when the user says no", async () => {
    fake.dirty = ["src/a.ts", "src/b.ts"];
    const { env } = setup({ confirm: vi.fn(async () => false) });
    await actions.archiveSession("a", env);
    expect(env.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: t.archiveGuard.title, message: expect.stringContaining("src/a.ts, src/b.ts") }));
    expect(fake.calls.some((c) => c.startsWith("archive"))).toBe(false);
  });
});

describe("uncommittedFilesOf", () => {
  it("looks in the session's own worktree when it has one", async () => {
    const { env } = setup({}, [{ id: "a", title: "A", worktree: { path: "/wt/a", branch: "b" }, messages: [] }]);
    await actions.uncommittedFilesOf("a", env);
    expect(fake.calls).toEqual(["tree /wt/a"]);
  });

  it("otherwise checks the files it tracked, in memory and saved", async () => {
    const { env } = setup(
      { liveFileHistory: () => ({ trackedFiles: new Set(["mem.ts"]) }) as never },
      [{ id: "a", title: "A", fileHistory: { trackedFiles: ["saved.ts"] } as never, messages: [] }],
    );
    await actions.uncommittedFilesOf("a", env);
    expect(fake.calls).toEqual(["session /other a mem.ts+saved.ts"]);
  });

  it("checks nothing when the warning is off", async () => {
    fake.warn = false;
    expect(await actions.uncommittedFilesOf("a", setup().env)).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe("rewindSavedSession", () => {
  it("asks, rewinds and says how many files changed", async () => {
    const { env } = setup();
    await actions.rewindSavedSession("a", env);
    const titles = vi.mocked(env.confirm).mock.calls.map(([o]) => o.title);
    expect(titles).toEqual([t.app.revertSessionTitle, t.app.revertSessionDone.replace("{count}", "2")]);
    expect(vi.mocked(env.confirm).mock.calls[1][0].message).toBeUndefined();
  });

  it("names the files it left because someone else changed them, as the rewind dialog does", async () => {
    fake.kept = ["src/a.ts", "notes.md"];
    const { env } = setup();
    await actions.rewindSavedSession("a", env);
    expect(vi.mocked(env.confirm).mock.calls[1][0].message).toBe(`${t.message.rewindKept} src/a.ts, notes.md`);
  });

  it("only says so when there is nothing to rewind", async () => {
    fake.rewindable = false;
    const { env } = setup();
    await actions.rewindSavedSession("a", env);
    expect(vi.mocked(env.confirm).mock.calls.map(([o]) => o.title)).toEqual([t.app.revertSessionNone]);
  });
});

describe("deleting", () => {
  it("deletes a chat with its turn, Claude Code process, views and file", () => {
    const { env, chats } = setup({ streaming: (id) => id === "a" });
    actions.deleteChat("a", env);
    expect(env.abortTurn).toHaveBeenCalledWith("a");
    expect(fake.calls).toEqual(["close a", "deleteFile a"]);
    expect(chats().map((c) => c.id)).toEqual(["child", "grand"]);
    expect(env.setActiveId).toHaveBeenCalledWith(null);
    expect(env.dropChatViews).toHaveBeenCalledWith("a");
    expect(env.hydrated.has("a")).toBe(false);
  });

  it("deletes a session with its nested ones, ending each one's agent", async () => {
    const { env, chats } = setup({ activeId: "child" });
    await actions.deleteSession("a", true, env);
    // Marked deleted on disk first, so the save of a stopped turn writes nothing back.
    expect(fake.calls).toEqual(["deleteFamily a", "close a", "close child"]);
    expect(env.dropSessions).toHaveBeenCalledWith(["a", "child"], "a", "root");
    expect(chats().map((c) => c.id)).toEqual(["grand"]);
    expect(env.setActiveId).toHaveBeenCalledWith(null);
    expect(env.refreshSessions).toHaveBeenCalled();
  });

  it("still removes the session when closing its agent throws", async () => {
    const { env, chats } = setup({ streaming: () => true, abortTurn: vi.fn(() => { throw new Error("gone"); }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await actions.deleteSession("a", false, env);
    warn.mockRestore();
    expect(chats().map((c) => c.id)).toEqual(["child", "grand"]);
    expect(env.setActiveId).toHaveBeenCalledWith(null);
    expect(env.refreshSessions).toHaveBeenCalled();
  });

  it("refreshes the list even when deleting from disk fails", async () => {
    fake.failDelete = true;
    const { env } = setup();
    await expect(actions.deleteSession("a", false, env)).rejects.toThrow("disk");
    expect(env.refreshSessions).toHaveBeenCalled();
  });

  it("hands a deleted session's children to its parent and keeps the open chat", async () => {
    const { env, chats } = setup({ activeId: "grand" });
    await actions.deleteSession("a", false, env);
    expect(chats().map((c) => [c.id, c.parentId])).toEqual([["child", "root"], ["grand", "child"]]);
    expect(env.setActiveId).not.toHaveBeenCalled();
  });
});

describe("from a session's menu", () => {
  it("forks the whole session next to it, without opening it", async () => {
    const { env, chats } = setup();
    const fork = await actions.forkSession("a", env);
    expect(fork?.workspace).toBe("/other");
    expect(fake.calls).toEqual([`save /other ${fork!.id}`]);
    // Saved, not put in memory: the caller opens it from disk in its project.
    expect(chats().some((c) => c.id === fork!.id)).toBe(false);
  });

  it("moves a session to another project under a new id, its marks with it", async () => {
    const { setPinned, sessionMarks, resetSessionMarksForTests } = await import("@/lib/sessionMarks");
    resetSessionMarksForTests();
    setPinned("a", true);
    const { env } = setup();
    const moved = await actions.moveSession("a", "/new", env);
    expect(moved).toMatchObject({ workspace: "/new", wasActive: true });
    expect(moved!.id).not.toBe("a");
    expect(fake.calls.slice(0, 2)).toEqual([`save /new ${moved!.id}`, "deleteFamily a"]);
    expect(sessionMarks().pinned).toEqual([moved!.id]);
  });

  it("doesn't move a session while it works, nor to its own project", async () => {
    expect(await actions.moveSession("a", "/new", setup({ streaming: () => true }).env)).toBeNull();
    expect(await actions.moveSession("a", "/other", setup().env)).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("copies the session as Markdown, its id and where it works", async () => {
    const { env } = setup();
    const md = await actions.sessionCopyText("a", "markdown", env);
    expect(md).toBe(`# A\n\n## ${t.sidebarMenu.mdUser}\n\nu1\n\n## ${t.sidebarMenu.mdAssistant}\n\nr1\n\n## ${t.sidebarMenu.mdUser}\n\nu2\n`);
    expect(await actions.sessionCopyText("a", "id", env)).toBe("a");
    expect(await actions.sessionCopyText("child", "id", env)).toBeNull();
    expect(await actions.sessionCopyText("a", "dir", env)).toBe("/other");
    expect(await actions.sessionCopyText("a", "handoff", env)).toContain(t.sidebarMenu.handoffProject.replace("{path}", "/other"));
  });
});

describe("forkOpenChat", () => {
  it("opens and saves a copy of the open chat up to the message", () => {
    const { env, chats } = setup();
    actions.forkOpenChat("r1", env);
    const fork = chats()[0];
    expect(fork.title).toBe(`A (${t.chatUi.forkSuffix})`);
    expect(fork.messages.map((m) => m.id)).toEqual(["u1", "r1"]);
    expect(env.setActiveId).toHaveBeenCalledWith(fork.id);
    expect(env.hydrated.has(fork.id)).toBe(true);
    expect(fake.calls).toEqual([`save /ws ${fork.id}`]);
  });
});

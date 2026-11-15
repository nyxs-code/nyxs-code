// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  return {
    archived: [] as { id: string; archived: boolean; archivedAt?: number }[],
    dirty: {} as Record<string, string[]>,
    warn: true,
  };
});

vi.mock("@/lib/ipc", () => ({ invoke: async () => null }));
vi.mock("@/lib/sessionStorage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sessionStorage")>()),
  setSessionArchived: async (_ws: string, id: string, archived: boolean, archivedAt?: number) => {
    fake.archived.push({ id, archived, archivedAt });
  },
}));
vi.mock("@/lib/archiveGuard", () => ({
  uncommittedSessionFiles: async (_ws: string, id: string) => fake.dirty[id] ?? [],
  uncommittedWorktreeFiles: async (path: string) => fake.dirty[path] ?? [],
}));
vi.mock("@/lib/featureSettings", () => ({ warnUncommittedArchive: () => fake.warn }));

import { autoArchiveMergedSessions, type PrSession, type SessionPrReading } from "@/lib/prArchive";
import type { SessionSummary } from "@/lib/sessionStorage";

const WS = "D:/app";
const START = Date.parse("2026-11-10T10:00:00Z");
const MERGED = START + 60 * 60_000;
const NOW = MERGED + 60 * 60_000;
const URL = "https://github.com/acme/app/pull/7";

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: id,
  createdAt: START,
  modifiedAt: MERGED + 60_000,
  messageCount: 3,
  workspace: WS,
  prs: [{ url: URL, host: "github.com", repo: "acme/app", number: 7, source: "printed", linkedAt: START + 10 * 60_000 }],
  ...extra,
});

const merged = async (s: PrSession): Promise<SessionPrReading[]> =>
  (s.prs ?? []).map((link) => ({
    link,
    pr: {
      status: "merged",
      number: link.number,
      url: link.url,
      createdAt: START + 10 * 60_000,
      base: "main",
      head: "feature",
      ci: null,
      autoMerge: false,
      headSha: "abc",
      mergedAt: MERGED,
      closedAt: MERGED,
    },
    problem: null,
  }));

const run = (sessions: SessionSummary[], skip?: (id: string) => boolean) =>
  autoArchiveMergedSessions(sessions, merged, { skip, now: NOW });

beforeEach(() => {
  fake.archived = [];
  fake.dirty = {};
  fake.warn = true;
  localStorage.clear();
});

describe("autoArchiveMergedSessions", () => {
  it("archives a session whose PR was merged, with the time it was archived", async () => {
    expect(await run([session("done")])).toEqual([{ id: "done", workspace: WS }]);
    expect(fake.archived).toEqual([{ id: "done", archived: true, archivedAt: NOW }]);
  });

  it("leaves the open session and those with a turn running", async () => {
    await run([session("open"), session("busy"), session("done")], (id) => id === "open" || id === "busy");
    expect(fake.archived.map((a) => a.id)).toEqual(["done"]);
  });

  it("leaves a session someone kept working in after the merge", async () => {
    await run([session("later", { modifiedAt: MERGED + 30 * 60_000 })]);
    expect(fake.archived).toEqual([]);
  });

  it("doesn't archive again a session the user brought back", async () => {
    await run([session("back")]);
    expect(fake.archived).toHaveLength(1);
    await run([session("back", { archived: false })]);
    expect(fake.archived).toHaveLength(1);
  });

  it("keeps sessions with uncommitted changes, as archiving by hand would warn", async () => {
    fake.dirty = { dirty: ["src/a.ts"], "D:/wt/tree": ["b.ts"] };
    await run([
      session("dirty"),
      session("tree", { worktree: { path: "D:/wt/tree", branch: "x" } as SessionSummary["worktree"] }),
    ]);
    expect(fake.archived).toEqual([]);

    fake.warn = false;
    await run([session("dirty")]);
    expect(fake.archived.map((a) => a.id)).toEqual(["dirty"]);
  });
});

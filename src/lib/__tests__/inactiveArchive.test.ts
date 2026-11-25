// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@/lib/sessionStorage";

vi.mock("@/lib/sessionStorage", () => ({ setSessionArchived: vi.fn() }));
vi.mock("@/lib/prArchive", () => {
  const seen: Record<string, number> = {};
  return {
    autoArchivedIds: () => ({ ...seen }),
    rememberAutoArchived: (id: string, at: number) => {
      seen[id] = at;
    },
  };
});

const { archiveInactiveSessions, inactiveDaysOf } = await import("@/lib/inactiveArchive");
const { rememberAutoArchived } = await import("@/lib/prArchive");

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const session = (id: string, daysIdle: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: id,
  createdAt: 0,
  modifiedAt: NOW - daysIdle * DAY,
  messageCount: 3,
  workspace: "D:/p",
  ...extra,
});

let archived: string[];
const archive = async (_ws: string, id: string) => {
  archived.push(id);
};

beforeEach(() => {
  archived = [];
});

describe("archiving inactive sessions", () => {
  it("archives only the sessions unused for the chosen days", async () => {
    const out = await archiveInactiveSessions([session("old", 8), session("recent", 2), session("gone", 30, { archived: true })], { days: 7, now: NOW, archive });
    expect(archived).toEqual(["old"]);
    expect(out).toEqual([{ id: "old", workspace: "D:/p" }]);
  });

  it("never touches a session open, working or with a command in the background", async () => {
    await archiveInactiveSessions([session("open", 9), session("bg", 9), session("idle", 9)], {
      days: 7,
      now: NOW,
      inUse: (id) => id === "open",
      busy: new Set(["bg"]),
      archive,
    });
    expect(archived).toEqual(["idle"]);
  });

  it("does nothing when off", async () => {
    await archiveInactiveSessions([session("old", 90)], { days: 0, now: NOW, archive });
    expect(archived).toEqual([]);
  });

  it("leaves a session the user brought back until it's used again", async () => {
    rememberAutoArchived("back", NOW - 2 * DAY);
    await archiveInactiveSessions([session("back", 20)], { days: 7, now: NOW, archive });
    expect(archived).toEqual([]);
    rememberAutoArchived("usedAgain", NOW - 40 * DAY);
    await archiveInactiveSessions([session("usedAgain", 10)], { days: 7, now: NOW, archive });
    expect(archived).toEqual(["usedAgain"]);
  });

  it("reads the setting as whole days, anything else as off", () => {
    expect(inactiveDaysOf({ sessions: { archiveInactiveDays: 14 } })).toBe(14);
    expect(inactiveDaysOf({ sessions: { archiveInactiveDays: "14" } })).toBe(0);
    expect(inactiveDaysOf({ sessions: { archiveInactiveDays: -3 } })).toBe(0);
    expect(inactiveDaysOf({})).toBe(0);
  });
});

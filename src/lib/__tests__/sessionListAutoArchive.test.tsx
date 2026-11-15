// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const fake = vi.hoisted(() => ({ archiveCalls: [] as { skip?: (id: string) => boolean }[] }));

vi.mock("@/lib/ipc", () => ({ invoke: async () => ({ sessionsDeleted: 0 }) }));
vi.mock("@/lib/settingsRuntime", () => ({ getMergedSettings: async () => ({ pullRequests: { autoArchive: true } }) }));
vi.mock("@/lib/sessionStorage", () => ({ listSessionsByState: async () => ({ active: [], archived: [] }) }));
vi.mock("@/lib/workspace", () => ({ loadRecentWorkspaces: () => [] }));
vi.mock("@/lib/sessionPrs", () => ({ readSessionPrs: async () => [] }));
vi.mock("@/lib/prArchive", () => ({
  onPrLinked: () => () => {},
  autoArchiveMergedSessions: async (_s: unknown, _read: unknown, opts: { skip?: (id: string) => boolean }) => {
    fake.archiveCalls.push(opts);
    return [];
  },
}));

import { useSessionList } from "@/lib/useSessionList";

afterEach(cleanup);

describe("useSessionList auto-archive", () => {
  it("hands auto-archive the sessions to leave alone", async () => {
    const busy = new Set(["open", "running"]);
    renderHook(() => useSessionList("D:/app", true, (id) => busy.has(id)));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const skip = fake.archiveCalls[0]?.skip;
    expect(skip?.("open")).toBe(true);
    expect(skip?.("running")).toBe(true);
    expect(skip?.("done")).toBe(false);
  });
});

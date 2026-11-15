// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const fake = vi.hoisted(() => ({ reads: 0, visibility: "visible" as DocumentVisibilityState }));

vi.mock("@/lib/ipc", () => ({ invoke: async () => null }));
vi.mock("@/lib/prArchive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prArchive")>()),
  readPrLink: async (_ws: string, link: { url: string; number: number }) => {
    fake.reads++;
    return {
      link,
      pr: { status: "open", number: link.number, url: link.url, createdAt: Date.now(), base: "main", head: "f", ci: null, autoMerge: false, headSha: "a" },
      problem: null,
    };
  },
}));

import { useSessionPrs } from "@/lib/sessionPrs";
import type { SessionSummary } from "@/lib/sessionStorage";

const session: SessionSummary = {
  id: "s1",
  title: "s1",
  createdAt: Date.now() - 60_000,
  modifiedAt: Date.now(),
  messageCount: 1,
  workspace: "D:/app",
  prs: [{ url: "https://github.com/acme/app/pull/7", host: "github.com", repo: "acme/app", number: 7, source: "printed", linkedAt: Date.now() - 30_000 }],
};

beforeEach(() => {
  vi.useFakeTimers();
  fake.reads = 0;
  fake.visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => fake.visibility });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSessionPrs", () => {
  it("doesn't ask GitHub while the window is hidden, and catches up on focus", async () => {
    renderHook(() => useSessionPrs([session]));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fake.reads).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fake.reads).toBe(2);

    fake.visibility = "hidden";
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(fake.reads).toBe(2);

    fake.visibility = "visible";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fake.reads).toBe(3);
  });
});

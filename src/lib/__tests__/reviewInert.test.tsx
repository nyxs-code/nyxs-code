// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const fake = vi.hoisted(() => ({ calls: [] as { cmd: string; args: Record<string, unknown> }[], watched: 0 }));

vi.mock("@/lib/ipc", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    fake.calls.push({ cmd, args });
    if (cmd === "agent_review_load") return JSON.stringify({ files: [{ path: "D:/app/src/a.ts", base: "old" }] });
    if (cmd === "agent_review_read") return { exists: true, text: "new" };
    return null;
  },
}));
vi.mock("@/lib/fsWatch", () => ({
  subscribeFsChange: () => {
    fake.watched++;
    return () => {};
  },
}));

import { useReviewSync } from "@/lib/review/useReview";

afterEach(cleanup);

describe("useReviewSync while the hunk review has no UI", () => {
  it("reads and watches nothing, and drops what older versions saved for the chat", async () => {
    renderHook(() => useReviewSync("s1", "D:/app"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fake.calls).toEqual([{ cmd: "agent_review_save", args: { workspace: "D:/app", sessionId: "s1", data: "" } }]);
    expect(fake.watched).toBe(0);
  });
});

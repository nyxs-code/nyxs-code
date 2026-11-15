// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  return { args: [] as string[][], replies: [] as { code: number; stderr: string }[] };
});
vi.mock("@/lib/ipc", () => ({
  invoke: async (_cmd: string, a: { args: string[] }) => {
    calls.args.push(a.args);
    const r = calls.replies.shift() ?? { code: 0, stderr: "" };
    return { stdout: "", stderr: r.stderr, code: r.code, timed_out: false };
  },
}));

import { setPrAutoMerge } from "@/lib/prArchive";

describe("setPrAutoMerge", () => {
  beforeEach(() => {
    calls.args = [];
    calls.replies = [];
  });

  it("turns on auto-merge with a squash", async () => {
    expect(await setPrAutoMerge("D:\\p", "feat/x", true)).toEqual({ ok: true });
    expect(calls.args).toEqual([["pr", "merge", "feat/x", "--auto", "--squash"]]);
  });

  it("leaves the strategy to a merge queue", async () => {
    calls.replies = [{ code: 1, stderr: "The merge strategy for main is set by the merge queue" }];
    expect(await setPrAutoMerge("D:\\p", "feat/x", true)).toEqual({ ok: true });
    expect(calls.args[1]).toEqual(["pr", "merge", "feat/x", "--auto"]);
  });

  it("merges a PR that is already ready", async () => {
    calls.replies = [{ code: 1, stderr: "Pull request #12 is in clean status" }];
    expect(await setPrAutoMerge("D:\\p", "feat/x", true)).toEqual({ ok: true, merged: true });
    expect(calls.args[1]).toEqual(["pr", "merge", "feat/x", "--squash"]);
  });

  it("says when the repository doesn't allow auto-merge, and turns it off", async () => {
    calls.replies = [{ code: 1, stderr: "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)" }];
    expect(await setPrAutoMerge("D:\\p", "feat/x", true)).toMatchObject({ ok: false, reason: "notAllowed" });
    expect(await setPrAutoMerge("D:\\p", "feat/x", false)).toEqual({ ok: true });
    expect(calls.args.at(-1)).toEqual(["pr", "merge", "feat/x", "--disable-auto"]);
  });
});

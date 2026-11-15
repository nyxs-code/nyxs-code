import { beforeEach, describe, expect, it, vi } from "vitest";

const git = vi.hoisted(() => ({ calls: [] as string[][], answer: (_args: string[]) => ({ stdout: "", stderr: "", code: 0, timed_out: false }) }));
vi.mock("@/lib/gitErrors", () => ({
  runGit: async (_cwd: string, args: string[]) => {
    const a = args.filter((x) => x !== "--no-optional-locks");
    git.calls.push(a);
    return git.answer(a);
  },
}));

const { classifyPullFailure, classifyPushFailure, loadUpstreamStatus, parseLeftRight, pullBranch, pushBranch } = await import("@/lib/gitPush");

const res = (stdout = "", code = 0, stderr = "") => ({ stdout, stderr, code, timed_out: false });

beforeEach(() => {
  git.calls = [];
});

describe("classifyPushFailure", () => {
  it("spots a push turned away because the remote moved", () => {
    const stderr = [
      "To github.com:acme/app.git",
      " ! [rejected]        feature -> feature (fetch first)",
      "error: failed to push some refs to 'github.com:acme/app.git'",
      "hint: Updates were rejected because the remote contains work that you do not",
      "hint: have locally.",
    ].join("\n");
    const r = classifyPushFailure(stderr);
    expect(r).toMatchObject({ ok: false, reason: "rejected" });
    // git's hints are left out of the message shown.
    expect(r.ok === false && r.message).not.toContain("hint:");
  });

  it("spots a sign-in failure", () => {
    expect(classifyPushFailure("fatal: Authentication failed for 'https://github.com/acme/app.git/'")).toMatchObject({ reason: "auth" });
    expect(classifyPushFailure("git@github.com: Permission denied (publickey).")).toMatchObject({ reason: "auth" });
  });

  it("keeps anything else as it came", () => {
    expect(classifyPushFailure("fatal: unable to access: Could not resolve host: github.com")).toMatchObject({
      reason: "other",
      message: "fatal: unable to access: Could not resolve host: github.com",
    });
  });
});

describe("classifyPullFailure", () => {
  it("spots conflicts, whether git reports them on stdout or stderr", () => {
    expect(classifyPullFailure("", "CONFLICT (content): Merge conflict in src/app.ts\nAutomatic merge failed")).toMatchObject({ reason: "conflict" });
    expect(classifyPullFailure("error: could not apply 1a2b3c... Fix login")).toMatchObject({ reason: "conflict" });
    expect(classifyPullFailure("fatal: couldn't find remote ref feature")).toMatchObject({ reason: "other" });
  });
});

describe("parseLeftRight", () => {
  it("reads ahead and behind", () => {
    expect(parseLeftRight("3\t1\n")).toEqual({ ahead: 3, behind: 1 });
    expect(parseLeftRight("")).toEqual({ ahead: 0, behind: 0 });
  });
});

describe("loadUpstreamStatus", () => {
  it("compares with the upstream when there is one", async () => {
    git.answer = (a) => (a[0] === "rev-parse" ? res("origin/feature\n") : res("2\t0\n"));
    expect(await loadUpstreamStatus("C:/p", "feature")).toEqual({ upstream: "origin/feature", ahead: 2, behind: 0 });
    expect(git.calls.at(-1)).toEqual(["rev-list", "--left-right", "--count", "HEAD...origin/feature"]);
  });

  it("falls back to origin/<branch> for a branch pushed without -u", async () => {
    git.answer = (a) => (a.includes("@{u}") ? res("", 128, "fatal: no upstream configured") : a[0] === "rev-parse" ? res("abc\n") : res("1\t0\n"));
    expect(await loadUpstreamStatus("C:/p", "feature")).toEqual({ upstream: null, ahead: 1, behind: 0 });
    expect(git.calls.at(-1)).toEqual(["rev-list", "--left-right", "--count", "HEAD...origin/feature"]);
  });

  it("is null for a branch that was never pushed", async () => {
    git.answer = () => res("", 128);
    expect(await loadUpstreamStatus("C:/p", "feature")).toBeNull();
  });
});

describe("pushBranch", () => {
  it("pushes to the upstream, or sets one on origin", async () => {
    git.answer = () => res();
    await pushBranch("C:/p", "feature", true);
    await pushBranch("C:/p", "feature", false);
    expect(git.calls).toEqual([["push"], ["push", "-u", "origin", "feature"]]);
  });
});

describe("pullBranch", () => {
  it("pulls from the upstream when the branch has one", async () => {
    git.answer = () => res();
    expect(await pullBranch("D:/app", "feature", true)).toEqual({ ok: true });
    expect(git.calls).toEqual([["pull", "--no-edit"]]);
  });

  it("names origin and the branch when it has none, as git pull alone would fail", async () => {
    git.answer = () => res();
    expect(await pullBranch("D:/app", "feature", false)).toEqual({ ok: true });
    expect(git.calls).toEqual([["pull", "--no-edit", "origin", "feature"]]);
  });
});

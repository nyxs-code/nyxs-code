import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real git, in a throwaway repository: what the picker does is what git does.
vi.mock("@/lib/gitErrors", () => ({
  runGit: async (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
}));
vi.mock("@/lib/ipc", () => ({
  invoke: async (cmd: string, args: { path: string }) => (cmd === "agent_path_exists" ? existsSync(args.path) : undefined),
}));

import { clearWorkingTree, readFolderBranches, sortBranches, switchFolderBranch } from "@/lib/gitBranches";

// Each case runs a dozen real git commands, slow on a busy CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ENV = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: ENV, encoding: "utf8" }).trim();

let repo: string;
let extra: string[];

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "nyxs-branches-"));
  extra = [];
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "branch", "feature");
  git(repo, "branch", "alpha");
});

afterEach(() => {
  for (const dir of [...extra, repo]) rmSync(dir, { recursive: true, force: true });
});

describe("the branch list", () => {
  it("puts main and master first, then the rest by name", () => {
    expect(sortBranches(["zeta", "master", "beta", "main"])).toEqual(["main", "master", "beta", "zeta"]);
  });

  it("says which branch is checked out and which another worktree has", async () => {
    const wt = join(tmpdir(), `nyxs-branches-wt-${Date.now()}`);
    extra.push(wt);
    git(repo, "worktree", "add", "-q", wt, "alpha");
    const info = await readFolderBranches(repo);
    expect(info?.current).toBe("main");
    expect(info?.branches).toEqual(["main", "alpha", "feature"]);
    expect([...(info?.elsewhere.keys() ?? [])]).toEqual(["alpha"]);
    expect(info?.linkedWorktree).toBe(false);
    expect((await readFolderBranches(wt))?.linkedWorktree).toBe(true);
  });
});

describe("switching the folder's branch", () => {
  it("checks out the branch when the folder is clean", async () => {
    expect(await switchFolderBranch(repo, "feature")).toEqual({ ok: true });
    expect(git(repo, "branch", "--show-current")).toBe("feature");
  });

  it("refuses with uncommitted changes, an untracked file included", async () => {
    writeFileSync(join(repo, "new.txt"), "x\n");
    expect(await switchFolderBranch(repo, "feature")).toMatchObject({ ok: false, reason: "uncommitted_changes" });
    expect(git(repo, "branch", "--show-current")).toBe("main");
  });

  it("refuses while a session works in the folder, on a detached HEAD and mid-merge", async () => {
    expect(await switchFolderBranch(repo, "feature", { sessionWorking: true })).toMatchObject({ reason: "session_working" });
    git(repo, "switch", "-q", "--detach", "HEAD");
    expect(await switchFolderBranch(repo, "feature")).toMatchObject({ reason: "detached_head" });
    git(repo, "switch", "-q", "main");
    writeFileSync(join(repo, "a.txt"), "main side\n");
    git(repo, "commit", "-qam", "main side");
    git(repo, "switch", "-q", "feature");
    writeFileSync(join(repo, "a.txt"), "feature side\n");
    git(repo, "commit", "-qam", "feature side");
    spawnSync("git", ["merge", "main"], { cwd: repo, env: ENV });
    expect(await switchFolderBranch(repo, "alpha")).toMatchObject({ reason: "operation_in_progress" });
  });

  it("refuses a branch another worktree has, and one that is gone", async () => {
    const wt = join(tmpdir(), `nyxs-branches-wt2-${Date.now()}`);
    extra.push(wt);
    git(repo, "worktree", "add", "-q", wt, "alpha");
    expect(await switchFolderBranch(repo, "alpha")).toMatchObject({ reason: "branch_elsewhere" });
    expect(await switchFolderBranch(repo, "nope")).toMatchObject({ reason: "branch_missing" });
    expect(await switchFolderBranch(wt, "feature")).toMatchObject({ reason: "app_worktree" });
  });
});

describe("handling uncommitted changes before a switch", () => {
  it("stashes them, untracked files too, under a message that names the target", async () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "new.txt"), "x\n");
    await clearWorkingTree(repo, "stash", "main", "feature");
    expect(await switchFolderBranch(repo, "feature")).toEqual({ ok: true });
    expect(git(repo, "stash", "list")).toContain("Nyxs: before switching to feature");
  });

  it("commits them as WIP on the branch being left", async () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");
    await clearWorkingTree(repo, "commit", "main", "feature");
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("WIP on main");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("discards them, ignored files kept", async () => {
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-qm", "ignore");
    writeFileSync(join(repo, ".env"), "TOKEN=1\n");
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "new.txt"), "x\n");
    await clearWorkingTree(repo, "discard", "main", "feature");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(repo, ".env"))).toBe(true);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  countChecks,
  createPrCallTracker,
  isMergedPrLink,
  openedPrs,
  prBelongsToSession,
  prTargetsFromTool,
  prUrlsIn,
} from "@/lib/prArchive";

describe("countChecks", () => {
  it("sorts check runs and commit statuses into four buckets", () => {
    expect(
      countChecks([
        { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
        { __typename: "CheckRun", status: "QUEUED" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "NEUTRAL" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "TIMED_OUT" },
        { __typename: "StatusContext", state: "PENDING" },
        { __typename: "StatusContext", state: "SUCCESS" },
        { __typename: "StatusContext", state: "ERROR" },
      ]),
    ).toEqual({ pending: 3, passed: 2, failed: 3, skipped: 2 });
  });

  it("says there is no CI when the PR has no checks", () => {
    expect(countChecks([])).toBeNull();
  });
});

describe("openedPrs", () => {
  it("links the PR a session opens, like Claude Code Desktop", () => {
    expect(openedPrs("Bash gh pr create --fill")).toEqual([{ current: true }]);
    expect(openedPrs("Bash git push -u origin feat/x && gh pr create --title x --body y")).toEqual([{ current: true }]);
    expect(openedPrs("Bash gh pr create --fill --head someone:feat/y")).toEqual([{ branch: "feat/y" }]);
  });

  it("doesn't link pushes or merges: they don't make a PR the session's", () => {
    expect(openedPrs("Bash git push -q origin amanda/intake-fix")).toEqual([]);
    expect(openedPrs("Bash git push")).toEqual([]);
    expect(openedPrs("Bash gh pr merge 378 --repo acme/app --squash --delete-branch")).toEqual([]);
    expect(openedPrs("Bash gh pr merge --squash")).toEqual([]);
    expect(openedPrs("Bash gh pr view 341")).toEqual([]);
  });

  it("ignores the command when it's only mentioned", () => {
    expect(openedPrs(`Bash grep -o 'gh pr create' session.jsonl`)).toEqual([]);
    expect(openedPrs(`Bash git commit -m "run gh pr create later"`)).toEqual([]);
  });

  it("ignores links to merged PRs stored by 0.8.28", () => {
    expect(isMergedPrLink("https://github.com/acme/app/pull/382")).toBe(true);
    expect(isMergedPrLink("380")).toBe(true);
    expect(isMergedPrLink("feat/x")).toBe(false);
    expect(isMergedPrLink("release-2")).toBe(false);
  });
});

describe("prTargetsFromTool", () => {
  const created = "Creating pull request for claude/fix-intake into main in acme/app\n\nhttps://github.com/acme/app/pull/403\n";

  it("finds the PR by the URL gh printed, wherever the command ran", () => {
    expect(prUrlsIn(created)).toEqual(["https://github.com/acme/app/pull/403"]);
    expect(prTargetsFromTool("Bash cd ../wt && gh pr create --fill", created)).toEqual([{ url: "https://github.com/acme/app/pull/403" }]);
    expect(prTargetsFromTool("PowerShell gh pr create --fill", created)).toEqual([{ url: "https://github.com/acme/app/pull/403" }]);
  });

  it("names the existing PR when the branch already had one", () => {
    const exists = 'a pull request for branch "feat/x" into branch "main" already exists:\nhttps://github.com/acme/app/pull/12';
    expect(prTargetsFromTool("Bash gh pr create --fill", exists)).toEqual([{ url: "https://github.com/acme/app/pull/12" }]);
  });

  it("falls back to the command line without a URL, and ignores other commands' URLs", () => {
    expect(prTargetsFromTool("Bash gh pr create --fill", "error")).toEqual([{ current: true }]);
    expect(prTargetsFromTool("Bash gh pr create --head me:feat/y", undefined)).toEqual([{ branch: "feat/y" }]);
    expect(prTargetsFromTool("Bash gh pr view 12", "https://github.com/acme/app/pull/12")).toEqual([]);
  });
});

describe("createPrCallTracker", () => {
  afterEach(() => vi.useRealTimers());
  const url = "https://github.com/acme/app/pull/403";

  it("links a PR as soon as its call ends, with the output that follows the end mark", () => {
    vi.useFakeTimers();
    const link = vi.fn();
    const tracker = createPrCallTracker(link);
    tracker.onTool("a", { name: "Bash", detail: "gh pr create --fill" });
    tracker.onTool("a", { name: "Bash", detail: "gh pr create --fill", endedAt: 1 });
    tracker.onTool("a", { name: "Bash", detail: "gh pr create --fill", endedAt: 1, output: url });
    expect(link).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(link).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith([{ url }]);
    tracker.flush();
    expect(link).toHaveBeenCalledTimes(1);
  });

  it("links calls that never ended when the turn stops, and nothing for other commands", () => {
    const link = vi.fn();
    const tracker = createPrCallTracker(link);
    tracker.onTool("a", { name: "Bash", detail: "git push -u origin feat/x" });
    tracker.onTool("b", { name: "Bash", detail: "gh pr create --fill" });
    tracker.flush();
    expect(link).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith([{ current: true }]);
  });
});

describe("prBelongsToSession", () => {
  const HOUR = 60 * 60 * 1000;
  const started = 1_000_000_000_000;

  it("drops a PR older than the session, even on a branch it pushed to", () => {
    expect(prBelongsToSession({ createdAt: started, prPushed: true }, { createdAt: started - 24 * HOUR })).toBe(false);
    expect(prBelongsToSession({ createdAt: started }, { createdAt: started - 3 * HOUR })).toBe(false);
  });

  it("keeps a PR opened after the session started", () => {
    expect(prBelongsToSession({ createdAt: started }, { createdAt: started + 2 * HOUR })).toBe(true);
    expect(prBelongsToSession({ createdAt: started }, { createdAt: started - 60_000 })).toBe(true);
  });

  it("trusts its own link only when GitHub gives no date", () => {
    expect(prBelongsToSession({ createdAt: started, prPushed: true }, {})).toBe(true);
    expect(prBelongsToSession({ createdAt: started }, {})).toBe(false);
  });
});

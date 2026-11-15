import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const git = vi.hoisted(() => ({ remotes: "" as string }));
const gh = vi.hoisted(() => ({
  pr: null as null | { status: string; number: number; url: string; createdAt?: number; mergedAt?: number; head: string },
  lookups: [] as { cwd: string; branch: string; repos: string[]; owner: string | null }[],
}));
const linked = vi.hoisted(() => [] as { workspace: string | null; sessionId: string; url: string; source: string; branch?: string }[]);

vi.mock("@/lib/gitErrors", () => ({
  runGit: async (_cwd: string, args: string[]) =>
    args[0] === "remote" ? { code: 0, stdout: git.remotes, stderr: "" } : { code: 1, stdout: "", stderr: "" },
}));
vi.mock("@/lib/prArchive", async (importOriginal) => ({
  // The real rules for which tools open PRs and what they returned.
  PR_OPENING_TOOL_RE: (await importOriginal<typeof import("@/lib/prArchive")>()).PR_OPENING_TOOL_RE,
  openedPrUrlsFromApiOutput: (await importOriginal<typeof import("@/lib/prArchive")>()).openedPrUrlsFromApiOutput,
  defaultBranch: async () => "main",
  prLookup: async (_cwd: string, branch: string) => ({ head: branch, owner: "acme", repos: ["acme/app"], fork: false }),
  fetchBranchPrDetails: async (cwd: string, branch: string, lookup: { repos: string[]; owner: string | null }) => {
    gh.lookups.push({ cwd, branch, repos: lookup.repos, owner: lookup.owner });
    return gh.pr;
  },
}));
vi.mock("@/lib/sessionStorage", () => ({ addSessionPrLink: async () => {} }));
vi.mock("@/lib/sessionPrLinks", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sessionPrLinks")>();
  return {
    ...real,
    linkSessionPr: async (workspace: string | null, sessionId: string, ref: { url: string }, source: string, branch?: string) => {
      linked.push({ workspace, sessionId, url: ref.url, source, ...(branch ? { branch } : {}) });
    },
  };
});

import {
  acceptPushedPr,
  createDeclaredPrScanner,
  createPrToolLinker,
  createPushCallTracker,
  declaredPrUrls,
  linkDeclaredPr,
  notePushedBranches,
  publishedPrOpened,
  pushedBranches,
  pushedBranchesWatched,
  prUrlsFromToolOutput,
  refreshPushedPrs,
  remoteRepoKey,
  resetPushedBranches,
  stripPrCreatedTags,
  PUSH_CHECK_MS,
} from "@/lib/prDetect";
import { parseMessage } from "@/components/message/parse";

const URL = "https://github.com/acme/app/pull/456";

beforeEach(() => {
  linked.length = 0;
  gh.lookups.length = 0;
  gh.pr = null;
  git.remotes = "origin\tgit@github.com:acme/app.git (fetch)\norigin\tgit@github.com:acme/app.git (push)\n";
  resetPushedBranches();
});
afterEach(() => vi.useRealTimers());

describe("<pr-created> tag", () => {
  it("reads the declared URLs", () => {
    expect(declaredPrUrls(`Listo.\n<pr-created>${URL}</pr-created>\n<pr-created> ${URL} </pr-created>`)).toEqual([URL]);
  });

  it("finds a tag split across streamed chunks, once", () => {
    const found: string[] = [];
    const scan = createDeclaredPrScanner((u) => found.push(u));
    for (const chunk of ["PR abierto. <pr-", "created>https://github.com/acme/", "app/pull/456</pr-cr", "eated> más texto ", `<pr-created>${URL}</pr-created>`]) scan(chunk);
    expect(found).toEqual([URL]);
  });

  it("hides the tag from the chat, also while it is still streaming", () => {
    expect(stripPrCreatedTags(`Abrí el PR.\n<pr-created>${URL}</pr-created>`)).toBe("Abrí el PR.\n");
    expect(stripPrCreatedTags("Abrí el PR. <pr-created>https://github.com/ac")).toBe("Abrí el PR. ");
    expect(stripPrCreatedTags("Abrí el PR. <pr-cr")).toBe("Abrí el PR. ");
    expect(stripPrCreatedTags("a < b")).toBe("a < b");
    const text = parseMessage(`Hecho.<pr-created>${URL}</pr-created>`).segments.map((s) => (s.type === "text" ? s.content : "")).join("");
    expect(text).toBe("Hecho.");
  });

  it("keeps the tag inside a code block", () => {
    const { segments } = parseMessage("```\n<pr-created>x</pr-created>\n```");
    expect(segments).toEqual([{ type: "code", lang: "code", content: "<pr-created>x</pr-created>", closed: true }]);
  });

  it("links a declared PR only when its repo is one of the workspace's remotes", async () => {
    expect(await linkDeclaredPr(URL, ["/w"], "/w", "s1")).toBe(true);
    expect(await linkDeclaredPr("https://github.com/someone/else/pull/1", ["/w"], "/w", "s1")).toBe(false);
    expect(await linkDeclaredPr("not a url", ["/w"], "/w", "s1")).toBe(false);
    expect(linked).toEqual([{ workspace: "/w", sessionId: "s1", url: URL, source: "declared" }]);
  });
});

describe("remoteRepoKey", () => {
  it("reads https, ssh and scp-like remotes", () => {
    expect(remoteRepoKey("https://github.com/Acme/App.git")).toBe("github.com/acme/app");
    expect(remoteRepoKey("git@github.com:acme/app.git")).toBe("github.com/acme/app");
    expect(remoteRepoKey("ssh://git@ssh.github.com:443/acme/app.git")).toBe("github.com/acme/app");
    expect(remoteRepoKey("https://ghe.corp.com/team/svc")).toBe("ghe.corp.com/team/svc");
    expect(remoteRepoKey("nope")).toBeNull();
  });
});

describe("PR-opening MCP tools", () => {
  it("reads the PR page URL, not the API one", () => {
    const out = JSON.stringify({ url: "https://api.github.com/repos/acme/app/pulls/7", html_url: "https://github.com/acme/app/pull/7" });
    expect(prUrlsFromToolOutput(out)).toEqual(["https://github.com/acme/app/pull/7"]);
  });

  it("links what create_pull_request printed once it ends, and ignores other tools", async () => {
    vi.useFakeTimers();
    const got: string[][] = [];
    const onTool = createPrToolLinker((urls) => got.push(urls));
    onTool("t1", { name: "mcp__github__create_pull_request", detail: "" });
    onTool("t1", { name: "mcp__github__create_pull_request", detail: "", endedAt: 1 });
    onTool("t1", { name: "mcp__github__create_pull_request", detail: "", endedAt: 1, output: `{"html_url":"${URL}"}` });
    onTool("t2", { name: "Bash", detail: `echo ${URL}`, endedAt: 1, output: URL });
    onTool("t3", { name: "mcp__github__get_pull_request", detail: "", endedAt: 1, output: URL });
    await vi.runAllTimersAsync();
    expect(got).toEqual([[URL]]);
  });
});

describe("Claude Code's code_change_published", () => {
  it("counts a PR the session created, not one it only touched", () => {
    expect(publishedPrOpened({ url: URL, action: "created" })).toBe(true);
    expect(publishedPrOpened({ url: URL })).toBe(true);
    expect(publishedPrOpened({ url: URL, action: "pushed" })).toBe(false);
    expect(publishedPrOpened({ url: URL, action: "merged" })).toBe(false);
    expect(publishedPrOpened({ url: "https://gitlab.com/a/b/-/merge_requests/1", action: "created" })).toBe(false);
  });
});

describe("pushedBranches", () => {
  const newBranch = "To github.com:acme/app.git\n * [new branch]      feat/x -> feat/x\nbranch 'feat/x' set up to track 'origin/feat/x'.\n";

  it("reads `git push -u origin branch`", () => {
    expect(pushedBranches("git push -u origin feat/x", newBranch, "/w")).toEqual([
      { cwd: "/w", branch: "feat/x", remote: "origin", remoteUrl: "github.com:acme/app.git" },
    ]);
  });

  it("reads HEAD:branch and a renamed refspec", () => {
    const out = "To https://github.com/acme/app.git\n   1a2b3c4..5d6e7f8  HEAD -> fix-1\n";
    expect(pushedBranches("git push origin HEAD:fix-1", out, "/w").map((b) => b.branch)).toEqual(["fix-1"]);
    const out2 = "To https://github.com/acme/app.git\n + 1a2b3c4...5d6e7f8 local -> remote-name (forced update)\n";
    expect(pushedBranches("git push -f origin local:remote-name", out2, "/w").map((b) => b.branch)).toEqual(["remote-name"]);
  });

  it("takes the branch from the output when the command doesn't name it", () => {
    expect(pushedBranches("git push", newBranch, "/w").map((b) => b.branch)).toEqual(["feat/x"]);
    expect(pushedBranches("git push origin HEAD 2>&1", newBranch, "/w").map((b) => b.branch)).toEqual(["feat/x"]);
  });

  it("follows cd and git -C to the folder it pushed from", () => {
    expect(pushedBranches('cd "../wt one" && git push -u origin feat/x', newBranch, "/w/repo")[0].cwd).toBe("/w/repo/../wt one");
    expect(pushedBranches("git -C D:/wt push origin feat/x", newBranch, "/w")[0].cwd).toBe("D:/wt");
  });

  it("ignores rejected pushes, tags, deletions and other commands", () => {
    const rejected = "To github.com:acme/app.git\n ! [rejected]        feat/x -> feat/x (fetch first)\nerror: failed to push some refs\n";
    expect(pushedBranches("git push origin feat/x", rejected, "/w")).toEqual([]);
    expect(pushedBranches("git push origin feat/x", "fatal: unable to access", "/w")).toEqual([]);
    expect(pushedBranches("git push --tags", " * [new tag]  v1 -> v1\n", "/w")).toEqual([]);
    expect(pushedBranches("git push origin --delete feat/x", " - [deleted]  feat/x\n", "/w")).toEqual([]);
    expect(pushedBranches("git status", newBranch, "/w")).toEqual([]);
    expect(pushedBranches("git push origin feat/x", "", "/w")).toEqual([]);
  });

  it("trusts a push git says was already up to date", () => {
    expect(pushedBranches("git push origin feat/x", "Everything up-to-date\n", "/w").map((b) => b.branch)).toEqual(["feat/x"]);
  });
});

describe("acceptPushedPr", () => {
  const started = 1_000_000_000;
  const pushed = started + 60_000;
  it("takes a PR opened after the session started", () => {
    expect(acceptPushedPr({ status: "open", createdAt: pushed + 1000 }, started, pushed)).toBe(true);
    expect(acceptPushedPr({ status: "draft", createdAt: pushed + 1000 }, started, pushed)).toBe(true);
  });
  it("leaves an older PR, or one merged or closed before the push", () => {
    expect(acceptPushedPr({ status: "open", createdAt: started - 3_600_000 }, started, pushed)).toBe(false);
    expect(acceptPushedPr({ status: "closed", createdAt: pushed + 1000 }, started, pushed)).toBe(false);
    expect(acceptPushedPr({ status: "merged", createdAt: started + 1000, mergedAt: started + 2000 - 3_600_000 }, started, pushed)).toBe(false);
    expect(acceptPushedPr({ status: "merged", createdAt: pushed + 1000, mergedAt: pushed + 5000 }, started, pushed)).toBe(true);
    expect(acceptPushedPr({ status: "open" }, started, pushed)).toBe(false);
  });
});

describe("pushed branches watched for a PR", () => {
  it("links the PR opened on the web for a pushed branch, throttled to ~30 s", async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const onTool = createPushCallTracker("/w", (branches) => notePushedBranches("s1", "/proj", t0 - 60_000, branches));
    onTool("b1", {
      name: "Bash",
      detail: "git push -u fork feat/x",
      endedAt: 1,
      output: "To github.com:me/app.git\n * [new branch]      feat/x -> feat/x\n",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(pushedBranchesWatched()).toEqual([{ cwd: "/w", branch: "feat/x", remote: "fork", remoteUrl: "github.com:me/app.git" }]);

    // Not due yet.
    await refreshPushedPrs(t0 + 1000);
    expect(gh.lookups).toEqual([]);

    // No PR yet: keeps watching.
    await vi.advanceTimersByTimeAsync(PUSH_CHECK_MS);
    expect(gh.lookups).toHaveLength(1);
    // The fork's PR is looked up in upstream and in the fork it was pushed to.
    expect(gh.lookups[0]).toMatchObject({ cwd: "/w", branch: "feat/x", owner: "me", repos: ["acme/app", "me/app"] });
    expect(linked).toEqual([]);

    gh.pr = { status: "open", number: 456, url: URL, createdAt: Date.now(), head: "feat/x" };
    await vi.advanceTimersByTimeAsync(PUSH_CHECK_MS);
    expect(linked).toEqual([{ workspace: "/proj", sessionId: "s1", url: URL, source: "pushed", branch: "feat/x" }]);
    expect(pushedBranchesWatched()).toEqual([]);
  });

  it("stops watching a branch that already had someone's open PR", async () => {
    const t0 = Date.now();
    notePushedBranches("s1", "/w", t0, [{ cwd: "/w", branch: "teammate", remote: "origin", remoteUrl: null }], t0);
    gh.pr = { status: "open", number: 9, url: "https://github.com/acme/app/pull/9", createdAt: t0 - 86_400_000, head: "teammate" };
    await refreshPushedPrs(t0 + PUSH_CHECK_MS);
    expect(linked).toEqual([]);
    expect(pushedBranchesWatched()).toEqual([]);
  });

  it("never watches the default branch", async () => {
    const t0 = Date.now();
    notePushedBranches("s1", "/w", t0, [{ cwd: "/w", branch: "main", remote: "origin", remoteUrl: null }], t0);
    await refreshPushedPrs(t0 + PUSH_CHECK_MS);
    expect(gh.lookups).toEqual([]);
    expect(pushedBranchesWatched()).toEqual([]);
  });
});

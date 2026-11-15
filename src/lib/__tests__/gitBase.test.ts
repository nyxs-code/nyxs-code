// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A fake repo: refs that exist, what merge-base answers, and every git call made. */
const repo = vi.hoisted(() => ({
  refs: new Set<string>(),
  originHead: "" as string,
  mergeBase: "base123" as string | null,
  numstat: "",
  patch: "",
  calls: [] as string[][],
  /** The same calls with the options before the subcommand (`-c name=value`). */
  raw: [] as string[][],
}));

vi.mock("@/lib/gitErrors", () => ({
  runGit: async (_cwd: string, args: string[]) => {
    const a = args.filter((x) => x !== "--no-optional-locks");
    repo.raw.push([...a]);
    while (a[0] === "-c") a.splice(0, 2);
    repo.calls.push(a);
    const out = (stdout: string, code = 0) => ({ stdout, stderr: "", code, timed_out: false });
    if (a[0] === "symbolic-ref") return repo.originHead ? out(repo.originHead) : out("", 128);
    if (a[0] === "rev-parse") return repo.refs.has(a.at(-1)!) ? out("sha") : out("", 1);
    if (a[0] === "merge-base") return repo.mergeBase ? out(`${repo.mergeBase}\n`) : out("", 1);
    if (a[0] === "diff" && a.includes("--numstat")) return out(repo.numstat);
    if (a[0] === "diff") return out(repo.patch);
    if (a[0] === "ls-files") return out("");
    return out("");
  },
}));
vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(async () => null) }));

const { DIFF_FLAGS, EMPTY_TREE, PLAIN_PATHS, defaultBaseRef, diffModeFor, resolveDiffBase, setDiffMode } = await import("@/lib/gitBase");
const { loadChanges } = await import("@/components/diff/load");

beforeEach(() => {
  repo.refs = new Set();
  repo.originHead = "";
  repo.mergeBase = "base123";
  repo.numstat = "";
  repo.patch = "";
  repo.calls = [];
  repo.raw = [];
  localStorage.clear();
});

describe("defaultBaseRef", () => {
  it("follows origin/HEAD first", async () => {
    repo.originHead = "origin/develop";
    repo.refs = new Set(["origin/main"]);
    expect(await defaultBaseRef("C:/p")).toBe("origin/develop");
  });

  it("falls back to origin/main, origin/master, then a local main or master", async () => {
    repo.refs = new Set(["origin/master", "main"]);
    expect(await defaultBaseRef("C:/p")).toBe("origin/master");
    // A repo without origin.
    repo.refs = new Set(["master"]);
    expect(await defaultBaseRef("C:/p")).toBe("master");
    repo.refs = new Set();
    expect(await defaultBaseRef("C:/p")).toBeNull();
  });
});

describe("resolveDiffBase", () => {
  it("compares the branch with its merge-base, or uncommitted work with HEAD", async () => {
    repo.refs = new Set(["origin/main"]);
    expect(await resolveDiffBase("C:/p", "branch", true)).toEqual({ base: "base123", baseRef: "origin/main", mode: "branch" });
    expect(repo.calls).toContainEqual(["merge-base", "origin/main", "HEAD"]);
    expect(await resolveDiffBase("C:/p", "uncommitted", true)).toEqual({ base: "HEAD", baseRef: "origin/main", mode: "uncommitted" });
  });

  it("uses a local main when there is no origin", async () => {
    repo.refs = new Set(["main"]);
    expect(await resolveDiffBase("C:/p", "branch", true)).toMatchObject({ base: "base123", baseRef: "main", mode: "branch" });
  });

  it("falls back to uncommitted without a default branch or a merge-base", async () => {
    expect(await resolveDiffBase("C:/p", "branch", true)).toEqual({ base: "HEAD", baseRef: null, mode: "uncommitted" });
    repo.refs = new Set(["origin/main"]);
    repo.mergeBase = null;
    expect(await resolveDiffBase("C:/p", "branch", true)).toEqual({ base: "HEAD", baseRef: "origin/main", mode: "uncommitted" });
  });

  it("compares a repo with no commits with the empty tree", async () => {
    repo.refs = new Set(["origin/main"]);
    expect(await resolveDiffBase("C:/p", "branch", false)).toEqual({ base: EMPTY_TREE, baseRef: null, mode: "uncommitted" });
  });
});

describe("diff mode per folder", () => {
  it("defaults to the branch's changes and remembers each folder's choice", () => {
    expect(diffModeFor("C:/p")).toBe("branch");
    setDiffMode("C:/p", "uncommitted");
    expect(diffModeFor("C:/p")).toBe("uncommitted");
    expect(diffModeFor("C:/other")).toBe("branch");
    // The same folder written another way (Windows).
    expect(diffModeFor("c:\\P\\")).toBe("uncommitted");
    expect(diffModeFor(null)).toBe("branch");
  });
});

describe("loadChanges", () => {
  it("reads against the given base with the Git bar's diff options", async () => {
    repo.numstat = "3\t1\tsrc/a.ts\n";
    repo.patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,3 @@\n-a\n+b\n+c\n+d\n";
    const files = await loadChanges("C:/p", false, "base123");
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([["src/a.ts", 3, 1]]);
    const diffs = repo.calls.filter((c) => c[0] === "diff");
    expect(diffs).toContainEqual(["diff", "--numstat", ...DIFF_FLAGS, "base123"]);
    expect(diffs).toContainEqual(["diff", ...DIFF_FLAGS, "base123"]);
    // Paths unquoted, so a file named with accents or ñ matches between the two.
    const raw = repo.raw.filter((c) => c.includes("diff"));
    expect(raw.length).toBeGreaterThan(0);
    for (const c of raw) expect(c.slice(0, 2)).toEqual(PLAIN_PATHS);
  });

  it("adds -w when whitespace is hidden", async () => {
    await loadChanges("C:/p", true, "HEAD");
    expect(repo.calls).toContainEqual(["diff", "--numstat", ...DIFF_FLAGS, "-w", "HEAD"]);
  });
});

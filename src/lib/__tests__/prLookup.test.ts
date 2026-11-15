// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  return {
    /** `git config --get <key>` and `git remote get-url <name>` answers. */
    git: {} as Record<string, string>,
    /** gh `pr list` answers by `-R` repo ("" for none). */
    prs: {} as Record<string, unknown[]>,
    ghCalls: [] as string[][],
  };
});
vi.mock("@/lib/ipc", () => ({
  invoke: async (cmd: string, a: { args: string[] }) => {
    const reply = (stdout: string | undefined) => ({ stdout: stdout ?? "", stderr: "", code: stdout === undefined ? 1 : 0, timed_out: false });
    if (cmd === "agent_git") {
      const [verb, , key] = a.args;
      if (verb === "config") return reply(fake.git[key]);
      if (verb === "remote") return reply(fake.git[`remote:${a.args[2]}`]);
      return reply(undefined);
    }
    fake.ghCalls.push(a.args);
    const r = a.args.indexOf("-R");
    return reply(JSON.stringify(fake.prs[r >= 0 ? a.args[r + 1] : ""] ?? []));
  },
}));

import { fetchBranchPrDetails, pickBranchPr, prLookup, prTargetsFromCall } from "@/lib/prArchive";

const pr = (n: number, state: string, owner: string, createdAt = "2026-10-30T10:00:00Z") => ({
  number: n, state, isDraft: false, url: `https://github.com/acme/app/pull/${n}`, createdAt,
  baseRefName: "main", headRefName: "feat/x", headRepositoryOwner: { login: owner },
  statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], headRefOid: "abc",
});

beforeEach(() => {
  fake.git = { "remote:origin": "https://github.com/acme/app.git" };
  fake.prs = {};
  fake.ghCalls = [];
});

describe("prLookup", () => {
  it("looks a plain branch up in origin under its own name", async () => {
    expect(await prLookup("D:\\p", "feat/x")).toEqual({ head: "feat/x", owner: "acme", repos: ["acme/app"], fork: false });
  });

  it("uses the name the branch is pushed under", async () => {
    fake.git["branch.fix.remote"] = "origin";
    fake.git["branch.fix.merge"] = "refs/heads/feat/long-name";
    expect((await prLookup("D:\\p", "fix")).head).toBe("feat/long-name");
  });

  it("looks a fork's branch up in upstream first, owned by the fork", async () => {
    fake.git["remote:origin"] = "git@github.com:me/app.git";
    fake.git["remote:upstream"] = "https://github.com/acme/app";
    // Tracks upstream/main but pushes to the fork: the tracked name isn't the pushed one.
    fake.git["branch.feat/x.remote"] = "upstream";
    fake.git["branch.feat/x.merge"] = "refs/heads/main";
    fake.git["branch.feat/x.pushRemote"] = "origin";
    expect(await prLookup("D:\\p", "feat/x")).toEqual({ head: "feat/x", owner: "me", repos: ["acme/app", "me/app"], fork: true });
  });

  it("leaves the repo to gh when no remote is on github.com", async () => {
    fake.git["remote:origin"] = "https://git.example.com/acme/app.git";
    expect(await prLookup("D:\\p", "feat/x")).toMatchObject({ repos: [], owner: null });
  });
});

describe("pickBranchPr", () => {
  it("prefers an open PR to an older merged one", () => {
    const picked = pickBranchPr([pr(1, "MERGED", "acme", "2026-10-31T00:00:00Z"), pr(2, "OPEN", "acme")], "feat/x", "acme");
    expect(picked).toMatchObject({ number: 2, status: "open", ci: { passed: 1 } });
  });

  it("skips a same-named branch from someone else's fork", () => {
    expect(pickBranchPr([pr(3, "OPEN", "stranger")], "feat/x", "acme")).toBeNull();
  });
});

describe("fetchBranchPrDetails", () => {
  it("finds a fork's PR in upstream", async () => {
    fake.git["remote:origin"] = "https://github.com/me/app.git";
    fake.git["remote:upstream"] = "https://github.com/acme/app.git";
    fake.prs["acme/app"] = [pr(7, "OPEN", "me")];
    expect(await fetchBranchPrDetails("D:\\p", "feat/x")).toMatchObject({ number: 7, status: "open" });
    expect(fake.ghCalls[0]).toEqual(expect.arrayContaining(["pr", "list", "--head", "feat/x", "-R", "acme/app"]));
  });

  it("tries the next repo when the first has no PR for the branch", async () => {
    fake.git["remote:origin"] = "https://github.com/me/app.git";
    fake.git["remote:upstream"] = "https://github.com/acme/app.git";
    fake.prs["me/app"] = [pr(8, "OPEN", "me")];
    expect(await fetchBranchPrDetails("D:\\p", "feat/x")).toMatchObject({ number: 8 });
    expect(fake.ghCalls).toHaveLength(2);
  });
});

describe("prTargetsFromCall", () => {
  it("takes the PR an MCP tool opened from the URL it returned", () => {
    const out = '{"number":12,"html_url":"https://github.com/acme/app/pull/12","url":"https://api.github.com/repos/acme/app/pulls/12"}';
    expect(prTargetsFromCall("mcp__github__create_pull_request", "{}", out)).toEqual([{ url: "https://github.com/acme/app/pull/12" }]);
  });

  it("doesn't take a command that merely mentions such a tool", () => {
    expect(prTargetsFromCall("Bash", "grep create_pull_request src", "https://github.com/acme/app/pull/12")).toEqual([]);
  });
});

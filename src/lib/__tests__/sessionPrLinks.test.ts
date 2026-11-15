// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  return {
    /** Session metas by id, as `nyxs_session_read` returns them. */
    metas: {} as Record<string, Record<string, unknown>>,
    /** The branch the session's folder is checked out on. */
    head: "alex/void-client-check",
    /** Other folders' branches (worktrees), by the cwd git runs in. */
    heads: {} as Record<string, string>,
    /** Answers `gh` by its arguments; undefined fails like a missing login. */
    gh: (_args: string[]): { stdout: string; stderr?: string; code?: number } | undefined => undefined,
    ghCalls: [] as string[][],
  };
});

vi.mock("@/lib/ipc", () => ({
  invoke: async (cmd: string, a: { args: string[]; cwd: string; sessionId: string; json: string }) => {
    if (cmd === "nyxs_session_read" || cmd === "nyxs_session_read_meta") {
      const meta = fake.metas[a.sessionId];
      return { transcript: "", meta: meta ? JSON.stringify(meta) : "" };
    }
    if (cmd === "nyxs_list_sessions") {
      return Object.entries(fake.metas).map(([id, m]) => ({ id, meta: JSON.stringify(m), modifiedAt: m.createdAt, messageCount: 1 }));
    }
    if (cmd === "nyxs_session_write_meta") {
      fake.metas[a.sessionId] = JSON.parse(a.json) as Record<string, unknown>;
      return null;
    }
    const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, timed_out: false });
    if (cmd === "agent_git") {
      if (a.args[0] === "rev-parse") return ok(`${fake.heads[a.cwd] ?? fake.head}\n`);
      if (a.args[0] === "symbolic-ref") return ok("origin/master\n");
      if (a.args[0] === "remote") return ok("https://github.com/acme/storefront.git\n");
      return { stdout: "", stderr: "", code: 1, timed_out: false };
    }
    fake.ghCalls.push(a.args);
    const r = fake.gh(a.args);
    if (!r) return { stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login", code: 4, timed_out: false };
    return { stdout: r.stdout, stderr: r.stderr ?? "", code: r.code ?? 0, timed_out: false };
  },
}));

import {
  allPrsFinished,
  linkOpenedPrs,
  openedPrs,
  prTargetsFromTool,
  pickBarPr,
  readSessionPrsDirect,
  type BranchPrDetails,
  type PrSession,
} from "@/lib/prArchive";
import { linkSessionPr, MAX_SESSION_PRS, parsePrUrl, type SessionPrLink } from "@/lib/sessionPrLinks";
import { pickSessionBadge } from "@/lib/sessionPrs";
import { listSessions } from "@/lib/sessionStorage";

const WS = "D:/storefront";
const PR_456 = "https://github.com/acme/storefront/pull/456";
const SESSION_START = Date.parse("2026-11-10T10:00:00Z");

/** `gh pr view <url> --json …` for a PR. */
const prJson = (n: number, state: string, opts: { head?: string; createdAt?: string; mergedAt?: string; closedAt?: string; isDraft?: boolean } = {}) =>
  JSON.stringify({
    number: n,
    state,
    isDraft: !!opts.isDraft,
    url: `https://github.com/acme/storefront/pull/${n}`,
    createdAt: opts.createdAt ?? "2026-11-10T12:00:00Z",
    mergedAt: opts.mergedAt ?? null,
    closedAt: opts.closedAt ?? null,
    baseRefName: "master",
    headRefName: opts.head ?? `feat/${n}`,
    headRepositoryOwner: { login: "acme" },
    statusCheckRollup: [],
    headRefOid: "abc",
  });

const metaOf = (id: string) => fake.metas[id] as { prs?: SessionPrLink[]; prBranch?: string; prPushed?: boolean };

async function sessionOf(id: string): Promise<PrSession> {
  const s = (await listSessions(WS)).find((x) => x.id === id)!;
  return { ...s, workspace: WS };
}

beforeEach(() => {
  fake.metas = { s1: { title: "Subir cambios", createdAt: SESSION_START, updatedAt: SESSION_START } };
  fake.head = "alex/void-client-check";
  fake.heads = {};
  fake.gh = () => undefined;
  fake.ghCalls = [];
  vi.useRealTimers();
});

describe("parsePrUrl", () => {
  it("reads repo and number from github.com and GitHub Enterprise URLs", () => {
    expect(parsePrUrl(PR_456)).toEqual({ host: "github.com", repo: "acme/storefront", number: 456, url: PR_456 });
    expect(parsePrUrl(`${PR_456}/files?w=1`)?.url).toBe(PR_456);
    expect(parsePrUrl("https://GHE.acme.corp/team/app/pull/12#discussion")).toEqual({
      host: "ghe.acme.corp", repo: "team/app", number: 12, url: "https://ghe.acme.corp/team/app/pull/12",
    });
  });

  it("refuses what isn't a pull URL", () => {
    expect(parsePrUrl("https://github.com/acme/app/issues/3")).toBeNull();
    expect(parsePrUrl("https://github.com/acme/app/pull/new/feat")).toBeNull();
    expect(parsePrUrl("alex/void-client-check")).toBeNull();
  });
});

describe("PR #456: opened from a temporary worktree", () => {
  const command = "Bash cd ../wt-demand && git push -u origin alex/demand-deadline-hours && gh pr create --base master --fill";
  const output = `Creating pull request for alex/demand-deadline-hours into master\n\n${PR_456}\n`;

  it("links the PR at the URL gh printed, without asking GitHub or looking at the folder's branch", async () => {
    await linkOpenedPrs(WS, "s1", prTargetsFromTool(command, output));
    expect(fake.ghCalls).toEqual([]);
    expect(metaOf("s1").prs).toEqual([
      expect.objectContaining({ host: "github.com", repo: "acme/storefront", number: 456, url: PR_456, source: "printed" }),
    ]);
    expect(metaOf("s1").prBranch).toBeUndefined();
  });

  it("reads its status by URL after the worktree is gone and the folder is on another branch", async () => {
    await linkOpenedPrs(WS, "s1", prTargetsFromTool(command, output));
    fake.gh = (args) =>
      args[0] === "pr" && args[1] === "view" && args[2] === PR_456
        ? { stdout: prJson(456, "OPEN", { head: "alex/demand-deadline-hours" }) }
        : undefined;
    const session = await sessionOf("s1");
    const readings = await readSessionPrsDirect(session);
    expect(fake.ghCalls.every((a) => a[1] === "view" && a[2] === PR_456)).toBe(true);
    expect(pickSessionBadge(session, readings)).toMatchObject({ status: "open", number: 456 });
  });

  it("stays linked to #456, not void-client-check, when gh can't read the URL", async () => {
    await linkOpenedPrs(WS, "s1", prTargetsFromTool(command, output));
    const session = await sessionOf("s1");
    const readings = await readSessionPrsDirect(session);
    expect(metaOf("s1").prs?.map((p) => p.number)).toEqual([456]);
    expect(metaOf("s1").prBranch).toBeUndefined();
    expect(pickSessionBadge(session, readings)).toEqual({ status: "unknown", number: 456, url: PR_456, problem: "auth" });
    // Unknown is not finished: the session isn't archived while gh can't tell.
    expect(await allPrsFinished(session)).toBe(false);
  });
});

describe("linkOpenedPrs without a URL", () => {
  it("looks the --head branch up, never the folder's", async () => {
    fake.gh = (args) => (args[1] === "list" && args.includes("feat/named") ? { stdout: `[${prJson(500, "OPEN", { head: "feat/named" })}]` } : { stdout: "[]" });
    await linkOpenedPrs(WS, "s1", [{ branch: "feat/named" }]);
    expect(metaOf("s1").prs).toEqual([expect.objectContaining({ number: 500, source: "tool", branch: "feat/named" })]);
    expect(fake.ghCalls.some((a) => a.includes("alex/void-client-check"))).toBe(false);
  });

  it("reads where gh pr create ran: the folder it cd'd into and the repo --repo named", () => {
    expect(openedPrs("Bash cd ../wt-demand && gh pr create --fill")).toEqual([{ current: true, dir: "../wt-demand" }]);
    expect(openedPrs("Bash cd D:/wt && cd sub && gh pr create -R acme/app --fill")).toEqual([
      { current: true, dir: "D:/wt/sub", repo: "acme/app" },
    ]);
    expect(openedPrs("PowerShell Set-Location -Path D:/wt; gh pr create --head feat/z")).toEqual([{ branch: "feat/z", dir: "D:/wt" }]);
  });

  it("takes the last-resort branch from the folder the command cd'd into, not the session's", async () => {
    fake.heads[`${WS}/../wt-demand`] = "alex/demand-deadline-hours";
    fake.gh = (args) =>
      args[1] === "list" && args.includes("alex/demand-deadline-hours")
        ? { stdout: `[${prJson(456, "OPEN", { head: "alex/demand-deadline-hours" })}]` }
        : { stdout: "[]" };
    // The URL never made it to the output (truncated).
    await linkOpenedPrs(WS, "s1", prTargetsFromTool("Bash cd ../wt-demand && gh pr create --fill", "…"));
    expect(metaOf("s1").prs).toEqual([expect.objectContaining({ number: 456, branch: "alex/demand-deadline-hours" })]);
    expect(fake.ghCalls.some((a) => a.includes("alex/void-client-check"))).toBe(false);
  });

  it("links nothing for the folder's branch when GitHub shows no PR for it", async () => {
    await linkOpenedPrs(WS, "s1", [{ current: true }]);
    expect(metaOf("s1").prs).toBeUndefined();
    expect(metaOf("s1").prBranch).toBeUndefined();
    fake.gh = () => ({ stdout: "[]" });
    await linkOpenedPrs(WS, "s1", [{ current: true }]);
    expect(metaOf("s1").prs).toBeUndefined();
    expect(metaOf("s1").prBranch).toBeUndefined();
  });

  it("keeps an explicit --head branch to look up later when GitHub can't say yet", async () => {
    await linkOpenedPrs(WS, "s1", [{ branch: "feat/named" }]);
    expect(metaOf("s1")).toMatchObject({ prBranch: "feat/named", prPushed: true });
  });

  it("uses the folder's branch only as a last resort, and only for a PR newer than the session", async () => {
    fake.gh = (args) =>
      args[1] === "list" ? { stdout: `[${prJson(300, "OPEN", { head: fake.head, createdAt: "2026-10-01T00:00:00Z" })}]` } : undefined;
    await linkOpenedPrs(WS, "s1", [{ current: true }]);
    expect(metaOf("s1").prs).toBeUndefined();
  });
});

describe("the session's PR list", () => {
  it("keeps one entry per PR, whatever the URL looks like", async () => {
    await linkSessionPr(WS, "s1", parsePrUrl(PR_456)!, "printed");
    await linkSessionPr(WS, "s1", parsePrUrl(`${PR_456.replace("acme", "Acme")}/files`)!, "declared", "alex/demand-deadline-hours");
    expect(metaOf("s1").prs).toHaveLength(1);
    expect(metaOf("s1").prs![0]).toMatchObject({ number: 456, source: "printed", branch: "alex/demand-deadline-hours" });
  });

  it(`keeps the newest ${MAX_SESSION_PRS}`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let n = 1; n <= MAX_SESSION_PRS + 3; n++) {
      vi.setSystemTime(SESSION_START + n * 1000);
      await linkSessionPr(WS, "s1", parsePrUrl(`https://github.com/acme/app/pull/${n}`)!, "printed");
    }
    const numbers = metaOf("s1").prs!.map((p) => p.number);
    expect(numbers).toHaveLength(MAX_SESSION_PRS);
    expect(numbers).not.toContain(3);
    expect(numbers).toContain(MAX_SESSION_PRS + 3);
  });

  it("shows the most relevant of several PRs and archives only when all are done", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-10T11:00:00Z"));
    for (const n of [10, 11, 12]) await linkSessionPr(WS, "s1", parsePrUrl(`https://github.com/acme/storefront/pull/${n}`)!, "printed");
    vi.useRealTimers();
    const states: Record<string, string> = {
      "10": prJson(10, "MERGED", { mergedAt: "2026-11-10T13:00:00Z", createdAt: "2026-11-10T11:00:00Z" }),
      "11": prJson(11, "OPEN", { isDraft: true, createdAt: "2026-11-10T11:30:00Z" }),
      "12": prJson(12, "OPEN", { createdAt: "2026-11-10T11:10:00Z" }),
    };
    fake.gh = (args) => ({ stdout: states[args[2].split("/").pop()!] });
    const session = await sessionOf("s1");
    expect(pickSessionBadge(session, await readSessionPrsDirect(session))).toMatchObject({ status: "open", number: 12 });
    expect(await allPrsFinished(session)).toBe(false);

    states["11"] = prJson(11, "CLOSED", { closedAt: "2026-11-10T14:00:00Z" });
    states["12"] = prJson(12, "MERGED", { mergedAt: "2026-11-10T14:00:00Z", createdAt: "2026-11-10T11:10:00Z" });
    expect(pickSessionBadge(session, await readSessionPrsDirect(session))).toMatchObject({ status: "merged", number: 12 });
    expect(await allPrsFinished(session)).toBe(true);
  });

  it("ignores a PR that was already merged when it was linked", async () => {
    await linkSessionPr(WS, "s1", parsePrUrl(PR_456)!, "pushed");
    fake.gh = () => ({ stdout: prJson(456, "MERGED", { mergedAt: "2026-01-01T00:00:00Z" }) });
    const session = await sessionOf("s1");
    expect(pickSessionBadge(session, await readSessionPrsDirect(session))).toBeNull();
    expect(await allPrsFinished(session)).toBe(false);
  });
});

describe("Recents and the Git bar", () => {
  async function linkInOrder(numbers: number[]) {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [i, n] of numbers.entries()) {
      vi.setSystemTime(Date.parse("2026-11-10T11:00:00Z") + i * 60_000);
      await linkSessionPr(WS, "s1", parsePrUrl(`https://github.com/acme/storefront/pull/${n}`)!, "printed");
    }
    vi.useRealTimers();
  }

  it("show the same PR when the session has several, whatever order they were linked in", async () => {
    // #451 is open but older, and was linked last; #458 is the newest open one.
    await linkInOrder([458, 456, 451]);
    const states: Record<string, string> = {
      "458": prJson(458, "OPEN", { head: "feat/458", createdAt: "2026-11-10T12:30:00Z" }),
      "456": prJson(456, "MERGED", { head: "feat/456", createdAt: "2026-11-10T12:00:00Z", mergedAt: "2026-11-10T13:00:00Z" }),
      "451": prJson(451, "OPEN", { head: "feat/451", createdAt: "2026-11-10T11:30:00Z" }),
    };
    fake.gh = (args) => ({ stdout: states[args[2].split("/").pop()!] });
    const session = await sessionOf("s1");
    expect(metaOf("s1").prs?.map((p) => p.number)).toEqual([458, 456, 451]);
    const readings = await readSessionPrsDirect(session);
    const recents = pickSessionBadge(session, readings);
    // The folder is on a branch without a PR of its own.
    const bar = pickBarPr(null, "alex/void-client-check", session, readings);
    expect(recents).toMatchObject({ status: "open", number: 458 });
    expect(bar.pr?.number).toBe(458);
    expect(bar.local).toBe(false);
  });

  it("the bar still puts the checked-out branch's open PR first", async () => {
    await linkInOrder([458]);
    fake.gh = () => ({ stdout: prJson(458, "OPEN", { head: "feat/458" }) });
    const session = await sessionOf("s1");
    const readings = await readSessionPrsDirect(session);
    const own: BranchPrDetails = {
      status: "open", number: 470, url: "https://github.com/acme/storefront/pull/470",
      base: "master", head: "feat/here", ci: null, autoMerge: false, headSha: "abc",
    };
    const bar = pickBarPr(own, "feat/here", session, readings);
    expect(bar).toMatchObject({ local: true, pr: { number: 470 } });
  });
});

describe("sessions from before the PR list", () => {
  it("still read their prBranch as a link by branch", async () => {
    fake.metas.old = { title: "Vieja", createdAt: SESSION_START, updatedAt: SESSION_START, prBranch: "feat/old", prPushed: true };
    fake.gh = (args) =>
      args[1] === "list" && args.includes("feat/old")
        ? { stdout: `[${prJson(77, "MERGED", { head: "feat/old", mergedAt: "2026-11-10T15:00:00Z" })}]` }
        : { stdout: "[]" };
    const session = await sessionOf("old");
    expect(session.prs).toBeUndefined();
    const readings = await readSessionPrsDirect(session);
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ link: null, branch: "feat/old" });
    expect(pickSessionBadge(session, readings)).toMatchObject({ status: "merged", number: 77 });
    expect(await allPrsFinished(session)).toBe(true);
  });
});

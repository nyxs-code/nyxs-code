// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/accountScope", () => ({ accountKey: (k: string) => k }));

type Mod = typeof import("@/lib/prAutoFix");
const load = async (): Promise<Mod> => {
  vi.resetModules();
  return import("@/lib/prAutoFix");
};

const URL = "https://github.com/acme/app/pull/7";
const failing = { status: "open" as const, number: 7, url: URL, head: "feature", headSha: "abc123", ci: { failed: 1, pending: 0 } };
const linked = { prs: [{ host: "github.com", repo: "acme/app", number: 7 }], branch: null };
const base = { workspace: "D:/app", sessionId: "s1", autoFix: true, pr: failing, linked };

beforeEach(() => localStorage.clear());

describe("ciFixKey", () => {
  it("asks for the session that opened the PR once its checks have failed", async () => {
    const { ciFixKey } = await load();
    expect(ciFixKey(base)).toBe("D:/app\n7\nabc123");
  });

  it("never asks a chat that isn't the PR's session, such as a new empty one", async () => {
    const { ciFixKey } = await load();
    expect(ciFixKey({ ...base, sessionId: undefined })).toBe("");
    expect(ciFixKey({ ...base, linked: { prs: [], branch: null } })).toBe("");
    expect(ciFixKey({ ...base, linked: { prs: [], branch: "feature" } })).toBe("D:/app\n7\nabc123");
  });

  it("waits for the checks to finish, and only with auto-fix on", async () => {
    const { ciFixKey } = await load();
    expect(ciFixKey({ ...base, pr: { ...failing, ci: { failed: 1, pending: 2 } } })).toBe("");
    expect(ciFixKey({ ...base, pr: { ...failing, ci: { failed: 0, pending: 0 } } })).toBe("");
    expect(ciFixKey({ ...base, autoFix: false })).toBe("");
    expect(ciFixKey({ ...base, pr: { ...failing, status: "merged" } })).toBe("");
  });
});

describe("asked keys", () => {
  it("are remembered across restarts", async () => {
    const first = await load();
    expect(first.ciFixAlreadyAsked("D:/app\n7\nabc123")).toBe(false);
    first.noteCiFixAsked("D:/app\n7\nabc123");

    const afterRestart = await load();
    expect(afterRestart.ciFixAlreadyAsked("D:/app\n7\nabc123")).toBe(true);
    expect(afterRestart.ciFixAlreadyAsked("D:/app\n7\nnext-push")).toBe(false);
  });
});

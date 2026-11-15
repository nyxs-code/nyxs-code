import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({ invoke: async () => null }));

import { prTargetsFromCall } from "@/lib/prArchive";
import { PR_OPENING_TOOL_RE, prUrlsFromToolOutput } from "@/lib/prDetect";

const created = JSON.stringify({
  number: 12,
  html_url: "https://github.com/acme/app/pull/12",
  url: "https://api.github.com/repos/acme/app/pulls/12",
  body: "Follows up https://github.com/acme/app/pull/3 and https://github.com/other/lib/pull/88",
  base: { repo: { html_url: "https://github.com/acme/app" } },
});

describe("PR-opening API tools", () => {
  it("are matched on the whole tool name", () => {
    expect(PR_OPENING_TOOL_RE.test("mcp__github__create_pull_request")).toBe(true);
    expect(PR_OPENING_TOOL_RE.test("mcp__gitlab__open_pr")).toBe(true);
    expect(PR_OPENING_TOOL_RE.test("mcp__github__create_pull_request_review")).toBe(false);
    expect(PR_OPENING_TOOL_RE.test("mcp__github__create_pull_request_with_copilot_review")).toBe(false);
  });

  it("don't link the PR a review tool commented on", () => {
    const out = JSON.stringify({ html_url: "https://github.com/acme/app/pull/12#pullrequestreview-1" });
    expect(prTargetsFromCall("mcp__github__create_pull_request_review", "{}", out)).toEqual([]);
  });

  it("link only the PR they created, not the ones its body cites", () => {
    expect(prTargetsFromCall("mcp__github__create_pull_request", "{}", created)).toEqual([
      { url: "https://github.com/acme/app/pull/12" },
    ]);
    expect(prUrlsFromToolOutput(created)).toEqual(["https://github.com/acme/app/pull/12"]);
  });

  it("read the page URL of a minimal reply", () => {
    const out = JSON.stringify({ id: "123", url: "https://github.com/acme/app/pull/9" });
    expect(prUrlsFromToolOutput(out)).toEqual(["https://github.com/acme/app/pull/9"]);
    expect(prTargetsFromCall("mcp__github__create_pull_request", "{}", out)).toEqual([
      { url: "https://github.com/acme/app/pull/9" },
    ]);
  });

  it("take only the first PR of a reply that isn't JSON", () => {
    const out = "Created https://github.com/acme/app/pull/4\nSee also https://github.com/acme/app/pull/1";
    expect(prUrlsFromToolOutput(out)).toEqual(["https://github.com/acme/app/pull/4"]);
  });
});

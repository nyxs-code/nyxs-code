import { describe, it, expect } from "vitest";
import { rankDeferredTools, getToolSearchDescription, DEFER_THRESHOLD, type DeferredToolInfo } from "./prompt";

const CATALOG: DeferredToolInfo[] = [
  { name: "mcp__Linear__create_issue", summary: "Create a Linear issue" },
  { name: "mcp__Linear__search_issues", summary: "Search Linear issues" },
  { name: "mcp__GitHub__create_pr", summary: "Open a pull request on GitHub" },
  { name: "mcp__Stripe__list_payments", summary: "List Stripe payments" },
];

describe("rankDeferredTools", () => {
  it("ranks by keyword overlap (name weighted)", () => {
    const hits = rankDeferredTools(CATALOG, "create a linear issue", 5);
    expect(hits[0].name).toBe("mcp__Linear__create_issue");
  });

  it("supports exact 'select:' by name", () => {
    const hits = rankDeferredTools(CATALOG, "select:mcp__Stripe__list_payments,mcp__GitHub__create_pr", 5);
    expect(hits.map((h) => h.name).sort()).toEqual(
      ["mcp__GitHub__create_pr", "mcp__Stripe__list_payments"].sort(),
    );
  });

  it("respects the max-results cap", () => {
    expect(rankDeferredTools(CATALOG, "issue", 1).length).toBe(1);
  });

  it("returns nothing for an empty or non-matching query", () => {
    expect(rankDeferredTools(CATALOG, "   ", 5)).toEqual([]);
    expect(rankDeferredTools(CATALOG, "zzzznomatch", 5)).toEqual([]);
  });
});

describe("getToolSearchDescription", () => {
  it("lists every tool name without dumping schemas", () => {
    const desc = getToolSearchDescription(CATALOG);
    for (const c of CATALOG) expect(desc).toContain(c.name);
    expect(desc).toContain(String(CATALOG.length));
  });
});

describe("DEFER_THRESHOLD", () => {
  it("is a sane positive default", () => {
    expect(DEFER_THRESHOLD).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { chooseTableLayout, numericColumns, parseAlign } from "../markdownTable";

describe("parseAlign", () => {
  it("reads the colons of the separator row", () => {
    expect(parseAlign(["---", ":---", "---:", ":---:"])).toEqual([null, "left", "right", "center"]);
  });
});

describe("numericColumns", () => {
  it("accepts units, currencies, separators and empty markers", () => {
    const header = ["Model", "Context", "Price", "Usage"];
    const rows = [
      ["Gemini", "1.000.000", "$3.50", "15 %"],
      ["Claude", "200k", "€12", "—"],
      ["Grok", "256 000", "**$2**", "0%"],
    ];
    expect(numericColumns(header, rows)).toEqual([false, true, true, true]);
  });

  it("does not count text that merely contains digits", () => {
    expect(numericColumns(["A", "B"], [["x", "v1.2"], ["y", "2026-10-26"]])).toEqual([false, false]);
  });
});

describe("chooseTableLayout", () => {
  const cli = [
    ["Claude Code", "email and plan", "5-hour and weekly bars"],
    ["Antigravity", "email, from its log", "Gemini 15 %, Claude/GPT 0 %"],
    ["Grok", "email and name", "from the billing API"],
  ];

  it("compares a few text rows side by side", () => {
    expect(chooseTableLayout(["CLI", "Account", "Usage"], cli)).toBe("compare");
  });

  it("falls back to a list from five rows on", () => {
    const rows = [...cli, ["Codex", "email and plan", "already there"], ["Cursor", "email", "none"]];
    expect(chooseTableLayout(["CLI", "Account", "Usage"], rows)).toBe("list");
  });

  it("uses a list for two-column tables and very long cells", () => {
    expect(chooseTableLayout(["Command", "What it does"], [["ls", "lists"], ["cd", "moves"]])).toBe("list");
    const long = cli.map((r, i) => (i === 0 ? [r[0], "x".repeat(200), r[2]] : r));
    expect(chooseTableLayout(["CLI", "Account", "Usage"], long)).toBe("list");
  });

  it("keeps a table when most data columns are numbers", () => {
    const rows = [
      ["Gemini 3 Pro", "Antigravity", "1.000.000", "15 %"],
      ["Claude Opus", "Antigravity", "200.000", "0 %"],
    ];
    expect(chooseTableLayout(["Model", "Provider", "Context", "Usage"], rows)).toBe("table");
  });

  it("ignores a numeric first column, which only names the rows", () => {
    expect(chooseTableLayout(["Year", "Event", "Place"], [["2024", "launch", "Madrid"], ["2025", "v2", "Paris"]])).toBe("compare");
  });
});

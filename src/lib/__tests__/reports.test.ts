import { describe, it, expect } from "vitest";
import {
  toJsonBlock,
  formatStatusText,
  formatMcpText,
  formatSkillsText,
  type StatusReport,
  type McpReport,
  type SkillsReport,
} from "@/lib/reports";

describe("toJsonBlock", () => {
  it("wraps an object in a ```json fence with pretty indentation", () => {
    const out = toJsonBlock({ a: 1, b: "x" });
    expect(out.startsWith("```json\n")).toBe(true);
    expect(out.endsWith("\n```")).toBe(true);
    expect(out).toContain('"a": 1');
    const inner = out.slice("```json\n".length, -"\n```".length);
    expect(JSON.parse(inner)).toEqual({ a: 1, b: "x" });
  });
});

describe("formatStatusText", () => {
  const base: StatusReport = {
    schema: "nyxs.status/v1",
    appVersion: "0.2.8",
    model: "claude-opus-4-8",
    workspace: "D:/proj",
    permissionMode: "plan",
    planMode: true,
    contextTokens: 12345,
    messages: 7,
  };

  it("renders model, workspace and plan flag", () => {
    const t = formatStatusText(base);
    expect(t).toContain("`claude-opus-4-8`");
    expect(t).toContain("`D:/proj`");
    expect(t).toContain("plan (plan)");
    expect(t).toContain("12,345");
    expect(t).toContain("0.2.8");
  });

  it("shows _none_ when there is no workspace", () => {
    expect(formatStatusText({ ...base, workspace: null })).toContain("_none_");
  });
});

describe("formatMcpText", () => {
  it("notes when no servers are configured", () => {
    const r: McpReport = { schema: "nyxs.mcp/v1", count: 0, servers: [] };
    expect(formatMcpText(r)).toContain("No MCP servers configured");
  });

  it("lists servers with enabled/disabled markers", () => {
    const r: McpReport = {
      schema: "nyxs.mcp/v1",
      count: 2,
      servers: [
        { name: "gmail", url: "https://a", enabled: true },
        { name: "old", url: "https://b", enabled: false },
      ],
    };
    const t = formatMcpText(r);
    expect(t).toContain("`gmail`");
    expect(t).toContain("https://a");
    expect(t).toContain("(disabled)");
  });
});

describe("formatSkillsText", () => {
  it("notes when there are no skills", () => {
    const r: SkillsReport = { schema: "nyxs.skills/v1", count: 0, skills: [] };
    expect(formatSkillsText(r)).toContain("No skills available");
  });

  it("lists skills with their source", () => {
    const r: SkillsReport = {
      schema: "nyxs.skills/v1",
      count: 1,
      skills: [{ name: "deep-research", source: "builtin", description: "Research harness" }],
    };
    const t = formatSkillsText(r);
    expect(t).toContain("`/deep-research`");
    expect(t).toContain("(builtin)");
    expect(t).toContain("Research harness");
  });
});

import { describe, it, expect } from "vitest";
import { staleBranchFinding, classifyFailure, formatRecoveryHint } from "@/lib/recovery";

describe("staleBranchFinding", () => {
  it("returns null when up to date", () => {
    expect(staleBranchFinding(0)).toBeNull();
    expect(staleBranchFinding(-1)).toBeNull();
    expect(staleBranchFinding(Number.NaN)).toBeNull();
  });

  it("surfaces a non-auto-applicable merge when behind", () => {
    const f = staleBranchFinding(3, "main");
    expect(f).not.toBeNull();
    expect(f!.id).toBe("stale-branch");
    expect(f!.remedyCommand).toBe("git merge main");
    expect(f!.autoApplicable).toBe(false);
    expect(f!.severity).toBe("info");
  });

  it("escalates severity once well behind", () => {
    expect(staleBranchFinding(25)!.severity).toBe("warning");
  });
});

describe("classifyFailure", () => {
  it("returns null for empty / unmatched input", () => {
    expect(classifyFailure("")).toBeNull();
    expect(classifyFailure("totally unrelated message")).toBeNull();
  });

  it("classifies transient MCP timeouts as auto-applicable retries", () => {
    const f = classifyFailure("MCP server handshake timed out");
    expect(f!.id).toBe("mcp-timeout");
    expect(f!.kind).toBe("retryable");
    expect(f!.autoApplicable).toBe(true);
  });

  it("classifies connection refusals as escalations", () => {
    const f = classifyFailure("connect ECONNREFUSED 127.0.0.1:8080");
    expect(f!.id).toBe("connection-refused");
    expect(f!.kind).toBe("escalate");
    expect(f!.autoApplicable).toBe(false);
  });

  it("classifies a missing git base as an auto fetch", () => {
    const f = classifyFailure("fatal: ambiguous argument 'main': unknown revision");
    expect(f!.id).toBe("base-missing");
    expect(f!.remedyCommand).toBe("git fetch --all");
    expect(f!.autoApplicable).toBe(true);
  });

  it("classifies missing files and corrupt plugins and permission errors", () => {
    expect(classifyFailure("ENOENT: no such file or directory")!.id).toBe("file-missing");
    expect(classifyFailure("failed to parse plugin manifest")!.id).toBe("plugin-corrupt");
    expect(classifyFailure("EACCES: permission denied")!.id).toBe("permission-denied");
  });
});

describe("formatRecoveryHint", () => {
  it("includes the remedy and a confirm note when not auto-applicable", () => {
    const f = staleBranchFinding(3)!;
    const hint = formatRecoveryHint(f);
    expect(hint).toContain("git merge main");
    expect(hint).toContain("confirm before running");
  });

  it("omits the confirm note for auto-applicable remedies", () => {
    const f = classifyFailure("unknown revision foo")!;
    const hint = formatRecoveryHint(f);
    expect(hint).toContain("git fetch --all");
    expect(hint).not.toContain("confirm before running");
  });
});

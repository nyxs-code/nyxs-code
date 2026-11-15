import { describe, it, expect, vi, beforeEach } from "vitest";

const settings = vi.hoisted(() => ({ merged: {} as Record<string, unknown> }));

vi.mock("@/lib/settingsRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settingsRuntime")>()),
  getMergedSnapshot: () => settings.merged,
}));

const { checkPermission, parseRuleString } = await import("@/lib/permissions");
const { autoApproveReadOnly } = await import("@/lib/featureSettings");

const bash = (command: string, mode: Parameters<typeof checkPermission>[2] = "acceptEdits", rules = [] as ReturnType<typeof parseRuleString>[]) =>
  checkPermission("Bash", { command }, mode, rules);

const READ_ONLY = ["git status", "ls -la src", "git log --oneline -5", "git diff HEAD~1 | head -50", "Get-ChildItem src"];

beforeEach(() => {
  settings.merged = {};
});

describe("permissions.autoApproveReadOnly", () => {
  it("is on unless a settings layer turns it off", () => {
    expect(autoApproveReadOnly()).toBe(true);
    settings.merged = { permissions: { allow: [] } };
    expect(autoApproveReadOnly()).toBe(true);
    settings.merged = { permissions: { autoApproveReadOnly: false } };
    expect(autoApproveReadOnly()).toBe(false);
  });

  it("on: read-only commands run without asking in Accept edits", () => {
    for (const cmd of READ_ONLY) expect(bash(cmd), cmd).toBe("allow");
    expect(bash("npm install")).toBe("ask");
  });

  it("off: they ask in Accept edits like any other command", () => {
    settings.merged = { permissions: { autoApproveReadOnly: false } };
    for (const cmd of READ_ONLY) expect(bash(cmd), cmd).toBe("ask");
    expect(bash("npm install")).toBe("ask");
  });

  it("off: the rest of Accept edits and the other modes don't change", () => {
    const modes = ["ask", "plan", "auto", "skip"] as const;
    const on = modes.map((m) => READ_ONLY.map((cmd) => bash(cmd, m)));
    settings.merged = { permissions: { autoApproveReadOnly: false } };
    expect(modes.map((m) => READ_ONLY.map((cmd) => bash(cmd, m)))).toEqual(on);
    // Plan mode lets only read-only commands through; turning this off doesn't block those.
    expect(bash("git status", "plan")).toBe("allow");
    expect(checkPermission("Edit", { file_path: "C:/ws/a.ts" }, "acceptEdits", [])).toBe("allow");
    expect(checkPermission("Read", { file_path: "C:/ws/a.ts" }, "acceptEdits", [])).toBe("allow");
  });

  it("off: a rule the user saved still allows the command", () => {
    settings.merged = { permissions: { autoApproveReadOnly: false } };
    expect(bash("git status", "acceptEdits", [parseRuleString("Bash(git status:*)", "allow")])).toBe("allow");
    expect(bash("git diff", "acceptEdits", [parseRuleString("Bash(git status:*)", "allow")])).toBe("ask");
  });

  it("never lets a destructive command through, on or off", () => {
    expect(bash("rm -rf /")).toBe("ask");
    settings.merged = { permissions: { autoApproveReadOnly: false } };
    expect(bash("rm -rf /")).toBe("ask");
  });
});

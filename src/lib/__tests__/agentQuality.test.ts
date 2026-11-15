import { describe, it, expect, vi } from "vitest";

const reads = new Map<string, string>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "agent_read_text") return reads.get(String(args.path)) ?? null;
    return null;
  }),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const { matchToolName, coerceToolInput } = await import("@/lib/toolRepair");
const { DoomLoopGuard, DOOM_LOOP_THRESHOLD } = await import("@/lib/doomLoop");
const { checkPermission } = await import("@/lib/permissions");
const { nestedInstructionDirs, nestedInstructionsFor, seenNestedDirs } = await import("@/tools/Read/nested");
const { isContextOverflowError, isTransientStreamError } = await import("@/lib/ai");
const { modelFamilyOf, getSystemPromptSections } = await import("@/lib/systemPrompt");

describe("tool call repair", () => {
  it("fixes tool names that differ only in case, separators or prefixes", () => {
    const names = ["Read", "MultiEdit", "WebFetch"];
    expect(matchToolName("read", names)).toBe("Read");
    expect(matchToolName("multi_edit", names)).toBe("MultiEdit");
    expect(matchToolName("functions.WebFetch", names)).toBe("WebFetch");
    expect(matchToolName("Delete", names)).toBeNull();
  });

  it("coerces arguments to the schema", () => {
    const schema = {
      type: "object",
      properties: {
        offset: { type: "integer" },
        replace_all: { type: "boolean" },
        edits: { type: "array", items: { type: "object", properties: { old_string: { type: "string" } } } },
        file_path: { type: "string" },
        note: { type: ["string", "null"] },
      },
      additionalProperties: false,
    };
    const { value, changed } = coerceToolInput(
      { offset: "20", replace_all: "false", edits: '[{"old_string":"a"}]', file_path: 12, extra: 1, note: null },
      schema,
    );
    expect(changed).toBe(true);
    expect(value).toEqual({ offset: 20, replace_all: false, edits: [{ old_string: "a" }], file_path: "12", note: null });
  });

  it("drops null for non-nullable optional fields and leaves valid input alone", () => {
    const schema = { type: "object", properties: { limit: { type: "number" }, path: { type: "string" } } };
    expect(coerceToolInput({ limit: null, path: "a" }, schema).value).toEqual({ path: "a" });
    expect(coerceToolInput({ path: "a" }, schema).changed).toBe(false);
  });
});

describe("doom loop guard", () => {
  it("stops the third identical call in a row", () => {
    const g = new DoomLoopGuard();
    const input = { pattern: "foo", path: "src" };
    for (let i = 1; i < DOOM_LOOP_THRESHOLD; i++) expect(g.check("Grep", input)).toBeNull();
    expect(g.check("Grep", { path: "src", pattern: "foo" })).toMatch(/same input/);
  });

  it("resets when the input changes and ignores polling tools", () => {
    const g = new DoomLoopGuard();
    g.check("Grep", { pattern: "a" });
    g.check("Grep", { pattern: "a" });
    expect(g.check("Grep", { pattern: "b" })).toBeNull();
    for (let i = 0; i < 5; i++) expect(g.check("BashOutput", { shell_id: "1" })).toBeNull();
  });
});

describe("ask rules", () => {
  const rules = [
    { toolName: "Bash", ruleContent: "git push:*", behavior: "ask" as const },
    { toolName: "Bash", ruleContent: "git:*", behavior: "allow" as const },
  ];

  it("ask beats allow, even in auto mode", () => {
    expect(checkPermission("Bash", { command: "git push origin main" }, "auto", rules)).toBe("ask");
    expect(checkPermission("Bash", { command: "git status" }, "auto", rules)).toBe("allow");
  });

  it("skip mode still bypasses ask rules", () => {
    expect(checkPermission("Bash", { command: "git push" }, "skip", rules)).toBe("allow");
  });
});

describe("nested instructions", () => {
  it("lists the directories between the file and the workspace root", () => {
    expect(nestedInstructionDirs("E:\\ws\\pkg\\app\\src\\a.ts", "E:\\ws")).toEqual([
      "E:\\ws\\pkg\\app\\src",
      "E:\\ws\\pkg\\app",
      "E:\\ws\\pkg",
    ]);
    expect(nestedInstructionDirs("E:\\ws\\a.ts", "E:\\ws")).toEqual([]);
    expect(nestedInstructionDirs("E:\\other\\a.ts", "E:\\ws")).toEqual([]);
  });

  it("attaches each nearby instruction file once", async () => {
    reads.set("E:\\ws\\pkg\\AGENTS.md", "Use pnpm here.");
    const seen = new Set<string>();
    const first = await nestedInstructionsFor("E:\\ws\\pkg\\src\\a.ts", "E:\\ws", seen, "s");
    expect(first).toContain("Use pnpm here.");
    expect(first).toContain('path="e:/ws/pkg"');
    expect(await nestedInstructionsFor("E:\\ws\\pkg\\src\\b.ts", "E:\\ws", seen, "s")).toBe("");
    expect(seenNestedDirs([first]).has("e:/ws/pkg")).toBe(true);
  });
});

describe("error classification", () => {
  it("recognizes context overflow from different providers", () => {
    expect(isContextOverflowError(new Error("prompt is too long: 210000 tokens > 200000 maximum"))).toBe(true);
    expect(isContextOverflowError({ message: "Bad request", responseBody: "This model's maximum context length is 128000 tokens" })).toBe(true);
    expect(isContextOverflowError(new Error("Invalid API key"))).toBe(false);
  });

  it("only retries transient stream failures", () => {
    expect(isTransientStreamError(new Error("Overloaded"))).toBe(true);
    expect(isTransientStreamError(new Error("socket hang up"))).toBe(true);
    expect(isTransientStreamError(new Error("401 unauthorized"))).toBe(false);
    expect(isTransientStreamError(new Error("prompt is too long"))).toBe(false);
  });
});

describe("model family notes", () => {
  it("classifies models by provider and id", () => {
    expect(modelFamilyOf("anthropic", "claude-opus-4-5")).toBe("anthropic");
    expect(modelFamilyOf("openai", "gpt-5")).toBe("openai");
    expect(modelFamilyOf("openrouter", "openai/gpt-5-codex")).toBe("openai");
    expect(modelFamilyOf("google", "gemini-2.5-pro")).toBe("gemini");
    expect(modelFamilyOf("deepseek", "deepseek-chat")).toBe("open-weights");
    expect(modelFamilyOf("custom", "my-model")).toBe("default");
  });

  it("adds notes only for non-Claude families", () => {
    const ids = (family: Parameters<typeof modelFamilyOf>[0]) =>
      getSystemPromptSections({ workspace: null, modelFamily: modelFamilyOf(family, family === "openai" ? "gpt-5" : "claude-x") }).map((s) => s.id);
    expect(ids("anthropic").some((id) => id.startsWith("model-notes"))).toBe(false);
    expect(ids("openai")).toContain("model-notes-openai");
  });
});

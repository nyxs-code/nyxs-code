import { describe, it, expect, vi } from "vitest";
import type { ModelMessage } from "ai";

const calls: Array<[string, Record<string, unknown>]> = [];
let mtime = 1;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push([cmd, args]);
    if (cmd === "agent_glob") return String(args.pattern).startsWith(".prettierrc") ? [".prettierrc"] : [];
    if (cmd === "agent_file_mtime") return mtime;
    if (cmd === "agent_run") {
      mtime++;
      return { code: 0, timed_out: false, stdout: "", stderr: "" };
    }
    return null;
  }),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const settingsState: { format?: unknown } = {};
vi.mock("@/lib/settingsRuntime", async (orig) => ({
  ...(await orig<typeof import("@/lib/settingsRuntime")>()),
  getMergedSettings: async () => settingsState,
}));

const { planShellRestore } = await import("@/lib/fileHistory");
const { recallFromSession } = await import("@/lib/sessionRecall");
const { stripStreamMarkers, headlessPermissionMode } = await import("@/headless");
const { formatAfterEdit } = await import("@/lib/formatters");
const { resolveSubagentType } = await import("@/tools/Agent/types");

describe("shadow snapshots", () => {
  it("restores only files changed by the agent's commands, to their state before the first one", () => {
    const snaps = [
      { messageId: "a", trackedFileBackups: {}, timestamp: 0, shellChanges: [{ before: "t0", after: "t1", files: ["src/gen.ts", "src/a.ts"] }] },
      { messageId: "b", trackedFileBackups: {}, timestamp: 0, shellChanges: [{ before: "t5", after: "t6", files: ["src/gen.ts", "package.json"] }] },
    ];
    const items = planShellRestore(snaps, 0, ["E:\\ws\\src\\a.ts"], "E:\\ws");
    expect(items.sort((x, y) => x.file.localeCompare(y.file))).toEqual([
      { file: "package.json", before: "t5", after: "t6" },
      { file: "src/gen.ts", before: "t0", after: "t6" },
    ]);
  });
});

describe("session recall", () => {
  const entries = [
    { index: 0, role: "user" as const, content: "build is failing" },
    {
      index: 1,
      role: "assistant" as const,
      content: "⟦TOOL⟧x⟦SEP⟧Bash⟦SEP⟧npm test⟦/TOOL⟧ done",
      responseMessages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "x",
              toolName: "Bash",
              output: { type: "text", value: "FAIL src/parser.test.ts\nTypeError: cannot read properties of undefined (reading 'kind')" },
            },
          ],
        },
      ] as ModelMessage[],
    },
  ];

  it("finds exact text inside old tool results", () => {
    const out = recallFromSession(entries, "reading 'kind'");
    expect(out).toContain("message 2 (assistant)");
    expect(out).toContain("FAIL src/parser.test.ts");
  });

  it("matches lines with most of the keywords", () => {
    expect(recallFromSession(entries, "parser test fail")).toContain("parser.test.ts");
    expect(recallFromSession(entries, "nothing like this")).toMatch(/No match/);
  });
});

describe("headless helpers", () => {
  it("strips UI markers from the final answer", () => {
    expect(stripStreamMarkers("Hi ⟦TOOL⟧1⟦SEP⟧Read⟦SEP⟧a.ts⟦/TOOL⟧⟦TOOLEND⟧1⟦SEP⟧ok⟦/TOOLEND⟧there\n\n\n\nend")).toBe("Hi there\n\nend");
  });

  it("defaults to acceptEdits and accepts known modes", () => {
    expect(headlessPermissionMode(undefined)).toBe("acceptEdits");
    expect(headlessPermissionMode("auto")).toBe("auto");
    expect(headlessPermissionMode("yolo")).toBe("acceptEdits");
  });
});

describe("format after edit", () => {
  it("does nothing unless enabled", async () => {
    settingsState.format = undefined;
    expect(await formatAfterEdit("E:\\ws", "E:\\ws\\src\\a.ts")).toBeNull();
  });

  it("runs the first formatter whose config file exists", async () => {
    settingsState.format = { enabled: true };
    calls.length = 0;
    expect(await formatAfterEdit("E:\\ws", "E:\\ws\\src\\a.ts")).toBe("prettier");
    const run = calls.find(([c]) => c === "agent_run");
    expect(String(run?.[1].command)).toMatch(/prettier --write \$\{(env:)?NYXS_FILE\}$/);
    expect(run?.[1].env).toMatchObject({ NYXS_FILE: "src/a.ts" });
  });
});

describe("verify sub-agent", () => {
  it("is a built-in type with a restricted tool list", () => {
    const def = resolveSubagentType("verify");
    expect(def.type).toBe("verify");
    expect(def.tools).toContain("Bash");
    expect(def.tools).not.toContain("Edit");
  });
});

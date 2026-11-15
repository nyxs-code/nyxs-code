import { describe, it, expect, vi, beforeAll } from "vitest";
import type { ToolSet } from "ai";

const calls: [string, Record<string, unknown>][] = [];
const MEMORY = "C:\\Users\\me\\.claude\\projects\\E--ws\\memory";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push([cmd, args]);
    if (cmd === "agent_read_claude_memory") return { dir: MEMORY, index: "- [Language](language.md) — answer in Spanish" };
    if (cmd === "agent_read_file_range") return { text: "     1\tSpanish\n", startLine: 1, endLine: 1, totalLines: 1 };
    if (cmd === "agent_file_mtime") return null;
    return "OK";
  }),
}));

let buildTools: typeof import("@/lib/agentTools").buildTools;
let loadClaudeMemory: typeof import("@/lib/skills").loadClaudeMemory;

beforeAll(async () => {
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: { invoke: async () => null, transformCallback: () => 0 },
    __NYXS_HOME__: "C:/Users/me",
    dispatchEvent: () => true,
  });
  ({ buildTools } = await import("@/lib/agentTools"));
  ({ loadClaudeMemory } = await import("@/lib/skills"));
});

type Exec = (input: unknown, o: unknown) => Promise<unknown>;
const run = (tools: ToolSet, name: string, input: unknown) => (tools[name].execute as unknown as Exec)(input, { toolCallId: "c", messages: [] });

describe("the Claude Code memory the prompt tells the model to open", () => {
  it("can be read with Read, but not written", async () => {
    const index = await loadClaudeMemory("E:\\ws");
    expect(index).toContain("C:/Users/me/.claude/projects/E--ws/memory/language.md");
    const tools = buildTools({ workspace: "E:\\ws", pathScope: { id: "scope-ws", extraRoots: [] } });

    await run(tools, "Read", { file_path: "C:/Users/me/.claude/projects/E--ws/memory/language.md" });
    expect(calls.some(([cmd, a]) => cmd === "agent_read_file_range" && String(a.path).endsWith("memory\\language.md"))).toBe(true);

    await expect(run(tools, "Write", { file_path: "C:/Users/me/.claude/projects/E--ws/memory/language.md", content: "x" })).rejects.toThrow(/fuera/);
    await expect(run(tools, "Read", { file_path: "C:/Users/me/.claude/projects/E--ws/secret.md" })).rejects.toThrow(/fuera/);
  });

  it("is only opened for the project it belongs to", async () => {
    const other = buildTools({ workspace: "E:\\other", pathScope: { id: "scope-other", extraRoots: [] } });
    await expect(run(other, "Read", { file_path: "C:/Users/me/.claude/projects/E--ws/memory/language.md" })).rejects.toThrow(/fuera/);
  });
});

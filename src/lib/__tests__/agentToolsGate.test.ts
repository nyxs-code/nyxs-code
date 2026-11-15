import { describe, it, expect, vi, beforeEach } from "vitest";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";

const calls: Array<[string, Record<string, unknown>]> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push([cmd, args]);
    if (cmd === "agent_read_file_range") return { text: "     1\thello\n", startLine: 1, endLine: 1, totalLines: 1 };
    if (cmd === "agent_file_mtime") return /new\.ts$|settings\.json$/.test(String(args.path)) ? null : 1;
    if (cmd === "agent_list_dir" || cmd === "agent_glob") return [];
    if (cmd === "agent_grep") return "";
    return "OK";
  }),
}));

const fetchMock = vi.fn(async () => new Response("<p>hello from the web</p>", { headers: { "content-type": "text/html" } }));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => (fetchMock as unknown as (...a: unknown[]) => Promise<Response>)(...args),
}));

const { buildTools, gateToolSet } = await import("@/lib/agentTools");

const WS = "E:\\ws";
const opts = { toolCallId: "call-1", messages: [] };
const skill = { name: "commit", dir: "", source: "project" as const, description: "Commit", body: "Write a commit." };

type Exec = (input: unknown, o: typeof opts) => Promise<unknown>;
const run = (tools: ToolSet, name: string, input: unknown) => (tools[name].execute as unknown as Exec)(input, opts);

function makeTools(allow: boolean) {
  const gate = vi.fn(async () => allow);
  const tools = buildTools({
    workspace: WS,
    skills: [skill],
    gate,
    pathScope: { id: "scope-ws", extraRoots: ["C:\\Users\\me\\.nyxs\\skills"] },
  });
  return { gate, tools };
}

beforeEach(() => {
  calls.length = 0;
  fetchMock.mockClear();
});

describe("path scope reaches Rust on every agent file call", () => {
  it("passes the chat's scope id to reads, listings and searches", async () => {
    const { tools } = makeTools(true);
    await run(tools, "Read", { file_path: "src/a.ts" });
    await run(tools, "ListDir", { path: "." });
    await run(tools, "Glob", { pattern: "**/*.ts" });
    await run(tools, "Grep", { pattern: "x" });
    await run(tools, "Write", { file_path: "new.ts", content: "x" });
    const scoped = calls
      .filter(([cmd]) => ["agent_read_file_range", "agent_list_dir", "agent_glob", "agent_grep", "agent_write_file"].includes(cmd))
      .slice(0, 5);
    expect(scoped.map(([cmd]) => cmd)).toEqual(["agent_read_file_range", "agent_list_dir", "agent_glob", "agent_grep", "agent_write_file"]);
    for (const [, args] of scoped) expect(args.scope).toBe("scope-ws");
  });

  it("allows the scope's extra roots and rejects anything else before calling Rust", async () => {
    const { tools } = makeTools(true);
    await run(tools, "Read", { file_path: "C:\\Users\\me\\.nyxs\\skills\\x\\SKILL.md" });
    expect(calls.some(([cmd]) => cmd === "agent_read_file_range")).toBe(true);
    calls.length = 0;
    await expect(run(tools, "Read", { file_path: "C:\\Windows\\win.ini" })).rejects.toThrow(/fuera/);
    await expect(run(tools, "Read", { file_path: "..\\other\\secret.txt" })).rejects.toThrow(/fuera/);
    expect(calls.some(([cmd]) => cmd === "agent_read_file_range")).toBe(false);
  });
});

describe("project settings writes", () => {
  const writes = () => calls.filter(([cmd]) => cmd === "agent_write_file");

  it("only unlock .nyxs/settings.json in Rust after the gate approved it", async () => {
    const approved = makeTools(true);
    await run(approved.tools, "Write", { file_path: ".nyxs/settings.json", content: "{}" });
    expect(approved.gate).toHaveBeenCalledWith("Write", expect.objectContaining({ file_path: ".nyxs/settings.json", resolved_path: "E:\\ws\\.nyxs\\settings.json" }));
    expect(writes().at(-1)?.[1]).toMatchObject({ allowConfig: true, scope: "scope-ws" });

    calls.length = 0;
    const denied = makeTools(false);
    expect(String(await run(denied.tools, "Write", { file_path: ".nyxs/settings.json", content: "{}" }))).toMatch(/Permission denied/);
    expect(writes()).toHaveLength(0);

    const ungated = buildTools({ workspace: WS, pathScope: { id: "scope-ws", extraRoots: [] } });
    await run(ungated, "Write", { file_path: ".nyxs/settings.json", content: "{}" });
    expect(writes().at(-1)?.[1]).toMatchObject({ allowConfig: false });
    await run(approved.tools, "Write", { file_path: "src/new.ts", content: "x" });
    expect(writes().at(-1)?.[1]).toMatchObject({ allowConfig: false });
  });
});

describe("WebFetch, Skill and MCP go through the permission gate", () => {
  it("does not fetch when the user denies, and fetches the normalised URL when allowed", async () => {
    const denied = makeTools(false);
    const out = await run(denied.tools, "WebFetch", { url: "docs.rs/serde", prompt: "x" });
    expect(String(out)).toMatch(/Permission denied/);
    expect(denied.gate).toHaveBeenCalledWith("WebFetch", { url: "docs.rs/serde" });
    expect(fetchMock).not.toHaveBeenCalled();

    const allowed = makeTools(true);
    const ok = await run(allowed.tools, "WebFetch", { url: "http://docs.rs/serde", prompt: "x" });
    expect(String(ok)).toContain("hello from the web");
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("https://docs.rs/serde");
  });

  it("asks before loading a skill and returns nothing from it when denied", async () => {
    const denied = makeTools(false);
    expect(String(await run(denied.tools, "Skill", { skill: "/commit" }))).toMatch(/Permission denied/);
    expect(denied.gate).toHaveBeenCalledWith("Skill", { skill: "commit" });
    const allowed = makeTools(true);
    expect(String(await run(allowed.tools, "Skill", { skill: "commit" }))).toContain("Write a commit.");
    expect(String(await run(denied.tools, "Skill", { skill: "missing" }))).toMatch(/Unknown skill/);
  });

  it("wraps MCP tools so they only run after the gate approves", async () => {
    const remote = vi.fn(async () => "created");
    const mcp: ToolSet = {
      mcp__github__create_issue: dynamicTool({
        description: "Create an issue",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: remote,
      }),
    };
    const deny = vi.fn(async () => false);
    const blocked = gateToolSet(mcp, deny);
    expect(String(await run(blocked, "mcp__github__create_issue", { title: "bug" }))).toMatch(/Permission denied/);
    expect(deny).toHaveBeenCalledWith("mcp__github__create_issue", { title: "bug" });
    expect(remote).not.toHaveBeenCalled();

    const passed = gateToolSet(mcp, vi.fn(async () => true));
    expect(await run(passed, "mcp__github__create_issue", { title: "bug" })).toBe("created");
    expect(remote).toHaveBeenCalledTimes(1);
  });
});

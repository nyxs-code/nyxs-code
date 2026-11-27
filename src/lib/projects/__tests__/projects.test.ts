import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeProject, projectFilesDir, projectFolder, resetProjectsForTests } from "../projectStore";
import { buildProjectDirectory, noteProjectRole, resetProjectDirectoryForTests, setProjectDirectory } from "../projectDirectory";
import { projectFieldsOf } from "../sessionFields";
import { decisionOf, projectToolsFor, COORDINATOR_TOOLS, THREAD_TOOLS } from "../projectTools";
import { builtinNamer, filesSection, mcpNamer, projectFilesDirFor, projectPromptFor } from "../projectPrompt";
import { setProjectHost, type ProjectHost } from "../projectHost";
import { handleSessionsMcp } from "@/lib/browserMcp";
import { isProjectTool, sessionToolFor } from "@/lib/sessionTools";
import type { Project } from "../types";

const project: Project = {
  id: "p-1",
  name: "Shop",
  createdAt: 1,
  repos: [{ path: "C:\\code\\shop", gitUrl: "https://github.com/me/shop" }],
  instructions: "Use pnpm.",
  defaults: { where: "local" },
  coordinatorChatId: "coord",
  memoryPath: "project-hubs/p-1/MEMORY.md",
};

const NOW = 1_000_000_000_000;

function publish(threads: Parameters<typeof buildProjectDirectory>[1] = []) {
  setProjectDirectory(buildProjectDirectory([project], threads, [], new Set(), new Set(), NOW), [
    ...threads.map((t) => [t.id, { projectId: "p-1", role: "thread" as const }] as [string, { projectId: string; role: "thread" }]),
  ]);
}

beforeEach(() => {
  resetProjectsForTests([project], { "p-1": "- The API is in server/" });
  resetProjectDirectoryForTests();
});

afterEach(() => setProjectHost(null));

describe("normalizeProject", () => {
  it("keeps a saved project and fills what an older file lacks", () => {
    const p = normalizeProject({ id: "p-2", coordinatorChatId: "c", repos: [{ path: " D:\\a " }, { branch: "x" }], defaults: { effort: "high", where: "cloud" } });
    expect(p).toMatchObject({ id: "p-2", name: "p-2", repos: [{ path: "D:\\a" }], instructions: "", defaults: { effort: "high", where: "cloud" }, memoryPath: "project-hubs/p-2/MEMORY.md" });
    expect(projectFolder(p)).toBe("D:\\a");
    expect(normalizeProject({ id: "p-3", coordinatorChatId: "c", sessionFolders: ["D:\\a", 3, ""] })?.sessionFolders).toEqual(["D:\\a"]);
  });

  it("refuses what isn't a project", () => {
    expect(normalizeProject(null)).toBeNull();
    expect(normalizeProject({ id: "p" })).toBeNull();
    expect(normalizeProject({ coordinatorChatId: "c" })).toBeNull();
    expect(normalizeProject({ id: "p", coordinatorChatId: "c", defaults: { effort: "huge" } })?.defaults).toEqual({ where: "local" });
  });
});

describe("projectFieldsOf", () => {
  it("takes only well-formed project fields", () => {
    expect(projectFieldsOf({ title: "x" } as Record<string, unknown>)).toEqual({});
    expect(projectFieldsOf({ projectId: "p", projectRole: "boss", threadStatus: "sleeping", threadLocation: { kind: "local" } })).toEqual({ projectId: "p" });
    expect(
      projectFieldsOf({ projectId: "p", projectRole: "thread", threadStatus: "review", threadTitle: "Fix", threadLocation: { kind: "local", workspace: "C:\\a", worktree: "C:\\wt" }, threadUpdatedAt: 5 }),
    ).toEqual({ projectId: "p", projectRole: "thread", threadStatus: "review", threadTitle: "Fix", threadLocation: { kind: "local", workspace: "C:\\a", worktree: "C:\\wt" }, threadUpdatedAt: 5 });
  });
});

describe("buildProjectDirectory", () => {
  it("lists a project's threads, live chats over saved ones, and its dot", () => {
    const saved = [
      { id: "t1", title: "Fix login", projectId: "p-1", projectRole: "thread" as const, threadStatus: "review" as const, threadTitle: "Fix login", modifiedAt: NOW - 1000, messageCount: 6, worktree: { path: "w", branch: "nyxs/t1" } },
      { id: "t2", title: "Old", projectId: "p-1", projectRole: "thread" as const, threadStatus: "resolved" as const, modifiedAt: NOW - 5000, messageCount: 2 },
      { id: "t3", title: "Gone", projectId: "p-1", projectRole: "thread" as const, archived: true },
      { id: "other", title: "Other project", projectId: "p-9", projectRole: "thread" as const },
      { id: "coord", title: "Shop", projectId: "p-1", projectRole: "coordinator" as const },
    ];
    const live = [{ id: "t2", title: "Old", projectId: "p-1", projectRole: "thread" as const, threadStatus: "needs_input" as const, threadUpdatedAt: NOW - 10, messages: [{ role: "user" }, { role: "assistant" }, { role: "assistant" }] }];
    const [entry] = buildProjectDirectory([project], saved, live, new Set(["t1"]), new Set(), NOW);
    expect(entry.threads.map((t) => [t.id, t.group, t.replies])).toEqual([
      ["t2", "waiting", 2],
      ["t1", "working", 3],
    ]);
    expect(entry.threads[1].branch).toBe("nyxs/t1");
    expect(entry.dot).toBe("waiting");
  });
});

describe("project tools", () => {
  it("are offered only to a project's sessions, by role", () => {
    publish();
    noteProjectRole("t1", "p-1", "thread");
    expect(projectToolsFor("coord")).toBe(COORDINATOR_TOOLS);
    expect(projectToolsFor("t1")).toBe(THREAD_TOOLS);
    expect(projectToolsFor("someone-else")).toEqual([]);
    expect(isProjectTool("mcp__nyxs-sessions__start_thread")).toBe(true);
    expect(isProjectTool("StartThread")).toBe(true);
    expect(isProjectTool("CreateSession")).toBe(false);
    expect(sessionToolFor("mcp__nyxs-sessions__report")?.name).toBe("Report");
  });

  it("start_thread hands the thread to the app, with where only when asked", async () => {
    publish();
    const startThread = vi.fn<ProjectHost["startThread"]>(async (_c, r) => ({ id: "t9", model: "Opus", effort: "high", where: r.where ?? "local", ...(r.where === "cloud" ? {} : { branch: "nyxs/t9" }) }));
    setProjectHost({ startThread } as unknown as ProjectHost);
    const start = COORDINATOR_TOOLS.find((d) => d.mcpName === "start_thread")!;
    const cloud = await start.run({ title: "Fix", instructions: "Do it", where: "cloud" }, { chat: "coord" });
    expect(cloud).toContain("Nyxs cloud");
    const out = await start.run({ title: "Fix", instructions: "Do it", where: "moon" }, { chat: "coord" });
    expect(startThread).toHaveBeenLastCalledWith("coord", { title: "Fix", instructions: "Do it", model: undefined });
    expect(out).toContain("t9");
    expect(out).toContain("nyxs/t9");
    // Only the coordinator opens threads.
    noteProjectRole("t1", "p-1", "thread");
    await expect(start.run({ title: "Fix", instructions: "Do it" }, { chat: "t1" })).rejects.toThrow(/coordinator/);
  });

  it("report goes through the app with review as its default status", async () => {
    publish();
    noteProjectRole("t1", "p-1", "thread");
    const report = vi.fn<ProjectHost["report"]>(async () => "delivered");
    setProjectHost({ report } as unknown as ProjectHost);
    const tool = THREAD_TOOLS[0];
    await tool.run({ text: "Done, on nyxs/t1" }, { chat: "t1" });
    await tool.run({ text: "Halfway", status: "working" }, { chat: "t1" });
    await tool.run({ text: "?", status: "weird" }, { chat: "t1" });
    expect(report.mock.calls.map((c) => c[2])).toEqual(["review", "working", "review"]);
    await expect(tool.run({ text: "x" }, { chat: "coord" })).rejects.toThrow(/thread/);
  });

  it("list_threads tells each thread's state", async () => {
    publish([{ id: "t1", title: "Fix login", projectId: "p-1", projectRole: "thread", threadStatus: "review", threadPreview: "Fixed the redirect", threadUpdatedAt: NOW - 1000, worktree: { path: "w", branch: "nyxs/t1" } }]);
    const list = COORDINATOR_TOOLS.find((d) => d.mcpName === "list_threads")!;
    const out = await list.run({}, { chat: "coord" });
    expect(out).toContain("t1 · Fix login · to review · nyxs/t1");
    expect(out).toContain("Fixed the redirect");
  });

  it("checks a decision's options", () => {
    expect(decisionOf({ question: "Which?", options: [{ label: "A" }] })).toBeNull();
    expect(decisionOf({ question: "", options: [{ label: "A" }, { label: "B" }] })).toBeNull();
    expect(decisionOf({ question: "Which?", options: [{ label: "A", consequence: "fast" }, { label: "B" }, { label: "" }], recommended: "B" })).toEqual({
      question: "Which?",
      options: [{ label: "A", consequence: "fast" }, { label: "B" }],
      recommended: "B",
    });
    expect(decisionOf({ question: "Which?", options: [{ label: "A" }, { label: "B" }], recommended: "C" })?.recommended).toBeUndefined();
  });
});

describe("project prompts and the sessions MCP server", () => {
  it("gives each role its prompt with the project's instructions and memory", () => {
    publish();
    noteProjectRole("t1", "p-1", "thread");
    const coord = projectPromptFor("coord", builtinNamer);
    expect(coord).toContain('Nyxs project "Shop"');
    expect(coord).toContain("StartThread");
    expect(coord).toContain("Use pnpm.");
    expect(coord).toContain("- The API is in server/");
    const thread = projectPromptFor("t1", mcpNamer("mcp__nyxs-sessions__"));
    expect(thread).toContain("mcp__nyxs-sessions__report");
    expect(projectPromptFor("nobody")).toBe("");
  });

  it("lists the project tools only to a project's session", async () => {
    publish();
    const names = async (chat: string) => {
      const res = (await handleSessionsMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, chat)) as { result: { tools: { name: string }[] } };
      return res.result.tools.map((x) => x.name);
    };
    expect(await names("coord")).toEqual(expect.arrayContaining(["create_session", "start_thread", "ask_decision", "update_memory"]));
    expect(await names("coord")).not.toContain("report");
    expect(await names("plain")).not.toContain("start_thread");
    const init = (await handleSessionsMcp({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }, "coord")) as { result: { instructions: string } };
    expect(init.result.instructions).toContain("coordinator");
  });
});

describe("context files in the prompt", () => {
  it("inline the small text files, list the rest, and let the project's sessions read them", () => {
    resetProjectsForTests([project], {}, {
      dirs: { "p-1": "/data/project-hubs/p-1" },
      files: { "p-1": [{ rel: "brief.md", size: 12, text: "# Brief" }, { rel: "docs/big.pdf", size: 2_000_000, text: null }] },
    });
    publish();
    const section = filesSection(project, projectFilesDir("p-1"));
    expect(section).toContain("/data/project-hubs/p-1/files");
    expect(section).toContain("### brief.md");
    expect(section).toContain("# Brief");
    expect(section).toContain("- docs/big.pdf (1953 KB)");
    expect(projectPromptFor("coord")).toContain("## Project files");
    expect(projectFilesDirFor("coord")).toBe("/data/project-hubs/p-1/files");
    expect(projectFilesDirFor("nobody")).toBeNull();
    // A cloud thread gets the text only.
    expect(filesSection(project, null)).toContain("aren't available here");
  });
});

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

/** Every subscription preflight holds, by folder, with the callback the watcher would call. */
const subs = vi.hoisted(() => new Map<string, { cb: () => void; off: () => void }>());
vi.mock("../fsWatch", () => ({
  subscribeFsChange: (workspace: string, cb: () => void) => {
    const off = vi.fn(() => subs.delete(workspace));
    subs.set(workspace, { cb, off });
    return off;
  },
}));
const loadProjectMemory = vi.hoisted(() => vi.fn(async (workspace: string) => `memory of ${workspace}`));
vi.mock("../skills", () => ({
  loadSkills: async () => [],
  loadProjectMemory,
  loadProjectMemoryBundle: async () => ({ text: "", files: [] }),
  loadClaudeMemory: async () => "",
}));
vi.mock("../agentFiles", () => ({ loadAgentFiles: async () => [] }));
vi.mock("../plugins/pluginLoader", () => ({ loadPluginComponents: async () => null }));
vi.mock("../gitErrors", () => ({ runGit: vi.fn(), classifyGitFailure: vi.fn(), untrustedRepoContext: vi.fn() }));
vi.mock("../recovery", () => ({ staleBranchFinding: () => null, formatRecoveryHint: () => "" }));

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
const { cachedNyxsMemory } = await import("../preflight");

describe("preflight cache invalidation", () => {
  it("keeps watching the project on screen while a chat in the background asks for another", async () => {
    await cachedNyxsMemory("D:/app");
    await cachedNyxsMemory("E:/other");
    expect([...subs.keys()]).toEqual(["D:/app", "E:/other"]);

    // A change in the first project still drops its cache.
    await cachedNyxsMemory("D:/app");
    expect(loadProjectMemory).toHaveBeenCalledTimes(2);
    subs.get("D:/app")!.cb();
    await cachedNyxsMemory("D:/app");
    expect(loadProjectMemory).toHaveBeenCalledTimes(3);
  });

  it("stops watching the oldest projects, and forgets what it cached for them", async () => {
    for (const ws of ["F:/a", "F:/b", "F:/c", "F:/d"]) await cachedNyxsMemory(ws);
    // D:/app was used last of the first two, so E:/other goes first.
    expect(subs.has("E:/other")).toBe(false);
    expect(subs.size).toBe(4);
    const before = loadProjectMemory.mock.calls.length;
    await cachedNyxsMemory("E:/other");
    expect(loadProjectMemory.mock.calls.length).toBe(before + 1);
  });
});

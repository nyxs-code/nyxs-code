import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolSet } from "ai";

let snapshot: Record<string, unknown> = {};
/** Settings of folders other than the open one (whose settings are `snapshot`). */
const folders: Record<string, Record<string, unknown>> = {};
vi.mock("@/lib/settingsRuntime", async (orig) => ({
  ...(await orig<typeof import("@/lib/settingsRuntime")>()),
  getMergedSnapshot: () => snapshot,
  getMergedSettings: async () => snapshot,
  settingsSnapshotFor: (ws?: string | null) => ({ merged: folders[ws ?? ""] ?? snapshot, perSource: {} }),
}));

const calls: [string, Record<string, unknown>][] = [];
let grepOut = "";
let globOut: string[] = [];
let gitOut = "";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push([cmd, args]);
    if (cmd === "agent_read_file_range") return { text: "     1\tsecret\n", startLine: 1, endLine: 1, totalLines: 1 };
    if (cmd === "agent_file_mtime") return 1;
    if (cmd === "agent_list_dir") return ["a.txt"];
    if (cmd === "agent_grep") return grepOut;
    if (cmd === "agent_glob") return globOut;
    if (cmd === "agent_git") return { stdout: gitOut, stderr: "", code: 0, timed_out: false };
    return "OK";
  }),
}));

const { checkPermission } = await import("@/lib/permissions");
const { buildTools } = await import("@/lib/agentTools");

const WS = "E:\\ws";
type Rule = { toolName: string; ruleContent?: string; behavior: "allow" | "deny" | "ask" };
const deny = (...rules: string[]): Rule[] => rules.map((r) => {
  const m = /^([^(]+)\((.*)\)$/.exec(r)!;
  return { toolName: m[1], ruleContent: m[2], behavior: "deny" };
});

function toolsWith(rules: Rule[]) {
  snapshot = { permissions: { deny: rules.filter((r) => r.behavior === "deny").map((r) => `${r.toolName}(${r.ruleContent})`) } };
  const gate = vi.fn(async (tool: string, input: unknown) => checkPermission(tool, input, "acceptEdits", rules) !== "deny");
  return { gate, tools: buildTools({ workspace: WS, gate, pathScope: { id: "s", extraRoots: [] } }) };
}
type Exec = (input: unknown, o: unknown) => Promise<unknown>;
const run = (tools: ToolSet, name: string, input: unknown) => (tools[name].execute as unknown as Exec)(input, { toolCallId: "c", messages: [] });

beforeEach(() => {
  calls.length = 0;
  snapshot = {};
  for (const k of Object.keys(folders)) delete folders[k];
});

describe("path rules match the file, not how its path was written", () => {
  const forms = (raw: string, rel: string) => ({ file_path: raw, resolved_path: `${WS}\\${rel.replace(/\//g, "\\")}`, project_path: rel });

  it("match ./x, the absolute path and other letter case on Windows", () => {
    const rules = deny("Read(.env)");
    for (const input of [forms("./.env", ".env"), forms("E:\\ws\\.env", ".env"), forms("E:\\WS\\.ENV", ".ENV")]) {
      expect(checkPermission("Read", input, "acceptEdits", rules), input.file_path).toBe("deny");
    }
    expect(checkPermission("Read", forms("src/env.ts", "src/env.ts"), "acceptEdits", rules)).toBe("allow");
  });

  it("support ** and match a bare name at any depth", () => {
    expect(checkPermission("Read", forms("keys/deploy/a.pem", "keys/deploy/a.pem"), "acceptEdits", deny("Read(**/*.pem)"))).toBe("deny");
    expect(checkPermission("Read", forms("config/.env", "config/.env"), "acceptEdits", deny("Read(.env)"))).toBe("deny");
    expect(checkPermission("Edit", forms("./src/x.ts", "src/x.ts"), "acceptEdits", deny("Edit(src/x.ts)"))).toBe("deny");
  });

  it("don't let ../ stretch an allow rule beyond its folder", () => {
    const allow: Rule[] = [{ toolName: "Edit", ruleContent: "src/*", behavior: "allow" }];
    expect(checkPermission("Edit", forms("src/../secret.ts", "secret.ts"), "ask", allow)).toBe("ask");
    expect(checkPermission("Edit", forms("./src/a.ts", "src/a.ts"), "ask", allow)).toBe("allow");
  });
});

describe("deny rules hold for every tool of the built-in models that reads", () => {
  it("Read refuses a denied file however it is named", async () => {
    const { tools } = toolsWith(deny("Read(.env)"));
    for (const file_path of [".env", "./.env", "E:/WS/.env"]) {
      expect(String(await run(tools, "Read", { file_path })), file_path).toMatch(/Permission denied/);
    }
    expect(calls.some(([cmd]) => cmd === "agent_read_file_range")).toBe(false);
  });

  it("ListDir refuses a folder whose files are all denied", async () => {
    const { tools } = toolsWith(deny("Read(secrets/**)"));
    expect(String(await run(tools, "ListDir", { path: "secrets" }))).toMatch(/Permission denied/);
    expect(String(await run(tools, "ListDir", { path: "src" }))).toBe("a.txt");
  });

  it("Grep and Glob leave denied files out of what they found", async () => {
    const { tools } = toolsWith(deny("Read(.env)"));
    grepOut = "E:\\ws\\.env:1:API_KEY=123\nE:\\ws\\src\\a.ts:2:const API_KEY = env()";
    const found = String(await run(tools, "Grep", { pattern: "API_KEY", output_mode: "content" }));
    expect(found).not.toContain("123");
    expect(found).toContain("src\\a.ts:2:");
    grepOut = "E:\\ws\\.env";
    expect(String(await run(tools, "Grep", { pattern: "API_KEY" }))).toBe("No matches.");
    globOut = ["E:\\ws\\.env", "E:\\ws\\src\\a.ts"];
    expect(String(await run(tools, "Glob", { pattern: "**/*" }))).toBe("E:\\ws\\src\\a.ts");
  });

  it("Grep leaves out what the turn's own folder denies, whatever folder is open", async () => {
    const { tools } = toolsWith([]);
    folders[WS] = { permissions: { deny: ["Read(.env)"] } };
    snapshot = {};
    grepOut = "E:\\ws\\.env:1:API_KEY=123\nE:\\ws\\src\\a.ts:2:x";
    expect(String(await run(tools, "Grep", { pattern: "API_KEY", output_mode: "content" }))).not.toContain("123");
  });

  it("Grep and Glob refuse a denied folder to search in", async () => {
    const { tools } = toolsWith(deny("Read(secrets/**)"));
    expect(String(await run(tools, "Grep", { pattern: "x", path: "secrets" }))).toMatch(/Permission denied/);
    expect(String(await run(tools, "Glob", { pattern: "*", path: "./secrets" }))).toMatch(/Permission denied/);
  });

  it("the Git tools refuse a denied file and drop it from a whole diff", async () => {
    const { tools } = toolsWith(deny("Read(.env)"));
    expect(String(await run(tools, "GitBlame", { file_path: ".env" }))).toMatch(/Permission denied/);
    expect(String(await run(tools, "GitDiff", { path: "./.env" }))).toMatch(/Permission denied/);
    gitOut = [
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "-API_KEY=old",
      "+API_KEY=new",
      "diff --git a/src/a.ts b/src/a.ts",
      "+const a = 1;",
    ].join("\n");
    const diff = String(await run(tools, "GitDiff", {}));
    expect(diff).not.toContain("API_KEY");
    expect(diff).toContain("diff --git a/src/a.ts b/src/a.ts");
  });
});

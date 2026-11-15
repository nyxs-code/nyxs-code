import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const { buildTools, usesApplyPatch, planModeBlockMessage, patchFileStats, describeToolCall, buildToolDetail } = await import("@/lib/agentTools");
const { parsePatch, PatchError } = await import("@/tools/ApplyPatch/parse");
const { newToolSession } = await import("@/lib/fileStateCache");
const { getSystemPromptSections } = await import("@/lib/systemPrompt");

const patch = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");

describe("Codex patch format", () => {
  it("reads added, updated, moved and deleted files in order", () => {
    const ops = parsePatch(
      patch(
        "*** Add File: src/new.ts",
        "+export const a = 1;",
        "+",
        "*** Update File: src/app.ts",
        "*** Move to: src/main.ts",
        "@@ function run() {",
        "   const x = 1;",
        "-  return x;",
        "+  return x + 1;",
        " }",
        "*** Delete File: old.txt",
      ),
    );
    expect(ops).toEqual([
      { type: "add", path: "src/new.ts", content: "export const a = 1;\n\n" },
      {
        type: "update",
        path: "src/app.ts",
        moveTo: "src/main.ts",
        hunks: [{ header: "function run() {", oldLines: ["  const x = 1;", "  return x;", "}"], newLines: ["  const x = 1;", "  return x + 1;", "}"], endOfFile: false }],
      },
      { type: "delete", path: "old.txt" },
    ]);
  });

  it("takes a heredoc, a first hunk without @@ and blank lines that lost their space", () => {
    const [op] = parsePatch(`cat <<'EOF'\n${patch("*** Update File: a.py", " def f():", "", "-    pass", "+    return 1", "", "*** End of File")}\nEOF`);
    expect(op).toMatchObject({ type: "update", hunks: [{ oldLines: ["def f():", "", "    pass"], newLines: ["def f():", "", "    return 1"], endOfFile: true }] });
  });

  it("says what is wrong and where", () => {
    expect(() => parsePatch("*** Update File: a.ts\n-x")).toThrow(/must start with "\*\*\* Begin Patch"/);
    expect(() => parsePatch("*** Begin Patch\n*** Update File: a.ts\n-x\n+y")).toThrow(/cut off/);
    expect(() => parsePatch(patch("*** Update File: a.ts", "x"))).toThrow(/line 3 of the patch, in a\.ts/);
    expect(() => parsePatch(patch("*** Update File: a.ts", " same"))).toThrow(/no changes/);
    expect(() => parsePatch(patch("diff --git a/x b/x"))).toThrow(PatchError);
  });
});

describe("which models get apply_patch", () => {
  it("follows opencode's rule: GPT, but not gpt-oss nor GPT-4", () => {
    expect(["gpt-5", "gpt-5.2-codex", "openai/gpt-5-mini"].map(usesApplyPatch)).toEqual([true, true, true]);
    expect(["gpt-4o", "gpt-4.1", "openai/gpt-oss-120b", "claude-opus-4", "o3", "deepseek-chat"].map(usesApplyPatch)).toEqual([false, false, false, false, false, false]);
  });

  it("swaps the three edit tools for it, the same catalog every turn and in plan mode", async () => {
    const names = (o: Parameters<typeof buildTools>[0]) => Object.keys(buildTools(o));
    const patched = names({ workspace: "E:\\ws", patchEdits: true });
    expect(patched).toContain("apply_patch");
    expect(patched).not.toEqual(expect.arrayContaining(["Edit"]));
    expect(patched.filter((n) => ["Edit", "Write", "MultiEdit"].includes(n))).toEqual([]);
    expect(names({ workspace: "E:\\ws", patchEdits: true })).toEqual(patched);
    expect(names({ workspace: "E:\\ws", patchEdits: true, planMode: true })).toEqual(patched);
    expect(names({ workspace: "E:\\ws" })).toEqual(expect.arrayContaining(["Edit", "Write", "MultiEdit"]));
    const plan = buildTools({ workspace: "E:\\ws", patchEdits: true, planMode: true });
    const run = plan.apply_patch.execute as unknown as (i: unknown, o: unknown) => Promise<unknown>;
    expect(await run({ input: patch("*** Delete File: a.ts") }, { toolCallId: "p", messages: [] })).toBe(planModeBlockMessage("apply_patch"));
  });

  it("tells such a model about apply_patch instead of Edit and Write", () => {
    const text = (patchEdits: boolean) =>
      getSystemPromptSections({ workspace: null, modelFamily: "openai", planMode: true, confirmBeforeWrite: true, patchEdits })
        .map((s) => s.content)
        .join("\n");
    const patched = text(true);
    expect(patched).toContain("**apply_patch**");
    expect(patched).not.toMatch(/\*\*(Edit|Write|MultiEdit)\*\*|Edit\/MultiEdit|Write\/Edit|Write, Edit, MultiEdit/);
    expect(text(false)).toContain("**Edit**");
  });
});

type Tools = ReturnType<typeof buildTools>;
const exec = (tools: Tools, input: unknown, toolCallId = "c1") =>
  (tools.apply_patch.execute as unknown as (i: unknown, o: unknown) => Promise<string>)(input, { toolCallId, messages: [] });

describe("applying a patch", () => {
  const files = new Map<string, string>();
  let gate: ReturnType<typeof vi.fn>;
  let edits: unknown[];
  let tracked: string[];

  beforeEach(() => {
    files.clear();
    files.set("E:\\ws\\a.ts", "one\ntwo\nthree\n");
    edits = [];
    tracked = [];
    gate = vi.fn(async () => true);
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string, a: Record<string, unknown>) => {
      const path = a?.path as string;
      if (cmd === "agent_read_file_range") return { text: "     1\tone\n", startLine: 1, endLine: 3, totalLines: 3 };
      if (cmd === "agent_file_mtime") return files.has(path) ? 5 : null;
      if (cmd === "agent_read_text") return files.get(path) ?? null;
      if (cmd === "agent_multi_edit") {
        edits.push(...(a.edits as unknown[]));
        if ((a.edits as { oldString: string }[]).some((e) => e.oldString.includes("missing"))) {
          throw new Error("Edit #2: old_string wasn't found. Read the file and copy the exact text. No change was applied.");
        }
        return `OK: edits in ${path}`;
      }
      if (cmd === "agent_write_file") {
        files.set(path, a.content as string);
        return `OK: wrote ${path}`;
      }
      if (cmd === "agent_delete_file") {
        files.delete(path);
        return `OK: deleted ${path}`;
      }
      return null;
    });
  });

  const tools = async (read = true) => {
    const t = buildTools({ workspace: "E:\\ws", pathScope: { id: "scope-ws", extraRoots: [] }, session: newToolSession(), gate, patchEdits: true, onFileEdit: async (p) => void tracked.push(p) });
    if (read) await (t.Read.execute as unknown as (i: unknown, o: unknown) => Promise<unknown>)({ file_path: "a.ts" }, { toolCallId: "r", messages: [] });
    return t;
  };

  it("applies each hunk through Edit's matching, with Edit's and Write's permissions and history", async () => {
    const out = await exec(
      await tools(),
      { input: patch("*** Update File: a.ts", "@@", " one", "-two", "+TWO", "@@ three", "+four", "*** Add File: b.ts", "+hi") },
    );
    expect(out).toMatch(/^Success/);
    expect(out).toContain("M a.ts");
    expect(out).toContain("A b.ts");
    // A hunk with only added lines goes after its "@@" line, as it is in the file.
    expect(edits).toEqual([
      { oldString: "one\ntwo", newString: "one\nTWO" },
      { oldString: "three", newString: "three\nfour" },
    ]);
    expect(files.get("E:\\ws\\b.ts")).toBe("hi\n");
    // The Read the setup does asks Read's gate too.
    const changes = gate.mock.calls.filter(([tool]) => tool !== "Read");
    expect(changes.map(([tool, input]) => [tool, (input as { file_path: string }).file_path])).toEqual([
      ["Edit", "a.ts"],
      ["Write", "b.ts"],
    ]);
    expect(tracked).toEqual(["E:\\ws\\a.ts", "E:\\ws\\b.ts"]);
  });

  it("explains a hunk that doesn't apply in the patch's terms, and what was already changed", async () => {
    const out = await exec(await tools(), { input: patch("*** Add File: c.ts", "+x", "*** Update File: a.ts", "-one", "+1", "@@", "-missing", "+m", "*** Delete File: d.ts") });
    expect(out).toContain("ERROR applying the patch to a.ts: Hunk 2 in a.ts: the hunk's context and removed lines wasn't found.");
    expect(out).toContain("Nothing in a.ts was changed.");
    expect(out).toContain("Already applied (left as they are now): A c.ts.");
    expect(out).toContain("Not attempted: d.ts.");
    expect(invoke.mock.calls.some(([cmd]) => cmd === "agent_delete_file")).toBe(false);
  });

  it("won't update a file it hasn't read, and stops at a denied permission", async () => {
    expect(await exec(await tools(false), { input: patch("*** Update File: a.ts", "-one", "+1") })).toMatch(/haven't read/);
    gate.mockResolvedValue(false);
    expect(await exec(await tools(), { input: patch("*** Delete File: a.ts") })).toMatch(/Permission denied.*No file was changed/s);
    expect(files.has("E:\\ws\\a.ts")).toBe(true);
  });

  it("moves a file: the new path gets the result and the old one goes", async () => {
    files.set("E:\\ws\\a.ts", "one\nTWO\nthree\n");
    const out = await exec(await tools(), { input: patch("*** Update File: a.ts", "*** Move to: src/a.ts") });
    expect(out).toContain("R a.ts → src/a.ts");
    expect(files.get("E:\\ws\\src\\a.ts")).toBe("one\nTWO\nthree\n");
    expect(files.has("E:\\ws\\a.ts")).toBe(false);
  });

  it("rejects a malformed or cut-off patch without touching anything", async () => {
    expect(await exec(await tools(), { input: "*** Begin Patch\n*** Update File: a.ts\n-one" })).toMatch(/^ERROR: .*cut off.*Nothing was applied\./);
    expect(invoke.mock.calls.some(([cmd]) => cmd === "agent_multi_edit")).toBe(false);
  });
});

describe("a patch in the chat", () => {
  const text = patch("*** Update File: a.ts", " one", "-two", "+TWO", "+2b", "*** Add File: b.ts", "+x", "+y", "*** Delete File: c.ts");

  it("shows as an edit of its files, with the lines each one changes", async () => {
    expect(describeToolCall("apply_patch", { input: text })).toEqual({ name: "Edit", detail: "a.ts, b.ts, c.ts" });
    expect(patchFileStats(text)).toEqual([
      { path: "a.ts", added: 2, removed: 1 },
      { path: "b.ts", added: 2, removed: 0 },
      { path: "c.ts", added: 0, removed: 0 },
    ]);
    expect(await buildToolDetail("apply_patch", { input: text })).toMatchObject({ name: "Edit", added: 4, removed: 1 });
  });
});

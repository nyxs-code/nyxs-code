import { describe, it, expect, vi } from "vitest";
import { truncateMiddle, truncateNumberedLines } from "@/tools/limits";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const { buildTools, formatReadRange, formatRunResult } = await import("@/lib/agentTools");

const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i).padStart(6)}\tline ${from + i}\n`).join("");

describe("truncateMiddle", () => {
  it("keeps both ends and says how much was dropped", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `row ${i}`).join("\n");
    const out = truncateMiddle(text, 600);
    expect(out.length).toBeLessThanOrEqual(700);
    expect(out.startsWith("row 0\n")).toBe(true);
    expect(out.endsWith("row 999")).toBe(true);
    expect(out).toMatch(/\[\d+ characters omitted from the middle of the output\]/);
  });

  it("leaves short text alone", () => {
    expect(truncateMiddle("short", 100)).toBe("short");
  });
});

describe("formatRunResult", () => {
  it("puts the exit code first and keeps the end of a long failing build", () => {
    const stdout = Array.from({ length: 5000 }, (_, i) => `compiling crate ${i}`).join("\n") + "\nerror[E0308]: mismatched types";
    const out = formatRunResult({ stdout, stderr: "", code: 101, timed_out: false }, 30_000);
    expect(out.startsWith("[exit code: 101]")).toBe(true);
    expect(out).toContain("error[E0308]: mismatched types");
    expect(out.length).toBeLessThan(30_200);
  });

  it("gives stderr room even when stdout is huge", () => {
    const stdout = "x".repeat(100_000);
    const out = formatRunResult({ stdout, stderr: "FAIL src/a.test.ts", code: 1, timed_out: true, cancelled: false }, 30_000);
    expect(out.startsWith("[exit code: 1, timeout]")).toBe(true);
    expect(out).toContain("[stderr]\nFAIL src/a.test.ts");
  });

  it("points to the full log only when the output was cut", () => {
    const log = "C:\\cache\\command-output\\1-stdout.log";
    const cut = formatRunResult({ stdout: "y".repeat(100_000), stderr: "", code: 0, timed_out: false, stdout_log: log }, 30_000);
    expect(cut).toContain(`[full stdout saved to ${log}`);
    expect(cut.length).toBeLessThan(30_000);
    const whole = formatRunResult({ stdout: "short", stderr: "", code: 0, timed_out: false, stdout_log: log }, 30_000);
    expect(whole).not.toContain("full stdout");
  });
});

describe("formatReadRange", () => {
  it("says nothing extra when the whole file was shown", () => {
    const text = numbered(1, 3);
    expect(formatReadRange({ text, startLine: 1, endLine: 3, totalLines: 3 }, 60_000)).toBe(text);
  });

  it("tells the model where a partial read stops and how to continue", () => {
    const out = formatReadRange({ text: numbered(1, 2000), startLine: 1, endLine: 2000, totalLines: 5000 }, 60_000);
    expect(out).toMatch(/\[Showing lines 1-2000 of 5000\. Use offset=2001 to continue\.\]$/);
  });

  it("continues from the last whole line when the size limit cuts the range", () => {
    const out = formatReadRange({ text: numbered(1, 2000), startLine: 1, endLine: 2000, totalLines: 2000 }, 1000);
    const { lastLine } = truncateNumberedLines(numbered(1, 2000), 1000);
    expect(lastLine).toBeGreaterThan(10);
    expect(out).toContain(`[Showing lines 1-${lastLine} of 2000 (output size limit reached). Use offset=${lastLine! + 1} to continue.]`);
  });

  it("reports the file length when the offset is past the end", () => {
    const out = formatReadRange({ text: "(no hay líneas en el rango solicitado)", startLine: 0, endLine: 0, totalLines: 12 }, 60_000);
    expect(out).toContain("The file has 12 lines.");
  });
});

const { FileStateCache, fileStateFor, newToolSession, readFingerprint } = await import("@/lib/fileStateCache");
const { liveToolResultFingerprints, MC_CLEARED_MESSAGE } = await import("@/lib/microcompact");
const { toOneBasedPositions } = await import("@/lib/agentTools");

type Session = ReturnType<typeof newToolSession>;

function toolsWith(session: Session) {
  return buildTools({
    workspace: "E:\\ws",
    pathScope: {
    id: "scope-ws",
    extraRoots: [],
  },
    session,
  });
}

const exec = (tools: ReturnType<typeof toolsWith>, name: string, input: unknown, toolCallId: string) =>
  (tools[name].execute as unknown as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId, messages: [] });

function fakeDisk(mtime: { value: number }) {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "agent_read_file_range") return { text: numbered(1, 3), startLine: 1, endLine: 3, totalLines: 3 };
    if (cmd === "agent_file_mtime") return mtime.value;
    if (cmd === "agent_edit_file") {
      mtime.value += 10;
      return "OK: 1 reemplazo(s)";
    }
    return null;
  });
}

describe("re-reading a file", () => {
  it("skips the content when the same range is unchanged and still in context", async () => {
    const mtime = { value: 10 };
    fakeDisk(mtime);
    const tools = toolsWith(newToolSession());
    expect(String(await exec(tools, "Read", { file_path: "a.ts" }, "r1"))).toContain("line 1");
    expect(String(await exec(tools, "Read", { file_path: "a.ts" }, "r2"))).toMatch(/unchanged .* not repeated/);
    expect(String(await exec(tools, "Read", { file_path: "a.ts", offset: 2 }, "r3"))).toContain("line 1");
    mtime.value = 11;
    const changed = String(await exec(tools, "Read", { file_path: "a.ts", offset: 2 }, "r4"));
    expect(changed).toContain("changed on disk");
  });

  it("sends the content again when the earlier result was compacted away", async () => {
    fakeDisk({ value: 10 });
    const session = newToolSession();
    await exec(toolsWith(session), "Read", { file_path: "a.ts" }, "r1");
    const nextTurn = { fileState: session.fileState, visibleReads: new Set<string>() };
    expect(String(await exec(toolsWith(nextTurn), "Read", { file_path: "a.ts" }, "r2"))).toContain("line 1");
  });

  it("does not call our own edit an external change", async () => {
    const mtime = { value: 10 };
    fakeDisk(mtime);
    const tools = toolsWith(newToolSession());
    await exec(tools, "Read", { file_path: "a.ts" }, "r1");
    expect(String(await exec(tools, "Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, "e1"))).toContain("OK");
    const again = String(await exec(tools, "Read", { file_path: "a.ts" }, "r2"));
    expect(again).toContain("line 1");
    expect(again).not.toContain("changed on disk");
  });
});

describe("edit guard", () => {
  it("passes the mtime it checked to Rust so a late external edit is still caught", async () => {
    fakeDisk({ value: 42 });
    const tools = toolsWith(newToolSession());
    await exec(tools, "Read", { file_path: "a.ts" }, "r1");
    await exec(tools, "Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, "e1");
    const call = invoke.mock.calls.find(([cmd]) => cmd === "agent_edit_file");
    expect(call?.[1]).toMatchObject({ expectedMtime: 42 });
  });

  it("keeps what one chat read away from another chat", async () => {
    fakeDisk({ value: 1 });
    await exec(toolsWith({ fileState: fileStateFor("chat-a"), visibleReads: new Set() }), "Read", { file_path: "a.ts" }, "r1");
    const other = String(
      await exec(toolsWith({ fileState: fileStateFor("chat-b"), visibleReads: new Set() }), "Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, "e1"),
    );
    expect(other).toMatch(/haven't read/);
    expect(fileStateFor("chat-a").has("E:\\ws\\a.ts")).toBe(true);
  });
});

describe("FileStateCache keys", () => {
  it("treats Windows paths case-insensitively", () => {
    const cache = new FileStateCache();
    cache.set("E:\\Repo\\A.ts", { mtime: 1, size: 1 });
    expect(cache.get("e:/repo/a.ts")?.mtime).toBe(1);
    cache.set("/home/me/A.ts", { mtime: 2, size: 1 });
    expect(cache.has("/home/me/a.ts")).toBe(false);
  });
});

describe("liveToolResultFingerprints", () => {
  it("ignores results that microcompaction cleared", () => {
    const prints = liveToolResultFingerprints(
      [
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "a", toolName: "Read", output: { type: "text", value: "x" } },
            { type: "tool-result", toolCallId: "b", toolName: "Read", output: { type: "text", value: MC_CLEARED_MESSAGE } },
            { type: "tool-result", toolCallId: "c", toolName: "Grep", output: { type: "text", value: "y" } },
          ],
        },
      ] as never,
      "Read",
    );
    expect([...prints]).toEqual([readFingerprint("x")]);
  });

  it("still recognises an earlier read after the provider rewrote the tool call IDs", async () => {
    fakeDisk({ value: 10 });
    const session = newToolSession();
    const first = String(await exec(toolsWith(session), "Read", { file_path: "a.ts" }, "toolu_original"));
    const history = [
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_rewritten_7", toolName: "Read", output: { type: "text", value: first } }] },
    ];
    const nextTurn = { fileState: session.fileState, visibleReads: liveToolResultFingerprints(history as never, "Read") };
    expect(String(await exec(toolsWith(nextTurn), "Read", { file_path: "a.ts" }, "r2"))).toMatch(/unchanged .* not repeated/);
  });
});

describe("toOneBasedPositions", () => {
  it("shifts every LSP position to the numbers Read shows", () => {
    const out = toOneBasedPositions([{ uri: "f", range: { start: { line: 0, character: 4 }, end: { line: 2, character: 0 } } }]);
    expect(out).toEqual([{ uri: "f", range: { start: { line: 1, character: 5 }, end: { line: 3, character: 1 } } }]);
  });
});

describe("Read tool offset", () => {
  it("treats offset as the 1-based line number shown in the output", async () => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_read_file_range") return { text: numbered(120, 121), startLine: 120, endLine: 121, totalLines: 300 };
      if (cmd === "agent_file_mtime") return 1;
      return null;
    });
    const tools = buildTools({
      workspace: "E:\\ws",
      pathScope: {
      id: "scope-ws",
      extraRoots: [],
    },
    });
    const exec = tools.Read.execute as unknown as (i: unknown, o: unknown) => Promise<unknown>;
    await exec({ file_path: "a.ts", offset: 120, limit: 2 }, { toolCallId: "c", messages: [] });
    const call = invoke.mock.calls.find(([cmd]) => cmd === "agent_read_file_range");
    expect(call?.[1]).toMatchObject({ offset: 119, limit: 2 });
  });
});

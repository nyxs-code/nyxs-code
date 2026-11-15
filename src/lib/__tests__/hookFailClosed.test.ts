import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const { runHooks } = await import("@/lib/hooks");

const config = { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command" as const, command: "node guard.js" }] }] };
const post = { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command" as const, command: "node log.js" }] }] };

beforeEach(() => invoke.mockReset());

/** agent_run fails to start the process; anything else the modules ask for answers nothing. */
const failRun = (message: string) =>
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "agent_run") throw new Error(message);
    return null;
  });

describe("a guard hook that can't start", () => {
  it("stops the tool instead of letting it run unchecked", async () => {
    failRun("The environment block used to start a process is too large.");
    const res = await runHooks(config, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "a.ts" } }, "E:/ws");
    expect(res.outcomes[0].outcome).toBe("blocking");
    expect(res.blockingFeedback.join("\n")).toMatch(/couldn't start/);
  });

  it("is only an error after the tool ran, when there is nothing left to stop", async () => {
    failRun("spawn failed");
    const res = await runHooks(post, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: {} }, "E:/ws");
    expect(res.outcomes[0].outcome).toBe("error");
    expect(res.blockingFeedback).toEqual([]);
  });
});

describe("the hook's input in its environment", () => {
  it("stays small enough to start a process, with long texts cut and marked", async () => {
    invoke.mockResolvedValue({ stdout: "", stderr: "", code: 0, timed_out: false });
    const content = "x".repeat(200_000);
    await runHooks(config, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "a.ts", content } }, "E:/ws");
    const env = (invoke.mock.calls[0][1] as { env: Record<string, string> }).env;
    expect(env.NYXS_HOOK_INPUT.length).toBeLessThan(20_000);
    const parsed = JSON.parse(env.NYXS_HOOK_INPUT) as { tool_input: { file_path: string; content: string } };
    expect(parsed.tool_input.file_path).toBe("a.ts");
    expect(parsed.tool_input.content).toMatch(/cut: 200000 characters/);
    expect(env.NYXS_HOOK_INPUT_TRUNCATED).toBe("1");
    expect(env.NYXS_FILE_PATH).toBe("a.ts");
  });

  it("sends the whole input on stdin, however long, as Claude Code's hooks read it", async () => {
    invoke.mockResolvedValue({ stdout: "", stderr: "", code: 0, timed_out: false });
    const content = "x".repeat(200_000);
    const input = { hook_event_name: "PreToolUse" as const, tool_name: "Write", tool_input: { file_path: "a.ts", content } };
    await runHooks(config, input, "E:/ws");
    const args = invoke.mock.calls[0][1] as { stdin?: string; env: Record<string, string> };
    expect(JSON.parse(args.stdin ?? "null")).toEqual(input);
    // The variable keeps the cut copy for hooks that already read it.
    expect(args.env.NYXS_HOOK_INPUT_TRUNCATED).toBe("1");
  });

  it("passes a small input whole", async () => {
    invoke.mockResolvedValue({ stdout: "", stderr: "", code: 0, timed_out: false });
    const input = { hook_event_name: "PreToolUse" as const, tool_name: "Write", tool_input: { file_path: "a.ts", content: "hi" } };
    await runHooks(config, input, "E:/ws");
    const env = (invoke.mock.calls[0][1] as { env: Record<string, string> }).env;
    expect(JSON.parse(env.NYXS_HOOK_INPUT)).toEqual(input);
    expect(env.NYXS_HOOK_INPUT_TRUNCATED).toBeUndefined();
  });
});

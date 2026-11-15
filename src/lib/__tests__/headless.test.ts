import { describe, it, expect, vi, beforeEach } from "vitest";
import { tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const MODEL_ID = "anthropic:claude-sonnet-4-5";
const settings = {
  anthropic: { apiKey: "test-key", models: [{ id: MODEL_ID, provider: "anthropic", apiModel: "claude-sonnet-4-5", name: "Sonnet" }] },
};
vi.mock("@/lib/settings", async (orig) => ({ ...(await orig<object>()), loadSettings: () => settings, loadSelectedModel: () => null }));

const { runHeadless, headlessCanUse } = await import("@/headless");
const { runAgentTurn } = await import("@/lib/agentTurn");

type Chunk = Record<string, unknown>;
const usage = (input: number) => ({ inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } });
const finish = (reason: string): Chunk => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage: usage(120) });
const text = (t: string): Chunk[] => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: t }, { type: "text-end", id: "t" }];
const call = (id: string, toolName: string, input: unknown): Chunk => ({ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) });

/** A model that reads a file, edits it and answers. */
function scriptedModel() {
  let n = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      n++;
      const chunks =
        n === 1
          ? [call("r1", "Read", { file_path: "src/app.ts" }), finish("tool-calls")]
          : n === 2
            ? [call("e1", "Edit", { file_path: "src/app.ts", old_string: "1", new_string: "2" }), finish("tool-calls")]
            : [...text("The value was 1; it is 2 now."), finish("stop")];
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  });
}

// The app builds its own file tools only inside Tauri; these stand in for them.
const tools = {
  Read: tool({ description: "read", inputSchema: z.object({ file_path: z.string() }), execute: async () => "     1\texport const value = 1;\n" }),
  Edit: tool({
    description: "edit",
    inputSchema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() }),
    execute: async () => "OK: 1 replacement(s) in src/app.ts",
  }),
};

/** What the run wrote: stdout, stderr, the exit code and the saved session. */
function io() {
  const out = { stdout: "", stderr: "", exit: null as number | null, session: null as string | null };
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, a: Record<string, unknown>) => {
    if (cmd === "nyxs_headless_write") {
      if (a.stderr) out.stderr += a.text;
      else out.stdout += a.text;
    } else if (cmd === "nyxs_headless_exit") out.exit = a.code as number;
    else if (cmd === "nyxs_headless_save_session") {
      out.session = a.json as string;
      return "E:\\ws\\run.json";
    } else if (cmd === "agent_read_file_range") return { text: "     1\texport const value = 1;\n", startLine: 1, endLine: 1, totalLines: 1 };
    else if (cmd === "agent_file_mtime") return 1;
    return null;
  });
  return out;
}

const clock = () => {
  let t = Date.UTC(2026, 9, 29, 12, 0, 0);
  return () => (t += 250);
};

beforeEach(() => invoke.mockReset());

describe("headless mode", () => {
  it("saves the run as a session file an eval can compare", async () => {
    const out = io();
    const model = scriptedModel();
    await runHeadless(
      { prompt: "Set the value in src/app.ts to 2.", format: "text", cwd: "E:\\ws", model: MODEL_ID, permissionMode: "auto", maxSteps: 5, saveSession: "run.json" },
      { chat: (o) => runAgentTurn(o, { isTauri: false, buildModel: () => model, extraTools: tools }), now: clock() },
    );
    expect(out.exit).toBe(0);
    expect(out.stdout).toBe("The value was 1; it is 2 now.\n");
    expect(out.stderr).toContain("nyxs: session saved to E:\\ws\\run.json");
    // A golden file, as deepseek-harness keeps its `snapshots/`: a change in what a run records
    // shows up as a diff of it.
    await expect(out.session).toMatchFileSnapshot("./snapshots/headless-session.json");
  });

  it("stops at --max-steps", async () => {
    io();
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [call(`r${Math.random()}`, "Read", { file_path: "a.ts" }), finish("tool-calls")] as never }) }),
    });
    const steps = vi.fn();
    await runHeadless(
      { prompt: "loop", format: "json", cwd: "E:\\ws", model: MODEL_ID, permissionMode: "auto", maxSteps: 2 },
      {
        chat: (o) => {
          steps(o.maxSteps);
          return runAgentTurn(o, { isTauri: false, buildModel: () => model, extraTools: tools });
        },
        now: clock(),
      },
    );
    expect(steps).toHaveBeenCalledWith(2);
    // Two tool steps, then the closing pass that reports where it stopped.
    expect(model.doStreamCalls).toHaveLength(3);
  });

  it("records a failed run too, and exits with 1", async () => {
    const out = io();
    await runHeadless(
      { prompt: "hi", format: "json", cwd: "E:\\ws", model: MODEL_ID, saveSession: "run.json" },
      { chat: async () => Promise.reject(new Error("rate limited")), now: clock() },
    );
    expect(out.exit).toBe(1);
    expect(JSON.parse(out.session!)).toMatchObject({ status: "error", error: "rate limited", result: null });
    expect(out.stdout).toContain('"type":"error"');
  });

  it("takes Claude Code but not the other agent CLIs", () => {
    expect(headlessCanUse({ provider: "claude-code" } as never)).toBe(true);
    expect(headlessCanUse({ provider: "anthropic" } as never)).toBe(true);
    expect(headlessCanUse({ provider: "grok-cli" } as never)).toBe(false);
  });
});

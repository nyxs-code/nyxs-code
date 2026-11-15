import { describe, it, expect, vi } from "vitest";

type Json = Record<string, unknown>;
type ProcessEvent = { kind: "stdout"; line: string } | { kind: "stderr"; line: string } | { kind: "exit"; code: number | null };

const fake = vi.hoisted(() => ({
  runs: [] as Json[],
  attached: [] as Json[],
  killed: [] as string[],
  channels: new Map<string, { onmessage: (e: ProcessEvent) => void }>(),
  storage: new Map<string, string>(),
}));

vi.stubGlobal("sessionStorage", {
  get length() { return fake.storage.size; },
  key: (i: number) => [...fake.storage.keys()][i] ?? null,
  getItem: (k: string) => fake.storage.get(k) ?? null,
  setItem: (k: string, v: string) => void fake.storage.set(k, v),
  removeItem: (k: string) => void fake.storage.delete(k),
});

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return {
    Channel,
    invoke: async (cmd: string, args: Json) => {
      if (cmd === "claude_code_runs") return fake.runs;
      if (cmd === "claude_code_attach") {
        fake.attached.push({ runId: args.runId, replay: args.replay });
        fake.channels.set(args.runId as string, args.onEvent as { onmessage: (e: ProcessEvent) => void });
        return undefined;
      }
      if (cmd === "claude_code_kill") {
        fake.killed.push(args.runId as string);
        return true;
      }
      return undefined;
    },
  };
});

const { reattachClaudeCodeRuns, onClaudeCodeWake, streamClaudeCode, CLAUDE_CODE_MODELS } = await import("@/lib/claudeCode");
const opus = CLAUDE_CODE_MODELS.find((m) => m.apiModel === "opus")!;

const out = (runId: string, obj: Json) => fake.channels.get(runId)!.onmessage({ kind: "stdout", line: JSON.stringify(obj) });
const settle = () => new Promise((r) => setTimeout(r, 30));
const saveRuns = (runs: Json[]) => fake.storage.set("nyxs.reload.claudeRuns", JSON.stringify(runs));

describe("Claude Code after the app's page reloads", () => {
  it("shows a turn that was running again in its chat, rebuilt from the replay", async () => {
    saveRuns([{ runId: "cc-busy", config: "[]", sessionId: "s-busy", chatKey: "chat-9", expectsWake: false }]);
    fake.runs = [{ runId: "cc-busy", sessionId: "s-busy", busy: true, exited: false }];
    let shown = "";
    const wakes: Json[] = [];
    const stop = onClaudeCodeWake((sessionId, opts) => {
      wakes.push({ sessionId, ...opts });
      void streamClaudeCode({ model: opus, history: [], workspace: "E:\\ws", planMode: false, effort: "high", onChunk: (t) => (shown += t), attachSession: sessionId });
      return true;
    });
    await reattachClaudeCodeRuns();
    expect(fake.attached).toContainEqual({ runId: "cc-busy", replay: true });

    out("cc-busy", { type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: "build it" }] } });
    out("cc-busy", { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Halfway there. " } } });
    out("cc-busy", { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } } });
    out("cc-busy", { type: "result", subtype: "success", is_error: false, session_id: "s-busy", result: "Done.", usage: {} });
    await settle();
    stop();

    expect(wakes).toEqual([{ sessionId: "s-busy", chatKey: "chat-9", resumed: true }]);
    expect(shown).toBe("Halfway there. Done.");
  });

  it("picks up an idle process quietly, without replaying its last turn", async () => {
    saveRuns([{ runId: "cc-idle", config: "[]", sessionId: "s-idle", chatKey: "chat-1", expectsWake: false }]);
    fake.runs = [{ runId: "cc-idle", sessionId: "s-idle", busy: false, exited: false }];
    const wake = vi.fn(() => true);
    const stop = onClaudeCodeWake(wake);
    await reattachClaudeCodeRuns();
    stop();
    expect(fake.attached).toContainEqual({ runId: "cc-idle", replay: false });
    expect(wake).not.toHaveBeenCalled();
  });

  // Only the main page drives Claude Code: a run it doesn't know started just as it reloaded,
  // before it could note it, and nobody would ever pick it up.
  it("stops a process the page never got to note, without taking it up", async () => {
    saveRuns([]);
    fake.runs = [
      { runId: "cc-unnoted", sessionId: null, busy: false, exited: false },
      { runId: "cc-done", sessionId: "s-done", busy: false, exited: true },
    ];
    fake.attached = [];
    fake.killed = [];
    await reattachClaudeCodeRuns();
    expect(fake.attached).toEqual([]);
    expect(fake.killed).toEqual(["cc-unnoted"]);
  });
});

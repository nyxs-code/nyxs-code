import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelMessage } from "ai";
import type { ChatTurn } from "@/lib/ai";

type Json = Record<string, unknown>;
type ProcessEvent = { kind: "stdout"; line: string } | { kind: "stderr"; line: string } | { kind: "exit"; code: number | null };

const fake = vi.hoisted(() => ({
  starts: [] as Json[],
  sent: [] as Json[],
  sentRuns: [] as string[],
  channels: new Map<string, { onmessage: (e: ProcessEvent) => void }>(),
  current: "",
  closed: [] as string[],
  killed: [] as string[],
  onUser: (_msg: Json) => {},
  onControlResponse: (_msg: Json) => {},
  onInterrupt: (_msg: Json) => {},
  onClose: (_runId: string) => {},
  init: {} as Json,
  defaultEffortCalls: [] as Json[],
  version: "2.1.300",
  updates: 0,
  memory: "",
  connectors: false,
  /** Settings of a folder other than the open one, by folder. */
  folderSettings: {} as Record<string, Json>,
  /** Folders whose project config the user hasn't trusted. */
  untrustedFolders: new Set<string>(),
  sessionEnv: undefined as Record<string, string> | undefined,
  storage: new Map<string, string>(),
}));

vi.mock("@/lib/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/environments")>()),
  envForSession: async () => fake.sessionEnv,
}));

vi.stubGlobal("sessionStorage", {
  getItem: (k: string) => fake.storage.get(k) ?? null,
  setItem: (k: string, v: string) => void fake.storage.set(k, v),
  removeItem: (k: string) => void fake.storage.delete(k),
  key: (i: number) => [...fake.storage.keys()][i] ?? null,
  get length() {
    return fake.storage.size;
  },
});

vi.mock("@/lib/preflight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/preflight")>()),
  cachedNyxsMemory: async () => fake.memory,
}));

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return {
    Channel,
    invoke: async (cmd: string, args: Json) => {
      if (cmd === "claude_code_start") {
        const request = args.request as Json;
        fake.starts.push(request);
        fake.channels.set(request.runId as string, args.onEvent as { onmessage: (e: ProcessEvent) => void });
        fake.current = request.runId as string;
        return undefined;
      }
      if (cmd === "claude_code_send") {
        const msg = JSON.parse(args.line as string) as Json;
        fake.sent.push(msg);
        fake.sentRuns.push(args.runId as string);
        if (msg.type === "user") {
          fake.current = args.runId as string;
          queueMicrotask(() => fake.onUser(msg));
        }
        if (msg.type === "control_request") queueMicrotask(() => fake.onInterrupt(msg));
        if (msg.type === "control_response") queueMicrotask(() => fake.onControlResponse(msg));
        return undefined;
      }
      if (cmd === "claude_code_close_input") {
        fake.closed.push(args.runId as string);
        queueMicrotask(() => fake.onClose(args.runId as string));
        return undefined;
      }
      if (cmd === "claude_code_kill") {
        fake.killed.push(args.runId as string);
        return true;
      }
      if (cmd === "claude_code_initialize" || cmd === "claude_code_list_models") return fake.init;
      if (cmd === "claude_code_default_effort") {
        fake.defaultEffortCalls.push(args);
        return args.model === "claude-haiku-4-5-20251001" ? null : args.model === "opus" ? "xhigh" : "medium";
      }
      if (cmd === "agent_read_file") return "(not found)";
      if (cmd === "claude_code_status") return { installed: true, version: fake.version, loggedIn: true };
      if (cmd === "claude_code_update") {
        fake.updates++;
        return "updated";
      }
      return undefined;
    },
  };
});

// The built-in browser is on by default; the fake CLI never answers its initialize request.
vi.mock("@/lib/settingsRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settingsRuntime")>()),
  getMergedSnapshot: () => ({ allowPreview: false, allowMusic: false, allowVideoTools: false, claudeAiConnectors: fake.connectors }),
  settingsFor: async (ws?: string | null) => ({
    merged: { allowPreview: false, allowMusic: false, allowVideoTools: false, claudeAiConnectors: fake.connectors, ...fake.folderSettings[ws ?? ""] },
    perSource: {},
    projectTrusted: !fake.untrustedFolders.has(ws ?? ""),
  }),
}));

const {
  streamClaudeCode,
  fetchClaudeCodeModels,
  ClaudeCodeAuthError,
  CLAUDE_CODE_MODELS,
  claudeCodeEffortLevels,
  claudeCodeEffectiveEffort,
  claudeCodeDefaultEffort,
  claudeCodeNeedsUpdate,
  autoUpdateClaudeCode,
  startClaudeCodeMaintenance,
  onClaudeCodeUpdated,
  compactClaudeCodeSession,
  appendPromptFor,
  cachedClaudePlanUsage,
  claudePlanRefusal,
  claudePlanRefused,
  onClaudePlanUsage,
} = await import("@/lib/claudeCode");

const { resumePointOf } = await import("@/lib/claudeCodeText");
const { closeClaudeCodeChat } = await import("@/lib/claudeCode");
const { sessionHead } = await import("@/lib/claudeCodeHeads");

const opus = CLAUDE_CODE_MODELS.find((m) => m.apiModel === "opus")!;

const channel = (runId = fake.current) => fake.channels.get(runId)!;
const out = (obj: Json, runId?: string) => channel(runId).onmessage({ kind: "stdout", line: JSON.stringify(obj) });
const err = (line: string) => channel().onmessage({ kind: "stderr", line });
const exit = (code: number | null, runId?: string) => channel(runId).onmessage({ kind: "exit", code });
const init = (sessionId: string) => out({ type: "system", subtype: "init", session_id: sessionId, tools: [] });
const textDelta = (text: string) =>
  out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const messageStart = (input: number, cached: number) =>
  out({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "message_start", message: { usage: { input_tokens: input, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 } } },
  });
const messageEnd = (output: number) => {
  out({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", usage: { output_tokens: output } } });
  out({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } });
};
const toolUse = (id: string, name: string, input: Json) =>
  out({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", model: "claude-opus", content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id: string, content: string, isError = false) =>
  out({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
const permission = (requestId: string, toolName: string, input: Json, toolUseId: string) =>
  out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: toolName, input, tool_use_id: toolUseId } });
const result = (sessionId: string, extra: Json = {}) =>
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    result: "done",
    usage: { input_tokens: 10, output_tokens: 42, cache_read_input_tokens: 900, cache_creation_input_tokens: 5 },
    ...extra,
  });

const userTurn = (content: string): ChatTurn => ({ role: "user", content });

beforeEach(() => {
  fake.starts = [];
  fake.sent = [];
  fake.sentRuns = [];
  fake.closed = [];
  fake.killed = [];
  fake.onUser = () => {};
  fake.onControlResponse = () => {};
  fake.onInterrupt = () => {};
  fake.onClose = (runId) => exit(0, runId);
  fake.memory = "";
  fake.connectors = false;
  fake.folderSettings = {};
  fake.untrustedFolders.clear();
});

describe("what Claude Code is started with", () => {
  const answer = (sessionId: string) => () => {
    init(sessionId);
    result(sessionId);
  };

  it("adds the project's NYXS.md after Nyxs' own prompt", async () => {
    fake.memory = "Usa pnpm, nunca npm.";
    fake.onUser = answer("sess-memory");
    await streamClaudeCode({ model: opus, history: [userTurn("hola")], workspace: "C:/ws-memory", planMode: false, effort: "medium", onChunk: () => {} });

    const append = fake.starts[0].appendSystemPrompt as string;
    expect(append).toContain("# Project instructions (from NYXS.md)");
    expect(append.endsWith("Usa pnpm, nunca npm.")).toBe(true);
  });

  it("starts a fresh process, resuming the session, once NYXS.md changes", async () => {
    let saved: ModelMessage[] = [];
    fake.memory = "Regla uno.";
    fake.onUser = answer("sess-edit");
    const base = { model: opus, workspace: "C:/ws-edit", planMode: false, effort: "medium" as const };
    await streamClaudeCode({ ...base, history: [userTurn("uno")], onChunk: () => {}, onMessages: (m) => (saved = m) });

    fake.memory = "Regla dos.";
    const history: ChatTurn[] = [userTurn("uno"), { role: "assistant", content: "ok", messages: saved }, userTurn("dos")];
    await streamClaudeCode({ ...base, history, onChunk: () => {} });

    expect(fake.starts.map((s) => s.resume)).toEqual([null, "sess-edit"]);
    expect(fake.starts[1].appendSystemPrompt).toContain("Regla dos.");
  });

  it("keeps the claude.ai connectors out unless the setting lets them in", async () => {
    fake.onUser = answer("sess-off");
    await streamClaudeCode({ model: opus, history: [userTurn("a")], workspace: "C:/ws-off", planMode: false, effort: "medium", onChunk: () => {} });
    fake.connectors = true;
    fake.onUser = answer("sess-on");
    await streamClaudeCode({ model: opus, history: [userTurn("b")], workspace: "C:/ws-on", planMode: false, effort: "medium", onChunk: () => {} });

    expect((fake.starts[0].env as Json).ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(fake.starts[1].env as Json).not.toHaveProperty("ENABLE_CLAUDEAI_MCP_SERVERS");
  });

  it("reads those settings from the turn's own folder, not the one open in the app", async () => {
    fake.folderSettings["C:/ws-other"] = { claudeAiConnectors: true };
    fake.onUser = answer("sess-other");
    await streamClaudeCode({ model: opus, history: [userTurn("a")], workspace: "C:/ws-other", planMode: false, effort: "medium", onChunk: () => {} });
    expect(fake.starts.at(-1)!.env as Json).not.toHaveProperty("ENABLE_CLAUDEAI_MCP_SERVERS");
  });

  it("keeps an untrusted folder's own Claude Code config out, and starts afresh once it's trusted", async () => {
    let saved: ModelMessage[] = [];
    fake.untrustedFolders.add("C:/ws-cloned");
    fake.onUser = answer("sess-cloned");
    const base = { model: opus, workspace: "C:/ws-cloned", planMode: false, effort: "medium" as const };
    await streamClaudeCode({ ...base, history: [userTurn("uno")], onChunk: () => {}, onMessages: (m) => (saved = m) });
    expect(fake.starts.at(-1)?.untrustedProject).toBe(true);

    fake.untrustedFolders.delete("C:/ws-cloned");
    const history: ChatTurn[] = [userTurn("uno"), { role: "assistant", content: "ok", messages: saved }, userTurn("dos")];
    await streamClaudeCode({ ...base, history, onChunk: () => {} });
    expect(fake.starts.map((s) => [s.resume, s.untrustedProject])).toEqual([
      [null, true],
      ["sess-cloned", false],
    ]);
  });

  it("caps the process's turns when asked (headless --max-steps), in a process of its own", async () => {
    fake.onUser = answer("sess-cap");
    await streamClaudeCode({ model: opus, history: [userTurn("a")], workspace: "C:/ws-cap", planMode: false, effort: "medium", maxTurns: 7, onChunk: () => {} });
    expect(fake.starts.at(-1)?.maxTurns).toBe(7);
    fake.onUser = answer("sess-free");
    await streamClaudeCode({ model: opus, history: [userTurn("b")], workspace: "C:/ws-cap", planMode: false, effort: "medium", onChunk: () => {} });
    expect(fake.starts.at(-1)?.maxTurns).toBeNull();
  });

  it("keeps a saved environment's values out of what survives a reload, and still notices a change", async () => {
    fake.sessionEnv = { API_TOKEN: "tok-secreto-123" };
    try {
      fake.onUser = answer("sess-env");
      // No folder: with one, the fake CLI would have to answer the hosted MCP servers' initialize.
      const base = { model: opus, workspace: null, planMode: false, effort: "medium" as const, chatKey: "chat-env" };
      let saved: ModelMessage[] = [];
      await streamClaudeCode({ ...base, history: [userTurn("uno")], onChunk: () => {}, onMessages: (m) => (saved = m) });

      expect((fake.starts.at(-1)!.env as Json).API_TOKEN).toBe("tok-secreto-123");
      const kept = fake.storage.get("nyxs.reload.claudeRuns") ?? "";
      expect(kept).toContain("chat-env");
      expect(kept).not.toContain("tok-secreto-123");

      fake.sessionEnv = { API_TOKEN: "tok-otro-456" };
      const history: ChatTurn[] = [userTurn("uno"), { role: "assistant", content: "ok", messages: saved }, userTurn("dos")];
      await streamClaudeCode({ ...base, history, onChunk: () => {} });
      expect(fake.starts.map((s) => (s.env as Json).API_TOKEN).slice(-2)).toEqual(["tok-secreto-123", "tok-otro-456"]);
      expect(fake.storage.get("nyxs.reload.claudeRuns") ?? "").not.toContain("tok-otro-456");
    } finally {
      fake.sessionEnv = undefined;
    }
  });

  describe("a setting changed while a background task runs", () => {
    const controls: Json[] = [];
    // A turn that leaves a background command running, then plain answers.
    const withTask = (sessionId: string) => {
      let first = true;
      fake.onUser = () => {
        init(sessionId);
        if (first) out({ type: "system", subtype: "task_started", task_id: `${sessionId}-bg`, description: "servidor" });
        first = false;
        out({ type: "assistant", parent_tool_use_id: null, uuid: `${sessionId}-m${fake.sent.length}`, message: { role: "assistant", model: "claude-opus", content: [{ type: "text", text: "ok" }] } });
        result(sessionId);
      };
    };
    const answerControls = (ok: boolean) => {
      controls.length = 0;
      fake.onInterrupt = (msg) => {
        const request = msg.request as Json;
        controls.push(request);
        out({ type: "control_response", response: ok ? { subtype: "success", request_id: msg.request_id, response: {} } : { subtype: "error", request_id: msg.request_id, error: "no" } });
      };
    };
    const turn = async (history: ChatTurn[], o: { planMode: boolean; effort: "medium" | "high" }) => {
      let saved: ModelMessage[] = [];
      await streamClaudeCode({ model: opus, history, workspace: null, chatKey: "chat-bg", onChunk: () => {}, onMessages: (m) => (saved = m), ...o });
      return { role: "assistant" as const, content: "ok", messages: saved };
    };

    it("switches the running process in place instead of closing it", async () => {
      withTask("sess-bg");
      const r1 = await turn([userTurn("arranca el servidor")], { planMode: false, effort: "medium" });
      answerControls(true);
      await turn([userTurn("arranca el servidor"), r1, userTurn("planea")], { planMode: true, effort: "high" });

      expect(fake.starts).toHaveLength(1);
      expect(fake.closed).not.toContain(fake.starts[0].runId);
      expect(controls).toEqual([
        { subtype: "set_permission_mode", mode: "plan" },
        { subtype: "apply_flag_settings", settings: { effortLevel: expect.any(String) } },
      ]);
    });

    it("leaves the process and its task alone when the CLI won't switch, and starts another", async () => {
      withTask("sess-bg2");
      const r1 = await turn([userTurn("arranca")], { planMode: false, effort: "medium" });
      answerControls(false);
      await turn([userTurn("arranca"), r1, userTurn("planea")], { planMode: true, effort: "medium" });

      expect(fake.starts).toHaveLength(2);
      expect(fake.starts[1]).toMatchObject({ permissionMode: "plan", resume: "sess-bg2" });
      expect(fake.closed).not.toContain(fake.starts[0].runId);
    });
  });

  it("tells the user's hooks they run inside Nyxs, background helpers included", async () => {
    fake.onUser = answer("sess-hooks");
    await streamClaudeCode({ model: opus, history: [userTurn("a")], workspace: "C:/ws-hooks", planMode: false, effort: "medium", onChunk: () => {} });
    fake.onUser = answer("sess-helper");
    await streamClaudeCode({ model: opus, history: [userTurn("b")], workspace: null, planMode: false, effort: "low", ephemeral: true, onChunk: () => {} });

    expect(fake.starts.map((s) => (s.env as Json).NYXS_CLAUDE_CODE)).toEqual(["1", "1"]);
  });
});

describe("a chat that no longer ends where its Claude Code session does", () => {
  let n = 0;
  // Answers like CLI 2.1.312: `--resume` keeps the session id, `--resume-session-at` with
  // `--fork-session` goes on in a new one; an unknown message uuid ends the run.
  const cli = (opts: { missingAt?: boolean } = {}) => {
    const sessions = new Map<string, string>();
    fake.onUser = () => {
      const run = fake.current;
      const start = fake.starts.find((s) => s.runId === run)!;
      if (start.resumeAt && opts.missingAt) {
        err(`No message found with message.uuid of: ${String(start.resumeAt)}`);
        exit(1);
        return;
      }
      if (!sessions.has(run)) sessions.set(run, start.resume && !start.resumeAt ? String(start.resume) : `sess-cut-${++n}`);
      const id = sessions.get(run)!;
      init(id);
      out({ type: "assistant", parent_tool_use_id: null, uuid: `${id}-m${++n}`, message: { role: "assistant", model: "claude-opus", content: [{ type: "text", text: "ok" }] } });
      result(id);
    };
  };
  const turn = async (history: ChatTurn[], chatKey: string): Promise<ChatTurn> => {
    let saved: ModelMessage[] = [];
    await streamClaudeCode({ model: opus, history, workspace: null, planMode: false, effort: "medium", chatKey, onChunk: () => {}, onMessages: (m) => (saved = m) });
    return { role: "assistant", content: "ok", messages: saved };
  };
  const pointOf = (reply: ChatTurn) => resumePointOf(reply)!;
  const lastSent = () => ((fake.sent.filter((m) => m.type === "user").at(-1)!.message as Json).content as Json[])[0].text as string;

  it("reuses the live process for a normal follow-up", async () => {
    cli();
    const r1 = await turn([userTurn("uno")], "chat-follow");
    const r2 = await turn([userTurn("uno"), r1, userTurn("dos")], "chat-follow");

    expect(fake.starts).toHaveLength(1);
    expect(pointOf(r2).sessionId).toBe(pointOf(r1).sessionId);
    expect(pointOf(r2).at).not.toBe(pointOf(r1).at);
  });

  it("cuts the session at the last reply left after an edit, in a new session", async () => {
    cli();
    const r1 = await turn([userTurn("uno")], "chat-edit");
    await turn([userTurn("uno"), r1, userTurn("dos")], "chat-edit");
    const edited = await turn([userTurn("uno"), r1, userTurn("dos, editado")], "chat-edit");

    expect(fake.starts.map((s) => [s.resume, s.resumeAt])).toEqual([
      [null, null],
      [pointOf(r1).sessionId, pointOf(r1).at],
    ]);
    expect(pointOf(edited).sessionId).not.toBe(pointOf(r1).sessionId);
    // Claude Code has the history up to the reply, so nothing is sent again as context.
    expect(lastSent()).not.toContain("<earlier_conversation>");
    expect(fake.closed).not.toContain(fake.starts[0].runId);

    // The edited chat goes on in its new session's live process.
    await turn([userTurn("uno"), r1, userTurn("dos, editado"), edited, userTurn("tres")], "chat-edit");
    expect(fake.starts).toHaveLength(2);
  });

  it("forks the session for a forked chat and leaves the original's alone", async () => {
    cli();
    const r1 = await turn([userTurn("uno")], "chat-orig");
    const copy = await turn([userTurn("uno"), r1, userTurn("en la copia")], "chat-copy");

    expect(fake.starts[1]).toMatchObject({ resume: pointOf(r1).sessionId, resumeAt: pointOf(r1).at });
    expect(pointOf(copy).sessionId).not.toBe(pointOf(r1).sessionId);

    const orig = await turn([userTurn("uno"), r1, userTurn("en el original")], "chat-orig");
    expect(fake.starts).toHaveLength(2);
    expect(pointOf(orig).sessionId).toBe(pointOf(r1).sessionId);
  });

  it("cuts the session back to the chat's last kept reply after a stopped turn", async () => {
    cli();
    const r1 = await turn([userTurn("uno")], "chat-stop");
    const stop = new AbortController();
    const session = pointOf(r1).sessionId;
    fake.onUser = () => {
      init(session);
      out({ type: "assistant", parent_tool_use_id: null, uuid: `${session}-stopped`, message: { role: "assistant", model: "claude-opus", content: [{ type: "text", text: "a medias" }] } });
      stop.abort();
    };
    fake.onInterrupt = () => result(session, { is_error: true, subtype: "error_during_execution" });
    const stopped = streamClaudeCode({ model: opus, history: [userTurn("uno"), r1, userTurn("dos")], workspace: null, planMode: false, effort: "medium", chatKey: "chat-stop", signal: stop.signal, onChunk: () => {}, onMessages: () => {} });
    await expect(stopped).rejects.toThrow(/abort/i);

    cli();
    await turn([userTurn("uno"), r1, userTurn("dos"), { role: "assistant", content: "a medias" }, userTurn("tres")], "chat-stop");
    expect(fake.starts.at(-1)).toMatchObject({ resume: session, resumeAt: pointOf(r1).at });
    // What the session lost comes back once, as text.
    expect(lastSent().match(/User: dos/g)).toHaveLength(1);
  });

  it("starts over with the visible chat when the reply left has no message to cut at", async () => {
    cli();
    const r1 = await turn([userTurn("uno")], "chat-old");
    await turn([userTurn("uno"), r1, userTurn("dos")], "chat-old");
    const legacy: ChatTurn = { role: "assistant", content: "ok", messages: [{ role: "assistant", content: "ok", providerOptions: { claudeCode: { sessionId: pointOf(r1).sessionId } } }] };
    await turn([userTurn("uno"), legacy, userTurn("otra")], "chat-old");

    expect(fake.starts.at(-1)).toMatchObject({ resume: null, resumeAt: null });
    expect(lastSent()).toContain("User: uno");
  });

  it("starts over with the visible chat when Claude Code no longer has that message", async () => {
    cli();
    const r1 = await turn([userTurn("uno")], "chat-gone");
    await turn([userTurn("uno"), r1, userTurn("dos")], "chat-gone");
    cli({ missingAt: true });
    const output = await turn([userTurn("uno"), r1, userTurn("dos, otra vez")], "chat-gone");

    expect(fake.starts.map((s) => s.resumeAt)).toEqual([null, pointOf(r1).at, null]);
    expect(fake.starts[2].resume).toBeNull();
    expect(lastSent()).toContain("User: uno");
    expect(pointOf(output).sessionId).toMatch(/^sess-cut-/);
  });
});

describe("a cleared or deleted chat's Claude Code process", () => {
  let n = 0;
  const answering = () => {
    fake.onUser = () => {
      const run = fake.current;
      const start = fake.starts.find((s) => s.runId === run)!;
      const id = start.resume ? String(start.resume) : `sess-close-${run}`;
      init(id);
      out({ type: "assistant", parent_tool_use_id: null, uuid: `${id}-m${++n}`, message: { role: "assistant", model: "claude-opus", content: [{ type: "text", text: "ok" }] } });
      result(id);
    };
  };
  const turn = async (history: ChatTurn[], chatKey: string): Promise<ChatTurn> => {
    let saved: ModelMessage[] = [];
    await streamClaudeCode({ model: opus, history, workspace: null, planMode: false, effort: "medium", chatKey, onChunk: () => {}, onMessages: (m) => (saved = m) });
    return { role: "assistant", content: "ok", messages: saved };
  };

  it("ends at once on /clear, forgets its session, and the next turn starts a new one", async () => {
    answering();
    const reply = await turn([userTurn("uno")], "chat-clear");
    const sessionId = resumePointOf(reply)!.sessionId;
    expect(sessionHead(sessionId)).toBeDefined();

    closeClaudeCodeChat("chat-clear", [undefined, reply.messages]);
    expect(fake.closed).toContain(fake.starts[0].runId);
    expect(sessionHead(sessionId)).toBeUndefined();

    await turn([userTurn("de nuevo")], "chat-clear");
    expect(fake.starts.map((s) => s.resume)).toEqual([null, null]);
  });

  it("leaves other chats' processes alone, a fork's original included", async () => {
    answering();
    const a = await turn([userTurn("a")], "chat-keep");
    await turn([userTurn("b")], "chat-other");
    // A fork that hasn't had a turn yet carries the original's session in its replies.
    closeClaudeCodeChat("chat-fork", [a.messages]);
    closeClaudeCodeChat("chat-other", []);

    // (Earlier tests' idle processes may be let go too: only four stay parked.)
    expect(fake.closed).toContain(fake.starts[1].runId);
    expect(fake.closed).not.toContain(fake.starts[0].runId);
    expect(sessionHead(resumePointOf(a)!.sessionId)).toMatchObject({ chatKey: "chat-keep" });
    await turn([userTurn("a"), a, userTurn("sigue")], "chat-keep");
    expect(fake.starts).toHaveLength(2);
  });

  it("waits for a turn still running to end before it goes", async () => {
    fake.onUser = () => init("sess-close-busy");
    const running = streamClaudeCode({ model: opus, history: [userTurn("largo")], workspace: null, planMode: false, effort: "medium", chatKey: "chat-busy", onChunk: () => {} });
    await vi.waitFor(() => expect(fake.sent.some((m) => m.type === "user")).toBe(true));

    closeClaudeCodeChat("chat-busy", []);
    expect(fake.closed).not.toContain(fake.starts[0].runId);

    result("sess-close-busy");
    await running;
    expect(fake.closed).toContain(fake.starts[0].runId);
  });
});

describe("the plan's usage as turns report it", () => {
  const hour = 1793264400;
  const turnReporting = async (info: Json) => {
    fake.onUser = () => {
      init("sess-rl");
      out({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "sess-rl" });
      result("sess-rl");
    };
    await streamClaudeCode({ model: opus, history: [userTurn("hola")], workspace: "C:/ws-rl", planMode: false, effort: "medium", onChunk: () => {} });
  };

  it("moves the 5-hour and weekly bars at once, from fractions to percentages", async () => {
    const seen: unknown[] = [];
    const off = onClaudePlanUsage((u) => seen.push(u));
    await turnReporting({
      status: "allowed",
      resetsAt: hour,
      rateLimitType: "five_hour",
      unifiedWindows: { five_hour: { utilization: 0.06, resetsAt: hour }, seven_day: { utilization: 0.43, resetsAt: hour + 3600 } },
    });
    off();

    const limits = cachedClaudePlanUsage()!.limits;
    expect(limits.slice(0, 2)).toEqual([
      { kind: "session", utilization: 6, resetsAt: new Date(hour * 1000).toISOString() },
      { kind: "weekly", utilization: 43, resetsAt: new Date((hour + 3600) * 1000).toISOString() },
    ]);
    expect(seen).toHaveLength(1);
    expect(claudePlanRefused()).toBe(false);
  });

  it("remembers a refusal until it resets, but not one served from extra usage", async () => {
    const later = Math.floor(Date.now() / 1000) + 3600;
    await turnReporting({ status: "rejected", resetsAt: later, rateLimitType: "five_hour", isUsingOverage: true });
    expect(claudePlanRefused()).toBe(false);

    await turnReporting({ status: "rejected", resetsAt: later, rateLimitType: "five_hour", utilization: 1 });
    expect(claudePlanRefused()).toBe(true);
    expect(claudePlanRefusal()).toEqual({ until: later * 1000, kind: "session" });
    expect(cachedClaudePlanUsage()!.limits[0]).toMatchObject({ kind: "session", utilization: 100 });

    await turnReporting({ status: "allowed", resetsAt: later, rateLimitType: "five_hour" });
    expect(claudePlanRefused()).toBe(false);
  });
});

describe("appendPromptFor", () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;

  it("leaves Nyxs' prompt alone without project instructions", () => {
    expect(appendPromptFor("PREVIEW", "  ")).toBe("PREVIEW");
  });

  it("cuts long instructions at a line, under the CLI's limit, and says where the rest is", () => {
    const memory = Array.from({ length: 600 }, (_, i) => `- regla número ${i}: ñandú`).join("\n");
    const out = appendPromptFor("PREVIEW", memory);

    expect(bytes(out)).toBeLessThanOrEqual(16 * 1024);
    expect(out.startsWith("PREVIEW\n\n# Project instructions")).toBe(true);
    expect(out).toMatch(/ñandú\n\n\[The project instructions stop here/);
    expect(out).not.toContain("\uFFFD");
  });
});

describe("compactClaudeCodeSession", () => {
  it("runs Claude Code's own /compact on the resumed session and reports the context left", async () => {
    fake.onUser = () => {
      init("sess-compact");
      result("sess-compact", { result: "" });
    };
    fake.onInterrupt = () => {
      const req = fake.sent[fake.sent.length - 1] as { request_id: string; request: Json };
      if (req.request.subtype !== "get_context_usage") return;
      out({
        type: "control_response",
        response: { subtype: "success", request_id: req.request_id, response: { categories: [], totalTokens: 12_000, maxTokens: 200_000 } },
      });
    };

    const after = await compactClaudeCodeSession({ model: opus, workspace: "C:/ws", planMode: false, effort: "high" }, "sess-compact");

    expect(fake.starts[0]).toMatchObject({ resume: "sess-compact" });
    expect(fake.sent[0]).toMatchObject({ type: "user", message: { content: [{ type: "text", text: "/compact" }] } });
    expect(after).toMatchObject({ totalTokens: 12_000, maxTokens: 200_000 });
  });
});

describe("streamClaudeCode", () => {
  it("streams text and tools, asks the gate, and records the session for the next turn", async () => {
    const gate = vi.fn(async () => true);
    const onFileEdit = vi.fn(async () => {});
    const onMessages = vi.fn<(m: ModelMessage[]) => void>();
    const onCacheStats = vi.fn();
    const onContext = vi.fn();
    const editInput = { file_path: "C:/ws/a.ts", old_string: "a", new_string: "b" };

    fake.onUser = () => {
      init("sess-1");
      messageStart(100, 2000);
      textDelta("Voy a editar.");
      toolUse("toolu_1", "Edit", editInput);
      permission("req-1", "Edit", editInput, "toolu_1");
    };
    fake.onControlResponse = () => {
      toolResult("toolu_1", "The file has been updated.");
      messageEnd(30);
      textDelta("Listo.");
      result("sess-1");
    };

    let text = "";
    const output = await streamClaudeCode({
      model: opus,
      history: [userTurn("cambia a por b")],
      workspace: "C:/ws",
      planMode: false,
      effort: "high",
      gate,
      onFileEdit,
      onChunk: (d) => {
        text += d;
      },
      onMessages,
      onCacheStats,
      onContext,
    });

    expect(fake.starts[0]).toMatchObject({ cwd: "C:/ws", model: "opus", resume: null, permissionMode: null, effort: "high", noTools: false });
    expect(fake.sent[0]).toMatchObject({ type: "user", message: { role: "user", content: [{ type: "text" }] } });
    const sentText = (fake.sent[0] as { message: { content: { text: string }[] } }).message.content[0].text;
    expect(sentText.startsWith("cambia a por b\n\n<system-reminder>Language check: the user's latest message is in Spanish.")).toBe(true);
    expect(gate).toHaveBeenCalledWith("Edit", editInput);
    expect(onFileEdit).toHaveBeenCalledWith("C:/ws/a.ts");
    expect(fake.sent[1]).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: "req-1", response: { behavior: "allow", updatedInput: editInput, toolUseID: "toolu_1" } },
    });
    expect(output).toBe(text);
    expect(text).toContain("Voy a editar.");
    expect(text).toContain("⟦TOOL⟧toolu_1⟦SEP⟧Edit⟦SEP⟧C:/ws/a.ts⟦/TOOL⟧");
    expect(text).toContain("⟦TOOLEND⟧toolu_1⟦SEP⟧ok⟦/TOOLEND⟧");
    expect(text.indexOf("Listo.")).toBeGreaterThan(text.indexOf("⟦TOOLEND⟧"));
    expect(onContext).toHaveBeenCalledWith(2100);
    expect(onCacheStats).toHaveBeenCalledWith(expect.objectContaining({ readTokens: 900, creationTokens: 5, inputTokens: 915, outputTokens: 42 }));
    // Priced at the API rates of the model behind the alias, so the session panel can show it.
    expect(onCacheStats.mock.calls[0][0].costUsd).toBeGreaterThan(0);
    const saved = onMessages.mock.calls[0][0][0] as ModelMessage & { providerOptions: Json };
    expect(saved.role).toBe("assistant");
    expect(saved.providerOptions).toEqual({ claudeCode: { sessionId: "sess-1" } });
  });

  it("delivers queued messages mid-turn and keeps the turn open until Claude Code reads them", async () => {
    let users = 0;
    fake.onUser = (msg) => {
      users++;
      if (users === 1) {
        init("sess-q");
        textDelta("Trabajando.");
        toolUse("toolu_q", "Bash", { command: "sleep 5" });
        return;
      }
      const text = ((msg.message as Json).content as { text: string }[])[0].text;
      toolResult("toolu_q", "ok");
      result("sess-q");
      out({ type: "user", isReplay: true, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } });
      textDelta("PINEAPPLE");
      result("sess-q");
    };
    const queued = [{ id: "q1", text: "di PINEAPPLE" }];
    const consumed = vi.fn();
    let text = "";
    await streamClaudeCode({
      model: opus,
      history: [userTurn("haz algo largo")],
      workspace: "C:/ws",
      planMode: false,
      effort: "high",
      onChunk: (d) => {
        text += d;
      },
      inbox: {
        take: () => queued.splice(0),
        consumed,
        onArrive: () => () => {},
        onHurry: () => () => {},
      },
    });

    expect(fake.sent.filter((m) => m.type === "user")).toHaveLength(2);
    expect(consumed).toHaveBeenCalledWith([{ id: "q1", text: "di PINEAPPLE" }]);
    expect(text).toContain("Trabajando.");
    expect(text).toContain("PINEAPPLE");
  });

  it("takes in a queued message that is only an image, which has no text to match", async () => {
    let users = 0;
    fake.onUser = () => {
      users++;
      if (users === 1) {
        init("sess-img");
        // Claude Code first echoes the turn's own prompt.
        out({ type: "user", isReplay: true, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "mira esto" }] } });
        toolUse("toolu_i", "Bash", { command: "sleep 5" });
        return;
      }
      toolResult("toolu_i", "ok");
      result("sess-img");
      out({ type: "user", isReplay: true, parent_tool_use_id: null, message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] } });
      textDelta("Veo la imagen.");
      result("sess-img");
    };
    const queued = [{ id: "img1", text: "", images: [{ dataUrl: "data:image/png;base64,AAAA", name: "a.png", mediaType: "image/png" }] }];
    const consumed = vi.fn();
    let text = "";
    await streamClaudeCode({
      model: opus,
      history: [userTurn("mira esto")],
      workspace: "C:/ws",
      planMode: false,
      effort: "high",
      onChunk: (d) => (text += d),
      inbox: { take: () => queued.splice(0), consumed, onArrive: () => () => {}, onHurry: () => () => {} },
    });
    expect(consumed).toHaveBeenCalledWith([expect.objectContaining({ id: "img1" })]);
    expect(text).toContain("Veo la imagen.");
  });

  it("ends the turn when Claude Code goes quiet without taking the queued messages", async () => {
    vi.useFakeTimers();
    try {
      let users = 0;
      fake.onUser = () => {
        users++;
        if (users > 1) return;
        init("sess-quiet");
        toolUse("toolu_z", "Bash", { command: "sleep 5" });
        queueMicrotask(() => {
          toolResult("toolu_z", "ok");
          result("sess-quiet");
        });
      };
      const queued = [{ id: "z1", text: "otra cosa" }];
      const turn = streamClaudeCode({
        model: opus,
        history: [userTurn("haz algo")],
        workspace: "C:/ws",
        planMode: false,
        effort: "high",
        onChunk: () => {},
        inbox: { take: () => queued.splice(0), consumed: vi.fn(), onArrive: () => () => {}, onHurry: () => () => {} },
      });
      let ended = false;
      void turn.finally(() => (ended = true));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't cut the turn short once Claude Code has taken the queued messages", async () => {
    vi.useFakeTimers();
    try {
      let users = 0;
      let arrive = () => {};
      const queued = [{ id: "l1", text: "primero" }];
      fake.onUser = () => {
        users++;
        if (users === 1) {
          init("sess-late");
          toolUse("toolu_l1", "Bash", { command: "sleep 5" });
        } else if (users === 2) {
          toolResult("toolu_l1", "ok");
          result("sess-late");
          out({ type: "user", isReplay: true, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "primero" }] } });
          textDelta("Voy.");
          queued.push({ id: "l2", text: "segundo" });
          arrive();
        } else {
          // A long command that prints nothing while it runs.
          toolUse("toolu_l2", "Bash", { command: "sleep 60" });
        }
      };
      const turn = streamClaudeCode({
        model: opus,
        history: [userTurn("haz algo")],
        workspace: "C:/ws",
        planMode: false,
        effort: "high",
        onChunk: () => {},
        inbox: {
          take: () => queued.splice(0),
          consumed: vi.fn(),
          onArrive: (cb: () => void) => {
            arrive = cb;
            return () => {};
          },
          onHurry: () => () => {},
        },
      });
      let ended = false;
      void turn.finally(() => (ended = true));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ended).toBe(false);

      out({ type: "user", isReplay: true, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "segundo" }] } });
      toolResult("toolu_l2", "ok");
      result("sess-late");
      await vi.advanceTimersByTimeAsync(0);
      expect(ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the lines a subagent edited, without showing its messages", async () => {
    fake.onUser = () => {
      init("sess-sub");
      out({
        type: "user",
        parent_tool_use_id: "toolu_task",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sub_edit", content: "ok" }] },
        tool_use_result: { filePath: "C:/ws/CO.md", oldString: "a", newString: "b", structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: ["-a", "+b", "+c"] }] },
      });
      textDelta("listo");
      result("sess-sub");
    };
    const onSubagentEdit = vi.fn();
    let text = "";
    await streamClaudeCode({ model: opus, history: [userTurn("lanza agentes")], workspace: "C:/ws", planMode: false, effort: "medium", onChunk: (d) => (text += d), onSubagentEdit });

    expect(onSubagentEdit).toHaveBeenCalledWith({ path: "C:/ws/CO.md", added: 2, removed: 1 });
    expect(text).not.toContain("toolu_sub_edit");
  });

  it("reports Claude Code compacting its session and waiting out a retry", async () => {
    fake.onUser = () => {
      init("sess-st");
      out({ type: "system", subtype: "status", status: "compacting" });
      out({ type: "system", subtype: "compact_boundary" });
      out({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: "rate_limit" });
      textDelta("ok");
      result("sess-st");
    };
    const onCompacting = vi.fn();
    const onRetrying = vi.fn();
    await streamClaudeCode({ model: opus, history: [userTurn("hola")], workspace: "C:/ws", planMode: false, effort: "medium", onChunk: () => {}, onCompacting, onRetrying });

    expect(onCompacting.mock.calls).toEqual([[true], [false]]);
    expect(onRetrying.mock.calls).toEqual([[{ rateLimited: true, waitMs: 500 }], [null]]);
  });

  it("resumes the last Claude Code session and forwards only the turns it missed", async () => {
    fake.onUser = () => {
      init("sess-1");
      textDelta("ok");
      result("sess-1");
    };
    const history: ChatTurn[] = [
      userTurn("primera pregunta"),
      {
        role: "assistant",
        content: "respuesta vieja",
        messages: [{ role: "assistant", content: [{ type: "text", text: "respuesta vieja" }], providerOptions: { claudeCode: { sessionId: "sess-1" } } }],
      },
      userTurn("pregunta con otro modelo"),
      { role: "assistant", content: "⟦TOOL⟧t⟦SEP⟧Read⟦SEP⟧x⟦/TOOL⟧respuesta de GPT" },
      userTurn("sigue"),
    ];

    await streamClaudeCode({ model: opus, history, workspace: "C:/ws", planMode: false, effort: "medium", onChunk: () => {} });

    expect(fake.starts[0].resume).toBe("sess-1");
    const sentText = ((fake.sent[0].message as Json).content as Json[])[0].text as string;
    expect(sentText).toContain("User: pregunta con otro modelo");
    expect(sentText).toContain("Assistant: respuesta de GPT");
    expect(sentText).not.toContain("primera pregunta");
    expect(sentText).not.toContain("⟦TOOL⟧");
    expect(sentText.endsWith("sigue")).toBe(true);
  });

  it("answers AskUserQuestion through the Nyxs question prompt", async () => {
    const questions = [{ question: "¿Qué base de datos?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }] }];
    const askUser = vi.fn(async () => [{ question: "¿Qué base de datos?", answer: "SQLite" }]);
    fake.onUser = () => {
      init("sess-2");
      toolUse("toolu_q", "AskUserQuestion", { questions });
      permission("req-q", "AskUserQuestion", { questions }, "toolu_q");
    };
    fake.onControlResponse = () => result("sess-2");

    const output = await streamClaudeCode({ model: opus, history: [userTurn("hazlo")], workspace: "C:/ws", planMode: false, effort: "medium", askUser, onChunk: () => {} });

    expect(askUser).toHaveBeenCalledWith(questions);
    expect((fake.sent[1].response as Json).response).toEqual({
      behavior: "allow",
      updatedInput: { questions, answers: { "¿Qué base de datos?": "SQLite" } },
      toolUseID: "toolu_q",
    });
    expect(output).not.toContain("⟦TOOL⟧toolu_q");
  });

  it("shows the plan and stops in plan mode", async () => {
    const onPlan = vi.fn();
    fake.onUser = () => {
      init("sess-3");
      permission("req-p", "ExitPlanMode", { plan: "1. Hacer X" }, "toolu_p");
    };
    fake.onControlResponse = () => result("sess-3");

    const output = await streamClaudeCode({ model: opus, history: [userTurn("planifica")], workspace: "C:/ws", planMode: true, effort: "medium", onPlan, onChunk: () => {} });

    expect(fake.starts[0].permissionMode).toBe("plan");
    expect(onPlan).toHaveBeenCalledWith("1. Hacer X");
    expect(((fake.sent[1].response as Json).response as Json).behavior).toBe("deny");
    expect(output).toContain("⟦PLAN⟧");
  });

  it("reports a missing sign-in as an auth error", async () => {
    fake.onUser = () => {
      init("sess-4");
      out({
        type: "assistant",
        parent_tool_use_id: null,
        error: "authentication_failed",
        message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] },
      });
      result("sess-4", { is_error: true, result: "Not logged in · Please run /login" });
    };

    await expect(
      streamClaudeCode({ model: opus, history: [userTurn("hola")], workspace: "C:/ws", planMode: false, effort: "medium", onChunk: () => {} }),
    ).rejects.toBeInstanceOf(ClaudeCodeAuthError);
  });

  it("starts fresh with the whole conversation when the saved session is gone", async () => {
    let attempt = 0;
    fake.onUser = () => {
      attempt++;
      if (attempt === 1) {
        err("No conversation found with session ID: sess-old");
        exit(1);
        return;
      }
      init("sess-new");
      textDelta("hola de nuevo");
      result("sess-new");
    };
    const history: ChatTurn[] = [
      userTurn("antes"),
      { role: "assistant", content: "viejo", messages: [{ role: "assistant", content: [{ type: "text", text: "viejo" }], providerOptions: { claudeCode: { sessionId: "sess-old" } } }] },
      userTurn("ahora"),
    ];

    const output = await streamClaudeCode({ model: opus, history, workspace: "C:/ws", planMode: false, effort: "medium", onChunk: () => {} });

    expect(fake.starts.map((s) => s.resume)).toEqual(["sess-old", null]);
    const retryText = ((fake.sent[1].message as Json).content as Json[])[0].text as string;
    expect(retryText).toContain("User: antes");
    expect(retryText).toContain("Assistant: viejo");
    expect(output).toContain("hola de nuevo");
  });

  it("lists every model the user's Claude Code offers, including pinned versions", async () => {
    fake.init = {
      models: [
        { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
        { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", description: "Best for everyday", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"] },
        { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
      ],
    };

    const models = await fetchClaudeCodeModels();

    expect(models.map((m) => [m.id, m.apiModel, m.name])).toEqual([
      ["claude-code:opus", "opus", "Opus 5.5"],
      ["claude-code:claude-opus-4-6", "claude-opus-4-6", "Opus 4.6"],
      ["claude-code:claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", "Haiku 4.5"],
    ]);
    expect(models[0].description).toBe("For complex work → claude-opus-5-5");
    expect(models[2].effortLevels).toEqual([]);
  });

  it("only asks to update the CLI when a newer version really exists", () => {
    expect(claudeCodeNeedsUpdate("2.1.263", "2.1.303")).toBe(true);
    expect(claudeCodeNeedsUpdate("2.1.303", "2.1.303")).toBe(false);
    expect(claudeCodeNeedsUpdate("2.2.0", "2.1.303")).toBe(false);
    expect(claudeCodeNeedsUpdate("2.1.9", "2.1.10")).toBe(true);
    expect(claudeCodeNeedsUpdate("2.1", "2.1.1")).toBe(true);
    expect(claudeCodeNeedsUpdate(null, "2.1.303")).toBe(false);
    expect(claudeCodeNeedsUpdate("2.1.263", null)).toBe(false);
    expect(claudeCodeNeedsUpdate("unknown", "2.1.303")).toBe(false);
  });

  it("updates the CLI on its own only when a newer version is out", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ version: "2.1.306" })));
    const notified = vi.fn();
    const off = onClaudeCodeUpdated(notified);
    try {
      fake.updates = 0;
      fake.version = "2.1.306";
      expect(await autoUpdateClaudeCode()).toBe(false);
      expect(fake.updates).toBe(0);

      fake.version = "2.1.300";
      expect(await autoUpdateClaudeCode()).toBe(true);
      expect(fake.updates).toBe(1);
      expect(notified).toHaveBeenCalledTimes(1);
    } finally {
      off();
      vi.unstubAllGlobals();
    }
  });

  it("leaves the CLI alone while a turn is running and updates it once the turn ends", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ version: "2.1.306" })));
    try {
      fake.updates = 0;
      fake.version = "2.1.300";
      let running: () => void = () => {};
      const started = new Promise<void>((resolve) => (running = resolve));
      fake.onUser = () => running();
      const turn = streamClaudeCode({ model: opus, history: [userTurn("larga")], workspace: "C:/ws-busy-update", planMode: false, effort: "medium", onChunk: () => {} });
      await started;

      expect(await autoUpdateClaudeCode()).toBe(false);
      expect(fake.updates).toBe(0);

      init("sess-busy-update");
      result("sess-busy-update");
      await turn;
      expect(await autoUpdateClaudeCode()).toBe(true);
      expect(fake.updates).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tries a held-back update again ten minutes later, not hours", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ version: "2.1.306" })));
    let stop = () => {};
    try {
      fake.updates = 0;
      fake.version = "2.1.300";
      let running: () => void = () => {};
      const started = new Promise<void>((resolve) => (running = resolve));
      fake.onUser = () => running();
      const turn = streamClaudeCode({ model: opus, history: [userTurn("larga")], workspace: "C:/ws-retry-update", planMode: false, effort: "medium", onChunk: () => {} });
      await started;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      stop = startClaudeCodeMaintenance();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(fake.updates).toBe(0);

      init("sess-retry-update");
      result("sess-retry-update");
      await turn;
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(fake.updates).toBe(1);
    } finally {
      stop();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("caps the effort at what the chosen model supports", async () => {
    fake.onUser = () => {
      init("sess-6");
      result("sess-6");
    };
    const opus46 = { ...opus, id: "claude-code:claude-opus-4-6", apiModel: "claude-opus-4-6", effortLevels: ["low", "medium", "high", "max"] };
    const haiku45 = { ...opus, id: "claude-code:claude-haiku-4-5", apiModel: "claude-haiku-4-5", effortLevels: [] };

    await streamClaudeCode({ model: opus46, history: [userTurn("a")], workspace: "C:/ws", planMode: false, effort: "extra", onChunk: () => {} });
    await streamClaudeCode({ model: haiku45, history: [userTurn("b")], workspace: "C:/ws", planMode: false, effort: "max", onChunk: () => {} });

    expect(fake.starts.map((s) => [s.model, s.effort])).toEqual([
      ["claude-opus-4-6", "high"],
      ["claude-haiku-4-5", null],
    ]);
  });

  it("offers only the levels a model takes and shows the one it really runs at", () => {
    const opus55 = { ...opus, effortLevels: ["low", "medium", "high", "xhigh", "max"] };
    const opus46 = { ...opus, apiModel: "claude-opus-4-6", effortLevels: ["low", "medium", "high", "max"] };
    const haiku45 = { ...opus, apiModel: "claude-haiku-4-5-20251001", effortLevels: [] };

    expect(claudeCodeEffortLevels(opus55)).toEqual(["low", "medium", "high", "extra", "max"]);
    expect(claudeCodeEffortLevels(opus46)).toEqual(["low", "medium", "high", "max"]);
    expect(claudeCodeEffortLevels(haiku45)).toBeNull();
    // A saved list from before effort levels were known: offer everything, the CLI clamps.
    expect(claudeCodeEffortLevels({ ...opus, effortLevels: undefined })).toEqual(["low", "medium", "high", "extra", "max"]);

    expect(claudeCodeEffectiveEffort(opus55, "extra")).toBe("extra");
    expect(claudeCodeEffectiveEffort(opus46, "extra")).toBe("high");
    expect(claudeCodeEffectiveEffort(opus46, "max")).toBe("max");
    expect(claudeCodeEffectiveEffort(haiku45, "high")).toBeNull();
  });

  it("asks Claude Code for its own default effort once per model and folder", async () => {
    fake.defaultEffortCalls = [];
    expect(await claudeCodeDefaultEffort("opus", "C:/ws")).toBe("extra");
    expect(await claudeCodeDefaultEffort("opus", "C:/ws")).toBe("extra");
    expect(await claudeCodeDefaultEffort("claude-sonnet-4-6", "C:/ws")).toBe("medium");
    expect(await claudeCodeDefaultEffort("claude-haiku-4-5-20251001", null)).toBeNull();
    expect(fake.defaultEffortCalls).toEqual([
      { model: "opus", cwd: "C:/ws", untrustedProject: false },
      { model: "claude-sonnet-4-6", cwd: "C:/ws", untrustedProject: false },
      { model: "claude-haiku-4-5-20251001", cwd: null, untrustedProject: false },
    ]);
  });

  it("asks for the default effort without an untrusted folder's own settings", async () => {
    fake.defaultEffortCalls = [];
    fake.untrustedFolders.add("C:/ws-cloned");
    await claudeCodeDefaultEffort("opus", "C:/ws-cloned");
    expect(fake.defaultEffortCalls).toEqual([{ model: "opus", cwd: "C:/ws-cloned", untrustedProject: true }]);
  });

  it("restarts the session with the new effort when it changes mid-chat", async () => {
    let saved: ModelMessage[] = [];
    fake.onUser = () => {
      init("sess-effort");
      textDelta("ok");
      result("sess-effort");
    };
    const base = { model: opus, workspace: "C:/ws", planMode: false };
    await streamClaudeCode({ ...base, effort: "medium", history: [userTurn("uno")], onChunk: () => {}, onMessages: (m) => (saved = m) });
    const firstRun = fake.starts[0].runId;
    const history: ChatTurn[] = [userTurn("uno"), { role: "assistant", content: "ok", messages: saved }, userTurn("dos")];

    await streamClaudeCode({ ...base, effort: "extra", history, onChunk: () => {} });

    expect(fake.starts.map((s) => [s.effort, s.resume])).toEqual([
      ["medium", null],
      ["xhigh", "sess-effort"],
    ]);
    expect(fake.closed).toContain(firstRun);
  });

  it("finishes the turn on result and reuses the live process for the next turn", async () => {
    let saved: ModelMessage[] = [];
    fake.onUser = (msg) => {
      init("sess-live");
      textDelta(`eco: ${(((msg.message as Json).content as Json[])[0].text as string)}`);
      result("sess-live");
    };
    const base = { model: opus, workspace: "C:/ws", planMode: false, effort: "medium" as const };

    await streamClaudeCode({ ...base, history: [userTurn("uno")], onChunk: () => {}, onMessages: (m) => (saved = m) });
    const firstRun = fake.starts[0].runId;
    const history: ChatTurn[] = [userTurn("uno"), { role: "assistant", content: "eco: uno", messages: saved }, userTurn("dos")];
    const second = await streamClaudeCode({ ...base, history, onChunk: () => {} });

    expect(fake.starts).toHaveLength(1);
    expect(fake.closed).not.toContain(firstRun);
    expect(fake.sentRuns.filter((_, i) => fake.sent[i].type === "user")).toEqual([firstRun, firstRun]);
    expect(second).toContain("eco: dos");

    permission("req-late", "Bash", { command: "npm run dev" }, "toolu_late");
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.sent.at(-1)).toMatchObject({
      type: "control_response",
      response: { request_id: "req-late", response: { behavior: "deny" } },
    });

    await streamClaudeCode({ ...base, planMode: true, history: [...history, { role: "assistant", content: "eco: dos", messages: saved }, userTurn("tres")], onChunk: () => {} });
    expect(fake.starts).toHaveLength(2);
    expect(fake.starts[1]).toMatchObject({ resume: "sess-live", permissionMode: "plan" });
    expect(fake.closed).toContain(firstRun);
    expect(fake.closed).not.toContain(fake.starts[1].runId);
  });

  it("stops a turn with an interrupt and keeps the process alive", async () => {
    const controller = new AbortController();
    fake.onUser = () => {
      init("sess-stop");
      textDelta("trabajando…");
      queueMicrotask(() => controller.abort());
    };
    fake.onInterrupt = () => result("sess-stop", { subtype: "error_during_execution", is_error: true, result: "" });

    await expect(
      streamClaudeCode({ model: opus, history: [userTurn("largo")], workspace: "C:/ws", planMode: false, effort: "low", signal: controller.signal, onChunk: () => {} }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.sent.some((m) => m.type === "control_request" && (m.request as Json).subtype === "interrupt")).toBe(true);
    expect(fake.killed).toEqual([]);
    expect(fake.closed).not.toContain(fake.starts[0].runId);
  });

  it("runs without tools outside a project", async () => {
    fake.onUser = () => {
      init("sess-5");
      result("sess-5");
    };
    await streamClaudeCode({ model: opus, history: [userTurn("hola")], workspace: null, planMode: false, effort: "extra", onChunk: () => {} });
    expect(fake.starts[0]).toMatchObject({ cwd: null, noTools: true, effort: "xhigh" });
  });
});

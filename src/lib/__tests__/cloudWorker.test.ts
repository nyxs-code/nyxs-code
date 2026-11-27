import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelMessage } from "ai";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
// The keychain read the app makes inside Tauri (node has no window to tell it's there).
vi.mock("@/lib/secureStore", async (orig) => ({ ...(await orig<object>()), getSecret: (account: string) => invoke("nyxs_secret_get", { account }) }));

const MODEL_ID = "anthropic:claude-sonnet-4-5";
const settings = {
  anthropic: { apiKey: "sk-test", models: [{ id: MODEL_ID, provider: "anthropic", apiModel: "claude-sonnet-4-5", name: "Sonnet" }], enabled: [MODEL_ID] },
};
const saveSettings = vi.fn();
vi.mock("@/lib/settings", async (orig) => ({ ...(await orig<object>()), loadSettings: () => settings, saveSettings: (s: unknown) => saveSettings(s) }));

const { runCloudTurn, cloudSettings, cloudPreamble, readCloudSession, takeText, doneStatus, cloudTitle, cloudAllows } = await import("@/cloudWorker");
const { projectToolsFor } = await import("@/lib/projects/projectTools");
const { publishRepo, GIT_AUTH } = await import("@/cloudWorkerGit");
type Exec = import("@/cloudWorkerGit").CloudExec;
type StreamChat = typeof import("@/lib/ai").streamChat;

const job = {
  threadId: "th_1",
  turn: 1,
  prompt: "Add a README",
  repo: { url: "https://github.com/acme/app", branch: null },
  workBranch: "nyxs/readme-1a2b",
  model: { id: MODEL_ID, provider: "anthropic", effort: "xhigh" },
  settings: { providers: { anthropic: { models: settings.anthropic.models, enabled: [MODEL_ID] } } },
  projectInstructions: "Use pnpm.",
  memory: "- the API lives in server/",
  permissionMode: "auto",
  maxSteps: 200,
};

const res = (stdout = "", code = 0, stderr = "") => ({ stdout, stderr, code, timed_out: false });

/** A fake git/gh: a fresh clone whose turn changed a file, with no pull request yet. */
function fakeGit(over: (args: string[]) => ReturnType<typeof res> | undefined = () => undefined) {
  const calls: string[] = [];
  const exec: Exec = async (program, args, cwd) => {
    const plain = args.slice(args[0] === "-c" ? GIT_AUTH.length : 0);
    calls.push(`${program} ${plain.join(" ")} @${cwd}`);
    const o = over(plain);
    if (o) return o;
    const cmd = plain.join(" ");
    if (cmd.startsWith("-C") && cmd.includes("rev-parse --is-inside-work-tree")) return res("", 128);
    if (cmd === "symbolic-ref --short refs/remotes/origin/HEAD") return res("origin/main\n");
    if (cmd === "rev-parse --abbrev-ref HEAD") return res("main\n");
    if (cmd.startsWith("rev-parse --verify")) return res("", 1);
    if (cmd === "status --porcelain") return res(" M README.md\n");
    if (cmd.startsWith("rev-list --count")) return res("1\n");
    if (program === "gh" && plain[1] === "list") return res("[]");
    if (program === "gh" && plain[1] === "create") return res("https://github.com/acme/app/pull/7\n");
    return res();
  };
  return { exec, calls };
}

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
      return "/work/.nyxs/session.json";
    } else if (cmd === "nyxs_secret_get") return a.account === "provider:anthropic" ? "sk-from-env" : null;
    return null;
  });
  const events = () => out.stdout.trim().split("\n").map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
  return { out, events };
}

/** A model turn that reads a file, writes, and reports that it needs the user. */
const scriptedChat = (seen: { history?: unknown; effort?: unknown; sessionKey?: unknown; tools?: string[]; reply?: unknown } = {}): StreamChat =>
  (async (o) => {
    seen.history = o.history;
    seen.effort = o.effort;
    seen.sessionKey = o.sessionKey;
    // The model's tools: a cloud turn is a project's thread, so `report` is among them.
    const threadTools = projectToolsFor(o.sessionKey);
    seen.tools = threadTools.map((t) => t.mcpName);
    o.onChunk("Looking at the repo.");
    o.onTool?.("t1", { name: "Read", detail: "package.json" });
    o.onChunk("⟦TOOL⟧t1⟦/TOOL⟧");
    o.onTool?.("t1", { name: "Read", detail: "package.json", endedAt: 2, output: '{"name":"app"}' });
    o.onChunk("I wrote the README.");
    const reply = await threadTools.find((t) => t.mcpName === "report")!.run({ text: "Which license?", status: "needs_input" }, { chat: o.sessionKey });
    seen.reply = reply;
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "r1", toolName: "report", input: { text: "Which license?", status: "needs_input" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "r1", toolName: "report", output: { type: "text", value: "ok" } }] },
      { role: "assistant", content: "I wrote the README." },
    ];
    o.onMessages?.(messages);
    return "Looking at the repo.⟦TOOL⟧t1⟦/TOOL⟧I wrote the README.";
  }) as StreamChat;

const args = (over: Record<string, unknown> = {}) => ({
  prompt: job.prompt,
  format: "json" as const,
  cwd: "/work/repo",
  model: MODEL_ID,
  permissionMode: "auto",
  maxSteps: 200,
  saveSession: "/work/.nyxs/session.json",
  job,
  workDir: "/work",
  githubToken: true,
  ...over,
});

beforeEach(() => {
  invoke.mockReset();
  saveSettings.mockReset();
});

describe("cloud worker turn", () => {
  it("clones, runs the turn, prints the contract's events and opens a draft PR", async () => {
    const { out, events } = io();
    const git = fakeGit();
    const seen: { history?: unknown; effort?: unknown; sessionKey?: unknown; tools?: string[]; reply?: unknown } = {};
    await runCloudTurn(args(), { chat: scriptedChat(seen), exec: git.exec, now: () => Date.UTC(2026, 10, 26) });
    expect(seen.tools).toEqual(["report"]);
    expect(seen.reply).toBe("Reported to the coordinator.");

    expect(out.exit).toBe(0);
    const ev = events();
    expect(ev.map((e) => e.type)).toEqual(["status", "start", "text", "tool", "tool_result", "text", "report", "status", "result", "done"]);
    expect(ev[0].data).toEqual({ status: "working" });
    expect(ev[2].data).toEqual({ text: "Looking at the repo." });
    expect(ev[4].data).toEqual({ id: "t1", name: "Read", output: '{"name":"app"}' });
    expect(ev[6].data).toEqual({ text: "Which license?", status: "needs_input" });
    // The text went out as `text` events; the result only adds what they don't say.
    expect(ev[8].data).toEqual({ usage: null, denied: [] });
    expect(ev.at(-1)).toEqual({
      type: "done",
      data: { status: "needs_input", preview: "Which license?", branch: "nyxs/readme-1a2b", prUrl: "https://github.com/acme/app/pull/7" },
    });
    expect(seen.effort).toBe("extra");
    expect(seen.sessionKey).toBe("cloud-th_1");
    const first = (seen.history as { content: string }[])[0].content;
    expect(first).toContain("<project-instructions>\nUse pnpm.");
    expect(first).toContain("on the branch nyxs/readme-1a2b (from main)");
    expect(first.endsWith("Add a README")).toBe(true);

    // The token never shows in a command: git asks the credential helper for it.
    expect(git.calls.join("\n")).not.toMatch(/x-access-token:|ghp_/);
    expect(git.calls).toContain("git clone --filter=blob:none -- https://github.com/acme/app /work/repo @/work");
    expect(git.calls).toContain("git checkout --no-track -b nyxs/readme-1a2b origin/main @/work/repo");
    expect(git.calls.some((c) => c.startsWith("git commit -q -m Add a README"))).toBe(true);
    expect(git.calls).toContain("git push -q -u origin HEAD:refs/heads/nyxs/readme-1a2b @/work/repo");
    const create = git.calls.find((c) => c.startsWith("gh pr create"))!;
    expect(create.startsWith("gh pr create --draft --head nyxs/readme-1a2b --base main --title Add a README --body **Add a README**")).toBe(true);
    expect(create).toContain("- Turn 1: Which license?");
    expect(create).toContain("Opened by a Nyxs cloud thread");

    const session = JSON.parse(out.session!);
    expect(session).toMatchObject({ version: 1, threadId: "th_1", turns: 1, model: MODEL_ID, memory: "- the API lives in server/" });
    expect(session.history).toHaveLength(2);
    expect(session.history[1]).toMatchObject({ role: "assistant", content: "Looking at the repo.I wrote the README." });
    expect(session.history[1].messages).toHaveLength(3);
    expect(out.stdout).not.toContain("sk-from-env");
  });

  it("goes on from the saved session on the next turn", async () => {
    const first = io();
    await runCloudTurn(args(), { chat: scriptedChat(), exec: fakeGit().exec, now: () => 0 });
    const saved = first.out.session!;

    const { out, events } = io();
    const seen: { history?: unknown } = {};
    const git = fakeGit((a) => {
      const cmd = a.join(" ");
      if (cmd.startsWith("-C")) return res("true\n");
      if (cmd === "rev-parse --abbrev-ref HEAD") return res("nyxs/readme-1a2b\n");
      if (cmd.includes("refs/remotes/origin/nyxs/readme-1a2b")) return res("abc\n");
      if (a[0] === "pr" && a[1] === "list") return res('[{"url":"https://github.com/acme/app/pull/7"}]');
      return undefined;
    });
    const next = { ...job, turn: 2, prompt: "Use MIT" };
    await runCloudTurn(args({ job: next, prompt: "Use MIT", resume: saved }), { chat: scriptedChat(seen), exec: git.exec, now: () => 0 });
    const history = seen.history as { role: string; content: string }[];
    expect(history).toHaveLength(3);
    expect(history[2]).toEqual({ role: "user", content: "Use MIT" });
    expect(git.calls.some((c) => c.startsWith("git fetch --prune origin"))).toBe(true);
    expect(git.calls.some((c) => c.startsWith("git clone"))).toBe(false);
    expect(git.calls.some((c) => c.startsWith("git checkout"))).toBe(false);
    expect(git.calls.some((c) => c.startsWith("gh pr create"))).toBe(false);
    // The existing pull request gets the thread's title (not the follow-up) and both turns.
    const edit = git.calls.find((c) => c.startsWith("gh pr edit https://github.com/acme/app/pull/7 --title Add a README --body"))!;
    expect(edit).toContain("- Turn 1: Which license?\n- Turn 2: Which license?");
    expect(events().at(-1)?.data).toMatchObject({ prUrl: "https://github.com/acme/app/pull/7" });
    const session = JSON.parse(out.session!);
    expect(session.history).toHaveLength(4);
    expect(session).toMatchObject({ title: "Add a README", instructions: "Add a README" });
    expect(session.log.map((l: { turn: number }) => l.turn)).toEqual([1, 2]);
  });

  it("reports a job it couldn't read and still ends with done", async () => {
    const { out, events } = io();
    await runCloudTurn(args({ job: null, jobError: "The job isn't valid JSON" }), { chat: scriptedChat(), exec: fakeGit().exec, now: () => 0 });
    expect(events()).toEqual([
      { type: "error", data: { message: "The job isn't valid JSON" } },
      { type: "done", data: { status: "failed", preview: "The job isn't valid JSON" } },
    ]);
    expect(out.exit).toBe(0);
  });

  it("fails the turn when the clone fails, without calling the model", async () => {
    const { events } = io();
    const chat = vi.fn();
    const git = fakeGit((a) => (a.includes("clone") ? res("", 128, "fatal: repository not found") : undefined));
    await runCloudTurn(args(), { chat: chat as unknown as StreamChat, exec: git.exec, now: () => 0 });
    expect(chat).not.toHaveBeenCalled();
    expect(events().at(-1)).toEqual({ type: "done", data: { status: "failed", preview: "Couldn't clone the repository: fatal: repository not found", branch: "nyxs/readme-1a2b" } });
  });

  it("keeps a failed turn's work uncommitted and saves what happened", async () => {
    const { out, events } = io();
    const git = fakeGit();
    await runCloudTurn(args(), { chat: (async () => Promise.reject(new Error("rate limited"))) as StreamChat, exec: git.exec, now: () => 0 });
    expect(events().map((e) => e.type)).toEqual(["status", "start", "error", "done"]);
    expect(events().at(-1)?.data).toMatchObject({ status: "failed", preview: "rate limited" });
    expect(git.calls.some((c) => c.startsWith("git commit") || c.startsWith("git push"))).toBe(false);
    expect(JSON.parse(out.session!).history[1].content).toBe("(The turn failed: rate limited)");
  });

  it("lets through what would ask, refuses what the settings deny, and previews the last message", async () => {
    expect(cloudAllows("ask")).toBe(true);
    expect(cloudAllows("allow")).toBe(true);
    expect(cloudAllows("deny")).toBe(false);
    const { events } = io();
    const chat = (async (o) => {
      o.onChunk("First I look.");
      o.onTool?.("t1", { name: "Bash", detail: "git diff" });
      o.onChunk("All done.");
      return "First I look.All done.";
    }) as StreamChat;
    await runCloudTurn(args(), { chat, exec: fakeGit().exec, now: () => 0 });
    expect(events().at(-1)?.data).toMatchObject({ status: "review", preview: "All done." });
  });

  it("runs a dry run through the pipeline without a model", async () => {
    const { events } = io();
    const chat = vi.fn();
    const git = fakeGit((a) => (a.join(" ") === "status --porcelain" ? res("") : a[0] === "rev-list" ? res("0\n") : undefined));
    await runCloudTurn(args({ job: { ...job, model: null, dryRun: true }, model: null }), { chat: chat as unknown as StreamChat, exec: git.exec, now: () => 0 });
    expect(chat).not.toHaveBeenCalled();
    expect(events().map((e) => e.type)).toEqual(["status", "start", "text", "result", "done"]);
    expect(events().at(-1)?.data).toEqual({ status: "review", preview: expect.stringContaining("Dry run"), branch: "nyxs/readme-1a2b" });
    expect(git.calls.some((c) => c.startsWith("git push"))).toBe(false);
  });
});

describe("cloud worker pieces", () => {
  it("gives a cloud turn's model the report tool though headless has no sessions", async () => {
    const { addSessionTools } = await import("@/tools/Sessions/tool");
    const { noteProjectRole } = await import("@/lib/projects/projectDirectory");
    const toolsOf = (sessionKey: string) => {
      const tools: Record<string, unknown> = {};
      addSessionTools(tools as never, { sessionKey } as never);
      return Object.keys(tools);
    };
    expect(toolsOf("plain-headless-run")).toEqual([]);
    noteProjectRole("cloud-th_tools", "cloud", "thread");
    expect(toolsOf("cloud-th_tools")).toHaveLength(1);
    expect(toolsOf("cloud-th_tools")[0]).toMatch(/report/i);
  });

  it("takes provider keys from the keychain entries and marks CLI providers connected", async () => {
    const secret = vi.fn(async (account: string) => (account === "provider:anthropic" ? "sk-env" : null));
    const base = { anthropic: { apiKey: "" }, "claude-code": { apiKey: "" } } as never;
    const out = await cloudSettings({ ...job, settings: { providers: { anthropic: { apiKey: "leaked", baseUrl: "https://x" }, "claude-code": { models: [] }, bogus: {} } } }, base, secret);
    expect(out.anthropic).toMatchObject({ apiKey: "sk-env", baseUrl: "https://x", enabled: [MODEL_ID] });
    expect(out.anthropic.models?.map((m) => m.id)).toEqual([MODEL_ID]);
    expect(out["claude-code"].apiKey).toBe("subscription");
    expect("bogus" in out).toBe(false);
    expect(secret).not.toHaveBeenCalledWith("provider:claude-code");
  });

  it("keeps marker blocks that haven't closed for the next flush", () => {
    expect(takeText("Hi ⟦TOOL⟧x⟦/TOOL⟧there")).toEqual({ text: "Hi there", rest: "" });
    expect(takeText("Hi ⟦TOOL⟧x")).toEqual({ text: "Hi", rest: "⟦TOOL⟧x" });
  });

  it("tells the final status and the title", () => {
    expect(doneStatus(false, null)).toBe("review");
    expect(doneStatus(false, "needs_input")).toBe("needs_input");
    expect(doneStatus(false, "failed")).toBe("failed");
    expect(doneStatus(true, "needs_input")).toBe("failed");
    expect(cloudTitle({ ...job, prompt: `${"x".repeat(100)}\nmore` })).toHaveLength(72);
  });

  it("ignores another thread's or a broken session, and only repeats memory that changed", () => {
    const s = JSON.stringify({ version: 1, threadId: "th_1", turns: 1, model: null, memory: "m", history: [], updatedAt: "" });
    expect(readCloudSession(s, "th_2")).toBeNull();
    expect(readCloudSession("{", "th_1")).toBeNull();
    const prev = readCloudSession(s, "th_1");
    expect(cloudPreamble({ ...job, memory: "m" }, "main", prev)).toBe("");
    expect(cloudPreamble({ ...job, memory: "m2" }, "main", prev)).toContain("m2");
  });

  it("doesn't push without a token or when nothing changed", async () => {
    const repo = { dir: "/work/repo", base: "main", cloned: false };
    const clean = fakeGit((a) => (a.join(" ") === "status --porcelain" ? res("") : a[0] === "rev-list" ? res("0\n") : undefined));
    expect(await publishRepo(job, repo, { title: "t", body: "b", canPush: true }, clean.exec)).toEqual({ changed: false, pushed: false });
    const noToken = fakeGit();
    const r = await publishRepo(job, repo, { title: "t", body: "b", canPush: false }, noToken.exec);
    expect(r).toMatchObject({ changed: true, pushed: false });
    expect(noToken.calls.some((c) => c.startsWith("git push"))).toBe(false);
  });
});

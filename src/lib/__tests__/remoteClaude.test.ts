// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {};
const opened: string[] = [];

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push(cmd.replace("claude_code_remote_", ""));
    const handler = handlers[cmd];
    if (!handler) throw new Error(`unexpected ${cmd}`);
    return handler(args);
  }),
}));
vi.mock("../openExternal", () => ({ openExternalUrl: (url: string) => opened.push(url) }));
vi.mock("../claudeCodeCli", async () => {
  // Only the version comparison: the real module pulls in the whole process machinery.
  return {
    claudeCodeNeedsUpdate: (current: string | null | undefined, latest: string) =>
      !!current && current.localeCompare(latest, undefined, { numeric: true }) < 0,
  };
});

import {
  askRemoteSignInCode,
  ensureRemoteClaude,
  ensureRemoteClaudeUnattended,
  forgetRemoteClaude,
  retryRemoteClaude,
  sendRemoteSignInCode,
  signInRemoteClaude,
  useRemoteClaudeStep,
} from "../remoteClaude";

const CURRENT = { installed: true, version: "2.1.319", loggedIn: true };
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** A fresh machine name per test: what's known is kept per machine for the app's life. */
let n = 0;
const machine = () => `host-${++n}`;

function status(...answers: object[]) {
  handlers.claude_code_remote_status = () => (answers.length > 1 ? answers.shift() : answers[0]);
}

beforeEach(() => {
  calls.length = 0;
  opened.length = 0;
  for (const k of Object.keys(handlers)) delete handlers[k];
  handlers.claude_code_remote_login_cancel = () => undefined;
});

describe("ensureRemoteClaude", () => {
  it("shows nothing and asks nothing when the machine is ready, and remembers it", async () => {
    const host = machine();
    status(CURRENT);
    await ensureRemoteClaude(host);
    expect(calls).toEqual(["status"]);
    await ensureRemoteClaude(host);
    expect(calls).toEqual(["status"]);
    forgetRemoteClaude(host);
    await ensureRemoteClaude(host);
    expect(calls).toEqual(["status", "status"]);
  });

  it("installs what's missing on its own and goes on", async () => {
    const host = machine();
    status({ installed: false }, CURRENT);
    handlers.claude_code_remote_install = () => ({ ok: true, detail: "" });
    await ensureRemoteClaude(host);
    expect(calls).toEqual(["status", "install", "status"]);
  });

  it("updates a version too old for the flags Nyxs passes, only once", async () => {
    const host = machine();
    status({ installed: true, version: "2.1.100", loggedIn: true });
    handlers.claude_code_remote_update = () => { throw new Error("no permission"); };
    await ensureRemoteClaude(host);
    expect(calls).toEqual(["status", "update", "status"]);
  });

  it("stops at a failed install with its reason, and retrying starts over", async () => {
    const host = machine();
    const { result } = renderHook(() => useRemoteClaudeStep(host));
    status({ installed: false }, { installed: false }, CURRENT);
    let installs = 0;
    handlers.claude_code_remote_install = () =>
      ++installs === 1 ? { ok: false, reason: "download", detail: "" } : { ok: true, detail: "" };
    const done = ensureRemoteClaude(host);
    await flush();
    expect(result.current).toEqual({ kind: "failed", reason: "download", detail: "" });
    act(() => retryRemoteClaude(host));
    await done;
    await flush();
    expect(installs).toBe(2);
    expect(result.current).toBeNull();
  });

  it("doesn't reinstall forever when an install leaves nothing it can find", async () => {
    const host = machine();
    const { result } = renderHook(() => useRemoteClaudeStep(host));
    status({ installed: false });
    let installs = 0;
    handlers.claude_code_remote_install = () => { installs++; return { ok: true, detail: "" }; };
    const controller = new AbortController();
    const done = ensureRemoteClaude(host, controller.signal);
    await flush();
    expect(installs).toBe(1);
    expect(result.current?.kind).toBe("failed");
    controller.abort();
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
    await flush();
  });

  it("waits for the sign-in, opens the browser here, and sends the message after", async () => {
    const host = machine();
    const { result } = renderHook(() => useRemoteClaudeStep(host));
    status({ installed: true, version: "2.1.319", loggedIn: false }, CURRENT);
    let finish: (end: object) => void = () => undefined;
    handlers.claude_code_remote_login_start = () => ({ url: "https://claude.com/auto", manualUrl: "https://claude.com/code", automatic: true });
    handlers.claude_code_remote_login_wait = () => new Promise((r) => { finish = r; });
    let ready = false;
    const done = ensureRemoteClaude(host).then(() => { ready = true; });
    await flush();
    expect(result.current).toEqual({ kind: "login" });
    expect(opened).toEqual([]);

    void signInRemoteClaude(host);
    await flush();
    expect(opened).toEqual(["https://claude.com/auto"]);
    expect(result.current).toEqual({ kind: "signingIn", manualUrl: "https://claude.com/code", automatic: true, askCode: false });
    expect(ready).toBe(false);

    finish({ ok: true, cancelled: false, detail: "" });
    await done;
    expect(ready).toBe(true);
  });

  it("falls back to the link with a code, and a wrong code offers signing in again", async () => {
    const host = machine();
    const { result } = renderHook(() => useRemoteClaudeStep(host));
    status({ installed: true, version: "2.1.319", loggedIn: false });
    const sent: unknown[] = [];
    let finish: (end: object) => void = () => undefined;
    handlers.claude_code_remote_login_start = () => ({ url: "https://claude.com/auto", manualUrl: "https://claude.com/code", automatic: true });
    handlers.claude_code_remote_login_wait = () => new Promise((r) => { finish = r; });
    handlers.claude_code_remote_login_code = (args) => { sent.push(args.code); };
    const controller = new AbortController();
    const done = ensureRemoteClaude(host, controller.signal);
    await flush();
    void signInRemoteClaude(host);
    await flush();

    act(() => askRemoteSignInCode(host));
    expect(opened).toEqual(["https://claude.com/auto", "https://claude.com/code"]);
    expect(result.current).toMatchObject({ kind: "signingIn", askCode: true });
    await sendRemoteSignInCode(host, "abc#def");
    expect(sent).toEqual(["abc#def"]);

    finish({ ok: false, cancelled: false, detail: "That code wasn't accepted." });
    await flush();
    expect(result.current).toEqual({ kind: "login", error: "That code wasn't accepted." });

    controller.abort();
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(calls).toContain("login_cancel");
    expect(result.current).toBeNull();
  });

  it("with nobody watching, installs but doesn't wait for a sign-in", async () => {
    const host = machine();
    status({ installed: false }, { installed: true, version: "2.1.319", loggedIn: false });
    handlers.claude_code_remote_install = () => ({ ok: true, detail: "" });
    await expect(ensureRemoteClaudeUnattended(host)).resolves.toBe(false);
    expect(calls).toEqual(["status", "install", "status"]);

    const broken = machine();
    status({ installed: false });
    handlers.claude_code_remote_install = () => ({ ok: false, reason: "download", detail: "no route" });
    await expect(ensureRemoteClaudeUnattended(broken)).rejects.toThrow(/no route/);

    const fine = machine();
    status(CURRENT);
    await expect(ensureRemoteClaudeUnattended(fine)).resolves.toBe(true);
    calls.length = 0;
    await ensureRemoteClaude(fine);
    expect(calls).toEqual([]);
  });

  it("shares one run between chats, and only stops when the last one leaves", async () => {
    const host = machine();
    status({ installed: true, version: "2.1.319", loggedIn: false }, CURRENT);
    const first = new AbortController();
    const second = new AbortController();
    const one = ensureRemoteClaude(host, first.signal);
    const two = ensureRemoteClaude(host, second.signal);
    await flush();
    expect(calls.filter((c) => c === "status")).toHaveLength(1);
    first.abort();
    await expect(one).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).not.toContain("login_cancel");
    second.abort();
    await expect(two).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toContain("login_cancel");
    await flush();
  });
});

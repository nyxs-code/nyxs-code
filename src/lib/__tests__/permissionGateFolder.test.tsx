// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeAll } from "vitest";
import type { PermissionMode } from "@/components/ui/claude-style-chat-input";

const files = new Map<string, string>();
const norm = (p: unknown) => String(p ?? "").replace(/\\/g, "/");

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    const path = norm(args.path);
    if (cmd === "agent_read_text") return files.get(path) ?? null;
    if (cmd === "agent_file_mtime") return files.has(path) ? 1 : null;
    if (cmd === "agent_allow_ui_path") return null;
    if (cmd.startsWith("plugin:")) return 0;
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

const HOME = "C:/Users/me";
const A = "E:/a";
const B = "E:/b";

type Runtime = typeof import("@/lib/settingsRuntime");
type Prompts = typeof import("@/lib/usePermissionPrompts");
let rt: Runtime;
let usePermissionPrompts: Prompts["usePermissionPrompts"];

beforeAll(async () => {
  Object.assign(window, { __TAURI_INTERNALS__: { transformCallback: () => 0, invoke: async () => 0 }, __NYXS_HOME__: HOME });
  files.set(`${HOME}/.nyxs/settings.json`, JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }));
  // Deny rules apply untrusted, so no trust decision is needed here.
  files.set(`${A}/.nyxs/settings.json`, JSON.stringify({ permissions: { deny: ["Bash(echo:*)"] } }));
  files.set(`${B}/.nyxs/settings.json`, JSON.stringify({ permissions: { deny: ["Bash(ls:*)"] } }));
  rt = await import("@/lib/settingsRuntime");
  ({ usePermissionPrompts } = await import("@/lib/usePermissionPrompts"));
});

describe("the permission gate", () => {
  it("checks a chat's calls with its own project's rules, not the open one's", async () => {
    rt.setSettingsWorkspace(B);
    await rt.getMergedSettings();
    const chats = { current: [{ id: "inA", workspace: A }, { id: "inB", workspace: B }] };
    const auto = (): PermissionMode => "auto";
    const { result } = renderHook(() => usePermissionPrompts(null, auto, chats));
    const gate = result.current.gate;
    expect(await gate("inA", "Bash", { command: "echo hi" })).toBe(false);
    expect(await gate("inA", "Bash", { command: "ls" })).toBe(true);
    expect(await gate("inB", "Bash", { command: "ls" })).toBe(false);
    expect(await gate("inB", "Bash", { command: "echo hi" })).toBe(true);
    // The user's rules hold everywhere.
    expect(await gate("inA", "Bash", { command: "rm -rf build" })).toBe(false);
    expect(result.current.isAllowed("inA", "Bash", { command: "echo hi" })).toBe(false);
    expect(result.current.isAllowed("inA", "Bash", { command: "ls" })).toBe(true);
  });
});

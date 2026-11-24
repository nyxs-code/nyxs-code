// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(async (cmd: string) => (cmd === "agent_bg_list" ? [] : true)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { invoke } from "@/lib/ipc";
import { ToolChip } from "@/components/message/ToolChips";
import { hasMovableCommand, moveCommandsToBackground, movedIn, noteMovableCommand } from "@/lib/commandBackground";
import { formatMovedResult } from "@/tools/Bash/format";
import { getLanguage, getTranslations } from "@/lib/i18n";

afterEach(cleanup);

const tr = getTranslations(getLanguage());

describe("a command moved to the background", () => {
  it("tells the agent where it goes on, with what it printed so far", () => {
    const res = { stdout: "compiling…\n", stderr: "", code: -1, timed_out: false };
    const byUser = formatMovedResult(res, { shell_id: "bash_7", by_timeout: false }, 120_000, 20_000);
    expect(byUser.split("\n")[0]).toBe("[moved to the background: bash_7, by the user]");
    expect(byUser).toContain("BashOutput");
    expect(byUser).toContain("compiling…");
    expect(movedIn(byUser)).toEqual({ shellId: "bash_7" });
    const byLimit = formatMovedResult(res, { shell_id: "bash_8", by_timeout: true }, 120_000, 20_000);
    expect(byLimit).toContain("time limit of 120 s");
    expect(movedIn(byLimit)).toEqual({ shellId: "bash_8", limitMs: 120_000 });
  });

  it("is moved by the session it runs in, and only while it runs", () => {
    noteMovableCommand("chat-1", "run-a");
    expect(hasMovableCommand("chat-1")).toBe(true);
    expect(hasMovableCommand("chat-2")).toBe(false);
    expect(moveCommandsToBackground("chat-1")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("agent_run_to_background", { runId: "run-a" });
    noteMovableCommand("chat-1", "run-a", true);
    expect(moveCommandsToBackground("chat-1")).toBe(false);
  });

  it("shows its row as running in the background, with where it goes on", () => {
    render(<ToolChip name="Bash" detail="npm run build" end={{ status: "ok" }} streaming={false} info={{ name: "Bash", detail: "npm run build", background: { shellId: "bash_7", limitMs: 120_000 } }} />);
    expect(screen.getByText(`· ${tr.commandBackground.movedAfterLimit.replace("{duration}", "2 min")}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: tr.commandBackground.tasksLink })).toBeTruthy();
  });
});

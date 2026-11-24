// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToolChip } from "@/components/message/ToolChips";
import { CommandRunContext } from "@/components/message/commandRun";
import { memoryLimitLifted, memoryStopIn } from "@/lib/commandMemory";
import { formatRunResult } from "@/tools/Bash/format";
import { getLanguage, getTranslations } from "@/lib/i18n";

afterEach(cleanup);

const tr = getTranslations(getLanguage());
const stop = { used_gb: 34, installed_gb: 16 };

describe("a command stopped for its memory", () => {
  it("tells the agent what happened and not to run it again as it was", () => {
    const text = formatRunResult({ stdout: "loading…", stderr: "", code: -1, timed_out: false, cancelled: false, memory_stop: stop }, 20_000);
    expect(text.split("\n")[0]).toBe("[exit code: -1, stopped for memory]");
    expect(text).toContain("using 34 GB of memory on this 16 GB computer");
    expect(text).toContain("Don't run it again as it was");
    expect(memoryStopIn(text)).toEqual({ usedGb: 34, installedGb: 16 });
    expect(memoryStopIn(formatRunResult({ stdout: "ok", stderr: "", code: 0, timed_out: false }, 20_000))).toBeUndefined();
  });

  it("shows as stopped, with a note that lifts the limit for the session", () => {
    render(
      <CommandRunContext.Provider value={{ workspace: null, chatId: "chat-mem" }}>
        <ToolChip name="Bash" detail="python big.py" end={{ status: "ok" }} streaming={false} info={{ name: "Bash", detail: "python big.py", memoryStop: { usedGb: 34, installedGb: 16 } }} />
      </CommandRunContext.Provider>,
    );
    expect(screen.getByText(`· ${tr.message.toolStopped}`)).toBeTruthy();
    const note = screen.getByRole("status");
    expect(note.textContent).toContain(tr.commandMemory.stopped.replace("{used}", "34").replace("{installed}", "16"));
    fireEvent.click(screen.getByRole("button", { name: tr.commandMemory.allow }));
    expect(memoryLimitLifted("chat-mem")).toBe(true);
    expect(memoryLimitLifted("another-chat")).toBe(false);
    expect(note.textContent).toContain(tr.commandMemory.lifted);
    expect(screen.queryByRole("button", { name: tr.commandMemory.allow })).toBeNull();
  });
});

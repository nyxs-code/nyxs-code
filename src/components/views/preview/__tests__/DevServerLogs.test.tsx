// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const reads: Array<{ after: number }> = [];
vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(async (_cmd: string, args: { after: number }) => {
    reads.push(args);
    // What it printed before, then one more line, then it ends.
    if (args.after === 0) return { output: "\x1b[32mVITE ready\x1b[0m\nwarning: unused import\n", nextOffset: 40, status: "running" };
    if (args.after === 40) return { output: "Internal server error: boom\n", nextOffset: 68, status: "running" };
    return { output: "", nextOffset: 68, status: "done" };
  }),
}));

import { DevServerLogs } from "@/components/views/preview/DevServerLogs";
import { lineLevel } from "@/components/views/preview/logLevel";
import { getLanguage, getTranslations } from "@/lib/i18n";

afterEach(cleanup);
const t = getTranslations(getLanguage()).views;

describe("the dev server logs panel", () => {
  it("shows what the server printed, then what comes, each line once and in order", async () => {
    const onClose = vi.fn();
    render(<DevServerLogs shellId="bash_3" title="web · localhost:5173" onClose={onClose} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const log = screen.getByRole("log");
    expect(log.textContent).toBe("VITE readywarning: unused importInternal server error: boom");
    expect(reads.map((r) => r.after)).toEqual([0, 40, 68]);
    expect(screen.getByText("web · localhost:5173")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.closeServerLogs }));
    expect(onClose).toHaveBeenCalled();
  });

  it("colors errors and warnings", () => {
    expect(lineLevel("10:43 [vite] Internal server error: x")).toBe("error");
    expect(lineLevel("npm ERR! code 1")).toBe("error");
    expect(lineLevel("\x1b[33mwarning\x1b[0m: deprecated option")).toBe("warn");
    expect(lineLevel("  ➜  Local:   http://localhost:5173/")).toBeNull();
  });
});

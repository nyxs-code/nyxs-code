import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { inWorkspace, applyShellExit, applyShellOutput, lastOutputLine } = await import("../bgShells");

describe("shell events", () => {
  it("keeps the exit of a shell it didn't know yet", () => {
    const next = applyShellExit({}, { id: "bash_3", status: "exited", code: 0, endedAt: 5 });
    expect(next.bash_3).toMatchObject({ id: "bash_3", status: "exited", code: 0, endedAt: 5 });
    // A known shell keeps its details.
    const known = applyShellExit({ bash_1: { ...next.bash_3, id: "bash_1", command: "npm run dev", status: "running" } }, { id: "bash_1", status: "killed", code: null });
    expect(known.bash_1).toMatchObject({ command: "npm run dev", status: "killed" });
  });

  it("adds output, and only adds a shell when output isn't kept", () => {
    const one = applyShellOutput({}, { id: "a", stream: "stdout", line: "ready" }, false);
    expect(one.a.output).toBe("ready\n");
    expect(applyShellOutput(one, { id: "a", stream: "stdout", line: "more" }, false)).toBe(one);
    expect(applyShellOutput(one, { id: "a", stream: "stdout", line: "more" }, true).a.output).toBe("ready\nmore\n");
  });
});

describe("lastOutputLine", () => {
  it("takes the last line that says something, without colors or redrawn progress", () => {
    expect(lastOutputLine("\x1b[32m  VITE v5.4.0\x1b[0m  ready in 312 ms\n\n")).toBe("VITE v5.4.0  ready in 312 ms");
    expect(lastOutputLine("Compiling 10%\rCompiling 55%\rCompiling 90%\r")).toBe("Compiling 90%");
    expect(lastOutputLine("")).toBe("");
    expect(lastOutputLine("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("inWorkspace", () => {
  it("keeps a shell of the project or a folder under it", () => {
    expect(inWorkspace({ cwd: "D:\\optimicer" }, "D:\\optimicer")).toBe(true);
    expect(inWorkspace({ cwd: "D:/optimicer/web" }, "D:\\Optimicer\\")).toBe(true);
  });

  it("leaves out another project's shell, even one whose name starts the same", () => {
    expect(inWorkspace({ cwd: "D:\\storefront" }, "D:\\optimicer")).toBe(false);
    expect(inWorkspace({ cwd: "D:\\optimicer-old" }, "D:\\optimicer")).toBe(false);
  });

  it("keeps a shell with no folder, and every shell when there is no project", () => {
    expect(inWorkspace({ cwd: null }, "D:\\optimicer")).toBe(true);
    expect(inWorkspace({ cwd: "D:\\storefront" }, null)).toBe(true);
  });
});

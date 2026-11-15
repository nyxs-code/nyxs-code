import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
let settings: Record<string, unknown> = {};
vi.mock("@/lib/settingsRuntime", () => ({ getMergedSettings: async () => settings }));
let os = "windows";
vi.mock("@/lib/desktopOs", () => ({ desktopOs: () => os }));

const { clearDiagnosticsCache, runDiagnosticsForFile, fileCommand } = await import("@/lib/diagnostics");
const { formatAfterEdit } = await import("@/lib/formatters");

const runs = () => invoke.mock.calls.filter(([cmd]) => cmd === "agent_run").map(([, args]) => args as { command: string; env?: Record<string, string> });

beforeEach(() => {
  invoke.mockReset();
  clearDiagnosticsCache();
  settings = {};
  os = "windows";
  invoke.mockImplementation(async (cmd: string, args: { pattern?: string }) => {
    if (cmd === "agent_glob") return args.pattern?.startsWith("eslint") || args.pattern === "tsconfig.json" ? ["x"] : [];
    if (cmd === "agent_run") return { stdout: "", stderr: "", code: 0, timed_out: false };
    if (cmd === "agent_file_mtime") return 1;
    return null;
  });
});

describe("the edited file's name in diagnostics and formatter commands", () => {
  it("reaches the linter through an environment variable, never as shell text", async () => {
    await runDiagnosticsForFile("E:/ws", "E:/ws/src/a$(calc).ts");
    const [run] = runs();
    expect(run.command).toBe('npx --no-install eslint "${env:NYXS_FILE}"');
    expect(run.command).not.toContain("calc");
    expect(run.env).toEqual({ NYXS_FILE: "src/a$(calc).ts", NYXS_FILE_ABS: "E:/ws/src/a$(calc).ts" });
  });

  it("uses the POSIX form outside Windows and on a remote Linux machine", () => {
    os = "linux";
    expect(fileCommand("ruff check \"$FILE\"", "E:/ws", "src/`id`.py", "/ws/src/`id`.py").command).toBe('ruff check "${NYXS_FILE}"');
    os = "windows";
    expect(fileCommand("gofmt -w $FILE", "ssh://box/home/me/app", "a.go", "/home/me/app/a.go").command).toBe("gofmt -w ${NYXS_FILE}");
    expect(fileCommand("gofmt -w $FILE", "ssh://casa/C:/code/app", "a.go", "C:/code/app/a.go").command).toBe("gofmt -w ${env:NYXS_FILE}");
  });

  it("keeps $& and other replacement patterns in the name as they are", async () => {
    await runDiagnosticsForFile("E:/ws", "E:/ws/src/a$&b.ts");
    expect(runs()[0].env?.NYXS_FILE).toBe("src/a$&b.ts");
  });

  it("passes no variables to a command that doesn't name the file", () => {
    expect(fileCommand("npx --no-install tsc --noEmit", "E:/ws", "src/a.ts", "E:/ws/src/a.ts")).toEqual({ command: "npx --no-install tsc --noEmit", env: undefined });
  });

  it("does the same for the formatter, also when the rule single-quotes the name", async () => {
    settings = { format: { enabled: true, rules: [{ match: "**/*.ts", command: "prettier --write '$FILE' && echo $FILE_ABS" }] } };
    await formatAfterEdit("E:/ws", "E:\\ws\\src\\x$(whoami).ts");
    const [run] = runs();
    expect(run.command).toBe('prettier --write "${env:NYXS_FILE}" && echo ${env:NYXS_FILE_ABS}');
    expect(run.env).toEqual({ NYXS_FILE: "src/x$(whoami).ts", NYXS_FILE_ABS: "E:/ws/src/x$(whoami).ts" });
  });
});

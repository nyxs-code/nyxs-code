import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  /** What `lsp_diagnostics_wait` answers. */
  diagnostics: {} as Record<string, unknown[]>,
  installed: true,
  /** Resolves the running install. */
  finishInstall: null as (() => void) | null,
  lsp: { enabled: true, autoInstall: true, diagnosticsWaitMs: 1500 } as Record<string, unknown>,
}));

vi.mock("@/lib/ipc", () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    fake.calls.push({ cmd, args });
    switch (cmd) {
      case "lsp_ensure_server":
        if (!fake.installed) throw `LSP_NOT_INSTALLED:${String(args.language)}`;
        return { state: "ready" };
      case "nyxs_read_text":
        return "const a: number = 'x';\n";
      case "lsp_diagnostics_wait":
        return fake.diagnostics;
      case "lsp_provision":
        await new Promise<void>((r) => (fake.finishInstall = r));
        fake.installed = true;
        return { installed: true };
      case "path_is_dir":
        return true;
      default:
        return null;
    }
  },
}));

vi.mock("@/lib/settingsRuntime", () => ({ getMergedSnapshot: () => ({ lsp: fake.lsp }) }));

const lsp = await import("@/lib/lsp");

const WS = "E:/proj";
const FILE = "E:/proj/src/a.ts";
const URI = "file:///E:/proj/src/a.ts";
const error = { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, severity: 1, message: "Type 'string' is not assignable to type 'number'." };

const called = (cmd: string) => fake.calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  fake.calls = [];
  fake.diagnostics = {};
  fake.installed = true;
  fake.finishInstall = null;
  fake.lsp = { enabled: true, autoInstall: true, diagnosticsWaitMs: 1500 };
});

describe("diagnostics after an edit", () => {
  it("aren't taken as clean when the file's own didn't arrive", async () => {
    const res = await lsp.lspDiagnosticsForFile(WS, FILE, "src/a.ts");
    expect(res).toEqual({ handled: false, block: null });
    expect(called("lsp_diagnostics_wait")[0].args.uri).toBe(URI);
  });

  it("are reported when the server published them for the file", async () => {
    fake.diagnostics = { "file:///e%3A/proj/src/a.ts": [error] };
    const res = await lsp.lspDiagnosticsForFile(WS, FILE, "src/a.ts");
    expect(res.handled).toBe(true);
    expect(res.block).toContain("src/a.ts:1:7 error Type 'string' is not assignable");
  });

  it("are clean when the server published none for the file", async () => {
    fake.diagnostics = { [URI]: [] };
    expect(await lsp.lspDiagnosticsForFile(WS, FILE, "src/a.ts")).toEqual({ handled: true, block: null });
  });

  it("tell the server the file was saved", async () => {
    await lsp.lspDiagnosticsForFile(WS, "E:/proj/src/b.ts", "src/b.ts");
    await lsp.lspDiagnosticsForFile(WS, "E:/proj/src/b.ts", "src/b.ts");
    expect(called("lsp_did_open")[0].args.saved).toBe(true);
    expect(called("lsp_did_change")[0].args.saved).toBe(true);
  });
});

describe("installing a missing server", () => {
  it("happens in the background, once, without holding the edit", async () => {
    fake.installed = false;
    const first = await lsp.ensureServerForFile(WS, "E:/proj/main.py");
    const second = await lsp.ensureServerForFile(WS, "E:/proj/other.py");
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(called("lsp_provision").map((c) => c.args.language)).toEqual(["python"]);
    fake.finishInstall?.();
    await vi.waitFor(() => expect(fake.installed).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(await lsp.ensureServerForFile(WS, "E:/proj/main.py")).toBe("python");
  });

  it("doesn't happen with lsp.autoInstall off", async () => {
    fake.installed = false;
    fake.lsp = { ...fake.lsp, autoInstall: false };
    expect(await lsp.ensureServerForFile(WS, "E:/proj/main.rs")).toBeNull();
    expect(called("lsp_provision")).toEqual([]);
  });
});

describe("closing servers", () => {
  const disposed = () => called("lsp_dispose_workspace").map((c) => c.args.workspace);

  it("closes a folder's servers once nothing uses it, and not before", async () => {
    lsp.setLspFoldersInUse(["E:/a"]);
    lsp.setLspFoldersInUse(["E:/a", "E:/a/wt"]);
    expect(disposed()).toEqual([]);
    // The same folder spelled another way is still in use.
    lsp.setLspFoldersInUse(["e:/A/", "E:/a/wt"]);
    expect(disposed()).toEqual([]);
    lsp.setLspFoldersInUse(["E:/a"]);
    await vi.waitFor(() => expect(disposed()).toEqual(["E:/a/wt"]));
    lsp.setLspFoldersInUse([null, undefined]);
    await vi.waitFor(() => expect(disposed()).toEqual(["E:/a/wt", "E:/a"]));
  });
});

import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn(async (cmd: string, _args?: unknown) => (cmd === "nyxs_read_text" ? "const a = 1;\n" : null));
vi.mock("@/lib/ipc", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const { pathToUri, pickForFile, syncFile } = await import("@/lib/lsp");

const FILE = "ssh://box/home/me/app/src/a.ts";

describe("the language server on an ssh:// project", () => {
  it("names a remote file by its ssh:// path, which the backend turns into the server's file:// URI", () => {
    expect(pathToUri(FILE)).toBe(FILE);
    expect(pathToUri("ssh://casa/C:/code/app/a.ts")).toBe("ssh://casa/C:/code/app/a.ts");
  });

  it("opens the document under that name", async () => {
    await syncFile("ssh://box/home/me/app", "typescript", FILE);
    expect(invoke).toHaveBeenCalledWith("lsp_did_open", expect.objectContaining({ uri: FILE }));
    expect(invoke).not.toHaveBeenCalledWith("lsp_did_open", expect.objectContaining({ uri: expect.stringMatching(/^file:/) }));
  });

  it("finds the file's diagnostics, which come back keyed by the same ssh:// name", () => {
    const d = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "x" };
    expect(pickForFile({ [FILE]: [d] }, FILE)).toEqual([d]);
  });
});

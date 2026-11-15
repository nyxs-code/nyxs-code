import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import enUS from "@/locales/en-US";
import esES from "@/locales/es-ES";

const tauriInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => tauriInvoke(...args) }));

const { BackendError, describeError, invoke } = await import("@/lib/ipc");

describe("backend error codes", () => {
  it("every code in src-tauri/src/error.rs has a text in the locales", () => {
    const source = readFileSync("src-tauri/src/error.rs", "utf8");
    // rustfmt puts long calls' arguments on their own lines: `Self::new(\n    "code",`.
    const codes = [...source.matchAll(/Self::new\(\s*"(\w+)"/g)].map((m) => m[1]).filter((c) => c !== "other");
    expect(codes.length).toBeGreaterThan(20);
    for (const code of codes) expect(Object.keys(enUS.errors), code).toContain(code);
    expect(Object.keys(enUS.errors).sort()).toEqual([...new Set(codes)].sort());
  });
});

describe("invoke", () => {
  it("turns a coded backend error into a BackendError whose text is the English message", async () => {
    tauriInvoke.mockRejectedValueOnce({ code: "fileReadFailed", message: "Couldn't read a.txt: denied", params: { path: "a.txt", detail: "denied" } });
    const err = await invoke("agent_read_text").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(String(err)).toBe("Couldn't read a.txt: denied");
    expect(`${err}`).toBe("Couldn't read a.txt: denied");
  });

  it("leaves plain string errors as they were", async () => {
    tauriInvoke.mockRejectedValueOnce("boom");
    await expect(invoke("x")).rejects.toBe("boom");
  });
});

describe("describeError", () => {
  const err = new BackendError({ code: "fileReadFailed", message: "Couldn't read a.txt: denied", params: { path: "a.txt", detail: "denied" } });

  it("shows a known code in the user's language with its params", () => {
    expect(describeError(err, esES)).toBe("No se pudo leer a.txt: denied");
  });

  it("falls back to the message for an unknown code and to the text of any other error", () => {
    expect(describeError(new BackendError({ code: "other", message: "plain" }), esES)).toBe("plain");
    expect(describeError(new Error("e"), esES)).toBe("e");
    expect(describeError("s", esES)).toBe("s");
  });
});

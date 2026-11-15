import { describe, it, expect } from "vitest";
import { extToLanguage, isLspSupported, pathToUri } from "@/lib/lsp";

describe("extToLanguage", () => {
  it("maps TypeScript/JavaScript variants", () => {
    for (const ext of ["ts", "tsx", "mts", "cts"]) {
      expect(extToLanguage(`a.${ext}`)).toBe("typescript");
    }
    for (const ext of ["js", "jsx", "mjs", "cjs"]) {
      expect(extToLanguage(`a.${ext}`)).toBe("javascript");
    }
  });

  it("maps Rust and Python", () => {
    expect(extToLanguage("src/main.rs")).toBe("rust");
    expect(extToLanguage("app.py")).toBe("python");
    expect(extToLanguage("stubs/foo.pyi")).toBe("python");
  });

  it("is case-insensitive on the extension", () => {
    expect(extToLanguage("Component.TSX")).toBe("typescript");
    expect(extToLanguage("MAIN.RS")).toBe("rust");
  });

  it("returns null for unsupported or extension-less paths", () => {
    expect(extToLanguage("main.go")).toBeNull();
    expect(extToLanguage("notes.txt")).toBeNull();
    expect(extToLanguage("Makefile")).toBeNull();
    expect(extToLanguage("")).toBeNull();
  });

  it("uses the last extension and a full Windows path", () => {
    expect(extToLanguage("C:\\proj\\src\\a.d.ts")).toBe("typescript");
  });
});

describe("isLspSupported", () => {
  it("mirrors extToLanguage", () => {
    expect(isLspSupported("a.ts")).toBe(true);
    expect(isLspSupported("a.rs")).toBe(true);
    expect(isLspSupported("a.go")).toBe(false);
    expect(isLspSupported("README")).toBe(false);
  });
});

describe("pathToUri", () => {
  it("converts a Windows path to a three-slash file URI with forward slashes", () => {
    expect(pathToUri("C:\\Users\\me\\proj\\src\\main.rs")).toBe(
      "file:///C:/Users/me/proj/src/main.rs",
    );
  });

  it("preserves the drive colon but percent-encodes spaces", () => {
    expect(pathToUri("C:\\my docs\\a.ts")).toBe("file:///C:/my%20docs/a.ts");
  });

  it("handles POSIX absolute paths (leading slash → three slashes)", () => {
    expect(pathToUri("/home/me/a.py")).toBe("file:///home/me/a.py");
  });

  it("encodes reserved characters in segments", () => {
    expect(pathToUri("/tmp/a#b.ts")).toBe("file:///tmp/a%23b.ts");
  });
});

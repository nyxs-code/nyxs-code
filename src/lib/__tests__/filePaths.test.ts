import { describe, it, expect } from "vitest";
import { parsePathRef } from "@/lib/filePaths";

const WS = "D:\\proj";

describe("parsePathRef", () => {
  it("reads relative and absolute paths, with a line", () => {
    expect(parsePathRef("src/lib/theme.ts:183", WS)).toEqual({
      raw: "src/lib/theme.ts",
      abs: "D:\\proj\\src\\lib\\theme.ts",
      rel: "src/lib/theme.ts",
      name: "theme.ts",
      line: 183,
    });
    expect(parsePathRef("Cargo.toml", WS)?.abs).toBe("D:\\proj\\Cargo.toml");
    expect(parsePathRef("./src/App.tsx:10:4", WS)?.line).toBe(10);
    expect(parsePathRef("D:\\other\\notes.md", WS)).toMatchObject({ abs: "D:\\other\\notes.md", rel: "D:/other/notes.md" });
    expect(parsePathRef("src-tauri/src", WS)?.name).toBe("src");
  });

  it("works with a Unix project folder", () => {
    expect(parsePathRef("src/a.ts", "/home/me/proj")).toMatchObject({ abs: "/home/me/proj/src/a.ts", rel: "src/a.ts" });
  });

  it("leaves code that isn't a path alone", () => {
    for (const code of ["e.key", "foo.bar()", "npm run dev", "https://github.com/a/b", "useState", "a < b", "x.y.z()", "--port"]) {
      expect(parsePathRef(code, WS), code).toBeNull();
    }
  });

  it("needs a project folder for a relative path", () => {
    expect(parsePathRef("src/a.ts", null)).toBeNull();
    expect(parsePathRef("C:\\x\\a.ts", null)?.abs).toBe("C:\\x\\a.ts");
  });
});

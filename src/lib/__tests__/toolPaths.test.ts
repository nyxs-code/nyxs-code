import { describe, it, expect } from "vitest";
import { isInside, joinPath, normalizePath, normalizeRoots, resolvePath } from "@/tools/paths";

describe("resolvePath on a macOS or Linux project", () => {
  const WS = "/Users/me/proj";

  it("keeps the root and forward slashes", () => {
    expect(resolvePath("src/a.ts", WS)).toBe("/Users/me/proj/src/a.ts");
    expect(resolvePath("./src/../lib/b.ts", `${WS}/`)).toBe("/Users/me/proj/lib/b.ts");
    expect(resolvePath("/Users/me/proj/README.md", WS)).toBe("/Users/me/proj/README.md");
    expect(resolvePath(".", WS)).toBe("/Users/me/proj");
  });

  it("refuses what is outside, case and all, since POSIX names are case-sensitive", () => {
    expect(() => resolvePath("../other/x", WS)).toThrow(/fuera/);
    expect(() => resolvePath("/etc/passwd", WS)).toThrow(/fuera/);
    expect(() => resolvePath("/Users/me/PROJ/a.ts", WS)).toThrow(/fuera/);
    expect(() => resolvePath("/Users/me/proj-evil/a.ts", WS)).toThrow(/fuera/);
  });

  it("allows the extra roots in POSIX form", () => {
    const roots = normalizeRoots(["/Users/me/.nyxs/skills/"]);
    expect(roots).toEqual(["/Users/me/.nyxs/skills"]);
    expect(resolvePath("/Users/me/.nyxs/skills/x/SKILL.md", WS, roots)).toBe("/Users/me/.nyxs/skills/x/SKILL.md");
  });
});

describe("resolvePath on Windows, UNC and remote projects", () => {
  it("still works with drive letters, case-insensitively", () => {
    expect(resolvePath("src/a.ts", "E:\\ws")).toBe("E:\\ws\\src\\a.ts");
    expect(resolvePath("e:/WS/src/a.ts", "E:\\ws")).toBe("e:\\WS\\src\\a.ts");
    expect(() => resolvePath("C:\\Windows\\win.ini", "E:\\ws")).toThrow(/fuera/);
    expect(() => resolvePath("/etc/passwd", "E:\\ws")).toThrow(/fuera/);
  });

  it("treats //server/share as a UNC path, not a POSIX one", () => {
    expect(normalizePath("//server/share/a/../b")).toBe("\\\\server\\share\\b");
    expect(resolvePath("src/a.ts", "\\\\server\\share\\ws")).toBe("\\\\server\\share\\ws\\src\\a.ts");
  });

  it("leaves ssh:// projects to the remote resolver", () => {
    expect(resolvePath("src/a.ts", "ssh://box/home/me/app")).toBe("ssh://box/home/me/app/src/a.ts");
  });
});

describe("joinPath", () => {
  it("joins with the separator the base already uses", () => {
    expect(joinPath("/Users/me/app/", "package.json")).toBe("/Users/me/app/package.json");
    expect(joinPath("E:\\ws\\", "/package.json")).toBe("E:\\ws\\package.json");
    expect(joinPath("C:/ws", "package.json")).toBe("C:/ws/package.json");
    expect(joinPath("ssh://box/home/me/app", "package.json")).toBe("ssh://box/home/me/app/package.json");
  });
});

describe("isInside", () => {
  it("matches by path segment in both styles", () => {
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/bc", "/a/b")).toBe(false);
    expect(isInside("/A/b", "/a")).toBe(false);
    expect(isInside("E:\\WS\\x", "e:\\ws")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { parsePorcelainZ } from "@/lib/archiveGuard";

describe("parsePorcelainZ", () => {
  it("reads modified, added, untracked and renamed files", () => {
    const out = " M src/a.ts\0A  src/new.ts\0?? notes.md\0R  src/b2.ts\0src/b.ts\0";
    expect(parsePorcelainZ(out)).toEqual(["src/a.ts", "src/new.ts", "notes.md", "src/b2.ts"]);
  });

  it("keeps names with spaces and returns nothing for a clean tree", () => {
    expect(parsePorcelainZ(" M docs/my notes.md\0")).toEqual(["docs/my notes.md"]);
    expect(parsePorcelainZ("")).toEqual([]);
  });
});

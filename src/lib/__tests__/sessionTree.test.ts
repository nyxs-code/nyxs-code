import { describe, expect, it } from "vitest";
import { deleteTargetOf, descendantsOf, nestSessions } from "@/lib/sessionTree";

const s = (id: string, parentId?: string) => ({ id, parentId });
const rows = (items: ReturnType<typeof s>[], folded?: Set<string>) =>
  nestSessions(items, folded).map((r) => `${"  ".repeat(r.depth)}${r.item.id}${r.descendants ? ` (${r.descendants})` : ""}${r.depth && r.last ? " └" : ""}`);

describe("nestSessions", () => {
  it("lists each session right under the one that created it", () => {
    expect(rows([s("b", "a"), s("x"), s("a"), s("c", "a")])).toEqual(["x", "a (2)", "  b", "  c └"]);
  });

  it("nests deeper levels and counts every session below", () => {
    expect(rows([s("a"), s("b", "a"), s("c", "b")])).toEqual(["a (2)", "  b (1) └", "    c └"]);
  });

  it("keeps a session whose parent isn't listed at the top level", () => {
    expect(rows([s("b", "gone"), s("a")])).toEqual(["b", "a"]);
  });

  it("hides the sessions under a folded parent", () => {
    expect(rows([s("a"), s("b", "a"), s("c")], new Set(["a"]))).toEqual(["a (1)", "c"]);
  });

  it("survives a loop of parents", () => {
    expect(rows([s("a", "b"), s("b", "a")]).length).toBe(2);
  });
});

describe("descendantsOf", () => {
  it("finds every session below, at any depth", () => {
    const all = [s("a"), s("b", "a"), s("c", "b"), s("d")];
    expect(descendantsOf("a", all).map((x) => x.id)).toEqual(["b", "c"]);
    expect(descendantsOf("d", all)).toEqual([]);
  });
});

describe("deleteTargetOf", () => {
  const saved = [
    { id: "parent", title: "Parent" },
    { id: "kid", title: "Archived kid", parentId: "parent" },
    { id: "grandkid", title: "Archived grandkid", parentId: "kid" },
  ];

  it("treats an archived (nested) session as a saved session, not as an unsaved chat", () => {
    expect(deleteTargetOf("kid", saved, [])).toEqual({ id: "kid", title: "Archived kid", isSession: true, nested: 1 });
  });

  it("counts nested sessions across active and archived ones", () => {
    expect(deleteTargetOf("parent", saved, []).nested).toBe(2);
  });

  it("falls back to an unsaved chat", () => {
    expect(deleteTargetOf("draft", saved, [{ id: "draft", title: "Draft" }])).toEqual({ id: "draft", title: "Draft", isSession: false, nested: 0 });
  });
});

import { describe, expect, it } from "vitest";
import { sessionHandoff, sessionMarkdown } from "@/lib/sessionExport";

const labels = { user: "User", assistant: "Assistant", handoffIntro: "Pick this up.", handoffProject: "Project: {path}" };

describe("copying a session out", () => {
  it("leaves the app's tool markers, reasoning and notices behind", () => {
    const md = sessionMarkdown("Fix login", [
      { role: "user", content: "the login fails" },
      { role: "assistant", content: "⟦REASONING⟧thinking⟦/REASONING⟧Looking.⟦TOOL⟧{\"x\":1}⟦/TOOL⟧\n\n\n\nFixed it.⟦TODO⟧" },
      { role: "assistant", content: "Compacted", notice: { kind: "compact" } },
      { role: "assistant", content: "⟦TOOL⟧only a tool⟦/TOOL⟧" },
    ], labels);
    expect(md).toBe("# Fix login\n\n## User\n\nthe login fails\n\n## Assistant\n\nLooking.\n\nFixed it.\n");
  });

  it("hands another model what to do, where, and what was said, newest part kept when long", () => {
    const long = "x".repeat(70_000);
    const text = sessionHandoff("Fix login", "/proj", [{ role: "user", content: "old start" }, { role: "assistant", content: long }], labels);
    expect(text.startsWith("Pick this up.\n# Fix login\nProject: /proj\n\n…")).toBe(true);
    expect(text).not.toContain("old start");
    expect(text.endsWith(`${"x".repeat(100)}\n`)).toBe(true);
  });
});

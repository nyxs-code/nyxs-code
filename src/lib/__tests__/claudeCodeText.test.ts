import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import type { ChatTurn } from "@/lib/ai";
import {
  editedPath,
  isAuthFailure,
  plainText,
  priorContext,
  resultText,
  sessionIdOf,
  shortError,
  userContent,
} from "@/lib/claudeCodeText";

const withSession = (sessionId: string): ModelMessage =>
  ({ role: "assistant", content: "", providerOptions: { claudeCode: { sessionId } } }) as ModelMessage;

describe("sessionIdOf", () => {
  it("reads the Claude Code session saved on a reply", () => {
    const turn: ChatTurn = { role: "assistant", content: "", messages: [{ role: "assistant", content: "x" }, withSession("s-1")] };
    expect(sessionIdOf(turn)).toBe("s-1");
  });

  it("is undefined for a reply from another provider", () => {
    expect(sessionIdOf({ role: "assistant", content: "hi", messages: [{ role: "assistant", content: "hi" }] })).toBeUndefined();
  });
});

describe("plainText", () => {
  it("drops the tool, reasoning and todo markers and squeezes blank lines", () => {
    const content = "Antes⟦TOOL⟧{\"id\":1}⟦/TOOL⟧\n\n\n\nDespués⟦REASONING⟧pienso⟦/REASONING⟧⟦TODO⟧";
    expect(plainText(content)).toBe("Antes\n\nDespués");
  });
});

describe("priorContext", () => {
  it("wraps earlier turns as a labelled transcript", () => {
    const text = priorContext([
      { role: "user", content: "hola" },
      { role: "assistant", content: "⟦TOOL⟧x⟦/TOOL⟧" },
      { role: "assistant", content: "adiós" },
    ]);
    expect(text).toBe("<earlier_conversation>\nUser: hola\n\nAssistant: adiós\n</earlier_conversation>\n\n");
  });

  it("is empty when nothing is left to carry over", () => {
    expect(priorContext([{ role: "assistant", content: "⟦PLAN⟧" }])).toBe("");
  });

  it("keeps only the latest part of a long conversation", () => {
    const text = priorContext([{ role: "user", content: "a".repeat(70_000) + "FIN" }]);
    expect(text.length).toBeLessThan(61_000);
    expect(text).toContain("…");
    expect(text).toContain("FIN");
  });
});

describe("userContent", () => {
  it("sends the preamble and text, then each image as base64", () => {
    const blocks = userContent(
      { role: "user", content: "mira esto", images: [{ dataUrl: "data:image/png;base64,QUJD", name: "a.png" } as never] },
      "<ctx>\n",
    );
    expect(blocks[0]).toMatchObject({ type: "text" });
    expect(String(blocks[0].text)).toContain("<ctx>\nmira esto");
    expect(blocks[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
  });

  it("never sends an empty message", () => {
    expect(userContent({ role: "user", content: "" }, "")).toEqual([{ type: "text", text: "(empty message)" }]);
  });
});

describe("resultText", () => {
  it("joins the text parts of a tool result", () => {
    expect(resultText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(resultText("plain")).toBe("plain");
    expect(resultText(42)).toBe("");
  });
});

describe("shortError", () => {
  it("keeps the first lines without the error tags", () => {
    expect(shortError("<tool_use_error>uno\ndos\ntres\ncuatro</tool_use_error>")).toBe("uno dos tres");
  });

  it("cuts a very long message", () => {
    expect(shortError("x".repeat(400))).toHaveLength(301);
  });
});

describe("editedPath", () => {
  it("is the file an edit tool touches, and null for others", () => {
    expect(editedPath("Edit", { file_path: "C:/p/a.ts" })).toBe("C:/p/a.ts");
    expect(editedPath("NotebookEdit", { notebook_path: "C:/p/n.ipynb" })).toBe("C:/p/n.ipynb");
    expect(editedPath("Read", { file_path: "C:/p/a.ts" })).toBeNull();
  });
});

describe("isAuthFailure", () => {
  it("spots a signed-out CLI by its error code or its message", () => {
    expect(isAuthFailure("", "authentication_failed")).toBe(true);
    expect(isAuthFailure("Not logged in · Please run /login", null)).toBe(true);
    expect(isAuthFailure("Rate limit reached", null)).toBe(false);
  });
});

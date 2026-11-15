import { describe, it, expect } from "vitest";
import { parseMessage } from "@/components/message/parse";

describe("parseMessage code blocks", () => {
  it("marks a finished preview block as closed", () => {
    const { segments } = parseMessage("Idea A:\n```preview\n<div>A</div>\n```\nDone.");
    expect(segments[1]).toEqual({ type: "code", lang: "preview", content: "<div>A</div>", closed: true });
  });

  it("keeps a block still being written open, so it isn't drawn half done", () => {
    const { segments } = parseMessage("Idea A:\n```preview\n<div>A");
    expect(segments[1]).toEqual({ type: "code", lang: "preview", content: "<div>A", closed: false });
  });

  it("doesn't split a four-backtick fence that shows a three-backtick one", () => {
    const { segments } = parseMessage("Ejemplo:\n````markdown\nUsa:\n```ts\nconst a = 1;\n```\n````\nFin.");
    expect(segments.map((s) => s.type)).toEqual(["text", "code", "text"]);
    expect(segments[1]).toMatchObject({ lang: "markdown", content: "Usa:\n```ts\nconst a = 1;\n```", closed: true });
  });
});

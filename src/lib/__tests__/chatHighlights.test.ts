import { describe, it, expect } from "vitest";
import { locate, overlapping, turnHighlightColors, type TextHighlight } from "@/lib/chatHighlights";

const hl = (quote: string, prefix: string, suffix: string, extra: Partial<TextHighlight> = {}): TextHighlight => ({
  id: quote,
  color: "yellow",
  quote,
  prefix,
  suffix,
  createdAt: 1,
  ...extra,
});

describe("locate", () => {
  const text = "Paso uno: instala. Paso dos: configura. Paso tres: instala de nuevo.";

  it("picks the occurrence whose surroundings match", () => {
    expect(locate(text, hl("instala", "Paso uno: ", ". Paso dos"))).toEqual({ start: 10, end: 17 });
    const second = locate(text, hl("instala", "Paso tres: ", " de nuevo"));
    expect(second && text.slice(second.start - 11, second.start)).toBe("Paso tres: ");
  });

  it("still finds the quote after the text around it changed, and gives up when it is gone", () => {
    expect(locate("Nuevo encabezado. Paso dos: configura.", hl("configura", "Paso dos: ", "."))).toEqual({ start: 28, end: 37 });
    expect(locate(text, hl("borrado", "", ""))).toBeNull();
  });
});

describe("overlapping", () => {
  it("returns the highlights that share any character with the range", () => {
    const text = "uno dos tres cuatro";
    const list = [hl("dos", "uno ", " tres"), hl("cuatro", "tres ", "")];
    expect(overlapping(text, list, 5, 10).map((h) => h.quote)).toEqual(["dos"]);
    expect(overlapping(text, list, 8, 12)).toEqual([]);
  });
});

describe("turnHighlightColors", () => {
  it("colors each turn by its latest highlight, in your message or the replies after it", () => {
    const isTurn = (m: { role: string }) => m.role === "user";
    const messages = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant", highlights: [hl("x", "", "", { color: "green", createdAt: 5 }), hl("y", "", "", { color: "pink", createdAt: 9 })] },
      { id: "u2", role: "user" },
      { id: "a2", role: "assistant" },
      { id: "u3", role: "user", highlights: [hl("z", "", "", { color: "blue", createdAt: 2 })] },
    ];
    expect(turnHighlightColors(messages, isTurn)).toEqual({ u1: "pink", u3: "blue" });
  });
});

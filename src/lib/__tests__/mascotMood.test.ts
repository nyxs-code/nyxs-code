import { describe, expect, it } from "vitest";
import { moodOfMessage, moodOfTool } from "@/lib/mascotMood";

describe("moodOfMessage", () => {
  it("celebrates thanks and praise", () => {
    expect(moodOfMessage("¡Gracias, quedó genial!")).toBe("celebrate");
    expect(moodOfMessage("perfect, thanks")).toBe("celebrate");
    expect(moodOfMessage("ya funciona 🎉")).toBe("celebrate");
  });

  it("is sad at frustration before reading praise words in it", () => {
    expect(moodOfMessage("no funciona")).toBe("sad");
    expect(moodOfMessage("sigue fallando el build")).toBe("sad");
    expect(moodOfMessage("why??")).toBe("sad");
  });

  it("covers its eyes at an apology", () => {
    expect(moodOfMessage("perdón, me equivoqué de archivo")).toBe("shy");
  });

  it("has no reaction to a plain request", () => {
    expect(moodOfMessage("añade un botón de exportar")).toBeNull();
  });
});

describe("moodOfTool", () => {
  it("searches while reading and codes while writing or running", () => {
    expect(moodOfTool("Grep")).toBe("search");
    expect(moodOfTool("WebFetch")).toBe("search");
    expect(moodOfTool("Edit")).toBe("code");
    expect(moodOfTool("Bash")).toBe("code");
    expect(moodOfTool("TodoWrite")).toBeNull();
    expect(moodOfTool(undefined)).toBeNull();
  });
});

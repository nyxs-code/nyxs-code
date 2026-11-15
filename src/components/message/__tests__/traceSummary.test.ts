import { describe, expect, it } from "vitest";
import { getTranslations } from "@/lib/i18n";
import { traceSummary } from "../traceSummary";

type Tools = Parameters<typeof traceSummary>[0];

const tools = (...names: string[]) => names.map((name, i) => ({ kind: "tool", id: `t${i}`, name, detail: "" })) as unknown as Tools;
const summary = (lang: string, ...names: string[]) =>
  traceSummary(tools(...names), {}, new Map(), getTranslations(lang).message)
    .phrases.map((p) => p.map((part) => part.text).join(""))
    .join(", ");

describe("traceSummary", () => {
  it("counts read pages apart from searches", () => {
    expect(summary("en-US", "WebFetch")).toBe("Read a page");
    expect(summary("en-US", "WebSearch", "WebSearch", "WebFetch", "WebFetch", "WebFetch")).toBe("Searched 2 times, read 3 pages");
    expect(summary("es-ES", "Read", "WebSearch", "WebFetch")).toBe("Leyó un archivo, hizo una búsqueda, leyó una página");
    expect(summary("de-DE", "WebFetch", "WebFetch")).toBe("Hat 2 Seiten gelesen");
  });
});

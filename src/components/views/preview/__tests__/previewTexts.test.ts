import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTranslations } from "@/lib/i18n";

const source = (file: string) => readFileSync(join(__dirname, "..", file), "utf8");

describe("the preview's own texts", () => {
  it("come from the locales, not fixed in one language", () => {
    expect(source("PreviewPage.tsx")).not.toContain("No se pudo abrir el sitio");
    expect(source("useDevServers.ts")).not.toContain("Servidor de desarrollo (vista previa)");
    const en = getTranslations("en-US").previewTexts;
    const es = getTranslations("es-ES").previewTexts;
    expect(es.openFailed).toBe("No se pudo abrir el sitio en la vista previa.");
    expect(en.openFailed).not.toBe(es.openFailed);
    expect(en.devServerName).not.toBe(es.devServerName);
  });
});

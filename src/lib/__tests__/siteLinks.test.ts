import { describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/siteLinks";

describe("siteUrl", () => {
  it("keeps English pages at the site root", () => {
    expect(siteUrl("docs", "en-US")).toBe("https://nyxs.dev/docs/");
  });

  it("uses the translated copy for the app's language", () => {
    expect(siteUrl("quickstart", "es-ES")).toBe("https://nyxs.dev/es/docs/quickstart/");
    expect(siteUrl("terms", "pt-BR")).toBe("https://nyxs.dev/pt/legal/terms/");
  });

  it("falls back to English for a language the site lacks", () => {
    expect(siteUrl("blog", "nl-NL")).toBe("https://nyxs.dev/blog/");
  });
});

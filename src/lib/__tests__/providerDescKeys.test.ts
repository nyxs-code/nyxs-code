import { describe, it, expect } from "vitest";
import type { Translations } from "@/locales/types";
import { getTranslations, LANGUAGES } from "@/lib/i18n";

type ProviderDesc = Translations["settings"]["providerDesc"];

describe("provider descriptions", () => {
  it("have no entry for the retired Nyxs 2.0", () => {
    // @ts-expect-error Nyxs 2.0 is no longer a provider, so it has no description to translate.
    const retired: ProviderDesc = { nyxs2: "Nyxs 2.0" };
    expect(retired).toBeDefined();
    for (const { code } of LANGUAGES) {
      expect(Object.keys(getTranslations(code).settings.providerDesc ?? {}), code).not.toContain("nyxs2");
    }
  });
});

import { describe, expect, it } from "vitest";
import { getTranslations, LANGUAGES } from "@/lib/i18n";

describe("texts no screen shows", () => {
  it("are gone with the component that showed them (RecoveryCard's)", () => {
    for (const { code } of LANGUAGES) {
      expect(Object.keys(getTranslations(code)), code).not.toContain("recovery");
    }
  });
});

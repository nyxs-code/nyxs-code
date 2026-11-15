import { afterEach, describe, expect, it, vi } from "vitest";
import { requireSafe } from "../sourceSafety";
import { LocalizedError } from "@/lib/localizedError";
import { getTranslations, LANG_KEY, localizedError } from "@/lib/i18n";

const inSpanish = () =>
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k === LANG_KEY ? "es-ES" : null) });

afterEach(() => vi.unstubAllGlobals());

describe("plugin errors", () => {
  it("keep their English message for the agent and the logs", () => {
    expect(() => requireSafe(false, "gitRef", "$(calc)")).toThrow('Refusing unsafe git ref: "$(calc)".');
    expect(() => requireSafe(false, "pluginPath", "../x", "escape")).toThrow(
      'Refusing unsafe path for plugin "escape": "../x".',
    );
  });

  it("are shown in the app's language", () => {
    inSpanish();
    let caught: unknown;
    try {
      requireSafe(false, "gitRef", "$(calc)");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LocalizedError);
    const es = getTranslations("es-ES").pluginErrors;
    expect(es.unsafeGitRef).not.toBe(getTranslations("en-US").pluginErrors.unsafeGitRef);
    expect(localizedError(caught)).toBe(es.unsafeGitRef.replace("{value}", '"$(calc)"'));
    const wrong = new LocalizedError("wrongCommit", { url: "u", head: "aaa", sha: "bbb" }, "u is at commit aaa, not the reviewed commit bbb.");
    expect(localizedError(wrong)).toBe(es.wrongCommit.replace("{url}", "u").replace("{head}", "aaa").replace("{sha}", "bbb"));
  });

  it("other errors keep their own text", () => {
    inSpanish();
    expect(localizedError(new Error("the folder is in use"))).toBe("the folder is in use");
  });
});

import { describe, expect, it } from "vitest";
import { listboxMove } from "@/lib/listboxKeys";
import { withReadModels } from "@/lib/refreshModels";
import type { Settings } from "@/lib/settings";
import type { ModelInfo } from "@/lib/models";

describe("listboxMove", () => {
  const ids = ["openai", "nvidia", "anthropic", "azure"] as const;
  const names: Record<string, string> = { openai: "OpenAI", nvidia: "NVIDIA", anthropic: "Anthropic", azure: "Ázure" };
  const move = (current: (typeof ids)[number] | null, key: string) => listboxMove(ids, current, key, (id) => names[id]);

  it("steps with the arrows without wrapping", () => {
    expect(move("openai", "ArrowDown")).toBe("nvidia");
    expect(move("azure", "ArrowDown")).toBe("azure");
    expect(move("nvidia", "ArrowUp")).toBe("openai");
    expect(move("openai", "ArrowUp")).toBe("openai");
    // Nothing selected among the shown ones: ↓ goes to the first.
    expect(move(null, "ArrowDown")).toBe("openai");
  });

  it("jumps to the ends with Home and End", () => {
    expect(move("nvidia", "Home")).toBe("openai");
    expect(move("nvidia", "End")).toBe("azure");
  });

  it("jumps by first letter from the next item, wrapping, ignoring case and accents", () => {
    expect(move("openai", "a")).toBe("anthropic");
    expect(move("anthropic", "a")).toBe("azure");
    expect(move("azure", "A")).toBe("anthropic");
    expect(move("nvidia", "o")).toBe("openai");
    expect(move("openai", "x")).toBeNull();
  });

  it("leaves other keys alone", () => {
    expect(move("openai", "Enter")).toBeNull();
    expect(move("openai", " ")).toBeNull();
    expect(move("openai", "Tab")).toBeNull();
    expect(listboxMove([], null, "ArrowDown", String)).toBeNull();
  });
});

describe("withReadModels", () => {
  const model = (id: string): ModelInfo => ({ id, name: id, apiModel: id, provider: "openai" }) as ModelInfo;
  const settings = (models: ModelInfo[], enabled: string[]) => ({ openai: { apiKey: "sk", models, enabled } }) as unknown as Settings;

  it("takes the new list and stops enabling models that are gone", () => {
    const next = withReadModels(settings([model("a"), model("b")], ["a", "b"]), "openai", [model("b"), model("c")]);
    expect(next.openai.models?.map((m) => m.id)).toEqual(["b", "c"]);
    expect(next.openai.enabled).toEqual(["b"]);
  });

  it("keeps the list it had when the answer is empty", () => {
    const prev = settings([model("a")], ["a"]);
    expect(withReadModels(prev, "openai", [])).toBe(prev);
  });

  it("takes an empty answer when there was no list", () => {
    const next = withReadModels(settings([], []), "openai", []);
    expect(next.openai.models).toEqual([]);
  });
});

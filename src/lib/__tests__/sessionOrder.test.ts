import { describe, it, expect } from "vitest";
import { adjacentSession, setSessionOrder } from "@/lib/sessionOrder";

describe("adjacentSession", () => {
  it("walks Recents in order and wraps around", () => {
    setSessionOrder(["a", "b", "c"]);
    expect(adjacentSession("a", 1, [])).toBe("b");
    expect(adjacentSession("c", 1, [])).toBe("a");
    expect(adjacentSession("a", -1, [])).toBe("c");
  });

  it("starts at an end when no session in the list is open", () => {
    setSessionOrder(["a", "b", "c"]);
    expect(adjacentSession(null, 1, [])).toBe("a");
    expect(adjacentSession("zzz", -1, [])).toBe("c");
  });

  it("uses the app's order until the sidebar has given one, and stays put with one session", () => {
    setSessionOrder([]);
    expect(adjacentSession("x", 1, ["x", "y"])).toBe("y");
    expect(adjacentSession("x", 1, ["x"])).toBeNull();
    expect(adjacentSession(null, 1, [])).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { classifySession } from "@/lib/sessionState";

describe("classifySession", () => {
  it("marks a streaming session that waits for the user as blocked", () => {
    expect(classifySession({ blocked: true, streaming: true, modifiedAt: 0, messageCount: 3, now: 1 })).toBe("blocked");
    expect(classifySession({ blocked: false, streaming: true, modifiedAt: 0, messageCount: 3, now: 1 })).toBeNull();
  });
});

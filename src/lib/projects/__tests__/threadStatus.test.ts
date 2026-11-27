import { describe, expect, it } from "vitest";
import { AUTO_RESOLVE_MS, projectDot, threadGroup } from "../threadStatus";

const now = 1_000_000_000_000;
const at = (status: Parameters<typeof threadGroup>[0]["status"], extra: Partial<Parameters<typeof threadGroup>[0]> = {}) =>
  threadGroup({ status, streaming: false, blocked: false, updatedAt: now - 1000, ...extra }, now);

describe("threadGroup", () => {
  it("puts what waits on the user first, even while it runs", () => {
    expect(at("working", { streaming: true, blocked: true })).toBe("waiting");
    expect(at("needs_input")).toBe("waiting");
    // A new message to it is being answered: no longer waiting.
    expect(at("needs_input", { streaming: true })).toBe("working");
  });

  it("shows a running turn as working whatever was stored", () => {
    expect(at("review", { streaming: true })).toBe("working");
    expect(at("resolved", { streaming: true })).toBe("working");
  });

  it("takes a stored working with no turn as about to start, then as cut off", () => {
    expect(at("working")).toBe("working");
    expect(at("working", { updatedAt: now - 10 * 60_000 })).toBe("review");
  });

  it("resolves a review nobody looked at after a week", () => {
    expect(at("review")).toBe("review");
    expect(at(undefined)).toBe("review");
    expect(at("review", { updatedAt: now - AUTO_RESOLVE_MS - 1 })).toBe("resolved");
    expect(at("idle")).toBe("resolved");
    expect(at("resolved")).toBe("resolved");
    expect(at("failed")).toBe("failed");
  });
});

describe("projectDot", () => {
  it("is amber when something waits, blue when something works", () => {
    expect(projectDot(["review", "working", "waiting"], { streaming: false, blocked: false })).toBe("waiting");
    expect(projectDot(["review", "working"], { streaming: false, blocked: false })).toBe("working");
    expect(projectDot(["review"], { streaming: true, blocked: false })).toBe("working");
    expect(projectDot(["review"], { streaming: true, blocked: true })).toBe("waiting");
    expect(projectDot(["review", "resolved"], { streaming: false, blocked: false })).toBeNull();
  });
});

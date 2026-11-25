import { beforeEach, describe, expect, it } from "vitest";
import {
  noteMessageSent,
  refuseMessage,
  refusalText,
  resetMessageGuardForTests,
  sessionTookMessages,
  userSpokeIn,
} from "@/lib/sessionMessageGuard";

beforeEach(resetMessageGuardForTests);

describe("messages between sessions", () => {
  it("stop when two sessions keep answering each other", () => {
    for (let i = 0; i < 4; i++) {
      noteMessageSent("a", "b", false, i * 1000);
      noteMessageSent("b", "a", false, i * 1000 + 500);
    }
    expect(refuseMessage("a", "b", 9000)).toBe("loop");
    expect(refusalText("loop", "b")).toContain("in a loop");
    // Long after, it's a new conversation.
    expect(refuseMessage("a", "b", 10 * 60_000)).toBeNull();
  });

  it("aren't a loop when only one side talks, or once the user writes", () => {
    for (let i = 0; i < 8; i++) noteMessageSent("lead", "worker" + (i % 2), false, i * 8000);
    expect(refuseMessage("lead", "worker0", 70_000)).toBeNull();

    for (let i = 0; i < 4; i++) {
      noteMessageSent("a", "b", false, i);
      noteMessageSent("b", "a", false, i);
    }
    userSpokeIn("a");
    expect(refuseMessage("a", "b", 100)).toBeNull();
  });

  it("are limited in a short time from one session", () => {
    for (let i = 0; i < 10; i++) noteMessageSent("a", `s${i}`, false, i * 100);
    expect(refuseMessage("a", "s99", 2000)).toBe("rate");
    expect(refuseMessage("a", "s99", 2000 + 61_000)).toBeNull();
  });

  it("wait while a session has too many queued, until its turn takes them", () => {
    for (let i = 0; i < 5; i++) noteMessageSent(`from${i}`, "busy", true, i);
    expect(refuseMessage("other", "busy", 10)).toBe("backlog");
    sessionTookMessages("busy");
    expect(refuseMessage("other", "busy", 10)).toBeNull();
  });
});

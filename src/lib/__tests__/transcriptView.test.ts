// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cycleTranscriptView, getTranscriptView } from "@/lib/transcriptView";

describe("transcript view", () => {
  it("starts normal and cycles normal → thinking → verbose → normal, remembering the choice", () => {
    expect(getTranscriptView()).toBe("normal");
    expect(cycleTranscriptView()).toBe("thinking");
    expect(cycleTranscriptView()).toBe("verbose");
    expect(Object.values(localStorage).includes("verbose")).toBe(true);
    expect(cycleTranscriptView()).toBe("normal");
  });
});

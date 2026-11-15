import { describe, expect, it } from "vitest";
import { splitAnswer } from "@/lib/questionAnswers";

describe("splitAnswer", () => {
  const labels = ["Yes, continue", "No", "Yes"];

  it("keeps an option whose label has a comma as one", () => {
    expect(splitAnswer("Yes, continue", labels)).toEqual({ picked: ["Yes, continue"], text: "" });
  });

  it("splits several picked options and the text typed after them", () => {
    expect(splitAnswer("No, Yes, continue, in staging, please", labels)).toEqual({ picked: ["No", "Yes, continue"], text: "in staging, please" });
  });

  it("reads an answer that matches no option as typed text", () => {
    expect(splitAnswer("Maybe, later", labels)).toEqual({ picked: [], text: "Maybe, later" });
    expect(splitAnswer("", labels)).toEqual({ picked: [], text: "" });
  });
});

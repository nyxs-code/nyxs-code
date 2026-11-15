import { describe, it, expect } from "vitest";
import { previewToolOutput } from "@/lib/agentTools";

describe("previewToolOutput", () => {
  it("keeps short output intact", () => {
    expect(previewToolOutput("line 1\nline 2\n\n")).toEqual({ output: "line 1\nline 2", outputTruncated: false });
  });

  it("keeps the head and tail of long output and marks the gap", () => {
    const text = Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n");
    const { output, outputTruncated } = previewToolOutput(text);
    const lines = output.split("\n");
    expect(outputTruncated).toBe(true);
    expect(lines[0]).toBe("row 0");
    expect(lines[29]).toBe("row 29");
    expect(lines[30]).toBe("… 140 …");
    expect(lines[lines.length - 1]).toBe("row 199");
  });

  it("caps very wide output by characters", () => {
    const { output, outputTruncated } = previewToolOutput("x".repeat(20000));
    expect(outputTruncated).toBe(true);
    expect(output.length).toBeLessThanOrEqual(6003);
  });

  it("handles CRLF output", () => {
    expect(previewToolOutput("a\r\nb").output).toBe("a\nb");
  });
});

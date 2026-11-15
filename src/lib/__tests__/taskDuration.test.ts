import { describe, it, expect } from "vitest";
import { formatTaskDuration } from "@/components/views/bgShells";

describe("formatTaskDuration", () => {
  it("formats seconds, minutes and hours like the tasks panel", () => {
    expect(formatTaskDuration(0)).toBe("0s");
    expect(formatTaskDuration(8_400)).toBe("8s");
    expect(formatTaskDuration(248_000)).toBe("4min 08s");
    expect(formatTaskDuration(3_900_000)).toBe("1h 05min");
    expect(formatTaskDuration(-5)).toBe("0s");
  });
});

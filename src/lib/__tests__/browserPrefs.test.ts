import { describe, expect, it } from "vitest";
import { cookieProfile } from "@/lib/browserPrefs";

describe("browserPrefs", () => {

  it("gives each project its own cookie profile, stable and path-safe", () => {
    expect(cookieProfile("shared", "C:\\a")).toBe("shared");
    expect(cookieProfile("private", "C:\\a")).toBe("private");
    expect(cookieProfile("project", null)).toBe("shared");
    const a = cookieProfile("project", "C:\\Work\\App");
    expect(a).toMatch(/^p-[0-9a-f]+$/);
    expect(cookieProfile("project", "c:\\work\\app")).toBe(a);
    expect(cookieProfile("project", "C:\\Work\\Other")).not.toBe(a);
  });
});

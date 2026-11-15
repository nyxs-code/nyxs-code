import { describe, it, expect } from "vitest";
import { lastSessionOf } from "@/lib/lastSession";

const s = (id: string, workspace: string | undefined, modifiedAt: number) => ({ id, workspace, modifiedAt });

describe("lastSessionOf", () => {
  it("is the latest session of the open folder, not of another project in Recents", () => {
    const sessions = [s("other", "E:/b", 300), s("old", "E:\\a", 100), s("new", "e:/a/", 200)];
    expect(lastSessionOf(sessions, "E:/a")?.id).toBe("new");
  });

  it("keeps letter case on macOS and Linux, and takes a session without a folder as the open one's", () => {
    expect(lastSessionOf([s("x", "/Users/me/App", 5)], "/Users/me/app")).toBeUndefined();
    expect(lastSessionOf([s("y", undefined, 5)], "/Users/me/app")?.id).toBe("y");
    expect(lastSessionOf([], "/Users/me/app")).toBeUndefined();
  });
});

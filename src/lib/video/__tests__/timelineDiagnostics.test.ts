import { describe, expect, it } from "vitest";
import { parseDiagnosticsBlock } from "@/lib/toolDetail";
import { emptyTimeline } from "@/lib/video/timelineSchema";
import { isVideoTimelinePath, timelineDiagnostics } from "@/lib/video/timelineDiagnostics";
import { VIDEO_SKILL } from "@/lib/video/videoSkill";

describe("isVideoTimelinePath", () => {
  it("matches only videos/<slug>/timeline.json", () => {
    expect(isVideoTimelinePath("C:\\w\\videos\\launch\\timeline.json")).toBe(true);
    expect(isVideoTimelinePath("/home/u/w/videos/launch/timeline.json")).toBe(true);
    expect(isVideoTimelinePath("/w/timeline.json")).toBe(false);
    expect(isVideoTimelinePath("/w/videos/launch/src/timeline.json")).toBe(false);
  });
});

describe("timelineDiagnostics", () => {
  it("says nothing for a valid timeline", () => {
    const t = emptyTimeline({ width: 1920, height: 1080, fps: 30, durationInFrames: 300 });
    expect(timelineDiagnostics(JSON.stringify(t), "videos/a/timeline.json")).toBeNull();
  });

  it("returns schema errors as a diagnostics block the chat can parse", () => {
    const t = emptyTimeline({ width: 1920, height: 1080, fps: 30, durationInFrames: 300 });
    (t.compositions[0] as { fps: unknown }).fps = "fast";
    const block = timelineDiagnostics(JSON.stringify(t), "videos/a/timeline.json");
    const parsed = parseDiagnosticsBlock(block ?? "");
    expect(parsed?.tool).toBe("timeline");
    expect(parsed?.body).toMatch(/error: compositions\[0\]\.fps/);
  });

  it("reports broken JSON", () => {
    expect(timelineDiagnostics("{ nope", "videos/a/timeline.json")).toMatch(/invalid JSON/);
  });
});

describe("video skill", () => {
  it("ships its body", () => {
    expect(VIDEO_SKILL.name).toBe("video");
    expect(VIDEO_SKILL.body).toContain("timeline.json");
    expect(VIDEO_SKILL.body).toContain("screenshot");
  });
});

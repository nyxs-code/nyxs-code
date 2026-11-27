import { describe, expect, it } from "vitest";
import type { CloudThread } from "@/lib/cloud/cloudApi";
import { cloudChanges } from "@/lib/cloud/cloudInbox";

const thread = (id: string, status: CloudThread["status"], updatedAt = "2026-11-26T10:00:00Z"): CloudThread => ({
  id,
  projectId: "p1",
  title: id,
  status,
  updatedAt,
});

describe("cloud inbox", () => {
  it("reports threads that finished, failed or wait for the user since last time", () => {
    const changes = cloudChanges(
      { a: "working", b: "working", c: "working", d: "review" },
      [thread("a", "review"), thread("b", "needs_input"), thread("c", "failed"), thread("d", "review")],
      "2026-11-26T09:00:00Z",
    );
    expect(changes.map((c) => [c.thread.id, c.kind])).toEqual([["a", "review"], ["b", "needs_input"], ["c", "failed"]]);
  });

  it("ignores threads still working or resolved", () => {
    expect(cloudChanges({ a: "queued" }, [thread("a", "working"), thread("b", "resolved")], null)).toEqual([]);
  });

  it("counts a thread it never saw only when it changed after the last check", () => {
    const since = "2026-11-26T09:00:00Z";
    expect(cloudChanges({}, [thread("new", "review", "2026-11-26T09:30:00Z")], since)).toHaveLength(1);
    expect(cloudChanges({}, [thread("old", "review", "2026-11-26T08:00:00Z")], since)).toHaveLength(0);
    expect(cloudChanges({}, [thread("first", "review")], null)).toHaveLength(0);
  });
});

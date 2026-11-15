import { describe, it, expect } from "vitest";
import { elapsedLabel, liveElapsedLabel, livePhaseOf, orbLookFor, reasoningSeconds, runSeconds, tokensLabel, withTurnStatus } from "@/components/message/liveFormat";
import type { Segment, ToolEnd } from "@/components/message/parse";

describe("labels", () => {
  it("formats elapsed time like the status line", () => {
    expect(elapsedLabel(3_000)).toBe("3s");
    expect(elapsedLabel(134_000)).toBe("2m 14s");
    expect(elapsedLabel(3_780_000)).toBe("1h 03m");
    expect(tokensLabel(13_040)).toBe("13.0k tokens");
    expect(tokensLabel(512)).toBe("512 tokens");
  });

  it("formats the live clock down to tenths of a second", () => {
    expect(liveElapsedLabel(0)).toBe("0.0s");
    expect(liveElapsedLabel(8_349)).toBe("8.3s");
    expect(liveElapsedLabel(59_999)).toBe("59.9s");
    expect(liveElapsedLabel(611_400)).toBe("10m 11.4s");
    expect(liveElapsedLabel(3_791_450)).toBe("1h 03m 11.4s");
    expect(liveElapsedLabel(-500)).toBe("0.0s");
  });
});

describe("livePhaseOf", () => {
  const ends = new Map<string, ToolEnd>([["t1", { status: "ok" }]]);
  const segs = (...s: Segment[]) => s;

  it("prefers waiting on the person over anything the stream says", () => {
    expect(livePhaseOf(segs({ type: "reasoning", id: "r1" }), ends, false, true, false).phase).toBe("ask");
    expect(livePhaseOf(segs({ type: "reasoning", id: "r1" }), ends, true, false, false).phase).toBe("confirm");
  });

  it("reads the phase from the last meaningful segment", () => {
    expect(livePhaseOf(segs({ type: "reasoning", id: "r1" }, { type: "text", content: "\n\n" }), ends, false, false, false)).toEqual({ phase: "thinking" });
    expect(livePhaseOf(segs({ type: "tool", id: "t2", name: "Grep", detail: "x" }), ends, false, false, false)).toEqual({ phase: "tool", tool: "Grep" });
    expect(livePhaseOf(segs({ type: "tool", id: "t1", name: "Read", detail: "a" }), ends, false, false, false).phase).toBe("working");
    expect(livePhaseOf(segs({ type: "text", content: "Hola" }), ends, false, false, false).phase).toBe("writing");
    expect(livePhaseOf(segs({ type: "text", content: "Hola" }), ends, false, false, true).phase).toBe("working");
    expect(livePhaseOf([], ends, false, false, false).phase).toBe("working");
  });

  it("maps phases to orb looks", () => {
    expect(orbLookFor({ phase: "thinking" })).toEqual({ state: "reasoning" });
    expect(orbLookFor({ phase: "tool", tool: "Grep" })).toEqual({ state: "searching" });
    expect(orbLookFor({ phase: "tool", tool: "WebSearch" })).toEqual({ state: "searching", variant: "lighthouse" });
    expect(orbLookFor({ phase: "tool", tool: "Agent" })).toEqual({ state: "reasoning", variant: "twins" });
    expect(orbLookFor({ phase: "tool", tool: "Bash" })).toEqual({ state: "working", variant: "gyro" });
    expect(orbLookFor({ phase: "tool", tool: "BashOutput" })).toEqual({ state: "background" });
    expect(orbLookFor({ phase: "tool", tool: "Edit" })).toEqual({ state: "working" });
    expect(orbLookFor({ phase: "writing" })).toEqual({ state: "base" });
    expect(orbLookFor({ phase: "confirm" })).toEqual({ state: "waiting" });
    expect(orbLookFor({ phase: "compacting" })).toEqual({ state: "compacting" });
    expect(orbLookFor({ phase: "compacting", native: true })).toEqual({ state: "compacting", variant: "squeeze" });
    expect(orbLookFor({ phase: "retrying" })).toEqual({ state: "retrying" });
    expect(orbLookFor({ phase: "retrying", rateLimited: true })).toEqual({ state: "retrying", variant: "surge" });
    expect(orbLookFor({ phase: "working", wake: true })).toEqual({ state: "background", variant: "spiral" });
  });
});

describe("withTurnStatus", () => {
  it("lets retries and compaction override the stream, but never a wait on the person", () => {
    expect(withTurnStatus({ phase: "writing" }, { retrying: { rateLimited: true } })).toEqual({ phase: "retrying", rateLimited: true });
    expect(withTurnStatus({ phase: "thinking" }, { compacting: "native" })).toEqual({ phase: "compacting", native: true });
    expect(withTurnStatus({ phase: "confirm" }, { compacting: "summary" })).toEqual({ phase: "confirm" });
    expect(withTurnStatus({ phase: "working" }, { wake: true })).toEqual({ phase: "working", wake: true });
    expect(withTurnStatus({ phase: "thinking" }, { wake: true })).toEqual({ phase: "thinking" });
    expect(withTurnStatus({ phase: "writing" })).toEqual({ phase: "writing" });
  });
});

describe("run timing", () => {
  it("measures the wall clock across tools and thinking, never below 1s", () => {
    const toolData = {
      t1: { name: "Read", detail: "a", startedAt: 1_000, endedAt: 1_200 },
      t2: { name: "Grep", detail: "b", startedAt: 3_000, endedAt: 9_400 },
    };
    const times = { r1: { start: 0, end: 900 } };
    expect(
      runSeconds(
        [
          { kind: "reasoning", id: "r1", active: false },
          { kind: "tool", id: "t1", name: "Read", detail: "a" },
          { kind: "tool", id: "t2", name: "Grep", detail: "b" },
        ],
        toolData,
        times,
      ),
    ).toBe(9);
    expect(runSeconds([{ kind: "tool", id: "t1", name: "Read", detail: "a" }], toolData, {})).toBe(1);
    expect(reasoningSeconds({ start: 0, end: 7_600 })).toBe(8);
  });

  it("falls back to null for runs written before timing existed", () => {
    expect(runSeconds([{ kind: "tool", id: "old", name: "Read", detail: "a" }], {}, {})).toBeNull();
    expect(reasoningSeconds(undefined)).toBeNull();
  });
});

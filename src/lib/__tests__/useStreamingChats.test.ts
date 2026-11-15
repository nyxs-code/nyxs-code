// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useStreamingChats } from "@/lib/useStreamingChats";

describe("useStreamingChats compacting", () => {
  it("tracks compaction per chat, so one chat's /compact doesn't show on the others", () => {
    const { result } = renderHook(() => useStreamingChats());
    act(() => result.current.setCompacting("a", true));
    expect(result.current.compactingIds.has("a")).toBe(true);
    expect(result.current.compactingIds.has("b")).toBe(false);

    act(() => result.current.setCompacting("b", true));
    // A compaction finishing in a background chat clears only that chat.
    act(() => result.current.setCompacting("a", false));
    expect([...result.current.compactingIds]).toEqual(["b"]);
  });

  it("keeps the same set when nothing changes", () => {
    const { result } = renderHook(() => useStreamingChats());
    const before = result.current.compactingIds;
    act(() => result.current.setCompacting("a", false));
    expect(result.current.compactingIds).toBe(before);
  });
});

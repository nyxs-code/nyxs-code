// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useConfirm } from "@/lib/useConfirm";

describe("useConfirm", () => {
  it("answers an earlier question as cancelled when a new one takes its place", async () => {
    const { result } = renderHook(() => useConfirm());
    let first!: Promise<boolean>;
    act(() => {
      first = result.current[0]({ title: "¿Borrar?" } as never);
    });
    act(() => {
      void result.current[0]({ title: "¿Archivar?" } as never);
    });
    await expect(first).resolves.toBe(false);
  });

  it("answers an open question as cancelled when its owner goes away", async () => {
    const { result, unmount } = renderHook(() => useConfirm());
    let asked!: Promise<boolean>;
    act(() => {
      asked = result.current[0]({ title: "¿Borrar?" } as never);
    });
    unmount();
    await expect(asked).resolves.toBe(false);
  });
});

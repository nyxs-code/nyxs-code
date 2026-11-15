// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { restoreChatViews, useChatViews, withView } from "@/lib/useChatViews";
import { OPEN_PREVIEW_EVENT } from "@/lib/previewControl";

describe("useChatViews", () => {
  // Each hook saves its views for a reload, and the next one would restore them.
  beforeEach(() => sessionStorage.clear());

  it("gives each chat its own browser when the saved views had two on one slot", () => {
    const views = (slot: string) => ({ open: true, views: ["preview"], previewFile: "", slot, previewStarted: true, usedAt: 1, workspace: null });
    sessionStorage.setItem("nyxs.reload.views", JSON.stringify({ a: views("views-1"), b: views("views-1"), c: views("views-3") }));
    const restored = restoreChatViews();
    const slots = Object.values(restored).map((v) => v.slot);
    expect(new Set(slots).size).toBe(3);
    expect(restored.a.slot).toBe("views-1");
    expect(restored.c.slot).toBe("views-3");
  });

  it("lists the live browsers in one order whichever chat is in front", () => {
    const { result, rerender } = renderHook(({ id }) => useChatViews(id, null, () => null), { initialProps: { id: "x" as string | null } });
    act(() => result.current.patchViews((cur) => withView(cur, "preview")));
    rerender({ id: "y" });
    act(() => result.current.patchViews((cur) => withView(cur, "preview")));
    const order = result.current.previewSlots.map((p) => p.slot);
    rerender({ id: "x" });
    expect(result.current.previewSlots.map((p) => p.slot)).toEqual(order);
    rerender({ id: "y" });
    expect(result.current.previewSlots.map((p) => p.slot)).toEqual(order);
  });

  it("keeps the browser of the chat left behind alive when switching chats", () => {
    const { result, rerender } = renderHook(({ id, ws }) => useChatViews(id, ws, () => ws), {
      initialProps: { id: "a" as string | null, ws: "D:\\p" as string | null },
    });
    act(() => result.current.patchViews((cur) => withView(cur, "preview")));
    const slotA = result.current.currentViews?.slot;
    rerender({ id: "b", ws: "D:\\p" });
    act(() => result.current.patchViews((cur) => withView(cur, "preview")));
    const slotB = result.current.currentViews?.slot;
    expect(slotA).toBeTruthy();
    expect(slotB).toBeTruthy();
    expect(slotA).not.toBe(slotB);
    expect(result.current.previewSlots.map((p) => p.slot).sort()).toEqual([slotA, slotB].sort());
    rerender({ id: "a", ws: "D:\\p" });
    expect(result.current.previewSlots.map((p) => p.slot).sort()).toEqual([slotA, slotB].sort());
  });

  it("starts the browser of a chat in the background out of sight, not in the chat on screen", () => {
    const { result } = renderHook(() => useChatViews("shown", "D:\\shown", (id) => (id === "busy" ? "D:\\mail" : "D:\\shown")));
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_PREVIEW_EVENT, { detail: { chat: "busy" } }));
    });
    // The chat on screen keeps its panel as it was.
    expect(result.current.viewsOpen).toBe(false);
    const busy = result.current.previewSlots.find((p) => p.workspace === "D:\\mail");
    expect(busy).toBeTruthy();
    expect(busy?.slot).not.toBe(result.current.currentViews?.slot);
    // The chat's own agent, on screen, still brings its browser up.
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_PREVIEW_EVENT, { detail: { chat: "shown" } }));
    });
    expect(result.current.openViews).toEqual(["preview"]);
  });

  it("opens the Preview tool's page in the browser of the agent's chat, not in the one on screen", () => {
    const { result } = renderHook(() => useChatViews("shown", "D:\\shown", (id) => (id === "busy" ? "D:\\mail" : "D:\\shown")));
    act(() => result.current.patchViews((cur) => withView(cur, "preview")));
    act(() => result.current.showPreviewOf("busy", "report.html"));
    const shown = result.current.previewSlots.find((p) => p.slot === result.current.currentViews?.slot);
    expect(shown?.previewFile).toBe("");
    expect(result.current.previewSlots.find((p) => p.workspace === "D:\\mail")?.previewFile).toBe("report.html");
    // The chat on screen shows its own.
    act(() => result.current.showPreviewOf("shown", "index.html"));
    expect(result.current.previewSlots.find((p) => p.slot === result.current.currentViews?.slot)?.previewFile).toBe("index.html");
  });

  it("doesn't give a new chat the slot of a deleted chat whose tabs are still saved", () => {
    sessionStorage.setItem("nyxs.reload.browser:views-900", JSON.stringify({ tabs: [{ id: "tab-1", fresh: false }], activeId: "tab-1", pages: {} }));
    const { result } = renderHook(() => useChatViews("new", null, () => null));
    act(() => result.current.patchViews((cur) => withView(cur, "preview")));
    expect(Number(/\d+$/.exec(result.current.currentViews?.slot ?? "")?.[0])).toBeGreaterThan(900);
  });
});

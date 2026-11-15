import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { setPreviewWebviewBounds } from "../previewWebview";

const box = (width: number) => ({ x: 10, y: 20, width, height: 300 });
const flush = () => new Promise((r) => setTimeout(r));

describe("setPreviewWebviewBounds", () => {
  let landed: Array<() => void>;

  beforeEach(() => {
    landed = [];
    invoke.mockReset();
    invoke.mockImplementation(() => new Promise<void>((resolve) => landed.push(resolve)));
  });

  const land = async () => {
    landed.shift()?.();
    await flush();
  };
  const widths = () => invoke.mock.calls.map(([, args]) => (args as { width: number }).width);

  it("sends only the newest bounds once the move under way lands", async () => {
    setPreviewWebviewBounds("a", box(100));
    setPreviewWebviewBounds("a", box(200));
    setPreviewWebviewBounds("a", box(300));
    expect(widths()).toEqual([100]);
    await land();
    expect(widths()).toEqual([100, 300]);
    await land();
    expect(widths()).toEqual([100, 300]);
  });

  it("doesn't repeat the bounds already on their way", async () => {
    setPreviewWebviewBounds("b", box(100));
    setPreviewWebviewBounds("b", box(200));
    setPreviewWebviewBounds("b", box(100));
    await land();
    expect(widths()).toEqual([100]);
  });

  it("keeps each tab apart and goes on after a failed move", async () => {
    invoke.mockImplementationOnce(() => Promise.reject(new Error("gone")));
    setPreviewWebviewBounds("c", box(100));
    setPreviewWebviewBounds("c", box(200));
    setPreviewWebviewBounds("d", box(400));
    await flush();
    expect(invoke.mock.calls.map(([, args]) => (args as { tab: string }).tab)).toEqual(["c", "d", "c"]);
    expect(widths()).toEqual([100, 400, 200]);
  });
});

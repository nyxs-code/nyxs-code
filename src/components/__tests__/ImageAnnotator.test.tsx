// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "@/components/ImageLightbox";
import { setComposerAttach } from "@/lib/composerAttach";
import { drawMarks } from "@/lib/imageMarks";
import { getTranslations } from "@/lib/i18n";

// jsdom has no PointerEvent: without it the events carry no coordinates.
if (typeof window.PointerEvent === "undefined") {
  class FakePointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (window as unknown as { PointerEvent: typeof FakePointerEvent }).PointerEvent = FakePointerEvent;
}

const tx = getTranslations("en-US").messageExtra;
const tv = getTranslations("en-US").views;
afterEach(() => {
  cleanup();
  setComposerAttach(null);
});

/** Shows the viewer, opens the drawing tools and loads a 200×100 image drawn at 100×50. */
async function annotate() {
  const onClose = vi.fn();
  render(<ImageLightbox src="data:image/png;base64," alt="screen.png" onClose={onClose} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: tx.annotateImage }));
  const img = screen.getByRole("img", { name: "screen.png" }) as HTMLImageElement;
  Object.defineProperty(img, "naturalWidth", { value: 200 });
  Object.defineProperty(img, "naturalHeight", { value: 100 });
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.load(img);
  const svg = document.querySelector("svg[viewBox='0 0 200 100']") as SVGSVGElement;
  svg.setPointerCapture = () => {};
  return { onClose, svg };
}

describe("annotating an image", () => {
  it("is offered only when there's a message to add it to", async () => {
    render(<ImageLightbox src="data:image/png;base64," alt="x" onClose={() => {}} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: tx.annotateImage })).toBeNull();
  });

  it("draws in the image's own pixels, undoes and redoes", async () => {
    setComposerAttach(() => {});
    const { svg } = await annotate();
    fireEvent.pointerDown(svg, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 30, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    // The pen, from (20,20) to (60,40) in image pixels: the shown image is half its size.
    const line = svg.querySelector("polyline")!;
    expect(line.getAttribute("points")).toBe("20,20 20,20 60,40");
    fireEvent.click(screen.getByRole("button", { name: tv.annotUndo }));
    expect(svg.querySelector("polyline")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: tv.annotRedo }));
    expect(svg.querySelector("polyline")).not.toBeNull();
  });

  it("leaves the drawing tools with Escape before closing the viewer", async () => {
    setComposerAttach(() => {});
    const { onClose } = await annotate();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: tx.annotateImage })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("annotating an attachment in the message box", () => {
  it("saves over it instead of adding another image to the message", async () => {
    const attach = vi.fn();
    setComposerAttach(attach);
    const onSave = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      new Proxy({}, { get: () => () => {} }) as never,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done) => done(new Blob(["png"], { type: "image/png" })));
    const onClose = vi.fn();
    render(<ImageLightbox src="data:image/png;base64," alt="screen.png" onClose={onClose} onSave={onSave} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: tx.annotateImage }));
    const img = screen.getByRole("img", { name: "screen.png" }) as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 200 });
    Object.defineProperty(img, "naturalHeight", { value: 100 });
    fireEvent.load(img);
    expect(screen.queryByRole("button", { name: tx.addToMessage })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: tx.saveAnnotations })));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0][0] as File).type).toBe("image/png");
    expect(attach).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("the annotated copy", () => {
  it("draws every mark on the canvas, with the steps numbered", () => {
    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_t, k: string) => (k in _t ? _t[k] : (...args: unknown[]) => calls.push(`${k}(${args.join(",")})`)),
      set: (_t, k: string, v) => ((_t[k] = v), true),
    }) as unknown as CanvasRenderingContext2D;
    drawMarks(ctx, [
      { kind: "rect", color: "#e03131", width: 4, points: [[0, 0], [50, 20]] },
      { kind: "step", color: "#1c7ed6", width: 4, points: [[80, 80]], n: 2 },
    ]);
    expect(calls).toContain("rect(0,0,50,20)");
    expect(calls).toContain("fillText(2,80,80)");
  });
});

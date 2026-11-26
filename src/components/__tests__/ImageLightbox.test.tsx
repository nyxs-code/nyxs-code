// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ImageLightbox } from "@/components/ImageLightbox";
import { getTranslations } from "@/lib/i18n";
import { setNativeViewShown } from "@/lib/nativeViews";

afterEach(() => {
  cleanup();
  setNativeViewShown("tab-1", false);
});

const backdrop = () => screen.getByRole("img").closest<HTMLElement>(".fixed")!;

describe("ImageLightbox's buttons", () => {
  it("sit beside the image, close above draw, and a click on the image keeps it open", () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="data:image/png;base64," alt="captura" onClose={onClose} />);
    const t = getTranslations("en-US");
    const frame = screen.getByRole("img").parentElement!;
    const close = within(frame).getByRole("button", { name: t.changelog.close });
    const draw = within(frame).queryByRole("button", { name: t.messageExtra.annotateImage });
    if (draw) expect(close.compareDocumentPosition(draw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole("img"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ImageLightbox over the browser panel", () => {
  it("shows at once when no website is on screen", async () => {
    render(<ImageLightbox src="data:image/png;base64," alt="captura" onClose={() => {}} />);
    await act(async () => {});
    expect(backdrop().className).not.toContain("opacity-0");
  });

  it("stays invisible until the website steps aside", async () => {
    setNativeViewShown("tab-1", true);
    render(<ImageLightbox src="data:image/png;base64," alt="captura" onClose={() => {}} />);
    await act(async () => {});
    expect(backdrop().className).toContain("opacity-0");

    await act(async () => setNativeViewShown("tab-1", false));
    expect(backdrop().className).not.toContain("opacity-0");
  });
});

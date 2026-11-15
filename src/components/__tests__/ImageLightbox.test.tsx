// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ImageLightbox } from "@/components/ImageLightbox";
import { setNativeViewShown } from "@/lib/nativeViews";

afterEach(() => {
  cleanup();
  setNativeViewShown("tab-1", false);
});

const backdrop = () => screen.getByRole("img").parentElement!;

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

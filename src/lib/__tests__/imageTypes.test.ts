import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { isImageAttachment } = await import("@/lib/imageAttachments");
const { toDocumentAttachments } = await import("@/lib/fileAttachments");
const { toModelMessage } = await import("@/lib/turnInput");

const attached = (name: string, type: string, body: BlobPart = "x") => ({
  id: name,
  file: new File([body], name, { type }),
  type: type.startsWith("image/") ? "image/unknown" : type,
  preview: type.startsWith("image/") ? "blob:preview" : null,
  uploadStatus: "complete",
}) as never;

describe("which attachments go to the model as images", () => {
  it("only the types every provider reads as one", () => {
    for (const [name, type] of [["a.png", "image/png"], ["a.jpg", "image/jpeg"], ["a.gif", "image/gif"], ["a.webp", "image/webp"], ["b.JPG", ""]]) {
      expect(isImageAttachment(attached(name, type)), name).toBe(true);
    }
    for (const [name, type] of [["a.svg", "image/svg+xml"], ["a.heic", "image/heic"], ["a.bmp", "image/bmp"], ["a.tiff", "image/tiff"], ["a.heic", ""]]) {
      expect(isImageAttachment(attached(name, type)), name).toBe(false);
    }
  });

  it("sends an SVG as its text instead", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
    const [doc] = await toDocumentAttachments([attached("logo.svg", "image/svg+xml", svg)]);
    expect(doc.text).toBe(svg);
  });

  it("doesn't send an earlier message's SVG to the model as an image", () => {
    const msg = toModelMessage(
      { role: "user", content: "look", images: [{ mediaType: "image/svg+xml", dataUrl: "data:image/svg+xml;base64,AA==", name: "a.svg" }, { mediaType: "image/png", dataUrl: "data:image/png;base64,AA==" }] },
      true,
    );
    const parts = msg.content as { type: string; mediaType?: string }[];
    expect(parts.filter((p) => p.type === "image").map((p) => p.mediaType)).toEqual(["image/png"]);
  });
});

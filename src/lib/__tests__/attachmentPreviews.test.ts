import { describe, expect, it, vi } from "vitest";
import { livePreview, releasePreviews } from "@/lib/attachmentPreviews";

const image = (preview: string | null) => ({ id: "f", file: new File(["x"], "a.png", { type: "image/png" }), type: "image/png", preview });

describe("attachment thumbnails", () => {
  it("free a thumbnail's object URL once, and draw a new one if the image is shown again", () => {
    const revoke = vi.fn();
    const create = vi.fn(() => "blob:new");
    URL.revokeObjectURL = revoke;
    URL.createObjectURL = create;
    const f = image("blob:old");
    expect(livePreview(f)).toBe(f);
    releasePreviews([f, image(null), image("data:image/png;base64,AA==")]);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:old");
    expect(livePreview(f).preview).toBe("blob:new");
    expect(create).toHaveBeenCalledWith(f.file);
  });
});

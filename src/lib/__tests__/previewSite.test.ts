import { describe, expect, it } from "vitest";
import { PREVIEW_ORIGIN, previewMessageTarget, previewSite } from "../previewWebview";

describe("previewSite", () => {
  it("names the site of a preview page, with its port", () => {
    expect(previewSite(`${PREVIEW_ORIGIN}:23817/docs/index.html?v=1`)).toBe(`${PREVIEW_ORIGIN}:23817`);
    expect(previewSite(`${PREVIEW_ORIGIN}:23817`)).toBe(`${PREVIEW_ORIGIN}:23817`);
    expect(previewSite(`${PREVIEW_ORIGIN}/__nyxs/mockup/a`)).toBe(PREVIEW_ORIGIN);
  });

  it("is null for any other address", () => {
    expect(previewSite("http://localhost:5173/")).toBeNull();
    expect(previewSite(`${PREVIEW_ORIGIN}.evil.com/`)).toBeNull();
    expect(previewSite(`${PREVIEW_ORIGIN}:abc/`)).toBeNull();
  });
});

describe("previewMessageTarget", () => {
  it("is the page's own site where origins can be named, and * where they can't", () => {
    const src = `${PREVIEW_ORIGIN}:23817/index.html`;
    expect(previewMessageTarget(src)).toBe(PREVIEW_ORIGIN.startsWith("http") ? `${PREVIEW_ORIGIN}:23817` : "*");
  });
});

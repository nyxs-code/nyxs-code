// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { addBookmark, isBookmarked, removeBookmark, sameBookmarkUrl, useBookmarks } from "@/lib/browserBookmarks";

describe("browser bookmarks", () => {
  beforeEach(() => {
    for (const b of [...(JSON.parse(localStorage.getItem("nyxs.browserBookmarks.v1") || "[]") as { url: string }[])]) removeBookmark(b.url);
  });

  it("treats an address with or without its trailing slash or fragment as the same page", () => {
    expect(sameBookmarkUrl("https://Example.com/docs/", "https://example.com/docs#intro")).toBe(true);
    expect(sameBookmarkUrl("https://example.com/a", "https://example.com/b")).toBe(false);
  });

  it("adds a page once, shows it to every reader, and removes it", () => {
    const { result } = renderHook(() => useBookmarks());
    act(() => addBookmark({ url: "https://example.com/", title: "Example", icon: "" }));
    act(() => addBookmark({ url: "https://example.com", title: "Again", icon: "" }));
    expect(result.current.map((b) => b.title)).toEqual(["Example"]);
    expect(isBookmarked(result.current, "https://example.com")).toBe(true);
    act(() => removeBookmark("https://example.com"));
    expect(result.current).toEqual([]);
  });
});

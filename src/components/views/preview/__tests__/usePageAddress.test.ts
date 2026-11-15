// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { PreviewNavReport } from "@/lib/previewWebview";

const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(event, cb);
    return () => handlers.delete(event);
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));
const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined);
vi.mock("@/lib/ipc", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
const search = { engine: "duckduckgo" as string | undefined };
vi.mock("@/lib/featureSettings", () => ({ browserSearch: () => ({ engine: search.engine }) }));

const { usePageAddress } = await import("../usePageAddress");
const { currentPreviewNav } = await import("@/lib/previewWebview");

const TAB = "tab-hist";

function setup() {
  const { result } = renderHook(() => usePageAddress({ workspace: null, tabId: TAB, fresh: true, setMenuOpen: () => {} }));
  const page = (url: string, length: number, more: Partial<PreviewNavReport> = {}) =>
    act(() => handlers.get("preview-nav")?.({ payload: { tab: TAB, url, nav: currentPreviewNav(TAB), length, canBack: length > 1, canForward: false, ...more } }));
  return { result, page };
}

describe("usePageAddress following the website", () => {
  it("shows where a click, a redirect or a script took the page, and steps back through the page itself", async () => {
    const { result, page } = setup();
    await act(() => result.current.loadTarget("http://example.com", true).then(() => {}));
    expect(result.current.extUrl).toBe("http://example.com");

    // The site redirects to https: the entry is replaced, not added.
    page("https://example.com/", 1);
    expect(result.current.hist).toEqual({ list: ["https://example.com/"], i: 0 });

    // A link inside the site.
    page("https://example.com/docs", 2);
    expect(result.current.input).toBe("https://example.com/docs");
    expect(result.current.extUrl).toBe("https://example.com/docs");
    expect(result.current.hist.list).toEqual(["https://example.com/", "https://example.com/docs"]);
    expect(result.current.canBack).toBe(true);

    // Back goes through the page's own history, not by opening the address again.
    invoke.mockClear();
    act(() => result.current.step(-1));
    expect(invoke).toHaveBeenCalledWith("preview_history", { tab: TAB, delta: -1 });
    page("https://example.com/", 2, { canBack: false, canForward: true });
    expect(result.current.hist.i).toBe(0);
    expect(result.current.canForward).toBe(true);

    // pushState from a single-page app: the history grew, so it's a new entry.
    page("https://example.com/app#/settings", 2, { canForward: false });
    expect(result.current.hist.list.at(-1)).toBe("https://example.com/app#/settings");
  });

  it("drops a late report about a page the tab already left", async () => {
    const { result, page } = setup();
    await act(() => result.current.loadTarget("https://a.com/", true).then(() => {}));
    page("https://a.com/", 1);
    const before = currentPreviewNav(TAB);
    await act(() => result.current.loadTarget("https://b.com/", true).then(() => {}));
    expect(currentPreviewNav(TAB)).toBe(before + 1);
    // Still about a.com: it must not pull the tab back.
    act(() => handlers.get("preview-nav")?.({ payload: { tab: TAB, url: "https://a.com/late", nav: before, length: 2, canBack: true, canForward: false } }));
    expect(result.current.extUrl).toBe("https://b.com/");
    expect(result.current.hist.list.at(-1)).toBe("https://b.com/");
    // Another tab's page doesn't count either.
    act(() => handlers.get("preview-nav")?.({ payload: { tab: "other", url: "https://c.com/", nav: currentPreviewNav(TAB), length: 1, canBack: false, canForward: false } }));
    expect(result.current.extUrl).toBe("https://b.com/");
  });

  it("doesn't overwrite what the user is typing in the address bar", async () => {
    const { result, page } = setup();
    await act(() => result.current.loadTarget("https://a.com/", true).then(() => {}));
    act(() => { result.current.setUrlFocused(true); result.current.setInput("https://typ"); });
    page("https://a.com/next", 2);
    expect(result.current.input).toBe("https://typ");
    expect(result.current.extUrl).toBe("https://a.com/next");
  });
});

describe("usePageAddress reading what was typed", () => {
  const project = () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "agent_list_files" ? ["C:/ws/docs/README.md", "C:/ws/README.md", "C:/ws/src/app.ts"] : undefined,
    );
    return renderHook(() => usePageAddress({ workspace: "C:/ws", tabId: "tab-typed", fresh: true, setMenuOpen: () => {} })).result;
  };

  it("opens the project file a single word names instead of searching it", async () => {
    const result = project();
    await act(() => result.current.loadTarget("README", true).then(() => {}));
    expect(result.current.input).toBe("README.md");
    expect(result.current.src).toBe("asset://C:/ws/README.md");
    expect(result.current.extUrl).toBe("");
  });

  it("keeps what the user typed while an address was still being worked out", async () => {
    const result = project();
    let release: (files: string[]) => void = () => {};
    invoke.mockImplementation((cmd: string) =>
      cmd === "agent_list_files" ? new Promise<string[]>((r) => { release = r; }) : Promise.resolve(undefined),
    );
    let loading: Promise<unknown> = Promise.resolve();
    act(() => { loading = result.current.loadTarget("example.com/docs", true); });
    act(() => { result.current.setUrlFocused(true); result.current.setInput("READ"); });
    await act(async () => { release([]); await loading; });
    expect(result.current.input).toBe("READ");
    expect(result.current.extUrl).toBe("https://example.com/docs");
  });

  it("doesn't rewrite the address under a user who clicked back into the bar before typing", async () => {
    const result = project();
    let release: (files: string[]) => void = () => {};
    invoke.mockImplementation((cmd: string) =>
      cmd === "agent_list_files" ? new Promise<string[]>((r) => { release = r; }) : Promise.resolve(undefined),
    );
    act(() => result.current.setInput("example.com/docs"));
    let loading: Promise<unknown> = Promise.resolve();
    act(() => { loading = result.current.loadTarget("example.com/docs", true); });
    act(() => result.current.setUrlFocused(false));
    act(() => result.current.setUrlFocused(true));
    await act(async () => { release([]); await loading; });
    expect(result.current.input).toBe("example.com/docs");
    expect(result.current.extUrl).toBe("https://example.com/docs");
  });

  it("lists the project's files only for a single word, not for addresses or phrases", async () => {
    const result = project();
    invoke.mockClear();
    await act(() => result.current.loadTarget("https://example.com", true).then(() => {}));
    await act(() => result.current.loadTarget("read me", true).then(() => {}));
    expect(invoke).not.toHaveBeenCalledWith("agent_list_files", expect.anything());
    await act(() => result.current.loadTarget("readme", true).then(() => {}));
    expect(invoke).toHaveBeenCalledWith("agent_list_files", { workspace: "C:/ws" });
  });

  it("serves an HTML file on its folder's site, with the cookie profile chosen in the browser menu", async () => {
    const { setBrowserPrefs } = await import("@/lib/browserPrefs");
    const result = project();
    const base = invoke.getMockImplementation();
    invoke.mockImplementation(async (cmd: string, args?: unknown) =>
      cmd === "agent_set_preview_root" ? "http://nyxspreview.localhost:23817" : base?.(cmd, args),
    );
    setBrowserPrefs({ cookies: "private" });
    await act(() => result.current.loadTarget("C:/ws/site/index.html", true).then(() => {}));
    expect(invoke).toHaveBeenCalledWith("agent_set_preview_root", { root: "C:/ws/site", profile: "private" });
    expect(result.current.src).toMatch(/^http:\/\/nyxspreview\.localhost:23817\/index\.html\?v=\d+$/);
    setBrowserPrefs({ cookies: "shared" });
  });

  it("serves a remote project's files through the preview site", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "agent_set_preview_root" ? "http://nyxspreview.localhost:23456" : cmd === "agent_list_files" ? ["site/index.html"] : undefined,
    );
    const result = renderHook(() => usePageAddress({ workspace: "ssh://vps/home/me/app", tabId: "tab-remote", fresh: true, setMenuOpen: () => {} })).result;
    await act(() => result.current.loadTarget("site/index.html", true).then(() => {}));
    expect(invoke).toHaveBeenCalledWith("agent_set_preview_root", expect.objectContaining({ root: "ssh://vps/home/me/app/site" }));
    expect(result.current.src).toMatch(/^http:\/\/nyxspreview\.localhost:23456\/index\.html\?v=\d+$/);
    // Not only HTML: a README opens there too.
    await act(() => result.current.loadTarget("ssh://vps/home/me/app/README.md", true).then(() => {}));
    expect(invoke).toHaveBeenLastCalledWith("agent_set_preview_root", expect.objectContaining({ root: "ssh://vps/home/me/app" }));
    expect(result.current.src).toMatch(/:23456\/README\.md\?v=/);
  });

  it("joins a project file to a macOS or Linux project with /", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "agent_set_preview_root" ? "http://nyxspreview.localhost:23999" : cmd === "agent_list_files" ? ["site/index.html"] : undefined,
    );
    const result = renderHook(() => usePageAddress({ workspace: "/Users/me/app", tabId: "tab-posix", fresh: true, setMenuOpen: () => {} })).result;
    await act(() => result.current.loadTarget("site/index.html", true).then(() => {}));
    expect(invoke).toHaveBeenCalledWith("agent_set_preview_root", expect.objectContaining({ root: "/Users/me/app/site" }));
    expect(result.current.src).toMatch(/:23999\/index\.html\?v=/);
  });

  it("searches with the engine chosen in Settings", async () => {
    const result = project();
    await act(() => result.current.loadTarget("how to center a div", true).then(() => {}));
    expect(result.current.extUrl).toBe("https://duckduckgo.com/?q=how%20to%20center%20a%20div");
    search.engine = undefined;
    await act(() => result.current.loadTarget("vite", true).then(() => {}));
    expect(result.current.extUrl).toBe("https://www.google.com/search?q=vite");
  });
});

describe("usePageAddress with loads that overlap", () => {
  /** An invoke whose answer for `cmd` waits until the test lets it go. */
  function holdOn(cmd: string, answer: unknown) {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    invoke.mockImplementation(async (c: string) => {
      if (c === cmd) {
        await gate;
        return answer;
      }
      return undefined;
    });
    return () => act(async () => { release(); await gate; });
  }

  const render = () =>
    renderHook(() => usePageAddress({ workspace: "/ws", tabId: "tab-race", fresh: true, setMenuOpen: () => {} })).result;

  it("drops a slow file search when another address was opened meanwhile", async () => {
    const release = holdOn("agent_list_files", ["/ws/readme.html"]);
    const result = render();
    let first: Promise<string> = Promise.resolve("");
    act(() => { first = result.current.loadTarget("readme", true); });
    await act(() => result.current.loadTarget("https://example.com/", true).then(() => {}));
    await release();
    await act(() => first.then(() => {}));
    expect(result.current.extUrl).toBe("https://example.com/");
    expect(result.current.src).toBe("");
    expect(result.current.input).toBe("https://example.com/");
  });

  it("drops a local page whose site opened after another address", async () => {
    const release = holdOn("agent_set_preview_root", "http://nyxspreview.localhost:23456");
    const result = render();
    let first: Promise<string> = Promise.resolve("");
    act(() => { first = result.current.loadTarget("site/index.html", false); });
    await act(() => result.current.loadTarget("https://example.com/", false).then(() => {}));
    await release();
    await act(() => first.then(() => {}));
    expect(result.current.extUrl).toBe("https://example.com/");
    expect(result.current.src).toBe("");
  });
});

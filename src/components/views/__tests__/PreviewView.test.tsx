// @vitest-environment jsdom
import { useEffect, useMemo, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensurePreview, previewForAddress, registerPreviewTab, setPreviewFront, setPreviewSlots, startPreviewTurn, type PreviewController, type PreviewPageInfo } from "@/lib/previewControl";
import { PreviewView } from "../PreviewView";

vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(async () => undefined) }));
/** The backend's events, by name, to every listener the views registered. */
const listeners = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(cb);
    listeners.set(name, set);
    return () => set.delete(cb);
  },
}));
const emit = (name: string, payload: unknown) =>
  act(async () => listeners.get(name)?.forEach((cb) => cb({ payload })));
vi.mock("@/lib/i18n", () => ({ useTranslations: () => ({ views: { newTab: "New tab", closeTab: "Close tab" } }) }));

/** Each mounted tab's address, by slot and tab, and the way to change it as a page would. */
const pages = new Map<string, { slot: string; url: string; load: (url: string, byUser: boolean) => void }>();

// The tab's page without its webview: what it shows and how the agent's tools reach it.
vi.mock("../preview/PreviewPage", () => ({
  PreviewPage: function FakePage({ slot, tabId, front, active, requestedFile, strip, onUserLoad }: {
    slot: string;
    tabId: string;
    front: boolean;
    active: boolean;
    requestedFile?: string;
    strip: React.ReactNode;
    onUserLoad: (id: string) => void;
  }) {
    const [url, setUrl] = useState(requestedFile ?? "");
    const [asked, setAsked] = useState(requestedFile);
    if (requestedFile !== asked) {
      setAsked(requestedFile);
      if (requestedFile) setUrl(requestedFile);
    }
    useEffect(() => {
      pages.set(tabId, {
        slot,
        url,
        load: (next, byUser) => {
          setUrl(next);
          if (byUser) onUserLoad(tabId);
        },
      });
    }, [slot, tabId, url, onUserLoad]);
    const controller = useMemo<PreviewController>(
      () => ({
        info: (): PreviewPageInfo => {
          const shown = pages.get(tabId)?.url ?? "";
          return shown ? { kind: "external", url: shown } : { kind: "empty", url: "" };
        },
        navigate: async (next) => {
          pages.get(tabId)?.load(next, false);
          return `Loaded ${next}.`;
        },
        reload: async () => "",
        exec: async () => tabId,
        bounds: () => null,
        capture: async () => "",
        onScreen: () => active,
      }),
      [tabId, active],
    );
    useEffect(() => registerPreviewTab(slot, tabId, controller), [slot, tabId, controller]);
    useEffect(() => {
      if (front) setPreviewFront(slot, tabId, active);
    }, [slot, tabId, front, active, controller]);
    return front ? <div data-testid={`strip-${slot}`}>{strip}</div> : null;
  },
}));

const urlsOf = (slot: string) => [...pages.values()].filter((p) => p.slot === slot).map((p) => p.url);

/** What the browser tool does with an address. A tab it opens only mounts once the first `act`
 *  ends and React renders, so the wait for that tab has to go on outside of it. */
async function agentNavigate(chat: string, url: string) {
  let pending!: Promise<PreviewController>;
  await act(async () => {
    pending = previewForAddress(url, chat);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const page = await pending;
  await act(async () => {
    await page.navigate(url);
  });
}

async function userOpens(tab: string, url: string) {
  await act(async () => pages.get(tab)?.load(url, true));
}

const tabIdShowing = (url: string) => [...pages].find(([, p]) => p.url === url)?.[0] ?? "";

describe("PreviewView with the agent's tools", () => {
  beforeEach(() => {
    sessionStorage.clear();
    pages.clear();
    setPreviewSlots({ work: "views-1", other: "views-2" });
  });
  afterEach(cleanup);

  it("leaves the user's page alone, reuses the agent's tab, and the project's tab for the project", async () => {
    render(<PreviewView persistKey="views-1" workspace="D:\project" />);
    await act(async () => {});
    const first = [...pages.keys()][0];
    await userOpens(first, "https://www.youtube.com/watch?v=1");

    await agentNavigate("work", "https://example.com/");
    expect(urlsOf("views-1")).toEqual(["https://www.youtube.com/watch?v=1", "https://example.com/"]);

    await agentNavigate("work", "https://example.org/");
    expect(urlsOf("views-1")).toEqual(["https://www.youtube.com/watch?v=1", "https://example.org/"]);

    await agentNavigate("work", "http://localhost:5173/");
    // Its own tab held no project page, so the project goes there, not over the video.
    expect(urlsOf("views-1")).toEqual(["https://www.youtube.com/watch?v=1", "http://localhost:5173/"]);

    await agentNavigate("work", "http://localhost:5173/settings");
    expect(urlsOf("views-1")).toEqual(["https://www.youtube.com/watch?v=1", "http://localhost:5173/settings"]);

    // A site now goes to a third tab: the page under test stays.
    await agentNavigate("work", "https://example.com/docs");
    expect(urlsOf("views-1")).toEqual(["https://www.youtube.com/watch?v=1", "http://localhost:5173/settings", "https://example.com/docs"]);
  });

  it("opens a link a site sends to a new window in a new tab, in front", async () => {
    render(<PreviewView persistKey="views-1" workspace="D:\project" />);
    await act(async () => {});
    const first = [...pages.keys()][0];
    await userOpens(first, "https://shop.example.com/");
    await emit("preview-new-tab", { tab: first, url: "https://shop.example.com/terms" });
    expect(urlsOf("views-1")).toEqual(["https://shop.example.com/", "https://shop.example.com/terms"]);
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain("New tab");
    // A tab of another browser isn't this one's to follow.
    await emit("preview-new-tab", { tab: "tab-elsewhere", url: "https://other.example.com/" });
    expect(urlsOf("views-1")).toHaveLength(2);
  });

  it("treats a tab as the user's once they open an address in it", async () => {
    render(<PreviewView persistKey="views-1" workspace="D:\project" />);
    await act(async () => {});
    await agentNavigate("work", "https://example.com/");
    // It started empty, so the agent took it; the user then goes somewhere of their own in it.
    await userOpens(tabIdShowing("https://example.com/"), "https://mail.example.com/");
    await agentNavigate("work", "https://example.org/");
    expect(urlsOf("views-1")).toEqual(["https://mail.example.com/", "https://example.org/"]);
  });

  it("doesn't touch another session's browser", async () => {
    render(
      <>
        <PreviewView persistKey="views-1" workspace="D:\project" visible={false} />
        <PreviewView persistKey="views-2" workspace="D:\project" />
      </>,
    );
    await act(async () => {});
    const [, otherTab] = [...pages.keys()];
    await userOpens(otherTab, "https://www.youtube.com/");
    const before = screen.getByTestId("strip-views-2").textContent;

    await agentNavigate("work", "https://example.com/");
    await agentNavigate("work", "https://example.org/");

    expect(urlsOf("views-1")).toEqual(["https://example.org/"]);
    expect(urlsOf("views-2")).toEqual(["https://www.youtube.com/"]);
    expect(screen.getByTestId("strip-views-2").textContent).toBe(before);
  });

  it("keeps the agent's commands in its tab while the user is on theirs", async () => {
    render(<PreviewView persistKey="views-1" workspace="D:\project" />);
    await act(async () => {});
    const first = [...pages.keys()][0];
    await userOpens(first, "https://www.youtube.com/");
    startPreviewTurn("work");
    await agentNavigate("work", "https://example.com/");
    const own = tabIdShowing("https://example.com/");

    await act(async () => screen.getAllByRole("tab")[0].click());
    expect(await (await ensurePreview("work")).exec("snapshot")).toBe(own);

    // The next message is about what the user is looking at.
    startPreviewTurn("work");
    expect(await (await ensurePreview("work")).exec("snapshot")).toBe(first);
  });

  it("opens a page asked for from the chat in a new tab, without closing the page it had", async () => {
    const { rerender } = render(<PreviewView persistKey="views-1" workspace="D:\project" requestedFile="http://localhost:5173/" />);
    await act(async () => {});
    expect(urlsOf("views-1")).toEqual(["http://localhost:5173/"]);
    rerender(<PreviewView persistKey="views-1" workspace="D:\project" requestedFile="https://example.com/" />);
    await act(async () => {});
    expect(urlsOf("views-1")).toEqual(["http://localhost:5173/", "https://example.com/"]);
    // The project's page keeps its tab.
    rerender(<PreviewView persistKey="views-1" workspace="D:\project" requestedFile="http://localhost:5173/cart" />);
    await act(async () => {});
    expect(urlsOf("views-1")).toEqual(["http://localhost:5173/cart", "https://example.com/"]);
  });
});

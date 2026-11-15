import { describe, expect, it } from "vitest";
import { isProjectTarget } from "@/components/views/preview/helpers";
import { pickAgentTab, type BrowserTabInfo } from "@/lib/previewTabs";

const WS = "E:\\work\\shop";

const tab = (id: string, url: string, o: { front?: boolean; agent?: boolean; kind?: BrowserTabInfo["page"]["kind"] } = {}): BrowserTabInfo => ({
  id,
  page: { kind: o.kind ?? (url ? "external" : "empty"), url },
  front: !!o.front,
  agent: !!o.agent,
});

describe("isProjectTarget", () => {
  it("counts local servers, the preview's site and the project's files", () => {
    expect(isProjectTarget("http://localhost:5173/settings", WS)).toBe(true);
    expect(isProjectTarget("localhost:3000", WS)).toBe(true);
    expect(isProjectTarget("http://127.0.0.1:8000", WS)).toBe(true);
    expect(isProjectTarget("http://nyxspreview.localhost:4321/index.html", WS)).toBe(true);
    expect(isProjectTarget("nyxspreview://localhost/index.html", WS)).toBe(true);
    expect(isProjectTarget("index.html", WS)).toBe(true);
    expect(isProjectTarget("E:\\work\\shop\\public\\index.html", WS)).toBe(true);
    expect(isProjectTarget("e:/work/SHOP/index.html", WS)).toBe(true);
    expect(isProjectTarget("ssh://host/home/me/app/index.html", "ssh://host/home/me/app")).toBe(true);
  });

  it("leaves out websites, searches and files of other folders", () => {
    expect(isProjectTarget("https://www.youtube.com/watch?v=1", WS)).toBe(false);
    expect(isProjectTarget("youtube.com", WS)).toBe(false);
    expect(isProjectTarget("how to center a div", WS)).toBe(false);
    expect(isProjectTarget("E:\\work\\other\\index.html", WS)).toBe(false);
    expect(isProjectTarget("E:\\work\\shop-old\\index.html", WS)).toBe(false);
    expect(isProjectTarget("ssh://host/home/me/other/index.html", "ssh://host/home/me/app")).toBe(false);
    expect(isProjectTarget("about:blank", WS)).toBe(false);
    expect(isProjectTarget("", WS)).toBe(false);
  });
});

describe("pickAgentTab", () => {
  it("never reuses a tab of the user's for something unrelated", () => {
    expect(pickAgentTab("https://example.com", [tab("yt", "https://www.youtube.com/", { front: true })], WS)).toBeNull();
    expect(pickAgentTab("http://localhost:5173", [tab("yt", "https://www.youtube.com/", { front: true })], WS)).toBeNull();
    // Not even when it is on the same site: the user is in the middle of something there.
    expect(pickAgentTab("https://www.youtube.com/watch?v=2", [tab("yt", "https://www.youtube.com/", { front: true })], WS)).toBeNull();
  });

  it("reuses the tab showing the project for the project", () => {
    const tabs = [tab("yt", "https://www.youtube.com/", { front: true }), tab("app", "http://localhost:5173/")];
    expect(pickAgentTab("http://localhost:5173/settings", tabs, WS)).toBe("app");
    expect(pickAgentTab("localhost:5173/login", tabs, WS)).toBe("app");
    expect(pickAgentTab("index.html", [tab("page", "E:\\work\\shop\\index.html", { kind: "local" })], WS)).toBe("page");
  });

  it("prefers the tab of the same server, and takes another of the project if there is none", () => {
    const tabs = [tab("api", "http://localhost:8000/docs", { front: true }), tab("web", "http://localhost:5173/")];
    expect(pickAgentTab("http://localhost:5173/cart", tabs, WS)).toBe("web");
    expect(pickAgentTab("http://localhost:3000/", tabs, WS)).toBe("api");
  });

  it("keeps the agent's lookups in its own tab, not over the project's page", () => {
    const tabs = [tab("app", "http://localhost:5173/", { front: true, agent: true }), tab("docs", "https://react.dev/", { agent: true })];
    expect(pickAgentTab("https://vite.dev/", tabs, WS)).toBe("docs");
    expect(pickAgentTab("https://vite.dev/", [tabs[0]], WS)).toBeNull();
  });

  it("prefers the tab the agent is working in among its own", () => {
    const tabs = [tab("a", "https://a.example/", { front: true, agent: true }), tab("b", "https://b.example/", { agent: true })];
    expect(pickAgentTab("https://c.example/", tabs, WS, "b")).toBe("b");
    expect(pickAgentTab("https://c.example/", tabs, WS)).toBe("a");
  });

  it("uses an empty tab before opening another, the one in front first", () => {
    const tabs = [tab("yt", "https://www.youtube.com/"), tab("blank", "", { front: true })];
    expect(pickAgentTab("https://example.com", tabs, WS)).toBe("blank");
    expect(pickAgentTab("http://localhost:5173", tabs, WS)).toBe("blank");
    expect(pickAgentTab("https://example.com", [tab("yt", "https://www.youtube.com/", { front: true }), tab("blank", "")], WS)).toBe("blank");
  });

  it("a file outside the project is a page of the user's", () => {
    expect(pickAgentTab("index.html", [tab("notes", "E:\\notes\\today.html", { kind: "local", front: true })], WS)).toBeNull();
  });
});

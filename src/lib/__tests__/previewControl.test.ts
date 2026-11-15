// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  ensurePreview,
  hasActivePreview,
  previewForAddress,
  previewSlotOf,
  previewTabsOf,
  previewWorkspace,
  registerPreviewBrowser,
  registerPreviewTab,
  setPreviewFront,
  setPreviewSlots,
  showAgentTab,
  startPreviewTurn,
  type PreviewController,
  type PreviewPageInfo,
} from "@/lib/previewControl";

const page = (name: string, shown: boolean, info: PreviewPageInfo = { kind: "external", url: name }): PreviewController => ({
  info: () => info,
  navigate: async () => name,
  reload: async () => name,
  exec: async () => name,
  bounds: () => null,
  capture: async () => "",
  onScreen: () => shown,
});

/** A browser with tabs, as PreviewView and its tabs register themselves. */
function browser(slot: string, tabs: Record<string, PreviewController>, opts: { front: string; visible?: boolean; agent?: string[]; workspace?: string }) {
  const agent = new Set(opts.agent ?? []);
  const offs = Object.entries(tabs).map(([id, controller]) => registerPreviewTab(slot, id, controller));
  let opened = 0;
  const handle = {
    workspace: () => opts.workspace ?? "D:\\project",
    isAgentTab: (id: string) => agent.has(id),
    openAgentTab: vi.fn(() => {
      const id = `${slot}-new-${++opened}`;
      agent.add(id);
      // A real tab mounts on the next render.
      setTimeout(() => offs.push(registerPreviewTab(slot, id, page(id, false, { kind: "empty", url: "" }))), 0);
      return id;
    }),
    claimTab: vi.fn((id: string) => void agent.add(id)),
    focusTab: vi.fn((id: string) => setPreviewFront(slot, id, opts.visible ?? false)),
  };
  offs.push(registerPreviewBrowser(slot, handle));
  setPreviewFront(slot, opts.front, opts.visible ?? false);
  return { handle, off: () => offs.forEach((off) => off()) };
}

describe("previewControl", () => {
  it("gives each chat's agent its own browser, not the one on screen", async () => {
    setPreviewSlots({ mail: "views-1", site: "views-2" });
    const mail = page("mail", false);
    const site = page("site", true);
    const offMail = browser("views-1", { a: mail }, { front: "a" });
    const offSite = browser("views-2", { b: site }, { front: "b", visible: true });
    expect(await ensurePreview("mail")).toBe(mail);
    expect(await ensurePreview("site")).toBe(site);
    expect(hasActivePreview("mail")).toBe(false);
    // An agent that can't name its chat gets the one on screen, as before.
    expect(await ensurePreview()).toBe(site);
    offMail.off();
    offSite.off();
  });

  it("waits for a background chat's browser to start", async () => {
    setPreviewSlots({});
    const later = page("later", false);
    const pending = ensurePreview("later", 1000);
    setPreviewSlots({ later: "views-9" });
    const off = browser("views-9", { a: later }, { front: "a" });
    expect(await pending).toBe(later);
    off.off();
  });

  it("opens a site in a new tab instead of over the page the user has open", async () => {
    setPreviewSlots({ chat: "views-3" });
    const youtube = page("youtube", true, { kind: "external", url: "https://www.youtube.com/watch?v=1" });
    const b = browser("views-3", { yt: youtube }, { front: "yt", visible: true });
    startPreviewTurn("chat");
    const tab = await previewForAddress("https://example.com", "chat");
    expect(tab).not.toBe(youtube);
    expect(b.handle.openAgentTab).toHaveBeenCalledOnce();
    expect(b.handle.focusTab).toHaveBeenCalledWith("views-3-new-1");
    // The next commands go to the agent's tab, not to the user's.
    expect(await ensurePreview("chat")).toBe(tab);
    b.off();
  });

  it("tests the project in the tab already showing it", async () => {
    setPreviewSlots({ chat: "views-4" });
    const app = page("app", true, { kind: "external", url: "http://localhost:5173/" });
    const b = browser("views-4", { app }, { front: "app", visible: true });
    expect(await previewForAddress("http://localhost:5173/settings", "chat")).toBe(app);
    expect(b.handle.openAgentTab).not.toHaveBeenCalled();
    b.off();
  });

  it("uses an empty tab and keeps it as the agent's", async () => {
    setPreviewSlots({ chat: "views-5" });
    const blank = page("blank", true, { kind: "empty", url: "" });
    const b = browser("views-5", { blank }, { front: "blank", visible: true });
    expect(await previewForAddress("https://example.com", "chat")).toBe(blank);
    expect(b.handle.openAgentTab).not.toHaveBeenCalled();
    expect(b.handle.claimTab).toHaveBeenCalledWith("blank");
    b.off();
  });

  it("keeps working in its tab when the user moves to another, until the next turn", async () => {
    setPreviewSlots({ chat: "views-6" });
    const youtube = page("youtube", true, { kind: "external", url: "https://www.youtube.com/" });
    const own = page("own", false, { kind: "external", url: "https://example.com/" });
    const b = browser("views-6", { yt: youtube, own }, { front: "own", visible: true, agent: ["own"] });
    startPreviewTurn("chat");
    expect(await previewForAddress("https://example.com/next", "chat")).toBe(own);
    // The user goes back to their video while the agent works.
    setPreviewFront("views-6", "yt", true);
    b.handle.focusTab.mockClear();
    expect(await ensurePreview("chat")).toBe(own);
    expect(await previewForAddress("https://example.com/other", "chat")).toBe(own);
    expect(b.handle.focusTab).not.toHaveBeenCalled();
    // A screenshot needs its tab drawn.
    showAgentTab("chat");
    expect(b.handle.focusTab).toHaveBeenCalledWith("own");
    // The next message is about the page the user is looking at.
    setPreviewFront("views-6", "yt", true);
    startPreviewTurn("chat");
    expect(await ensurePreview("chat")).toBe(youtube);
    b.off();
  });

  it("falls back to the tab in front when the agent's tab closes", async () => {
    setPreviewSlots({ chat: "views-7" });
    const front = page("front", true);
    const own = page("own", false);
    const offFront = registerPreviewTab("views-7", "front", front);
    const offOwn = registerPreviewTab("views-7", "own", own);
    setPreviewFront("views-7", "own", true);
    expect(await ensurePreview("chat")).toBe(own);
    setPreviewFront("views-7", "front", true);
    offOwn();
    expect(await ensurePreview("chat")).toBe(front);
    offFront();
  });

  it("tells a browser's project, tabs and chat apart from the others'", () => {
    setPreviewSlots({ a: "views-10", b: "views-11" });
    const first = browser("views-10", { x: page("x", false) }, { front: "x", workspace: "D:\\a" });
    const second = browser("views-11", { y: page("y", true) }, { front: "y", visible: true, workspace: "ssh://host/b" });
    expect(previewWorkspace("a")).toBe("D:\\a");
    expect(previewWorkspace("b")).toBe("ssh://host/b");
    expect(previewSlotOf("a")).toBe("views-10");
    expect(previewTabsOf("views-10").map((t) => t.id)).toEqual(["x"]);
    first.off();
    second.off();
    expect(previewTabsOf("views-10")).toEqual([]);
  });
});

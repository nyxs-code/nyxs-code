// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://nyxspreview.localhost:23817/index.html"}
// The page bridge (src-tauri/src/agent/preview_agent.js) on a local page, one of the preview
// host's sites: its cookies stay its own, and an action's wait doesn't follow a hidden page's
// slow timers.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

type Bridge = Window & {
  __nyxsAgentRun: (id: string, cmd: string, args?: unknown) => string;
  __nyxsAgentTake: (id: string) => { pending?: boolean; ok?: boolean; result?: unknown; error?: string };
};
const w = window as unknown as Bridge;

// The browser's cookie jar, as the bridge found it.
const jar = Object.getOwnPropertyDescriptor(Document.prototype, "cookie") as PropertyDescriptor;
const rawCookies = () => jar.get!.call(document) as string;
const setRaw = (c: string) => jar.set!.call(document, c);

// A hidden page's timers: none fires sooner than a second, as Chromium does in a background tab.
const realSetTimeout = window.setTimeout.bind(window);
let hidden = false;
window.setTimeout = ((fn: () => void, ms?: number) => realSetTimeout(fn, hidden ? Math.max(1000, ms ?? 0) : ms)) as typeof window.setTimeout;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  new Function(readFileSync("src-tauri/src/agent/preview_agent.js", "utf8"))();
});

describe("cookies on a local page", () => {
  it("keeps the page's cookies under its own site's name", () => {
    document.cookie = "theme=dark; path=/";
    document.cookie = "  lang=es";
    expect(rawCookies()).toContain("nyxs23817_theme=dark");
    expect(rawCookies()).toContain("nyxs23817_lang=es");
    expect(document.cookie).toBe("theme=dark; lang=es");
  });

  it("doesn't see the cookies of another local site, and deletes its own", () => {
    setRaw("nyxs40001_session=other");
    expect(document.cookie).not.toContain("session");
    document.cookie = "theme=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    expect(document.cookie).toBe("lang=es");
    expect(rawCookies()).toContain("nyxs40001_session=other");
  });

  it("reads back a cookie with no name as it was set", () => {
    document.cookie = "flag";
    expect(document.cookie.split("; ")).toContain("flag");
  });
});

describe("an action on a hidden page", () => {
  it("settles as Nyxs asks for the result, not on the page's slowed timers", async () => {
    // A scroll: focusing a field would set a timer of jsdom's own (for the selection).
    document.body.innerHTML = '<p id="end">End</p>';
    window.scrollTo = () => {};
    hidden = true;
    try {
      const t0 = Date.now();
      w.__nyxsAgentRun("h1", "scroll", { to: "top" });
      // Nyxs asks every few ms at first, then every 80 ms.
      let r = w.__nyxsAgentTake("h1");
      for (let wait = 8; r.pending; wait = Math.min(wait * 2, 80)) {
        await new Promise((res) => realSetTimeout(res, wait));
        r = w.__nyxsAgentTake("h1");
      }
      expect(r.ok).toBe(true);
      expect(String(r.result)).toContain("Scrolled to");
      // Before, the wait's own 25 ms loop ran once a second here.
      expect(Date.now() - t0).toBeLessThan(500);
    } finally {
      hidden = false;
    }
  });
});

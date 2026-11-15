// @vitest-environment jsdom
// The page bridge (src-tauri/src/agent/preview_agent.js) in an embedded page of another site,
// where Nyxs runs it on Windows (src-tauri/src/preview_frames.rs). The page around the frame is
// another site, so the bridge there talks to Nyxs alone: no messages, no globals of its own,
// no wrapped console, and no real keys (they'd go wherever the focus is when they arrive).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Host = { trusted: boolean; keys?: boolean };
type Input = { kind: string; x?: number; y?: number; text?: string; key?: string };
type Api = {
  __nyxsAgentRun: (id: string, cmd: string, args: unknown, host?: Host) => string;
  __nyxsAgentTake: (id: string, host?: Host) => { pending?: boolean; input?: Input; ok?: boolean; result?: unknown; error?: string };
  __nyxsAgentInputDone: (id: string, ok: boolean) => void;
};
const KEY = "_frameKey1";
const bridge = readFileSync("src-tauri/src/agent/preview_agent.js", "utf8");
const install = () => {
  (window as unknown as Record<string, unknown>).__nyxsFrame = KEY;
  new Function(bridge)();
};
const api = () => (window as unknown as Record<string, Api>)[KEY];

const pageLog = console.log;
const pageFetch = () => Promise.resolve({ ok: true });
(window as unknown as { fetch: unknown }).fetch = pageFetch;
const realSetTimeout = window.setTimeout.bind(window);
const posted = vi.spyOn(window, "postMessage");
let before: string[] = [];

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50, x: 10, y: 20, toJSON: () => ({}) });
  Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as unknown as DOMRectList; };
  before = Object.getOwnPropertyNames(window);
  install();
});

let seq = 0;
async function run(cmd: string, args: unknown, perform: (input: Input) => boolean, host: Host = { trusted: true, keys: false }) {
  const id = `f${++seq}`;
  const asked: Input[] = [];
  api().__nyxsAgentRun(id, cmd, args, host);
  for (;;) {
    const r = api().__nyxsAgentTake(id, host);
    if (r.input) {
      asked.push(r.input);
      api().__nyxsAgentInputDone(id, perform(r.input));
    } else if (!r.pending) {
      if (!r.ok) throw new Error(r.error);
      return { out: String(r.result), asked };
    }
    await new Promise((res) => realSetTimeout(res, 5));
  }
}

describe("the bridge in a frame of another site", () => {
  it("keeps its functions under Nyxs' name alone, off the window's listing", () => {
    const added = Object.getOwnPropertyNames(window).filter((k) => !before.includes(k));
    expect(added).toEqual([KEY]);
    expect(Object.keys(window)).not.toContain(KEY);
    expect(typeof api().__nyxsAgentRun).toBe("function");
    expect("__nyxsAgentRun" in window).toBe(false);
    expect("__nyxsFrame" in window).toBe(false);
  });

  it("leaves the frame's console and fetch alone", () => {
    expect(console.log).toBe(pageLog);
    expect(window.fetch).toBe(pageFetch);
  });

  it("goes in once per document", () => {
    const first = api();
    install();
    expect(api()).toBe(first);
  });

  it("answers no message and posts none, so the page around it can't ask it for anything", async () => {
    document.body.innerHTML = '<input id="n" aria-label="Card number" value="4242 4242 4242 4242">';
    window.dispatchEvent(new MessageEvent("message", { data: { source: "nyxs-agent", id: "x", cmd: "snapshot", args: {} }, source: window }));
    window.dispatchEvent(new Event("load"));
    await new Promise((res) => realSetTimeout(res, 20));
    expect(posted).not.toHaveBeenCalled();
  });

  it("types with its own events, never asking for real keys", async () => {
    document.body.innerHTML = '<input id="n" aria-label="Card number">';
    const n = document.getElementById("n") as HTMLInputElement;
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => n;
    const { out, asked } = await run("fill", { selector: "#n", value: "4242" }, () => true);
    expect(asked).toEqual([]);
    expect(n.value).toBe("4242");
    expect(out).toMatch(/^Filled textbox "Card number"\./);
    n.focus();
    const pressed = await run("press", { key: "Enter" }, () => true);
    expect(pressed.asked).toEqual([]);
  });

  it("still asks for a real click, at a point of its own viewport", async () => {
    document.body.innerHTML = '<button id="b">Pay</button>';
    const b = document.getElementById("b") as HTMLButtonElement;
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => b;
    const { asked } = await run("click", { selector: "#b" }, () => { b.click(); return true; });
    expect(asked).toEqual([{ kind: "click", x: 60, y: 35 }]);
  });
});

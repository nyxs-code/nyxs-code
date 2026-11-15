// @vitest-environment jsdom
// The page bridge (src-tauri/src/agent/preview_agent.js) as it runs in a website's own webview
// on Windows: Nyxs follows the page's requests from the browser and sends the agent's clicks
// and keys as real input, which the bridge asks for while it runs a command.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

type Host = { trusted: boolean; keys?: boolean; inflight?: number; net?: string[]; console?: { level: string; text: string }[] };
type Input = { kind: string; x?: number; y?: number; text?: string; key?: string };
type Bridge = Window & {
  __nyxsAgentRun: (id: string, cmd: string, args: unknown, host?: Host) => string;
  __nyxsAgentTake: (id: string, host?: Host) => { pending?: boolean; input?: Input; ok?: boolean; result?: unknown; error?: string };
  __nyxsAgentInputDone: (id: string, ok: boolean) => void;
  __nyxsFramePoint: (ref: string, x: number, y: number) => { x: number; y: number } | null;
  __nyxsNative?: boolean;
};
const w = window as unknown as Bridge;

const pageFetch = () => Promise.resolve({ ok: true });
const pageOpen = XMLHttpRequest.prototype.open;
(window as unknown as { fetch: unknown }).fetch = pageFetch;
const realSetTimeout = window.setTimeout.bind(window);
const pageLog = console.log;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  // jsdom has no layout: every element is a 100x30 box at (10, 20).
  Element.prototype.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50, x: 10, y: 20, toJSON: () => ({}) });
  Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as unknown as DOMRectList; };
  w.__nyxsNative = true;
  new Function(readFileSync("src-tauri/src/agent/preview_agent.js", "utf8"))();
});

let target: Element | null = null;
beforeEach(() => {
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => target;
});

let seq = 0;
/** Runs a command as Nyxs does, doing each real input it asks for with `perform` (which says
 *  whether it worked) and telling it `host` on every call. */
async function run(cmd: string, args: unknown, perform: (input: Input) => boolean, host: () => Host = () => ({ trusted: true })) {
  const id = `n${++seq}`;
  const asked: Input[] = [];
  w.__nyxsAgentRun(id, cmd, args, host());
  for (;;) {
    const r = w.__nyxsAgentTake(id, host());
    if (r.input) {
      asked.push(r.input);
      w.__nyxsAgentInputDone(id, perform(r.input));
    } else if (!r.pending) {
      if (!r.ok) throw new Error(r.error);
      return { out: String(r.result), result: r.result, asked };
    }
    await new Promise((res) => realSetTimeout(res, 5));
  }
}

const button = () => {
  document.body.innerHTML = '<button id="b">Save</button>';
  target = document.getElementById("b");
  return target as HTMLButtonElement;
};

describe("the bridge in a website's webview", () => {
  it("leaves the page's fetch and XMLHttpRequest alone and hides its flag", () => {
    expect(window.fetch).toBe(pageFetch);
    expect(XMLHttpRequest.prototype.open).toBe(pageOpen);
    expect("__nyxsNative" in window).toBe(false);
  });

  it("asks for a real click at the element's center, in the page's viewport", async () => {
    const b = button();
    const clicks: boolean[] = [];
    b.addEventListener("click", (e) => clicks.push(e.isTrusted));
    const { out, asked } = await run("click", { selector: "#b" }, () => { b.click(); return true; });
    expect(asked).toEqual([{ kind: "click", x: 60, y: 35 }]);
    expect(out).toMatch(/^Clicked button "Save"\./);
    // Only the click Nyxs made: the bridge sent none of its own.
    expect(clicks).toHaveLength(1);
  });

  it("uses its own events where real input isn't there or fails", async () => {
    document.body.innerHTML = '<input id="q" aria-label="Query">';
    const q = document.getElementById("q") as HTMLInputElement;
    const keys: boolean[] = [];
    q.addEventListener("keydown", (e) => keys.push(e.isTrusted));
    q.focus();
    const none = await run("press", { key: "Escape" }, () => true, () => ({ trusted: false }));
    expect(none.asked).toEqual([]);
    const failed = await run("press", { key: "Escape" }, () => false);
    expect(failed.asked).toHaveLength(1);
    // Both times the bridge's own (untrusted) key event.
    expect(keys).toEqual([false, false]);
  });

  it("sends no real input to a hidden page, where it might not land", async () => {
    document.body.innerHTML = '<input id="q" aria-label="Query">';
    (document.getElementById("q") as HTMLInputElement).focus();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    try {
      const { asked } = await run("press", { key: "Enter" }, () => true);
      expect(asked).toEqual([]);
    } finally {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    }
  });

  it("still refuses an element that is covered, before any input", async () => {
    const b = button();
    document.body.insertAdjacentHTML("beforeend", '<div id="cover" role="dialog" aria-label="Cookies"></div>');
    target = document.getElementById("cover");
    await expect(run("click", { selector: "#b" }, () => true)).rejects.toThrow(/covered by dialog "Cookies"/);
    expect(b).toBeTruthy();
  });

  it("types a field's value for real, replacing what was there", async () => {
    document.body.innerHTML = '<input id="q" aria-label="Query" value="old">';
    const q = document.getElementById("q") as HTMLInputElement;
    target = q;
    const { out, asked } = await run("fill", { selector: "#q", value: "hola" }, (input) => {
      q.value = input.text ?? "";
      return true;
    });
    expect(asked).toEqual([{ kind: "text", text: "hola" }]);
    expect(out).toMatch(/^Filled textbox "Query"\./);
    expect(q.value).toBe("hola");
  });

  it("presses a key for real on the focused element", async () => {
    document.body.innerHTML = '<input id="q" aria-label="Query">';
    const q = document.getElementById("q") as HTMLInputElement;
    q.focus();
    const { out, asked } = await run("press", { key: "Shift+Tab" }, () => true);
    expect(asked).toEqual([{ kind: "key", key: "Shift+Tab" }]);
    expect(out).toMatch(/^Pressed Shift\+Tab on textbox "Query"\./);
  });

  it("clicks into an embedded page from another site at a point", async () => {
    document.body.innerHTML = '<iframe title="Payment" src="https://pay.example/form"></iframe>';
    target = document.querySelector("iframe");
    Object.defineProperty(target, "contentDocument", { get: () => null });
    const { out, asked } = await run("click_at", { x: 40, y: 30 }, () => true);
    expect(asked).toEqual([{ kind: "click", x: 40, y: 30 }]);
    expect(out).toMatch(/^Clicked inside .*Payment/);
    await expect(run("click_at", { x: 40, y: 30 }, () => false)).rejects.toThrow(/another site/);
  });

  it("leaves the page's console alone and keeps what Nyxs hands over from the browser", async () => {
    expect(console.log).toBe(pageLog);
    const host = () => ({ trusted: true, console: [{ level: "warn", text: "careful [object Object]" }] });
    const { out } = await run("console", {}, () => true, host);
    expect(out).toContain("[warn] careful [object Object]");
  });

  /** A frame of another site the page embeds, 300x150, its document out of the bridge's reach. */
  const foreignFrame = () => {
    document.body.innerHTML = '<h1>Pay</h1><iframe name="card" title="Card" src="https://pay.example/form"></iframe>';
    const f = document.querySelector("iframe") as HTMLIFrameElement;
    Object.defineProperty(f, "contentDocument", { get: () => null });
    Object.defineProperty(f, "clientWidth", { get: () => 300 });
    Object.defineProperty(f, "clientHeight", { get: () => 150 });
    return f;
  };

  it("lists the frames of other sites for Nyxs, with what tells them apart", async () => {
    foreignFrame();
    const { result } = await run("snapshot", { area: "page", frames: true }, () => true);
    const { text, frames } = result as { text: string; frames: Record<string, unknown>[] };
    const body = text.split("\n\n")[1].split("\n");
    expect(frames).toEqual([{ ref: expect.stringMatching(/^e\d+$/), name: "card", src: "https://pay.example/form", width: 300, height: 150, line: 1, depth: 1 }]);
    // The note stays on the line until Nyxs fills it in, and the iframe's ref isn't shown.
    expect(body[1]).toBe('- iframe "Card" (another site: its content can\'t be read; use click_at on a screenshot)');

    const found = (await run("find", { query: "pay", frames: true }, () => true)).result as { total: number; lines: string[]; frames: unknown[]; query: string };
    expect(found).toMatchObject({ query: "pay", total: 1, frames: [expect.objectContaining({ name: "card", line: null })] });
    expect(found.lines[0]).toMatch(/^- heading "Pay"/);
  });

  it("places a point of a frame in the page, only inside it and where nothing covers it", async () => {
    const f = foreignFrame();
    const { result } = await run("snapshot", { area: "page", frames: true }, () => true);
    const ref = (result as { frames: { ref: string }[] }).frames[0].ref;
    target = f;
    // Every box is at (10, 20) here.
    expect(w.__nyxsFramePoint(ref, 5, 6)).toEqual({ x: 15, y: 26 });
    expect(w.__nyxsFramePoint(ref, 300, 6)).toBeNull();
    expect(w.__nyxsFramePoint(ref, -1, 6)).toBeNull();
    target = document.querySelector("h1");
    expect(w.__nyxsFramePoint(ref, 5, 6)).toBeNull();
    // Only an iframe's ref places a point.
    expect(w.__nyxsFramePoint("e999", 5, 6)).toBeNull();
  });

  it("waits for the requests the action started, as the browser reports them, and lists their failures", async () => {
    const b = button();
    const t0 = Date.now();
    const host = () => ({ trusted: true, inflight: Date.now() - t0 < 300 ? 1 : 0, net: Date.now() - t0 > 250 ? ["POST https://a.com/save -> 500"] : [] });
    const { out } = await run("click", { selector: "#b" }, () => { b.click(); return true; }, host);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(out).toContain("[network] POST https://a.com/save -> 500");
  });
});

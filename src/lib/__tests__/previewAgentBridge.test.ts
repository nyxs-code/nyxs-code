// @vitest-environment jsdom
// The page bridge (src-tauri/src/agent/preview_agent.js) run in jsdom: how an action waits for
// what the page does after it, and where the annotation layer draws as the page scrolls.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

type Bridge = Window & {
  __nyxsAgentRun: (id: string, cmd: string, args?: unknown) => string;
  __nyxsAgentTake: (id: string) => { pending?: boolean; ok?: boolean; result?: unknown; error?: string };
};
const w = window as unknown as Bridge;

// The page's own request, answered after 100 ms. The bridge wraps it when it loads.
const realSetTimeout = window.setTimeout.bind(window);
(window as unknown as { fetch: unknown }).fetch = () =>
  new Promise((resolve) => realSetTimeout(() => resolve({ ok: true, status: 200, url: "http://page/api" }), 100));

// The page's own timer functions, which it should see whenever no action is settling.
const pageTimers = { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, clearInterval: window.clearInterval };
const ownTimers = () => window.setTimeout === pageTimers.setTimeout && window.clearTimeout === pageTimers.clearTimeout && window.clearInterval === pageTimers.clearInterval;

// Draw calls on the annotation canvas (jsdom has no canvas).
let calls: { name: string; args: number[] }[] = [];
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({}, {
      get: (_t, name: string) => (...args: number[]) => { calls.push({ name, args }); },
      set: () => true,
    });
  } as unknown as HTMLCanvasElement["getContext"];
  new Function(readFileSync("src-tauri/src/agent/preview_agent.js", "utf8"))();
});

let seq = 0;
async function run(cmd: string, args: unknown = {}): Promise<string> {
  const id = `t${++seq}`;
  w.__nyxsAgentRun(id, cmd, args);
  for (;;) {
    const r = w.__nyxsAgentTake(id);
    if (!r.pending) {
      if (!r.ok) throw new Error(r.error);
      return String(r.result);
    }
    await new Promise((res) => realSetTimeout(res, 5));
  }
}

/** Runs `fill` on a field whose input handler is `onInput`, and how long the action took. */
async function fillWith(onInput: (field: HTMLInputElement) => void) {
  document.body.innerHTML = '<input id="q" aria-label="Query">';
  const field = document.getElementById("q") as HTMLInputElement;
  field.addEventListener("input", () => onInput(field));
  const t0 = Date.now();
  const out = await run("fill", { selector: "#q", value: "x" });
  return { out, ms: Date.now() - t0 };
}

const showDialog = () => {
  const d = document.createElement("div");
  d.setAttribute("role", "dialog");
  d.setAttribute("aria-label", "Saved");
  document.body.appendChild(d);
};

describe("the wait after an action", () => {
  it("doesn't slow down an action on a page with no timers", async () => {
    const { out, ms } = await fillWith(() => {});
    expect(out).toContain("Filled");
    // 100 ms of quiet, as before.
    expect(ms).toBeLessThan(300);
  });

  it("sees a dialog the page opens 300 ms after the action", async () => {
    const { out, ms } = await fillWith(() => window.setTimeout(showDialog, 300));
    expect(out).toContain('"Saved"');
    expect(ms).toBeGreaterThanOrEqual(300);
  });

  it("sees a dialog opened 300 ms after the server answers (a timer set from the request's callback)", async () => {
    const { out } = await fillWith(() => { void fetch("/api").then(() => window.setTimeout(showDialog, 300)); });
    expect(out).toContain('"Saved"');
  });

  it("doesn't wait for a timer the page cleared, or one due long after the action", async () => {
    const cleared = await fillWith(() => window.clearTimeout(window.setTimeout(showDialog, 600)));
    expect(cleared.ms).toBeLessThan(300);
    const late = await fillWith(() => window.setTimeout(showDialog, 1500));
    expect(late.ms).toBeLessThan(300);
    expect(late.out).not.toContain('"Saved"');
  });

  it("doesn't let a page that polls hold every action up", async () => {
    let stop = false;
    // Polling with an interval: never waited for.
    const interval = window.setInterval(() => { document.body.dataset.tick = String(Date.now()); }, 200);
    const withInterval = await fillWith(() => {});
    window.clearInterval(interval);
    expect(withInterval.ms).toBeLessThan(500);

    // Polling with a chain of timeouts started by the action: waited for up to about 1 s, not
    // the full 2 s cap.
    const poll = () => {
      if (stop) return;
      document.body.dataset.tick = String(Date.now());
      window.setTimeout(poll, 250);
    };
    const chained = await fillWith(() => window.setTimeout(poll, 250));
    stop = true;
    expect(chained.ms).toBeLessThan(1600);
  });

  it("only wraps the page's timer functions while an action settles", async () => {
    expect(ownTimers()).toBe(true);
    let during = true;
    await fillWith(() => { during = ownTimers(); });
    expect(during).toBe(false);
    expect(ownTimers()).toBe(true);
    // An action that fails gives them back too.
    document.body.innerHTML = '<button id="b" disabled>Save</button>';
    await expect(run("click", { selector: "#b" })).rejects.toThrow(/disabled/);
    expect(ownTimers()).toBe(true);
  });

  it("keeps a timer wrapper the page put on during an action, still counting its timers", async () => {
    let pageWrap: typeof window.setTimeout | null = null;
    const first = await fillWith(() => {
      const inner = window.setTimeout;
      pageWrap = ((fn: () => void, ms?: number) => inner(fn, ms)) as typeof window.setTimeout;
      window.setTimeout = pageWrap;
    });
    expect(first.out).toContain("Filled");
    expect(window.setTimeout).toBe(pageWrap);
    // Through the page's wrapper, the next action still waits for its short timer.
    const { out } = await fillWith(() => window.setTimeout(showDialog, 300));
    expect(out).toContain('"Saved"');
  });
});

describe("the annotation layer", () => {
  const canvas = () => document.querySelector("canvas[data-nyxs-annotations]") as HTMLCanvasElement;
  const setScroll = (x: number, y: number) => {
    Object.defineProperty(window, "scrollX", { value: x, configurable: true });
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  };
  /** Draws a rectangle by dragging from (x1, y1) to (x2, y2) on the canvas. */
  const drag = (x1: number, y1: number, x2: number, y2: number) => {
    const c = canvas();
    c.dispatchEvent(new MouseEvent("pointerdown", { clientX: x1, clientY: y1, button: 0, bubbles: true }));
    c.dispatchEvent(new MouseEvent("pointermove", { clientX: x2, clientY: y2, bubbles: true }));
    c.dispatchEvent(new MouseEvent("pointerup", { clientX: x2, clientY: y2, bubbles: true }));
  };
  /** Where the last redraw put the first shape: its translation and its rectangle. */
  const drawn = () => {
    const t = calls.filter((c) => c.name === "translate").at(-1)?.args.map((n) => n + 0);
    const r = calls.filter((c) => c.name === "strokeRect").at(-1)?.args;
    const clip = calls.filter((c) => c.name === "rect").at(-1)?.args;
    return { t, r, clip };
  };
  const redraw = (target: EventTarget = document) => {
    calls = [];
    target.dispatchEvent(new Event("scroll"));
  };
  let under: Element[] = [];

  beforeEach(async () => {
    await run("annotate_end");
    document.body.innerHTML = "";
    setScroll(0, 0);
    await run("annotate", { tool: "rect", color: "#e03131", width: 4 });
    document.elementsFromPoint = () => [canvas(), ...under];
    under = [document.body];
  });

  it("keeps a drawing on the page content as the page scrolls", async () => {
    setScroll(0, 100);
    drag(10, 20, 60, 80);
    setScroll(0, 300);
    redraw();
    // Drawn 100 px down the page; the page is now 300 px down, so it sits 200 px higher.
    expect(drawn().t).toEqual([0, -300]);
    expect(drawn().r).toEqual([10, 120, 50, 60]);
  });

  it("scrolls a drawing with the box it was drawn in, clipped to that box", async () => {
    const list = document.createElement("div");
    list.style.overflowY = "auto";
    document.body.appendChild(list);
    let top = 0;
    Object.defineProperties(list, {
      scrollHeight: { value: 500 },
      clientHeight: { value: 100 },
      clientWidth: { value: 200 },
      scrollTop: { get: () => top },
      getBoundingClientRect: { value: () => ({ left: 5, top: 50, right: 205, bottom: 150, width: 200, height: 100 }) },
    });
    under = [list, document.body];
    drag(20, 70, 40, 90);
    top = 30;
    // The page itself scrolling doesn't move it.
    setScroll(0, 400);
    redraw(list);
    expect(drawn().t).toEqual([5, 20]);
    expect(drawn().r).toEqual([15, 20, 20, 20]);
    expect(drawn().clip).toEqual([5, 50, 200, 100]);
  });

  it("keeps a drawing on a fixed bar in place, and pins one that spans boxes to the page", async () => {
    const bar = document.createElement("header");
    bar.style.position = "fixed";
    document.body.appendChild(bar);
    under = [bar, document.body];
    drag(10, 5, 100, 30);
    setScroll(0, 250);
    redraw();
    expect(drawn().t).toEqual([0, 0]);

    // From the bar down to the page: pinned to the page.
    await run("annotate_clear");
    setScroll(0, 0);
    document.elementsFromPoint = (_x, y) => [canvas(), ...(y < 40 ? [bar, document.body] : [document.body])];
    drag(10, 5, 100, 200);
    setScroll(0, 50);
    redraw();
    expect(drawn().t).toEqual([0, -50]);
  });
});

describe("fill says what the field ended up holding", () => {
  const field = (html: string) => {
    document.body.innerHTML = html;
    return document.body.firstElementChild as HTMLInputElement;
  };

  it("fails when the field didn't take the value, naming the format it wants", async () => {
    field('<input type="date" aria-label="Fecha">');
    await expect(run("fill", { selector: "input", value: "31/12/2026" })).rejects.toThrow(/stayed empty.*31\/12\/2026.*YYYY-MM-DD/);
    field('<input type="number" aria-label="Cantidad">');
    await expect(run("fill", { selector: "input", value: "1,5" })).rejects.toThrow(/stayed empty.*1\.5/);
    field('<input type="date" aria-label="Fecha">');
    expect(await run("fill", { selector: "input", value: "2026-12-31" })).toMatch(/^Filled textbox "Fecha"\.$/m);
  });

  it("says when the page changed what was typed, without repeating a password", async () => {
    const phone = field('<input aria-label="Teléfono">');
    phone.addEventListener("input", () => { phone.value = "(555) 123-4567"; });
    expect(await run("fill", { selector: "input", value: "5551234567" })).toContain('it now holds "(555) 123-4567", not "5551234567"');
    const pass = field('<input type="password" aria-label="Clave" maxlength="4">');
    pass.addEventListener("input", () => { pass.value = pass.value.slice(0, 4); });
    const out = await run("fill", { selector: "input", value: "hunter22" });
    expect(out).toContain("4 characters, not 8 characters");
    expect(out).not.toContain("hunt");
  });

  it("names the fields that came out different in fill_form", async () => {
    document.body.innerHTML = '<input id="a" aria-label="Nombre"><input id="d" type="date" aria-label="Fecha">';
    await expect(
      run("fill_form", { fields: [{ selector: "#a", value: "Ana" }, { selector: "#d", value: "mañana" }] }),
    ).rejects.toThrow(/Filled textbox "Nombre"\. Field 2 failed: .*stayed empty/);
  });
});

describe("scroll reaches the box that scrolls", () => {
  it("scrolls the container under the middle of the window when the window can't scroll", async () => {
    document.body.innerHTML = '<main aria-label="Mensajes" style="overflow-y:auto"><p>uno</p></main>';
    const box = document.querySelector("main") as HTMLElement;
    Object.defineProperty(box, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(box, "clientHeight", { value: 500, configurable: true });
    const doc = document as Document & { elementFromPoint: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => box.querySelector("p");
    try {
      const out = await run("scroll", { y: 300 });
      expect(box.scrollTop).toBe(300);
      expect(out).toMatch(/^Scrolled main "Mensajes" to 300px\./);
      await run("scroll", { to: "top" });
      expect(box.scrollTop).toBe(0);
    } finally {
      doc.elementFromPoint = original;
    }
  });
});

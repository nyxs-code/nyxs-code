import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** A Storage kept in memory, standing in for the webview's local and session storage. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
  };
}

/** `navigator.locks` of the profile. WebView2 keeps them in the browser process every window
 *  of the profile shares, so a lock one page holds is seen from the others until it ends. */
function fakeLocks() {
  const held: { name: string; page: number }[] = [];
  let page = 0;
  const manager = (owner: number) => ({
    request: (name: string, _opts: unknown, cb: () => Promise<void>) => {
      const lock = { name, page: owner };
      held.push(lock);
      return cb().finally(() => held.splice(held.indexOf(lock), 1));
    },
    query: async () => ({ held: held.map((l) => ({ name: l.name, mode: "shared", clientId: String(l.page) })), pending: [] }),
  });
  return {
    page: () => manager(++page),
    /** Every page so far is gone: the browser drops their locks. */
    dropAll: () => void held.splice(0),
  };
}

let local: Storage;
let session: Storage;
let locks: ReturnType<typeof fakeLocks>;

const loadPage = () => {
  vi.resetModules();
  vi.stubGlobal("navigator", { locks: locks.page() });
  return import("@/lib/interruptedTurns");
};

/** A fresh page of the app in place of the last one: the module's own state starts over, the
 *  storages stay as they were, and the old page's locks and timers go with it. */
const newPage = () => {
  locks.dropAll();
  vi.clearAllTimers();
  return loadPage();
};

/** A second window of the app, opened while the first one is still running. */
const secondWindow = loadPage;

/** The app closing: localStorage stays, sessionStorage goes. */
const restartApp = () => {
  session = memoryStorage();
  vi.stubGlobal("sessionStorage", session);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
  local = memoryStorage();
  session = memoryStorage();
  locks = fakeLocks();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", session);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("interruptedTurns", () => {
  it("carries on by itself a turn the app was killed in a moment ago", async () => {
    const page = await newPage();
    page.rememberApiTurn("c1", "openai:gpt", true);
    restartApp();
    vi.advanceTimersByTime(60_000);
    const next = await newPage();
    expect(await next.takeInterruptedApiTurns()).toEqual({ c1: { modelId: "openai:gpt", thinking: true, auto: true } });
    // Taking them clears the list: nothing is resumed twice.
    expect(await next.takeInterruptedApiTurns()).toEqual({});
  });

  it("asks before carrying on a turn cut long ago, measured from the page's last heartbeat", async () => {
    const page = await newPage();
    page.rememberApiTurn("c1", "openai:gpt", false);
    // A long turn keeps itself fresh while it runs, so it's the time since the page died that
    // counts, not since the turn started.
    vi.advanceTimersByTime(page.AUTO_RESUME_MS * 3);
    const late = Date.now() + page.AUTO_RESUME_MS + page.HEARTBEAT_MS + 1;
    restartApp();
    const fresh = await newPage();
    expect(await fresh.takeInterruptedApiTurns(late)).toEqual({ c1: { modelId: "openai:gpt", thinking: false, auto: false } });
  });

  it("asks before carrying on a turn whose window the user closed, but not after a reload", async () => {
    const closed = await newPage();
    closed.rememberApiTurn("c1", "openai:gpt", false);
    closed.markPageUnloading();
    restartApp();
    expect(await (await newPage()).takeInterruptedApiTurns()).toEqual({ c1: { modelId: "openai:gpt", thinking: false, auto: false } });

    const reloaded = await newPage();
    reloaded.rememberApiTurn("c2", "openai:gpt", false);
    reloaded.markPageUnloading();
    // A reload keeps sessionStorage, where the page left its mark.
    vi.advanceTimersByTime(reloaded.AUTO_RESUME_MS * 2);
    expect(await (await newPage()).takeInterruptedApiTurns()).toEqual({ c2: { modelId: "openai:gpt", thinking: false, auto: true } });
  });

  it("forgets a turn that ended in the page, including one the user stopped", async () => {
    const page = await newPage();
    page.rememberApiTurn("c1", "openai:gpt", false);
    page.rememberApiTurn("c2", "openai:gpt", false);
    page.forgetApiTurn("c1");
    restartApp();
    expect(Object.keys(await (await newPage()).takeInterruptedApiTurns())).toEqual(["c2"]);
  });

  it("doesn't take a turn the new page already started in the same chat", async () => {
    const old = await newPage();
    old.rememberApiTurn("c1", "openai:gpt", false);
    old.rememberApiTurn("c2", "openai:gpt", false);
    restartApp();
    const page = await newPage();
    page.rememberApiTurn("c1", "openai:mini", false);
    expect(await page.takeInterruptedApiTurns()).toEqual({ c2: { modelId: "openai:gpt", thinking: false, auto: true } });
    restartApp();
    expect(await (await newPage()).takeInterruptedApiTurns()).toEqual({ c1: { modelId: "openai:mini", thinking: false, auto: true } });
  });

  it("leaves alone, and on the list, a turn another open window is running", async () => {
    const first = await newPage();
    first.rememberApiTurn("c1", "openai:gpt", false);
    const second = await secondWindow();
    expect(await second.takeInterruptedApiTurns()).toEqual({});
    // The first window is still covered: once it dies, the next page carries its turn on.
    restartApp();
    expect(await (await newPage()).takeInterruptedApiTurns()).toEqual({ c1: { modelId: "openai:gpt", thinking: false, auto: true } });
  });

  it("puts its turn back on the list if another window took it off", async () => {
    const page = await newPage();
    page.rememberApiTurn("c1", "openai:gpt", true);
    local.removeItem("nyxs.apiTurns");
    vi.advanceTimersByTime(page.HEARTBEAT_MS);
    restartApp();
    expect(await (await newPage()).takeInterruptedApiTurns()).toEqual({ c1: { modelId: "openai:gpt", thinking: true, auto: true } });
  });

  it("stops carrying on by itself a turn that keeps taking the page down", async () => {
    const MAX = (await newPage()).MAX_AUTO_RESUMES;
    let page = await newPage();
    page.rememberApiTurn("c1", "openai:gpt", false);
    const autos: boolean[] = [];
    for (let i = 0; i <= MAX; i++) {
      restartApp();
      vi.advanceTimersByTime(30_000);
      page = await newPage();
      const taken = await page.takeInterruptedApiTurns();
      autos.push(taken.c1.auto);
      // The resumed turn runs in the new page, and the page dies again.
      if (taken.c1.auto) page.rememberApiTurn("c1", "openai:gpt", false);
    }
    expect(autos).toEqual([...Array<boolean>(MAX).fill(true), false]);
    // Once a turn ends in the page, the next one that's cut gets its own tries.
    page.rememberApiTurn("c1", "openai:gpt", false);
    page.forgetApiTurn("c1");
    page.rememberApiTurn("c1", "openai:gpt", false);
    restartApp();
    expect((await (await newPage()).takeInterruptedApiTurns()).c1.auto).toBe(true);
  });

  it("ignores a list it can't read", async () => {
    local.setItem("nyxs.apiTurns", "{not json");
    expect(await (await newPage()).takeInterruptedApiTurns()).toEqual({});
  });
});

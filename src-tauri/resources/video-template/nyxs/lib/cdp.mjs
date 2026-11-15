// A minimal Chrome DevTools Protocol client over --remote-debugging-pipe, so the runtime can drive
// the Chrome Headless Shell Remotion already downloaded without adding Playwright (its package and
// browsers would only duplicate that) or depending on Node's WebSocket, which Node 18 lacks.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class Chrome {
  #child;
  #pipeIn;
  #seq = 0;
  #pending = new Map();
  #listeners = new Map();
  #buffer = [];
  closed = false;

  constructor(child, profile) {
    this.#child = child;
    this.profile = profile;
    this.#pipeIn = child.stdio[3];
    child.stdio[4].on("data", (chunk) => this.#read(chunk));
    // Nothing reads Chrome's own logs; left unread, a full pipe would freeze the browser.
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("exit", () => {
      this.closed = true;
      for (const { reject, method } of this.#pending.values()) {
        reject(new Error(`The browser exited during ${method}.`));
      }
      this.#pending.clear();
    });
  }

  #read(chunk) {
    let start = 0;
    for (let end = chunk.indexOf(0, start); end !== -1; end = chunk.indexOf(0, start)) {
      this.#buffer.push(chunk.subarray(start, end));
      this.#dispatch(JSON.parse(Buffer.concat(this.#buffer).toString("utf8")));
      this.#buffer = [];
      start = end + 1;
    }
    if (start < chunk.length) this.#buffer.push(chunk.subarray(start));
  }

  #dispatch(msg) {
    if (msg.id !== undefined) {
      const call = this.#pending.get(msg.id);
      if (!call) return;
      this.#pending.delete(msg.id);
      if (msg.error) call.reject(new Error(`${call.method}: ${msg.error.message}`));
      else call.resolve(msg.result);
      return;
    }
    for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("The browser is closed."));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#pipeIn.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  }

  on(method, fn) {
    const list = this.#listeners.get(method) ?? [];
    list.push(fn);
    this.#listeners.set(method, list);
  }

  off(method, fn) {
    this.#listeners.set(method, (this.#listeners.get(method) ?? []).filter((f) => f !== fn));
  }

  async close() {
    if (!this.closed) {
      const exited = new Promise((r) => this.#child.once("exit", r));
      await Promise.race([
        this.send("Browser.close").catch(() => {}),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      if (!this.closed) this.#child.kill();
    }
    // The profile stays locked for a moment after the exit on Windows.
    fs.rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Starts Chrome with a throwaway profile: never the user's logins, cookies or history. */
export function launchChrome(executable, extraArgs = []) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nyxs-chrome-"));
  const child = spawn(
    executable,
    [
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "--force-color-profile=srgb",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--disable-extensions",
      ...extraArgs,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], windowsHide: true },
  );
  return new Promise((resolve, reject) => {
    child.once("error", (e) => reject(new Error(`Couldn't start the browser: ${e.message}`)));
    child.once("spawn", () => resolve(new Chrome(child, profile)));
  });
}

/** One plain page in `chrome`, for tasks that only draw and capture. */
export async function openPlainPage(chrome, { width, height, scale = 1 }) {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => chrome.send(method, params, sessionId);
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  return { send, sessionId, targetId };
}

/** Navigates and waits for the load event. */
export function navigate(chrome, page, url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      chrome.off("Page.loadEventFired", onLoad);
    };
    const onLoad = (_p, sessionId) => {
      if (sessionId !== page.sessionId) return;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${url} didn't finish loading in ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    chrome.on("Page.loadEventFired", onLoad);
    page.send("Page.navigate", { url }).then(
      (r) => {
        if (r.errorText) {
          cleanup();
          reject(new Error(`Couldn't open ${url}: ${r.errorText}`));
        }
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

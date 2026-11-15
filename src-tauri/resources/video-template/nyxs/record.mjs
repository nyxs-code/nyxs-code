// Films a web page into a clip: drives Remotion's Chrome Headless Shell through scripted steps with
// a visible cursor and captures it with the DevTools screencast, then encodes at a constant rate.
// READ-ONLY BY DEFAULT: every request that isn't GET/HEAD/OPTIONS is answered locally unless it
// matches `allowWrites`, so filming a real app can't change it. Mocked routes inject demo data.
//
//   node <runtime>/nyxs/record.mjs --project <dir> <options.json>
//
// Options are written by the app (src-tauri/src/video/tools.rs). Events as in render.mjs:
// {"type":"progress"|"done"|"error", ...}.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchChrome, navigate } from "./lib/cdp.mjs";
import { chromeExecutable, emit, ff, readRequest, runTask } from "./lib/common.mjs";

const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_TIMEOUT_MS = 12000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `*` matches anything, or a string starting and ending in `/` is a regular expression. */
export function urlMatcher(pattern) {
  if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    const re = new RegExp(pattern.slice(1, -1));
    return (url) => re.test(url);
  }
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return (url) => re.test(url);
}

/**
 * What to do with a request: a mocked answer, let it through, or stop it. Mocks win so demo data
 * can answer a write; a write that isn't allowed never reaches the network.
 */
export function decideRequest({ url, method }, routes, allowWrites) {
  const route = routes.find((r) => r.match(url) && (!r.method || r.method === method));
  if (route) return { action: "mock", route };
  if (READ_METHODS.has(method) || allowWrites.some((m) => m(url))) return { action: "continue" };
  return { action: "block" };
}

/** The script every page and frame gets first: the socket block, then the optional setup. */
function pageSetup({ cursor, allowWebSockets, localStorage, initScript }) {
  const allowed = JSON.stringify(allowWebSockets ?? []);
  const seed = JSON.stringify(localStorage ?? {});
  return `(() => {
${socketBlock(allowed)}
${cursor ? CURSOR : ""}
try { for (const [k, v] of Object.entries(${seed})) window.localStorage.setItem(k, v); } catch {}
})();
${initScript ?? ""}`;
}

/** WebSockets and peers can write and the request interception can't see them. The stand-in stays
 *  "connecting" forever: a socket that closes would make dev servers and apps retry or reload. */
function socketBlock(allowed) {
  return `const allowed = ${allowed}.map((p) => new RegExp("^" + p.replace(/[.+?^\${}()|[\\]\\\\]/g, "\\\\$&").replace(/\\*/g, ".*") + "$"));
const Real = globalThis.WebSocket;
if (Real) {
  const Stand = function (url, protocols) {
    if (allowed.some((r) => r.test(String(url)))) return new Real(url, protocols);
    const t = new EventTarget();
    Object.assign(t, { url: String(url), readyState: 0, protocol: "", extensions: "", bufferedAmount: 0, binaryType: "blob", send() {}, close() {}, onopen: null, onclose: null, onerror: null, onmessage: null });
    return t;
  };
  Object.assign(Stand, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: Real.prototype });
  globalThis.WebSocket = Stand;
}
for (const name of ["WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection"]) { try { delete globalThis[name]; } catch {} }`;
}

const CURSOR = `const mount = () => {
  if (window.top !== window || window.__nyxsCursor) return;
  if (!document.documentElement) return requestAnimationFrame(mount);
  const c = document.createElement("div");
  c.style.cssText = "position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);will-change:transform";
  c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 3 L5 19.5 L9.3 15.7 L12.3 21.7 L15 20.4 L12 14.5 L17.6 14.3 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const ring = document.createElement("div");
  ring.style.cssText = "position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid currentColor;color:#f97316;opacity:0;z-index:2147483646;pointer-events:none";
  document.documentElement.append(ring, c);
  addEventListener("mousemove", (e) => {
    c.style.transform = "translate(" + (e.clientX - 4) + "px," + (e.clientY - 2) + "px)";
    ring.style.left = e.clientX + "px";
    ring.style.top = e.clientY + "px";
  }, true);
  addEventListener("mousedown", () => ring.animate([{ opacity: 0.9, transform: "scale(.3)" }, { opacity: 0, transform: "scale(1.25)" }], { duration: 420, easing: "ease-out" }), true);
  window.__nyxsCursor = c;
};
mount();`;

/** Finds an element by CSS selector or visible text; returns its box when it's on screen. */
const LOCATE = `(selector, text, nth) => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
  };
  let found = [];
  if (selector) {
    found = [...document.querySelectorAll(selector)].filter(visible);
  } else {
    const needle = text.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    const clickable = "a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=option]";
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      // Falsy, not nullish: a button's value is an empty string, and its text is what we want.
      const own = String(n.innerText || n.value || n.placeholder || n.getAttribute("aria-label") || "");
      if (!own.toLowerCase().includes(needle) || !visible(n)) continue;
      // The innermost match: an ancestor always contains its descendant's text.
      found = found.filter((f) => !f.contains(n));
      found.push(n);
    }
    found = found.map((el) => el.closest(clickable) ?? el);
  }
  const el = found[nth ?? 0];
  if (!el) return null;
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, tag: el.tagName.toLowerCase() };
}`;

const KEYS = {
  Enter: [13, "\r"], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], Space: [32, " "],
  ArrowLeft: [37], ArrowUp: [38], ArrowRight: [39], ArrowDown: [40], Home: [36], End: [35], PageUp: [33], PageDown: [34],
};
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };

class Session {
  constructor(chrome, sessionId, viewport) {
    this.chrome = chrome;
    this.sessionId = sessionId;
    this.send = (method, params) => chrome.send(method, params, sessionId);
    this.pos = { x: viewport.width * 0.55, y: viewport.height * 0.6 };
    this.started = null;
    this.events = [];
    this.warnings = [];
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      const msg = exceptionDetails.exception?.description ?? exceptionDetails.text;
      throw new Error(`The page's script failed: ${msg}`);
    }
    return result.value;
  }

  locate({ selector, text, nth }) {
    const args = [selector ?? null, text ?? null, nth ?? 0].map((a) => JSON.stringify(a)).join(",");
    return this.evaluate(`(${LOCATE})(${args})`);
  }

  /** Waits until the element exists and stops moving: late data shifts rows under a stale box. */
  async settledBox(step, timeoutMs) {
    const end = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < end) {
      const box = await this.locate(step);
      if (box && last && Math.abs(box.x - last.x) < 1 && Math.abs(box.y - last.y) < 1) return box;
      last = box;
      await sleep(120);
    }
    if (last) return last;
    throw new Error(`Not found within ${Math.round(timeoutMs / 1000)} s: ${describeTarget(step)}.`);
  }

  async glide(x, y, ms) {
    const from = { ...this.pos };
    const n = Math.max(1, Math.round(ms / 16));
    const ease = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: from.x + (x - from.x) * k,
        y: from.y + (y - from.y) * k,
      });
      await sleep(ms / n);
    }
    this.pos = { x, y };
  }

  async mouse(type, button = "left") {
    await this.send("Input.dispatchMouseEvent", { type, ...this.pos, button, clickCount: 1 });
  }

  log(type, step, box) {
    const t = this.started ? (Date.now() - this.started) / 1000 : 0;
    this.events.push({
      t: Math.round(t * 1000) / 1000,
      type,
      ...(box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) } : {}),
      ...(step.label ? { label: step.label } : {}),
    });
  }

  async key(spec) {
    const parts = spec.split("+");
    const name = parts.pop();
    const modifiers = parts.reduce((m, p) => m | (MODIFIERS[p] ?? 0), 0);
    const known = KEYS[name];
    const code = known?.[0] ?? name.toUpperCase().charCodeAt(0);
    const text = modifiers & ~8 ? undefined : (known ? known[1] : name);
    const base = { key: name === "Space" ? " " : name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}

function describeTarget({ selector, text, nth }) {
  const what = selector ? `selector ${JSON.stringify(selector)}` : `text ${JSON.stringify(text)}`;
  return nth ? `${what} (match ${nth})` : what;
}

/** Runs one step of the script. */
async function runStep(s, step, opts, startCapture) {
  const timeout = step.timeoutMs ?? opts.stepTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  switch (step.type) {
    case "goto": {
      if (!step.url) throw new Error("goto needs a url.");
      await navigate(s.chrome, { send: s.send, sessionId: s.sessionId }, step.url, step.timeoutMs ?? 45000);
      await sleep(step.settleMs ?? 600);
      // Footage starts once the opening view has loaded, not on a blank page.
      await startCapture();
      s.log("goto", step);
      return;
    }
    case "hover":
    case "click": {
      const box = await s.settledBox(step, timeout);
      await s.glide(box.x + box.w / 2, box.y + box.h / 2, step.moveMs ?? 650);
      s.log(step.type, step, box);
      if (step.type === "click") {
        await sleep(90);
        await s.mouse("mousePressed");
        await sleep(50);
        await s.mouse("mouseReleased");
      }
      return;
    }
    case "type": {
      if (typeof step.text !== "string") throw new Error("type needs text.");
      if (step.selector) {
        const box = await s.settledBox({ selector: step.selector, nth: step.nth }, timeout);
        await s.glide(box.x + box.w / 2, box.y + box.h / 2, step.moveMs ?? 500);
        s.log("type", step, box);
        await s.mouse("mousePressed");
        await s.mouse("mouseReleased");
        await sleep(120);
      } else {
        s.log("type", step);
      }
      for (const ch of step.text) {
        await s.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
        await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        await sleep(step.delayMs ?? 42);
      }
      return;
    }
    case "press":
      if (!step.key) throw new Error("press needs a key.");
      await s.key(step.key);
      s.log("press", step);
      return;
    case "scroll": {
      s.log("scroll", step);
      const ms = step.durationMs ?? 900;
      if (step.selector || step.text) {
        await s.evaluate(`(() => {
          const box = (${LOCATE})(${JSON.stringify(step.selector ?? null)}, ${JSON.stringify(step.text ?? null)}, ${step.nth ?? 0});
          if (!box) throw new Error(${JSON.stringify(`Not found: ${describeTarget(step)}.`)});
        })()`);
        await sleep(ms);
        return;
      }
      const n = Math.max(1, Math.round(ms / 16));
      const dy = (step.y ?? 400) / n;
      const dx = (step.x ?? 0) / n;
      for (let i = 0; i < n; i++) {
        await s.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...s.pos, deltaX: dx, deltaY: dy });
        await sleep(16);
      }
      return;
    }
    case "wait":
      if (step.selector || step.text) await s.settledBox(step, timeout);
      else await sleep(step.ms ?? 500);
      return;
    case "eval":
      if (!step.js) throw new Error("eval needs js.");
      await s.evaluate(step.js);
      s.log("eval", step);
      return;
    case "mark":
      s.log("mark", step);
      return;
    default:
      throw new Error(`Unknown step type: ${step.type}. Use goto, click, hover, type, press, scroll, wait, eval or mark.`);
  }
}

/** Requests of `sessionId` (a page, a frame or a worker) go through `onRequest`, and targets it
 *  starts wait until the same is true of them: nothing runs a line before it's intercepted. */
function interceptEverything(chrome, setupScript, workerScript, onRequest, onPage) {
  const INTERCEPTED = new Set(["page", "iframe", "worker", "shared_worker", "service_worker"]);
  chrome.on("Fetch.requestPaused", (params, sessionId) => onRequest(params, sessionId));
  const attach = async (sessionId, type) => {
    const send = (m, p) => chrome.send(m, p, sessionId);
    if (INTERCEPTED.has(type)) {
      // Dedicated workers report that Fetch isn't theirs: the frame that owns them intercepts.
      await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }).catch(() => {});
    }
    if (type === "page" || type === "iframe") {
      await send("Page.enable").catch(() => {});
      await send("Network.enable").catch(() => {});
      await send("Network.setBypassServiceWorker", { bypass: true }).catch(() => {});
      await send("Page.addScriptToEvaluateOnNewDocument", { source: setupScript }).catch(() => {});
    } else if (INTERCEPTED.has(type)) {
      // Workers have sockets too, and no way to run a script on new documents. Not awaited: an
      // evaluate on a worker that's waiting for the debugger only answers after it's released.
      send("Runtime.evaluate", { expression: workerScript }).catch(() => {});
    }
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {});
    if (type === "page") await onPage(sessionId);
    await send("Runtime.runIfWaitingForDebugger").catch(() => {});
  };
  chrome.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    attach(sessionId, targetInfo.type).catch(() => {});
  });
}

async function encode(renderer, frames, dir, stopTs, { fps, output, crf }) {
  const entry = (f, k) => {
    const next = frames[k + 1]?.t ?? stopTs;
    // Real timestamps, so playback runs at true speed however unevenly frames arrived.
    return `file '${path.join(dir, f.file).replace(/\\/g, "/")}'\nduration ${Math.max(next - f.t, 1 / 240).toFixed(5)}`;
  };
  const list = path.join(dir, "list.txt");
  // The concat demuxer drops the last entry's duration unless the file is listed once more.
  const last = `file '${path.join(dir, frames.at(-1).file).replace(/\\/g, "/")}'`;
  fs.writeFileSync(list, [...frames.map(entry), last].join("\n"));
  await ff(renderer, "ffmpeg", [
    "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
    // Remotion's ffmpeg has no `fps` filter: the output rate with cfr gives the same constant rate.
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-r", String(fps), "-fps_mode", "cfr",
    "-c:v", "libx264", "-preset", "medium", "-crf", String(crf ?? 17), "-movflags", "+faststart", output,
  ]);
}

async function record(renderer, opts) {
  const viewport = { width: 1536, height: 864, scale: 2, ...(opts.viewport ?? {}) };
  if (viewport.width * viewport.scale > MAX_WIDTH || viewport.height * viewport.scale > MAX_HEIGHT) {
    throw new Error(`The recording would be ${viewport.width * viewport.scale}x${viewport.height * viewport.scale}; the limit is ${MAX_WIDTH}x${MAX_HEIGHT}.`);
  }
  if (!opts.steps?.length) throw new Error("A recording needs steps.");
  if (!opts.steps.some((s) => s.type === "goto")) throw new Error('A recording needs a "goto" step.');
  const fps = opts.fps ?? 60;
  const routes = (opts.routes ?? []).map((r) => ({ ...r, match: urlMatcher(r.url) }));
  const allowWrites = (opts.allowWrites ?? []).map(urlMatcher);
  const forbid = (opts.forbidText ?? []).filter(Boolean);
  const blocked = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nyxs-record-"));
  // The flag, not just the emulation: an emulated scale reaches the page, but the screencast still
  // sends CSS pixels (measured: 1536x864 instead of 3072x1728).
  const chrome = await launchChrome(await chromeExecutable(renderer), [`--force-device-scale-factor=${viewport.scale}`]);
  let frames = [];
  let firstPage = null;
  try {
    await chrome.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    const setup = pageSetup({ cursor: opts.cursor !== false, allowWebSockets: opts.allowWebSockets, localStorage: opts.localStorage, initScript: opts.initScript });

    const onRequest = (params, sessionId) => {
      const { requestId, request, resourceType } = params;
      const { action, route } = decideRequest(request, routes, allowWrites);
      const origin = request.headers?.Origin ?? request.headers?.origin;
      const cors = origin
        ? [{ name: "access-control-allow-origin", value: origin }, { name: "access-control-allow-credentials", value: "true" }]
        : [];
      const reply = (status, contentType, body) =>
        chrome.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: status,
          responseHeaders: [{ name: "content-type", value: contentType }, ...cors],
          body: Buffer.from(body).toString("base64"),
        }, sessionId);
      let done;
      if (action === "mock") {
        const body = route.json !== undefined ? JSON.stringify(route.json) : (route.body ?? "");
        const type = route.contentType ?? (route.json !== undefined ? "application/json" : "text/plain");
        done = reply(route.status ?? 200, type, body);
      } else if (action === "continue") {
        done = chrome.send("Fetch.continueRequest", { requestId }, sessionId);
      } else {
        blocked.push(`${request.method} ${request.url}`);
        // A page keeps working on a harmless answer; a blocked form post simply goes nowhere.
        done = resourceType === "Document"
          ? chrome.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId)
          : reply(200, "application/json", "{}");
      }
      done.catch(() => {});
    };

    let resolvePage;
    const pageReady = new Promise((r) => { resolvePage = r; });
    const workerScript = `(() => { ${socketBlock(JSON.stringify(opts.allowWebSockets ?? []))} })()`;
    interceptEverything(chrome, setup, workerScript, onRequest, async (sessionId) => {
      if (firstPage) return;
      firstPage = sessionId;
      const send = (m, p) => chrome.send(m, p, sessionId);
      await send("Runtime.enable");
      await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: false });
      if (opts.colorScheme) {
        await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: opts.colorScheme }] });
      }
      resolvePage(sessionId);
    });
    await chrome.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await chrome.send("Target.createTarget", { url: "about:blank" });
    const sessionId = await pageReady;
    const s = new Session(chrome, sessionId, viewport);

    let capturing = false;
    const writes = [];
    chrome.on("Page.screencastFrame", ({ data, metadata, sessionId: ack }, from) => {
      if (from !== sessionId) return;
      const file = `${String(frames.length).padStart(6, "0")}.jpg`;
      frames.push({ file, t: metadata.timestamp });
      writes.push(
        fs.promises.writeFile(path.join(dir, file), Buffer.from(data, "base64")).finally(() =>
          chrome.send("Page.screencastFrameAck", { sessionId: ack }, sessionId).catch(() => {}),
        ),
      );
    });
    const startCapture = async () => {
      if (capturing || opts.dryRun) return;
      capturing = true;
      await s.send("Page.startScreencast", {
        format: "jpeg",
        quality: opts.quality ?? 92,
        everyNthFrame: 1,
        maxWidth: viewport.width * viewport.scale,
        maxHeight: viewport.height * viewport.scale,
      });
      s.started = Date.now();
      await sleep(120);
    };

    const failure = async (i, step, e) => {
      let shot = "";
      if (opts.failureScreenshot) {
        const { data } = await s.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }).catch(() => ({}));
        if (data) {
          fs.mkdirSync(path.dirname(opts.failureScreenshot), { recursive: true });
          fs.writeFileSync(opts.failureScreenshot, Buffer.from(data, "base64"));
          shot = ` The page at that moment: ${opts.failureScreenshot}`;
        }
      }
      return new Error(`Step ${i + 1} (${step.type}) failed: ${e.message}${shot}`);
    };

    for (const [i, step] of opts.steps.entries()) {
      emit({ type: "progress", stage: "rendering", progress: i / opts.steps.length, renderedFrames: i, totalFrames: opts.steps.length });
      try {
        await runStep(s, step, opts, startCapture);
      } catch (e) {
        throw await failure(i, step, e);
      }
      if (forbid.length) {
        const text = await s.evaluate("document.body ? document.body.innerText : ''").catch(() => "");
        for (const word of forbid) {
          if (text.includes(word)) {
            throw await failure(i, step, new Error(`The forbidden text ${JSON.stringify(word)} is on the page.`));
          }
        }
      }
    }

    if (opts.dryRun) {
      const { data } = await s.send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
      fs.mkdirSync(path.dirname(opts.output), { recursive: true });
      fs.writeFileSync(opts.output, Buffer.from(data, "base64"));
      emit({ type: "done", output: opts.output, dryRun: true, events: s.events, blocked, warnings: s.warnings });
      return;
    }

    await sleep(opts.tailMs ?? 300);
    const stopTs = Date.now() / 1000;
    await s.send("Page.stopScreencast").catch(() => {});
    await sleep(50);
    await Promise.all(writes);
    if (frames.length < 1) throw new Error("The browser sent no frames: the page may never have drawn.");
    frames = frames.slice().sort((a, b) => a.t - b.t);
    emit({ type: "progress", stage: "encoding", progress: 1 });
    fs.mkdirSync(path.dirname(opts.output), { recursive: true });
    await encode(renderer, frames, dir, stopTs, { fps, output: opts.output, crf: opts.crf });
    const durationSecs = stopTs - frames[0].t;
    // The clip starts at its first frame, a moment after capture was asked for.
    const lag = s.started / 1000 - frames[0].t;
    const events = s.events.map((e) => ({ ...e, t: Math.max(0, Math.round((e.t + lag) * 1000) / 1000) }));
    emit({
      type: "done",
      output: opts.output,
      width: viewport.width * viewport.scale,
      height: viewport.height * viewport.scale,
      durationSecs: Math.round(durationSecs * 1000) / 1000,
      capturedFrames: frames.length,
      capturedFps: Math.round((frames.length / durationSecs) * 10) / 10,
      events,
      blocked,
      warnings: s.warnings,
    });
  } finally {
    await chrome.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runTask(async () => {
    const { opts } = readRequest();
    if (!opts.output) throw new Error("Missing output.");
    await record(await import("@remotion/renderer"), opts);
  });
}

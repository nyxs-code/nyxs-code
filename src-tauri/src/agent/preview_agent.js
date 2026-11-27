// Injected into every local page the preview shows. It lets the agent read and drive the page:
// Nyxs posts {source:"nyxs-agent", id, cmd, args} and gets {source:"nyxs-agent-reply", id, ok, result|error}.
// It also keeps the page's console output, errors and failed requests for the agent to read.
(function () {
  // An embedded page of another site that Nyxs reads on Windows (see src-tauri/src/preview_frames.rs).
  // Nyxs runs this in that frame alone and talks to it straight from the browser, never through
  // the page around it: the bridge there answers no messages and posts none, and its functions
  // live under a name Nyxs picks instead of on the window.
  var frameKey = typeof window.__nyxsFrame === "string" ? window.__nyxsFrame : null;
  if (frameKey !== null) { try { delete window.__nyxsFrame; } catch (e) { /* not deletable */ } }
  if (frameKey !== null ? window[frameKey] : window.__nyxsAgent) return;
  var api = frameKey !== null ? {} : window;
  api.__nyxsAgent = true;
  // A website in Nyxs' own webview on Windows: Nyxs follows its requests and its console from the
  // browser and sends the agent's clicks and keys as real input (see src-tauri/src/preview_cdp.rs).
  var native = frameKey !== null || window.__nyxsNative === true;
  try { delete window.__nyxsNative; } catch (e) { /* not deletable */ }
  /** Tells the page this one is embedded in (the app, for a local page). Never from a frame Nyxs
   *  reads, whose parent is another site. */
  function toParent(msg) {
    if (frameKey === null && window.parent !== window) window.parent.postMessage(msg, "*");
  }

  // A local page (a project's HTML file) is one site per port of the preview host, each with
  // its own storage, but cookies ignore the port, so one folder's cookies reached every other
  // folder's pages. Each site's cookies get its port in their names, which only its own pages
  // see. Here and not in the server: the files are static, so only the page sets cookies.
  (function () {
    if (native || (location.hostname !== "nyxspreview.localhost" && location.protocol !== "nyxspreview:")) return;
    var cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (!cookie || !cookie.get || !cookie.set) return;
    var prefix = "nyxs" + (location.port || "0") + "_";
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      enumerable: cookie.enumerable,
      get: function () {
        return cookie.get.call(this).split("; ")
          .filter(function (c) { return c.indexOf(prefix) === 0; })
          .map(function (c) { return c.slice(prefix.length); })
          .join("; ");
      },
      // A cookie with no "=" is a value with no name; prefixed, it reads back the same.
      set: function (v) { cookie.set.call(this, prefix + String(v).replace(/^\s+/, "")); }
    });
  })();

  var MAX_LOGS = 500;
  var logs = [];
  var logSeq = 0;

  function show(v) {
    try {
      if (typeof v === "string") return v;
      if (v instanceof Error) return v.stack || String(v);
      if (v instanceof Element) return "<" + v.tagName.toLowerCase() + (v.id ? "#" + v.id : "") + ">";
      var s = JSON.stringify(v);
      return s === undefined ? String(v) : s;
    } catch (e) {
      return String(v);
    }
  }

  function record(level, parts) {
    var text = Array.prototype.map.call(parts, show).join(" ");
    if (text.length > 2000) text = text.slice(0, 2000) + "...";
    logs.push({ seq: ++logSeq, level: level, text: text });
    if (logs.length > MAX_LOGS) logs.shift();
  }

  // Where Nyxs gets the console from the browser (Console.messageAdded, see preview_cdp.rs) the
  // page's console stays its own: a wrapped one shows in console.log.toString() and the like.
  if (!native) ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      record(level, arguments);
      return original.apply(console, arguments);
    };
  });

  window.addEventListener(
    "error",
    function (e) {
      var t = e.target;
      if (t && t !== window && (t.src || t.href)) {
        record("network", ["Failed to load " + (t.src || t.href)]);
        return;
      }
      var where = e.filename ? " (" + e.filename + ":" + e.lineno + ":" + e.colno + ")" : "";
      record("error", [(e.error && e.error.stack) || e.message + where]);
    },
    true
  );
  window.addEventListener("unhandledrejection", function (e) {
    record("error", ["Unhandled promise rejection: " + show(e.reason)]);
  });

  // Requests in flight, so an action can wait for the ones it started.
  var inflight = new Set();
  var reqSeq = 0;
  function reqStart() { var id = ++reqSeq; inflight.add(id); return id; }
  function reqEnd(id) { inflight.delete(id); }

  // Short timers an action sets off, so its wait sees what the page does a moment later (a
  // dialog shown 300 ms after the server answers). While an action settles, every timeout due
  // before `timerDeadline` counts, chained ones too (set from a request's callback or from
  // another timer). Intervals never count, nor timeouts due later: a page that polls can't
  // hold every action up. The bridge's own waits use the originals.
  // The wrappers are only on the window while an action settles: the rest of the time the page
  // sees its own functions, so a site that checks them (anti-bot scripts do) finds nothing.
  var TIMER_WINDOW = 1000;
  // A timer this late (a hidden page's are slowed to about one a second) stops being waited for.
  var TIMER_LATE = 1000;
  var timerDeadline = 0;
  var pendingTimers = new Map();
  var rawSetTimeout = window.setTimeout;
  var rawClearTimeout = window.clearTimeout;
  var rawClearInterval = window.clearInterval;
  // What the page had when each wrapper went on (its own, if it replaced the browser's), which
  // the wrapper calls and which goes back on after.
  var pageTimers = {};
  var timerWrap = {
    setTimeout: function (fn, ms) {
      var set = pageTimers.setTimeout || rawSetTimeout;
      var delay = Math.max(0, Number(ms) || 0);
      var due = Date.now() + delay;
      if (!timerDeadline || typeof fn !== "function" || due > timerDeadline) return set.apply(window, arguments);
      var args = Array.prototype.slice.call(arguments, 2);
      var id = set.call(window, function () {
        pendingTimers.delete(id);
        return fn.apply(this, args);
      }, delay);
      pendingTimers.set(id, due);
      return id;
    },
    clearTimeout: function (id) {
      pendingTimers.delete(id);
      return (pageTimers.clearTimeout || rawClearTimeout).apply(window, arguments);
    },
    // clearInterval clears timeouts as well.
    clearInterval: function (id) {
      pendingTimers.delete(id);
      return (pageTimers.clearInterval || rawClearInterval).apply(window, arguments);
    }
  };
  /** From now on, short timers count for the action that is starting (until it settles). */
  function watchTimers() {
    pendingTimers.clear();
    timerDeadline = Date.now() + TIMER_WINDOW;
    Object.keys(timerWrap).forEach(function (k) {
      if (pageTimers[k]) return;
      pageTimers[k] = window[k];
      window[k] = timerWrap[k];
    });
  }
  /** The action settled: the page gets its own timer functions back. */
  function unwatchTimers() {
    timerDeadline = 0;
    pendingTimers.clear();
    Object.keys(pageTimers).forEach(function (k) {
      // One the page wrapped meanwhile stays, calling ours, which then just passes through.
      if (window[k] !== timerWrap[k]) return;
      window[k] = pageTimers[k];
      delete pageTimers[k];
    });
  }

  // Where Nyxs follows the requests from the browser, the page's own fetch and XMLHttpRequest
  // stay untouched: a site could notice them wrapped.
  var originalFetch = window.fetch;
  if (originalFetch && !native) {
    window.fetch = function (input, init) {
      var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      var rid = reqStart();
      return originalFetch.apply(this, arguments).then(
        function (res) {
          reqEnd(rid);
          if (!res.ok) record("network", [method + " " + res.url + " -> " + res.status]);
          return res;
        },
        function (err) {
          reqEnd(rid);
          record("network", [method + " " + url + " failed: " + show(err)]);
          throw err;
        }
      );
    };
  }
  var xhrOpen = XMLHttpRequest.prototype.open;
  if (!native) XMLHttpRequest.prototype.open = function (method, url) {
    var xhr = this;
    xhr.addEventListener("loadend", function () {
      if (xhr.status === 0 || xhr.status >= 400) {
        record("network", [String(method).toUpperCase() + " " + url + " -> " + (xhr.status || "failed")]);
      }
    });
    return xhrOpen.apply(this, arguments);
  };
  var xhrSend = XMLHttpRequest.prototype.send;
  if (!native) XMLHttpRequest.prototype.send = function () {
    var rid = reqStart();
    this.addEventListener("loadend", function () { reqEnd(rid); });
    try {
      return xhrSend.apply(this, arguments);
    } catch (e) {
      reqEnd(rid);
      throw e;
    }
  };

  // ---- Nyxs, around the page ---------------------------------------------------------------

  // What Nyxs says with each call it makes (src-tauri/src/preview_webview.rs, run_agent):
  // whether it can send real input, how many of the page's requests the command started are
  // still running, and the requests that failed since it last said.
  var hostTrusted = false;
  // In a frame of another site Nyxs clicks for real but never types: typed text and keys go to
  // whatever has the focus when they arrive, which the page around the frame could take.
  var hostKeys = true;
  var hostId = null;
  var hostInflight = 0;
  var inputDone = {};
  function applyHost(h) {
    if (!h || typeof h !== "object") return;
    hostInflight = Number(h.inflight) || 0;
    hostKeys = h.keys !== false;
    (Array.isArray(h.console) ? h.console : []).forEach(function (m) {
      if (m && typeof m === "object") record(String(m.level || "log"), [String(m.text)]);
    });
    (Array.isArray(h.net) ? h.net : []).forEach(function (t) { record("network", [String(t)]); });
  }

  /** Asks Nyxs to do `req` as real input (see preview_cdp.rs, input_calls) and resolves with
   *  whether it did; false at once where it can't, and the caller uses its own events. */
  function hostInput(req) {
    var id = hostId;
    // A hidden webview (a chat's browser not on screen) may not take input where it points,
    // and a click that did land must not be sent twice: there the bridge's own events go.
    var r = hostTrusted && id != null && !document.hidden && (hostKeys || req.kind === "click") ? results[id] : null;
    if (!r || !r.pending) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var finish = function (ok) {
        if (r.input !== req) return;
        delete r.input;
        delete inputDone[id];
        resolve(ok);
      };
      r.input = req;
      inputDone[id] = finish;
      rawSetTimeout(function () { finish(false); }, 5000);
    });
  }
  api.__nyxsAgentInputDone = function (id, ok) {
    var f = inputDone[id];
    if (f) f(!!ok);
  };

  /** A point of a frame of this site, in the top page's viewport, where real input aims. */
  function topPoint(el, x, y) {
    var w = el.ownerDocument.defaultView;
    try {
      while (w && w !== window && w.frameElement) {
        var r = w.frameElement.getBoundingClientRect();
        x += r.left + w.frameElement.clientLeft;
        y += r.top + w.frameElement.clientTop;
        w = w.parent;
      }
    } catch (e) {
      return null;
    }
    return w === window ? { x: x, y: y } : null;
  }

  // ---- Reading the page -------------------------------------------------------------------

  // A ref names one element for as long as it stays on the page: a new snapshot gives the
  // elements it already knows the same refs, and a number is never used twice in a document.
  var refs = new Map();
  var refOf = new WeakMap();
  var nextRef = 0;
  var MAX_LINES = 600;

  function refFor(el, role, name) {
    var ref = refOf.get(el);
    var entry = ref && refs.get(ref);
    if (entry && entry.el === el) {
      entry.role = role;
      entry.name = name;
      return ref;
    }
    ref = "e" + ++nextRef;
    refOf.set(el, ref);
    refs.set(ref, { el: el, role: role, name: name });
    return ref;
  }

  function pruneRefs() {
    refs.forEach(function (entry, ref) { if (!entry.el.isConnected) refs.delete(ref); });
  }

  var LANDMARKS = {
    header: "banner", nav: "navigation", main: "main", footer: "contentinfo", aside: "complementary",
    form: "form", dialog: "dialog", section: "region", ul: "list", ol: "list", li: "listitem",
    table: "table", tr: "row", menu: "list"
  };
  var INPUT_ROLES = {
    button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox",
    radio: "radio", range: "slider", search: "searchbox", file: "button"
  };
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, svg: 1, LINK: 1, META: 1 };

  function clean(s, max) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > (max || 100) ? s.slice(0, max || 100) + "..." : s;
  }

  function roleOf(el) {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "input") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return "";
      return INPUT_ROLES[type] || "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return el.getAttribute("alt") ? "img" : "";
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return "textbox";
    return LANDMARKS[tag] || "";
  }

  var INTERACTIVE = /^(button|link|textbox|searchbox|checkbox|radio|combobox|slider|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|spinbutton|clickable)$/;
  var DIALOG = /^(dialog|alertdialog)$/;
  var NESTED = "a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=option],[role=switch]";

  function nameOf(el, role) {
    var label = el.getAttribute("aria-label");
    if (label) return clean(label);
    var by = el.getAttribute("aria-labelledby");
    if (by) {
      var text = by.split(/\s+/).map(function (id) {
        var n = el.ownerDocument.getElementById(id);
        return n ? n.textContent : "";
      }).join(" ");
      if (clean(text)) return clean(text);
    }
    if (el.labels && el.labels.length) return clean(labelText(el.labels[0], el));
    if (el.tagName === "IMG") return clean(el.getAttribute("alt"));
    if (el.tagName === "INPUT" && /^(submit|button|reset)$/i.test(el.type)) return clean(el.value);
    if (role === "textbox" || role === "searchbox" || role === "combobox") {
      return clean(el.getAttribute("placeholder") || el.getAttribute("title"));
    }
    if (DIALOG.test(role)) {
      var heading = el.querySelector("h1,h2,h3,h4,[role=heading]");
      return heading ? clean(heading.textContent) : "";
    }
    return clean(el.innerText || el.textContent || el.getAttribute("title"), 80);
  }

  /** A label's text without that of the control inside it (a select's options). */
  function labelText(lab, control) {
    var out = "";
    for (var n = lab.firstChild; n; n = n.nextSibling) {
      if (n === control || (n.nodeType === 1 && n.contains(control))) continue;
      out += n.textContent;
    }
    return out;
  }

  function isShown(el) {
    if (el.checkVisibility) return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    var s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }

  function isDisabled(el) {
    return !!el.disabled || el.getAttribute("aria-disabled") === "true";
  }

  /** Elements a walk leaves out: code, hidden parts and Nyxs' own layers. */
  function skipped(el) {
    return !!SKIP_TAGS[el.tagName] || el.getAttribute("aria-hidden") === "true" || el.hasAttribute("data-nyxs-annotations") || !isShown(el);
  }

  /** What a walk visits under `el`: its children, its open shadow root and, for a frame of
   *  the same site, the frame's page. */
  function kids(el) {
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      var doc = frameDoc(el);
      return doc && doc.body ? [doc.body] : [];
    }
    var out = Array.prototype.slice.call(el.children);
    if (el.shadowRoot) out = out.concat(Array.prototype.slice.call(el.shadowRoot.children));
    return out;
  }

  function frameDoc(el) {
    try { return el.contentDocument; } catch (e) { return null; }
  }

  /** A plain element the page made clickable (a div with an onClick shows a pointer cursor). */
  function clickable(el, inPointer) {
    if (inPointer || el.tagName === "BODY" || el.tagName === "HTML" || el.tagName === "LABEL") return false;
    if (getComputedStyle(el).cursor !== "pointer") return false;
    // The cursor is inherited: only the element that sets it counts.
    var parent = el.parentElement;
    return !parent || getComputedStyle(parent).cursor !== "pointer";
  }

  /** The element's role, with page-made buttons as "clickable". */
  function roleIn(el, inPointer) {
    var role = roleOf(el);
    return role || (clickable(el, inPointer) ? "clickable" : "");
  }

  function ownText(el) {
    var out = "";
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) out += n.nodeValue;
    return clean(out, 200);
  }

  /** The state an element shows: its value, checked, disabled, expanded... */
  function stateOf(el, role) {
    var out = "";
    if (role === "textbox" || role === "searchbox" || role === "combobox" || role === "slider" || role === "spinbutton") {
      var value = el.isContentEditable ? el.innerText : el.value;
      if (el.tagName === "SELECT" && el.selectedOptions && el.selectedOptions[0]) value = el.selectedOptions[0].textContent;
      if (el.type === "password" && value) value = "\u2022\u2022\u2022\u2022";
      if (value) out += ' value="' + clean(value, 120).replace(/"/g, "'") + '"';
    }
    if (el.checked || el.getAttribute("aria-checked") === "true") out += " [checked]";
    if (el.getAttribute("aria-selected") === "true") out += " [selected]";
    if (el.getAttribute("aria-pressed") === "true") out += " [pressed]";
    if (isDisabled(el)) out += " [disabled]";
    if (el.getAttribute("aria-expanded")) out += " [expanded=" + el.getAttribute("aria-expanded") + "]";
    return out;
  }

  function describe(el, role) {
    var name = nameOf(el, role);
    var ref = refFor(el, role, name);
    var line = role + (name ? ' "' + name.replace(/"/g, "'") + '"' : "");
    if (role === "heading") line += " [level=" + (el.getAttribute("aria-level") || el.tagName.charAt(1)) + "]";
    line += stateOf(el, role);
    if (role === "link") {
      var href = el.getAttribute("href");
      if (href && !/^javascript:/i.test(href)) line += " -> " + clean(href, 80);
    }
    return line + " [ref=" + ref + "]";
  }

  /** -1 when the element is above the viewport, 1 below it, 0 when it shows (or has no box). */
  function offscreen(el) {
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) return 0;
    var view = el.ownerDocument.defaultView || window;
    if (r.bottom <= 0) return -1;
    if (r.top >= view.innerHeight) return 1;
    return 0;
  }

  function countInteractive(el) {
    return el.querySelectorAll(NESTED).length + (el.matches(NESTED) ? 1 : 0);
  }

  function frameLine(el) {
    var title = clean(el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("src"), 80);
    return "iframe" + (title ? ' "' + title + '"' : "");
  }

  // Nyxs puts the content of a frame of another site in place of this note when it can read it
  // (src-tauri/src/preview_frames.rs).
  var FOREIGN_NOTE = " (another site: its content can't be read; use click_at on a screenshot)";

  /** A frame of another site, for Nyxs to tell which of the browser's frames it is: its name,
   *  address and size, and a ref to find its place later (not shown to the agent). */
  function frameSlot(el, line, depth) {
    return {
      ref: refFor(el, "iframe", frameLine(el)),
      name: el.getAttribute("name") || "",
      src: el.src || "",
      width: el.clientWidth,
      height: el.clientHeight,
      line: line,
      depth: depth
    };
  }

  /** What is at a point of this page's viewport, through frames of this site and shadow roots,
   *  stopping at `stop`. */
  function deepHit(x, y, stop) {
    var hit = document.elementFromPoint(x, y);
    for (;;) {
      if (!hit || hit === stop) return hit;
      if (hit.tagName === "IFRAME" || hit.tagName === "FRAME") {
        var inner = frameDoc(hit);
        if (!inner) return hit;
        var fr = hit.getBoundingClientRect();
        x -= fr.left + hit.clientLeft;
        y -= fr.top + hit.clientTop;
        hit = inner.elementFromPoint(x, y);
        continue;
      }
      var deeper = hit.shadowRoot && hit.shadowRoot.elementFromPoint(x, y);
      if (!deeper || deeper === hit) return hit;
      hit = deeper;
    }
  }

  /** A point of the frame `ref` (of another site), in that frame's viewport, as a point of this
   *  page's viewport, where Nyxs sends a real click. Null when the point is outside the frame
   *  or something else covers it there, so a frame can't have Nyxs click this page for it. */
  api.__nyxsFramePoint = function (ref, x, y) {
    var entry = refs.get(String(ref));
    var el = entry && entry.el;
    if (!el || !el.isConnected || (el.tagName !== "IFRAME" && el.tagName !== "FRAME")) return null;
    x = Number(x);
    y = Number(y);
    if (!(x >= 0 && y >= 0 && x < el.clientWidth && y < el.clientHeight)) return null;
    var r = el.getBoundingClientRect();
    var p = topPoint(el, r.left + el.clientLeft + x, r.top + el.clientTop + y);
    return p && deepHit(p.x, p.y, el) === el ? p : null;
  };

  // Options: area "viewport" (the default: what is on screen) or "page"; filter "interactive"
  // (only what can be clicked or typed into); ref, to read only that element's part.
  function snapshot(a) {
    a = a || {};
    pruneRefs();
    var root = a.ref || a.selector ? target(a) : document.body || document.documentElement;
    var whole = a.area ? a.area === "page" : !!(a.ref || a.selector);
    var onlyInteractive = a.filter === "interactive";
    var lines = [];
    // Asked by Nyxs, which reads frames of other sites itself: the ones on this page.
    var frames = a.frames ? [] : null;
    var truncated = false;
    var above = 0;
    var below = 0;
    var lastName = "";

    function walk(node, depth, inPointer) {
      var list = kids(node);
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (lines.length >= MAX_LINES) { truncated = true; return; }
        if (skipped(el)) continue;
        if (!whole) {
          var off = offscreen(el);
          if (off) {
            if (off < 0) above += countInteractive(el); else below += countInteractive(el);
            continue;
          }
        }
        var pad = new Array(depth + 1).join("  ");
        if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
          var doc = frameDoc(el);
          lines.push(pad + "- " + frameLine(el) + (doc ? ":" : FOREIGN_NOTE));
          if (doc) walk(el, depth + 1, false);
          else if (frames) frames.push(frameSlot(el, lines.length - 1, depth + 1));
          continue;
        }
        if (el.tagName === "CANVAS" || el.tagName === "VIDEO") {
          var box = el.getBoundingClientRect();
          lines.push(pad + "- " + el.tagName.toLowerCase() + (el.getAttribute("aria-label") ? ' "' + clean(el.getAttribute("aria-label")) + '"' : "") +
            " " + Math.round(box.width) + "x" + Math.round(box.height) + " (its content has no refs: use click_at on a screenshot)");
          continue;
        }
        var role = roleIn(el, inPointer);
        if (INTERACTIVE.test(role) || role === "heading" || role === "img") {
          if (!onlyInteractive || INTERACTIVE.test(role)) {
            lines.push(pad + "- " + describe(el, role));
            lastName = nameOf(el, role);
          }
          var pointer = inPointer || INTERACTIVE.test(role);
          if (role === "clickable" ? el.querySelector(NESTED) || (el.innerText || "").length > 80 : role !== "heading" && el.tagName !== "SELECT" && el.querySelector(NESTED)) {
            walk(el, depth + 1, pointer);
          } else if (el.shadowRoot && el.shadowRoot.querySelector(NESTED)) {
            walk(el, depth + 1, pointer);
          }
          continue;
        }
        var text = ownText(el);
        if (role && !onlyInteractive) {
          var label = el.getAttribute("aria-label");
          lines.push(pad + "- " + role + (label ? ' "' + clean(label) + '"' : "") + (text ? ": " + text : ""));
          walk(el, depth + 1, inPointer);
        } else {
          if (text && !onlyInteractive && text !== lastName) lines.push(pad + "- text: " + text);
          walk(el, depth, inPointer);
        }
      }
    }

    if (root !== document.body && root !== document.documentElement) {
      lines.push("- " + describe(root, roleIn(root, false) || root.tagName.toLowerCase()));
      walk(root, 1, false);
    } else {
      walk(root, 0, false);
    }
    var head = [
      "URL: " + location.href,
      "Title: " + document.title,
      "Viewport: " + innerWidth + "x" + innerHeight + ", scrolled " + Math.round(scrollY) + " of " +
        Math.max(0, document.documentElement.scrollHeight - innerHeight) + "px"
    ];
    if (!whole) {
      var more = [];
      if (above) more.push(above + " above");
      if (below) more.push(below + " below");
      head.push("Showing what is on screen" + (more.length ? " (interactive elements off screen: " + more.join(", ") + "; scroll, use find, or snapshot with area \"page\")" : "") + ".");
    }
    if (truncated) lines.push("... (snapshot cut at " + MAX_LINES + " lines: use find, a ref, or filter \"interactive\")");
    var text = head.join("\n") + "\n\n" + (lines.length ? lines.join("\n") : "(the page shows nothing here)");
    return frames ? { text: text, frames: frames } : text;
  }

  function norm(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
  }

  // Finds elements by their text, name or role across the whole page, on screen or not.
  function find(a) {
    var words = norm(a.query).split(" ").filter(Boolean);
    if (!words.length) throw new Error("Pass the text to look for.");
    var limit = Math.max(1, Math.min(Number(a.limit) || 20, 50));
    var out = [];
    var total = 0;
    var frames = a.frames ? [] : null;
    function matches(s) {
      s = norm(s);
      return words.every(function (w) { return s.indexOf(w) >= 0; });
    }
    function where(el) {
      var off = offscreen(el);
      return off < 0 ? " (off screen, above)" : off > 0 ? " (off screen, below)" : "";
    }
    function walk(node, inPointer, inControl) {
      var list = kids(node);
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (skipped(el)) continue;
        if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
          if (frames && !frameDoc(el)) frames.push(frameSlot(el, null, 0));
          walk(el, false, false);
          continue;
        }
        var role = roleIn(el, inPointer);
        if (INTERACTIVE.test(role) || role === "heading" || role === "img") {
          var hay = role + " " + nameOf(el, role) + " " + (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("title") || "") + (el.value ? " " + el.value : "");
          if (matches(hay)) {
            total++;
            if (out.length < limit) out.push("- " + describe(el, role) + where(el));
          }
          walk(el, inPointer || INTERACTIVE.test(role), true);
          continue;
        }
        var text = ownText(el);
        if (text && !inControl && matches(text)) {
          total++;
          if (out.length < limit) out.push("- " + (role || "text") + ': "' + text.replace(/"/g, "'") + '" [ref=' + refFor(el, role || "text", text) + "]" + where(el));
        }
        walk(el, inPointer, inControl);
      }
    }
    walk(document.body || document.documentElement, false, false);
    // Nyxs adds what the frames of other sites have and words the answer (preview_frames.rs).
    if (frames) return { query: clean(a.query), limit: limit, total: total, lines: out, frames: frames };
    if (!total) return 'Nothing on the page matches "' + clean(a.query) + '" (the whole page was searched, off-screen parts too).';
    var head = total + (total === 1 ? " match" : " matches") + ' for "' + clean(a.query) + '":';
    if (total > out.length) out.push("... and " + (total - out.length) + " more: narrow the query.");
    return head + "\n" + out.join("\n");
  }

  // ---- What an action changed --------------------------------------------------------------

  var MAX_COLLECT = 3000;

  // What a change summary compares: the visible interactive elements and dialogs, with the
  // state each one shows, and the messages of live regions (toasts, alerts).
  function collect() {
    var items = new Map();
    var notes = [];
    var count = 0;
    function walk(node, inPointer) {
      var list = kids(node);
      for (var i = 0; i < list.length && count < MAX_COLLECT; i++) {
        var el = list[i];
        if (skipped(el)) continue;
        var role = roleIn(el, inPointer);
        if (INTERACTIVE.test(role) || DIALOG.test(role)) {
          count++;
          items.set(el, { role: role, name: nameOf(el, role), state: DIALOG.test(role) ? "" : stateOf(el, role) });
        }
        var live = el.getAttribute("aria-live");
        if (role === "alert" || role === "status" || (live && live !== "off")) {
          var text = clean(el.innerText, 200);
          if (text) notes.push(text);
        }
        walk(el, inPointer || INTERACTIVE.test(role));
      }
    }
    walk(document.body || document.documentElement, false);
    return { items: items, notes: notes, title: document.title, focus: deepFocus() };
  }

  function deepFocus() {
    var el = document.activeElement;
    while (el && (el.tagName === "IFRAME" || el.tagName === "FRAME")) {
      var doc = frameDoc(el);
      if (!doc || !doc.activeElement) break;
      el = doc.activeElement;
    }
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function list(els, max, more) {
    var out = els.slice(0, max).map(function (x) { return "  - " + describe(x.el, x.role); });
    if (els.length > max) out.push("  - ... and " + (els.length - max) + " more" + (more || ""));
    return out;
  }

  // The summary of what changed between two collects, or "" when nothing did.
  function changes(a, b, quiet, target) {
    var out = [];
    if (b.title !== a.title) out.push('- title is now "' + clean(b.title) + '"');
    var added = [];
    var gone = [];
    var changed = [];
    b.items.forEach(function (v, el) {
      var old = a.items.get(el);
      if (!old) added.push({ el: el, role: v.role, name: v.name, state: v.state });
      else if ((old.state !== v.state || old.name !== v.name) && !quiet.has(el)) changed.push({ el: el, role: v.role });
    });
    a.items.forEach(function (v, el) { if (!b.items.has(el)) gone.push({ el: el, role: v.role, name: v.name, state: v.state }); });
    // An element the page drew again (a framework re-render) is the same control: it keeps its
    // ref and isn't reported as gone and new.
    added = added.filter(function (n) {
      for (var i = 0; i < gone.length; i++) {
        var g = gone[i];
        if (g.role === n.role && g.name === n.name) {
          gone.splice(i, 1);
          var ref = refOf.get(g.el);
          if (ref && refs.has(ref)) { refs.get(ref).el = n.el; refOf.set(n.el, ref); }
          if (g.state !== n.state) changed.push({ el: n.el, role: n.role });
          return false;
        }
      }
      return true;
    });
    added.filter(function (n) { return DIALOG.test(n.role); }).forEach(function (n) { out.push("- opened " + describe(n.el, n.role)); });
    gone.filter(function (g) { return DIALOG.test(g.role); }).forEach(function (g) { out.push("- closed " + g.role + (g.name ? ' "' + g.name + '"' : "")); });
    added = added.filter(function (n) { return !DIALOG.test(n.role); });
    gone = gone.filter(function (g) { return !DIALOG.test(g.role); });
    if (added.length) out = out.concat(["- new:"], list(added, 15, ": take a snapshot to see them"));
    if (changed.length) out = out.concat(["- changed:"], list(changed, 10));
    if (gone.length) {
      var names = gone.slice(0, 8).map(function (g) { return g.role + (g.name ? ' "' + g.name + '"' : ""); });
      out.push("- gone: " + names.join(", ") + (gone.length > 8 ? " and " + (gone.length - 8) + " more" : ""));
    }
    b.notes.forEach(function (t) { if (a.notes.indexOf(t) < 0) out.push('- message: "' + t.replace(/"/g, "'") + '"'); });
    var f = b.focus;
    if (f && f !== a.focus && f !== target && !quiet.has(f) && f !== document.body) {
      var role = roleIn(f, false);
      if (INTERACTIVE.test(role)) out.push("- focus: " + describe(f, role));
    }
    return out.join("\n");
  }

  // ---- Acting on the page -----------------------------------------------------------------

  function target(args) {
    if (args.ref) {
      var ref = String(args.ref).replace(/^ref=/, "");
      var entry = refs.get(ref);
      if (!entry) throw new Error("Unknown ref " + ref + ". Take a new snapshot (refs start over when the page navigates).");
      if (entry.el.isConnected) return entry.el;
      // Drawn again by the page: the one element with the same role and name is the same control.
      var same = [];
      collect().items.forEach(function (v, el) { if (v.role === entry.role && v.name === entry.name) same.push(el); });
      if (same.length === 1 && !refOf.get(same[0])) {
        entry.el = same[0];
        refOf.set(same[0], ref);
        return same[0];
      }
      throw new Error("Ref " + ref + " (" + entry.role + (entry.name ? ' "' + entry.name + '"' : "") + ") is no longer on the page. Take a new snapshot.");
    }
    if (args.selector) {
      var found = document.querySelector(String(args.selector));
      if (!found) throw new Error("No element matches " + args.selector);
      return found;
    }
    throw new Error("Pass a ref from the snapshot or a CSS selector.");
  }

  function label(el) {
    var role = roleIn(el, false) || el.tagName.toLowerCase();
    var name = nameOf(el, role);
    return role + (name ? ' "' + name + '"' : "");
  }

  /** The nearest element with a role around `el`, to name what sits at a point. */
  function owner(el) {
    for (var n = el, i = 0; n && i < 5 && n.tagName !== "BODY"; n = n.parentElement, i++) if (roleOf(n)) return n;
    return el;
  }

  /** What a click at a point hit: the control it is part of, or the element itself. */
  function pointLabel(hit) {
    for (var n = hit, i = 0; n && i < 5 && n.tagName !== "BODY"; n = n.parentElement, i++) {
      if (INTERACTIVE.test(roleIn(n, false))) return label(n);
    }
    return hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "");
  }

  var lastMutation = 0;
  // The check of the wait in progress. Nyxs runs it each time it asks for a command's result
  // (see __nyxsAgentTake): a hidden page's timers fire about once a second, the 25 ms loop's
  // too, and so an action on a tab not in front took a second even on a quiet page.
  var settleCheck = null;

  // Waits until the page is quiet: no DOM change for 100 ms, none of the requests the action
  // started still running and none of its short timers still to run (see watchTimers), for at
  // most 2 s.
  function settle(sinceReq) {
    return new Promise(function (resolve) {
      var started = Date.now();
      lastMutation = started;
      var observer = new MutationObserver(function () { lastMutation = Date.now(); });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      var timer = 0;
      var check = function () {
        rawClearTimeout(timer);
        var now = Date.now();
        var busy = false;
        inflight.forEach(function (id) { if (id > sinceReq) busy = true; });
        if (hostInflight > 0) busy = true;
        pendingTimers.forEach(function (due) { if (now < due + TIMER_LATE) busy = true; });
        if ((now - lastMutation >= 100 && !busy) || now - started >= 2000) {
          observer.disconnect();
          if (settleCheck === check) settleCheck = null;
          unwatchTimers();
          resolve();
          return;
        }
        timer = rawSetTimeout(check, 25);
      };
      settleCheck = check;
      check();
    });
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      var done = false;
      var go = function () { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(go);
      // A page in the background gets no frames.
      rawSetTimeout(go, 50);
    });
  }

  /** Whether a pointer at the element's center reaches it (or its label, or its own parts). */
  function reaches(el, hit) {
    if (hit === el || el.contains(hit) || hit.contains(el)) return true;
    var host = el.getRootNode && el.getRootNode().host;
    if (host && (hit === host || host.contains(hit))) return true;
    var lab = hit.closest && hit.closest("label");
    return !!(lab && (lab.control === el || lab.contains(el)));
  }

  // Gets an element ready for the pointer, like Playwright's actionability checks: enabled,
  // visible, scrolled into view, not moving, and not covered by something else.
  async function actionable(el, a) {
    if (isDisabled(el)) throw new Error(label(el) + " is disabled.");
    if (!isShown(el)) throw new Error(label(el) + " isn't visible on the page.");
    el.scrollIntoView({ block: "center", inline: "center" });
    var r = el.getBoundingClientRect();
    // A hidden page gets no frames and slow timers, and nothing animates there anyway.
    for (var i = 0; i < 10 && !document.hidden; i++) {
      await nextFrame();
      var n = el.getBoundingClientRect();
      var still = n.left === r.left && n.top === r.top && n.width === r.width && n.height === r.height;
      r = n;
      if (still) break;
    }
    if (!r.width && !r.height) throw new Error(label(el) + " has no size on the page.");
    var x = r.left + r.width / 2;
    var y = r.top + r.height / 2;
    var root = el.getRootNode && el.getRootNode().elementFromPoint ? el.getRootNode() : el.ownerDocument;
    var hit = root.elementFromPoint(x, y);
    if (hit && !reaches(el, hit) && !a.force) {
      throw new Error(label(el) + " is covered by " + label(owner(hit)) + " at its center. Close or dismiss that first, or pass force: true to click anyway.");
    }
    return { x: x, y: y, at: hit && (hit === el || el.contains(hit)) ? hit : el };
  }

  function mouse(el, type, x, y) {
    var W = el.ownerDocument.defaultView || window;
    var init = { bubbles: true, cancelable: true, composed: true, view: W, clientX: x, clientY: y, button: 0, buttons: type.indexOf("down") >= 0 ? 1 : 0 };
    var Ctor = type.indexOf("pointer") === 0 && W.PointerEvent ? W.PointerEvent : W.MouseEvent;
    if (Ctor === W.PointerEvent) { init.pointerId = 1; init.pointerType = "mouse"; init.isPrimary = true; }
    el.dispatchEvent(new Ctor(type, init));
  }

  function pointAt(at, focusEl, x, y) {
    ["pointerover", "pointerenter", "mouseover", "pointerdown", "mousedown"].forEach(function (t) { mouse(at, t, x, y); });
    if (focusEl && focusEl.focus) focusEl.focus({ preventScroll: true });
    ["pointerup", "mouseup", "click"].forEach(function (t) { mouse(at, t, x, y); });
  }

  async function click(el, a) {
    a = a || {};
    var p = await actionable(el, a);
    // A real click lands on whatever is on top: with force, the element gets it all the same.
    var at = !a.force && topPoint(p.at, p.x, p.y);
    if (at && (await hostInput({ kind: "click", x: at.x, y: at.y }))) return;
    pointAt(p.at, el, p.x, p.y);
  }

  var FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1']),[contenteditable='true']";

  // A click at a point of the viewport (CSS pixels), for what has no ref: a canvas, a video,
  // a map. It goes into frames of the same site, and with real input into frames of other
  // sites too (a video player, a payment form, a captcha).
  async function clickAt(a) {
    var x = Number(a.x);
    var y = Number(a.y);
    if (!isFinite(x) || !isFinite(y)) throw new Error("Pass x and y.");
    var doc = document;
    var hit = doc.elementFromPoint(x, y);
    var foreign = null;
    while (hit && (hit.tagName === "IFRAME" || hit.tagName === "FRAME")) {
      var inner = frameDoc(hit);
      if (!inner) { foreign = hit; break; }
      var fr = hit.getBoundingClientRect();
      x -= fr.left + hit.clientLeft;
      y -= fr.top + hit.clientTop;
      doc = inner;
      hit = doc.elementFromPoint(x, y);
    }
    while (hit && hit.shadowRoot) {
      var deeper = hit.shadowRoot.elementFromPoint(x, y);
      if (!deeper || deeper === hit) break;
      hit = deeper;
    }
    if (!hit) throw new Error("Nothing is at (" + Math.round(a.x) + ", " + Math.round(a.y) + "): the point is outside the page.");
    var what = foreign ? "inside " + frameLine(foreign) : pointLabel(hit);
    if (await hostInput({ kind: "click", x: Number(a.x), y: Number(a.y) })) return "Clicked " + what + ".";
    if (foreign) throw new Error("That point is inside " + frameLine(foreign) + ", an embedded page from another site, which the agent can't click into here.");
    pointAt(hit, hit.closest && hit.closest(FOCUSABLE), x, y);
    return "Clicked " + pointLabel(hit) + ".";
  }

  function setValue(el, value) {
    var W = el.ownerDocument.defaultView || window;
    var proto = el.tagName === "TEXTAREA" ? W.HTMLTextAreaElement.prototype
      : el.tagName === "SELECT" ? W.HTMLSelectElement.prototype : W.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  var TYPED = /^(text|search|email|url|tel|password|number)$/;

  /** Types the value for real into a field: what is there gets selected and replaced, as the
   *  keyboard would. False if it couldn't (no real input here, or the field didn't change). */
  async function typeInto(el, value) {
    if (!hostTrusted || !hostKeys) return false;
    if (el.tagName === "INPUT" && !TYPED.test((el.type || "text").toLowerCase())) return false;
    var before = el.value;
    try { el.select(); } catch (e) { return false; }
    if (deepFocus() !== el) return false;
    var ok = await hostInput(value ? { kind: "text", text: value } : { kind: "key", key: "Delete" });
    return ok && (el.value === value || el.value !== before);
  }

  /** The box that scrolls under the middle of the window: the element there or the nearest
   *  ancestor whose content is taller than it and whose overflow lets it scroll. */
  function scrollerAtCenter() {
    var n = document.elementFromPoint ? document.elementFromPoint(innerWidth / 2, innerHeight / 2) : null;
    for (; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(n).overflowY)) return n;
    }
    return null;
  }

  /** The value each kind of field takes, for when it refused one in another form. */
  var FIELD_FORMATS = {
    date: "YYYY-MM-DD", "datetime-local": "YYYY-MM-DDTHH:MM", time: "HH:MM", month: "YYYY-MM",
    week: "YYYY-W##", number: "digits with a dot for decimals (1.5)", range: "a number", color: "#rrggbb",
  };

  /** How a text field differs from what fill asked for, or null when it holds just that.
   *  `failed`: it stayed empty (a date as 31/12/2026, a number as 1,5), so the form isn't
   *  filled. Otherwise the page changed what was typed (a mask, a maxlength). A password's
   *  value is never repeated, only its length. */
  function fillMismatch(el, value) {
    var tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA") return null;
    var type = tag === "INPUT" ? (el.type || "text").toLowerCase() : "";
    if (type === "checkbox" || type === "radio" || type === "file") return null;
    var got = String(el.value);
    if (got === value) return null;
    var shown = function (v) {
      if (type === "password") return v.length + " characters";
      return JSON.stringify(v.length > 80 ? v.slice(0, 80) + "\u2026" : v);
    };
    var format = FIELD_FORMATS[type] ? " A " + type + " field takes " + FIELD_FORMATS[type] + "." : "";
    if (!got && value) return { failed: true, text: label(el) + " stayed empty: it didn't take " + shown(value) + "." + format };
    return { failed: false, text: "it now holds " + shown(got) + ", not " + shown(value) + "." + format };
  }

  /** Fills the field and says how it went: an error when it didn't take the value. */
  async function fillChecked(el, value) {
    await fill(el, value);
    var off = fillMismatch(el, value);
    if (off && off.failed) throw new Error(off.text);
    return off ? "Filled " + label(el) + ", but " + off.text : "Filled " + label(el) + ".";
  }

  async function fill(el, value) {
    var tag = el.tagName;
    var type = tag === "INPUT" ? (el.type || "text").toLowerCase() : "";
    if (type === "checkbox" || type === "radio") {
      var want = !/^(false|0|off|no|)$/i.test(value);
      // Styled checkboxes often hide the input itself behind their label.
      if (el.checked !== want) { if (isShown(el)) await click(el, { force: true }); else el.click(); }
      return;
    }
    if (isDisabled(el)) throw new Error(label(el) + " is disabled.");
    if (el.readOnly) throw new Error(label(el) + " is read-only.");
    el.scrollIntoView({ block: "center" });
    if (el.focus) el.focus({ preventScroll: true });
    if (tag === "SELECT") {
      var option = Array.prototype.find.call(el.options, function (o) { return o.value === value || clean(o.textContent) === value; });
      if (!option) throw new Error('The list has no option "' + value + '"');
      setValue(el, option.value);
      return;
    }
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (await typeInto(el, value)) return;
      setValue(el, value);
      return;
    }
    if (el.isContentEditable) {
      // Rich editors (ProseMirror, Lexical, Slate) follow insertText; plain ones get the text.
      var doc = el.ownerDocument;
      var sel = doc.getSelection();
      var range = doc.createRange();
      var selectAll = function () {
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      };
      selectAll();
      if (hostTrusted) {
        var typed = await hostInput(value ? { kind: "text", text: value } : { kind: "key", key: "Delete" });
        if (typed && clean(el.innerText, 100000) === clean(value, 100000)) return;
        // Not all of it went in: start over the old way, on the whole text again.
        if (typed) selectAll();
      }
      var done = false;
      try { done = value ? doc.execCommand("insertText", false, value) : doc.execCommand("delete"); } catch (e) { done = false; }
      if (!done || clean(el.innerText, 100000) !== clean(value, 100000)) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      }
      return;
    }
    throw new Error(label(el) + " can't be typed into.");
  }

  async function press(combo) {
    var el = deepFocus() || document.body;
    var doc = el.ownerDocument;
    var on = el === doc.body ? "the page" : label(el);
    // A real key does what it does in the page by itself: Tab moves, Enter submits, text types.
    if (await hostInput({ kind: "key", key: String(combo) })) return on;
    var parts = String(combo).split("+");
    var key = parts.pop();
    if (key === "" ) key = "+";
    var mods = parts.map(function (m) { return m.toLowerCase(); });
    var init = {
      key: key, bubbles: true, cancelable: true, composed: true,
      code: key.length === 1 ? (/[a-z]/i.test(key) ? "Key" + key.toUpperCase() : "") : key,
      ctrlKey: mods.indexOf("control") >= 0 || mods.indexOf("ctrl") >= 0,
      shiftKey: mods.indexOf("shift") >= 0,
      altKey: mods.indexOf("alt") >= 0,
      metaKey: mods.indexOf("meta") >= 0
    };
    var go = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (go && (key.length === 1 || key === "Enter")) el.dispatchEvent(new KeyboardEvent("keypress", init));
    // Synthetic key events have no default action, so do the common ones by hand.
    if (go && !init.ctrlKey && !init.metaKey && !init.altKey) {
      var tag = el.tagName;
      var editable = tag === "TEXTAREA" || (tag === "INPUT" && !/^(checkbox|radio|button|submit|reset|file|range|color)$/.test(el.type));
      if (key === "Enter" && tag === "INPUT" && el.form) {
        if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
      } else if (key === "Enter" && (tag === "BUTTON" || tag === "A")) {
        el.click();
      } else if (key === "Tab") {
        var all = Array.prototype.filter.call(doc.querySelectorAll(FOCUSABLE), isShown);
        var i = all.indexOf(el);
        var next = all[(i + (init.shiftKey ? -1 : 1) + all.length) % all.length];
        if (next) next.focus();
      } else if (editable && key.length === 1) {
        var start = el.selectionStart == null ? el.value.length : el.selectionStart;
        var end = el.selectionEnd == null ? el.value.length : el.selectionEnd;
        setValue(el, el.value.slice(0, start) + key + el.value.slice(end));
        try { el.setSelectionRange(start + 1, start + 1); } catch (e) { /* not a text input */ }
      } else if (editable && key === "Backspace") {
        var s = el.selectionStart, f = el.selectionEnd;
        if (s != null && s === f && s > 0) s -= 1;
        if (s != null) setValue(el, el.value.slice(0, s) + el.value.slice(f));
      }
    }
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    return on;
  }

  function serialize(v) {
    if (v === undefined) return "undefined";
    if (typeof v === "function") return v.toString().slice(0, 300);
    if (v instanceof Element) return v.outerHTML.length > 2000 ? v.outerHTML.slice(0, 2000) + "..." : v.outerHTML;
    if (v instanceof NodeList || v instanceof HTMLCollection) v = Array.prototype.slice.call(v, 0, 50).map(serialize);
    try {
      var seen = new WeakSet();
      var s = JSON.stringify(v, function (k, x) {
        if (x instanceof Element) return "<" + x.tagName.toLowerCase() + ">";
        if (typeof x === "object" && x !== null) { if (seen.has(x)) return "[circular]"; seen.add(x); }
        if (typeof x === "bigint") return x.toString();
        return x;
      }, 2);
      return s === undefined ? String(v) : s;
    } catch (e) {
      return String(v);
    }
  }

  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  async function evaluate(code) {
    var fn;
    try {
      fn = new AsyncFunction("return (" + code + "\n);");
    } catch (e) {
      fn = new AsyncFunction(code);
    }
    return serialize(await fn());
  }

  function errorsSince(seq) {
    return logs.filter(function (l) { return l.seq > seq && (l.level === "error" || l.level === "network"); })
      .map(function (l) { return "[" + l.level + "] " + l.text; });
  }

  /**
   * Keeps an action of the agent from opening a file picker. The system's picker is a window
   * of its own that blocks the page until someone closes it, so a click on "Upload" left the
   * agent waiting for an answer that never came. A file field's click (the page's own
   * `input.click()` too), `showPicker()` and `showOpenFilePicker()` are stopped instead, and
   * the action says which field to give `upload`. Returns the function that undoes it and
   * reports what it stopped.
   */
  function blockFilePickers() {
    var stopped = null;
    var isFile = function (el) { return el && el.tagName === "INPUT" && (el.type || "").toLowerCase() === "file"; };
    var onClick = function (e) {
      if (!isFile(e.target)) return;
      e.preventDefault();
      stopped = e.target;
    };
    window.addEventListener("click", onClick, true);
    var proto = window.HTMLInputElement.prototype;
    var showPicker = proto.showPicker;
    if (showPicker) {
      proto.showPicker = function () {
        if (isFile(this)) { stopped = this; return; }
        return showPicker.apply(this, arguments);
      };
    }
    var openPicker = window.showOpenFilePicker;
    if (openPicker) {
      window.showOpenFilePicker = function () {
        stopped = stopped || true;
        return Promise.reject(new DOMException("The agent can't use a file picker here.", "AbortError"));
      };
    }
    return function () {
      window.removeEventListener("click", onClick, true);
      if (showPicker) proto.showPicker = showPicker;
      if (openPicker) window.showOpenFilePicker = openPicker;
      if (!stopped) return "";
      var field = stopped === true ? "the area you clicked" : label(stopped) + " [ref=" + refFor(stopped, "file field", label(stopped)) + "]";
      return "\nThis opens a file picker, which the agent can't use, so it was stopped. To send files, call upload with their paths and " + field + ".";
    };
  }

  // Runs an action and says what it did to the page: the new URL, what changed in its controls,
  // dialogs and messages, and the errors it logged. `quiet` holds the elements whose own
  // change is the action itself (a filled field), and `target` the element it acted on.
  async function act(run, quiet, target) {
    var before = logSeq;
    var reqMark = reqSeq;
    var url = location.href;
    var was = collect();
    watchTimers();
    var pickers = blockFilePickers();
    var out;
    try {
      out = await run();
    } catch (e) {
      pickers();
      unwatchTimers();
      throw e;
    }
    await settle(reqMark);
    out += pickers();
    if (location.href !== url) out += "\nThe URL is now " + location.href;
    var summary = changes(was, collect(), quiet || new Set(), target);
    out += summary ? "\nChanges:\n" + summary : "\nNo change in the page's controls, dialogs or messages.";
    var errors = errorsSince(before);
    if (errors.length) out += "\nErrors after the action:\n" + errors.join("\n");
    return out;
  }

  function isFileInput(el) {
    return !!el && el.tagName === "INPUT" && (el.type || "").toLowerCase() === "file";
  }

  /** The file field an upload goes to: the element itself, its label's field, or the one file
   *  field around it (an "Upload" button usually sits next to a hidden input). Null when there
   *  is none, or more than one and it can't tell which. */
  function fileInputFor(el) {
    if (isFileInput(el)) return el;
    var lab = el.tagName === "LABEL" ? el : el.closest && el.closest("label");
    if (lab && isFileInput(lab.control)) return lab.control;
    for (var n = el, depth = 0; n && depth < 5; n = n.parentElement, depth++) {
      var found = n.querySelectorAll ? n.querySelectorAll("input[type=file]") : [];
      if (found.length === 1) return found[0];
      if (found.length > 1) return null;
    }
    return null;
  }

  /** Gives the page `files` ({name, type, data in base64}) as if the user had picked them in the
   *  system's picker, or dropped them on `el` when it is an area without a file field. */
  async function upload(el, files) {
    var W = el.ownerDocument.defaultView || window;
    var dt = new W.DataTransfer();
    var names = files.map(function (f) {
      var bin = atob(String(f.data || ""));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var name = String(f.name || "file");
      dt.items.add(new W.File([bytes], name, { type: String(f.type || "") }));
      return name;
    });
    var list = names.join(", ");
    var input = fileInputFor(el);
    if (input) {
      if (isDisabled(input)) throw new Error(label(input) + " is disabled.");
      if (!input.multiple && names.length > 1) throw new Error(label(input) + " takes one file, not " + names.length + ".");
      input.files = dt.files;
      input.dispatchEvent(new W.Event("input", { bubbles: true }));
      input.dispatchEvent(new W.Event("change", { bubbles: true }));
      return "Uploaded " + list + " to " + label(input) + ".";
    }
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2;
    var y = r.top + r.height / 2;
    ["dragenter", "dragover", "drop"].forEach(function (type) {
      el.dispatchEvent(new W.DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt }));
    });
    return "Dropped " + list + " on " + label(el) + ".";
  }

  var commands = {
    snapshot: function (a) { return snapshot(a); },
    find: function (a) { return find(a); },
    click: function (a) {
      var el = target(a);
      return act(async function () { var l = label(el); await click(el, a); return "Clicked " + l + "."; }, null, el);
    },
    click_at: function (a) { return act(function () { return clickAt(a); }); },
    fill: function (a) {
      var el = target(a);
      return act(function () { return fillChecked(el, String(a.value == null ? "" : a.value)); }, new Set([el]));
    },
    fill_form: function (a) {
      var fields = Array.isArray(a.fields) ? a.fields : [];
      if (!fields.length) throw new Error("Pass the fields to fill: [{ref, value}].");
      var quiet = new Set();
      return act(async function () {
        var done = [];
        var changed = [];
        for (var i = 0; i < fields.length; i++) {
          var f = fields[i] || {};
          try {
            var el = target(f);
            quiet.add(el);
            var value = String(f.value == null ? "" : f.value);
            await fill(el, value);
            var off = fillMismatch(el, value);
            if (off && off.failed) throw new Error(off.text);
            if (off) changed.push(label(el) + ": " + off.text);
            done.push(label(el));
          } catch (e) {
            throw new Error((done.length ? "Filled " + done.join(", ") + ". " : "") + "Field " + (i + 1) + " failed: " + (e && e.message ? e.message : e));
          }
        }
        return "Filled " + done.join(", ") + "." + (changed.length ? " But " + changed.join(" ") : "");
      }, quiet);
    },
    press: function (a) { return act(async function () { return "Pressed " + a.key + " on " + (await press(a.key)) + "."; }); },
    upload: function (a) {
      var el = target(a);
      var files = Array.isArray(a.files) ? a.files : [];
      if (!files.length) throw new Error("Pass the paths of the files to upload.");
      return act(function () { return upload(el, files); }, null, el);
    },
    // A scroll changes what is on screen, so it answers with the new view.
    scroll: async function (a) {
      var mark = reqSeq;
      var el = a.ref || a.selector ? target(a) : null;
      watchTimers();
      var what;
      if (el) { el.scrollIntoView({ block: "center" }); what = "Scrolled to " + label(el) + "."; }
      else {
        var before = scrollY;
        if (a.to === "top") scrollTo(0, 0);
        else if (a.to === "bottom") scrollTo(0, document.documentElement.scrollHeight);
        else scrollBy(0, Number(a.y) || innerHeight * 0.8);
        // Apps that scroll a box of their own (a chat, a feed) leave the window where it was.
        var box = scrollY === before ? scrollerAtCenter() : null;
        if (box) {
          if (a.to === "top") box.scrollTop = 0;
          else if (a.to === "bottom") box.scrollTop = box.scrollHeight;
          else box.scrollTop += Number(a.y) || box.clientHeight * 0.8;
          what = "Scrolled " + label(box) + " to " + Math.round(box.scrollTop) + "px.";
        } else what = "Scrolled to " + Math.round(scrollY) + "px.";
      }
      await settle(mark);
      return what + "\n\n" + snapshot({});
    },
    eval: function (a) { return evaluate(String(a.expression || "")); },
    console: function (a) {
      var levels = a.level ? String(a.level).split(",") : null;
      var picked = logs.filter(function (l) { return !levels || levels.indexOf(l.level) >= 0; });
      var limit = Math.max(1, Math.min(Number(a.limit) || 100, MAX_LOGS));
      var text = picked.slice(-limit).map(function (l) { return "[" + l.level + "] " + l.text; }).join("\n");
      if (a.clear) logs = [];
      return text || "(no console output)";
    },
    // The browser's annotation toolbar (see "Annotations" below).
    annotate: function (a) { return annotate(a); },
    annotate_undo: function () { return annUndo(); },
    annotate_redo: function () { return annRedo(); },
    annotate_clear: function () { return annClear(); },
    annotate_state: function () { return annState(); },
    annotate_end: function () { return annEnd(); }
  };

  // ---- Annotations ----
  // Drawings over the page for the browser's toolbar: a canvas fixed over the viewport (what a
  // screenshot of the panel shows), redrawn as the page scrolls. Each drawing is pinned to what
  // it was drawn on: the page, a scrolling box inside it (a list, a code panel: it scrolls with
  // the box and is clipped to it), or a fixed bar (it stays put). Nyxs sets the tool, color and
  // width with `annotate`; while the tool is "select" the canvas lets clicks through to the
  // page, for the element picker.
  var ann = null;
  var annTool = "select";
  var annColor = "#e03131";
  var annWidth = 4;

  function annFontSize(w) { return Math.round(10 + w * 1.5); }
  function annLineHeight(w) { return Math.round(annFontSize(w) * 1.25); }
  function annFont(w) { return "500 " + annFontSize(w) + "px system-ui, -apple-system, 'Segoe UI', sans-serif"; }

  function annLayer() {
    if (ann) return ann;
    var c = document.createElement("canvas");
    c.setAttribute("data-nyxs-annotations", "");
    c.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483646;pointer-events:none;touch-action:none;";
    (document.body || document.documentElement).appendChild(c);
    ann = { canvas: c, shapes: [], redo: [], draft: null, input: null };
    c.addEventListener("pointerdown", annDown);
    c.addEventListener("pointermove", annMove);
    c.addEventListener("pointerup", annUp);
    c.addEventListener("pointercancel", annUp);
    window.addEventListener("resize", annRedraw);
    // Capture: a box inside the page scrolls without the event reaching the window.
    document.addEventListener("scroll", annRedraw, true);
    annRedraw();
    return ann;
  }

  var ANN_PAGE = null;
  var ANN_FIXED = "fixed";

  /** What a point of the viewport is pinned to: the nearest box that scrolls (or a fixed bar)
   *  under it, or the page (ANN_PAGE). */
  function annAnchorAt(x, y) {
    var hits = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    for (var i = 0; i < hits.length; i++) {
      var el = hits[i];
      if (el === ann.canvas || (ann.input && el === ann.input.el)) continue;
      for (var n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        var s = getComputedStyle(n);
        if (s.position === "fixed") return ANN_FIXED;
        var scrollsY = /(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight;
        var scrollsX = /(auto|scroll|overlay)/.test(s.overflowX) && n.scrollWidth > n.clientWidth;
        if (scrollsY || scrollsX) return n;
      }
      return ANN_PAGE;
    }
    return ANN_PAGE;
  }

  /** Where the anchor's origin is on screen now (and, for a box, the part of it that shows). */
  function annPlace(anchor, last) {
    if (anchor === ANN_FIXED) return { x: 0, y: 0 };
    if (anchor === ANN_PAGE) return { x: -scrollX, y: -scrollY };
    // A box the page took away: the drawing stays where it was last seen.
    if (!anchor.isConnected) return last || { x: 0, y: 0 };
    var r = anchor.getBoundingClientRect();
    var left = r.left + anchor.clientLeft;
    var top = r.top + anchor.clientTop;
    return { x: left - anchor.scrollLeft, y: top - anchor.scrollTop, clip: { x: left, y: top, w: anchor.clientWidth, h: anchor.clientHeight } };
  }

  function annPoints(s) { return s.points || (s.b ? [s.a, s.b] : [s.a]); }

  /** The same shape with every point moved by (dx, dy). */
  function annShift(s, dx, dy) {
    var move = function (p) { return { x: p.x + dx, y: p.y + dy }; };
    var out = {};
    for (var k in s) out[k] = s[k];
    if (s.points) out.points = s.points.map(move);
    if (s.a) out.a = move(s.a);
    if (s.b) out.b = move(s.b);
    return out;
  }

  /** A shape drawn in viewport points, pinned to what it was drawn on. A shape that spans
   *  several boxes (an arrow from a list to the page) is pinned to the page, so no box's clip
   *  cuts it. */
  function annPin(s) {
    var pts = annPoints(s);
    var anchor = annAnchorAt(pts[0].x, pts[0].y);
    var step = Math.max(1, Math.floor(pts.length / 20));
    for (var i = step; i < pts.length; i += step) {
      if (annAnchorAt(pts[i].x, pts[i].y) !== anchor) { anchor = ANN_PAGE; break; }
    }
    if (pts.length > 1 && annAnchorAt(pts[pts.length - 1].x, pts[pts.length - 1].y) !== anchor) anchor = ANN_PAGE;
    var at = annPlace(anchor);
    var pinned = annShift(s, -at.x, -at.y);
    pinned.anchor = anchor;
    pinned.last = at;
    return pinned;
  }

  function annRedraw() {
    if (!ann) return;
    var c = ann.canvas;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.round(innerWidth * dpr);
    var h = Math.round(innerHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    var ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ann.shapes.forEach(function (s) {
      var at = annPlace(s.anchor, s.last);
      if (s.anchor !== ANN_PAGE && s.anchor !== ANN_FIXED && s.anchor.isConnected) s.last = at;
      ctx.save();
      if (at.clip) {
        ctx.beginPath();
        ctx.rect(at.clip.x, at.clip.y, at.clip.w, at.clip.h);
        ctx.clip();
      }
      ctx.translate(at.x, at.y);
      annShape(ctx, s);
      ctx.restore();
    });
    // Still being drawn: in viewport points until it's pinned.
    if (ann.draft) annShape(ctx, ann.draft);
    // The text being typed follows what it was started on.
    if (ann.input) {
      var p = annPlace(ann.input.anchor, ann.input.last);
      ann.input.el.style.left = ann.input.local.x + p.x - 3 + "px";
      ann.input.el.style.top = ann.input.local.y + p.y - 3 + "px";
    }
  }

  function annShape(ctx, s) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    var a = s.a;
    var b = s.b;
    if (s.type === "pen") {
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (var i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.01, s.points[0].y);
      ctx.stroke();
    } else if (s.type === "line" || s.type === "arrow") {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (s.type === "arrow") {
        var angle = Math.atan2(b.y - a.y, b.x - a.x);
        var head = Math.max(10, s.width * 3.5);
        ctx.beginPath();
        ctx.moveTo(b.x - head * Math.cos(angle - 0.45), b.y - head * Math.sin(angle - 0.45));
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(b.x - head * Math.cos(angle + 0.45), b.y - head * Math.sin(angle + 0.45));
        ctx.stroke();
      }
    } else if (s.type === "rect") {
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (s.type === "ellipse") {
      ctx.beginPath();
      ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.type === "step") {
      var r = 10 + s.width;
      ctx.beginPath();
      ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (s.color === "#ffffff") { ctx.lineWidth = 1; ctx.strokeStyle = "#1a1a1a"; ctx.stroke(); }
      ctx.fillStyle = s.color === "#ffffff" ? "#1a1a1a" : "#ffffff";
      ctx.font = "600 " + Math.round(r * 1.1) + "px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(s.n), a.x, a.y + 0.5);
    } else if (s.type === "text") {
      var lh = annLineHeight(s.width);
      var top = a.y + (lh - annFontSize(s.width)) / 2;
      ctx.font = annFont(s.width);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      s.text.split("\n").forEach(function (line, n) { ctx.fillText(line, a.x, top + n * lh); });
    }
  }

  function annState() { return { count: ann ? ann.shapes.length : 0, redo: ann ? ann.redo.length : 0 }; }
  // Pages in the panel's iframe tell Nyxs at once; native webviews are polled with annotate_state.
  function annNotify() {
    toParent({ source: "nyxs-annotations", state: annState() });
  }
  function annPush(s) {
    ann.shapes.push("anchor" in s ? s : annPin(s));
    ann.redo = [];
    annRedraw();
    annNotify();
  }

  function annDown(e) {
    if (annTool === "select" || e.button !== 0) return;
    e.preventDefault();
    var p = { x: e.clientX, y: e.clientY };
    if (annTool === "text") { annText(p); return; }
    annCommitText();
    if (annTool === "step") {
      var n = ann.shapes.filter(function (s) { return s.type === "step"; }).length + 1;
      annPush({ type: "step", a: p, n: n, color: annColor, width: annWidth });
      return;
    }
    try { ann.canvas.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic pointer */ }
    ann.draft = annTool === "pen"
      ? { type: "pen", points: [p], color: annColor, width: annWidth }
      : { type: annTool, a: p, b: p, color: annColor, width: annWidth };
  }
  function annMove(e) {
    if (!ann || !ann.draft) return;
    var p = { x: e.clientX, y: e.clientY };
    if (ann.draft.type === "pen") ann.draft.points.push(p);
    else ann.draft.b = p;
    annRedraw();
  }
  function annUp() {
    var d = ann && ann.draft;
    if (!d) return;
    ann.draft = null;
    // A click without dragging leaves no shape (a pen dot does).
    if (d.type === "pen" || Math.abs(d.b.x - d.a.x) + Math.abs(d.b.y - d.a.y) > 3) annPush(d);
    else annRedraw();
  }

  function annText(p) {
    annCommitText();
    var ta = document.createElement("textarea");
    var lh = annLineHeight(annWidth);
    ta.rows = 1;
    ta.spellcheck = false;
    ta.style.cssText =
      "position:fixed;z-index:2147483647;left:" + (p.x - 3) + "px;top:" + (p.y - 3) + "px;min-width:140px;height:" + (lh + 6) + "px;" +
      "margin:0;padding:2px;border:1px dashed " + annColor + ";border-radius:3px;outline:none;background:transparent;" +
      "resize:none;overflow:hidden;white-space:pre;color:" + annColor + ";font:" + annFont(annWidth) + ";line-height:" + lh + "px;";
    var anchor = annAnchorAt(p.x, p.y);
    var at = annPlace(anchor);
    ann.input = { el: ta, anchor: anchor, last: at, local: { x: p.x - at.x, y: p.y - at.y }, color: annColor, width: annWidth };
    ta.addEventListener("input", function () {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + 2 + "px";
      ta.style.width = Math.max(140, ta.scrollWidth + 4) + "px";
    });
    ta.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Escape") { ann.input = null; ta.remove(); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); annCommitText(); }
    });
    ta.addEventListener("blur", annCommitText);
    (document.body || document.documentElement).appendChild(ta);
    setTimeout(function () { ta.focus(); }, 0);
  }
  function annCommitText() {
    var i = ann && ann.input;
    if (!i) return;
    ann.input = null;
    var text = i.el.value.replace(/\s+$/, "");
    i.el.remove();
    if (text) annPush({ type: "text", a: i.local, text: text, color: i.color, width: i.width, anchor: i.anchor, last: i.last });
  }

  function annotate(a) {
    annLayer();
    if (a.commit) annCommitText();
    if (a.tool && a.tool !== annTool) { annCommitText(); annTool = a.tool; }
    if (a.color) annColor = a.color;
    if (a.width) annWidth = Number(a.width) || annWidth;
    ann.canvas.style.pointerEvents = annTool === "select" ? "none" : "auto";
    ann.canvas.style.cursor = annTool === "text" ? "text" : "crosshair";
    return annState();
  }
  function annUndo() {
    if (ann) {
      annCommitText();
      if (ann.shapes.length) { ann.redo.push(ann.shapes.pop()); annRedraw(); annNotify(); }
    }
    return annState();
  }
  function annRedo() {
    if (ann && ann.redo.length) { ann.shapes.push(ann.redo.pop()); annRedraw(); annNotify(); }
    return annState();
  }
  function annClear() {
    if (ann) {
      if (ann.input) { ann.input.el.remove(); ann.input = null; }
      ann.shapes = [];
      ann.redo = [];
      annRedraw();
      annNotify();
    }
    return annState();
  }
  function annEnd() {
    if (ann) {
      if (ann.input) ann.input.el.remove();
      ann.canvas.remove();
      window.removeEventListener("resize", annRedraw);
      document.removeEventListener("scroll", annRedraw, true);
      ann = null;
      annNotify();
    }
    annTool = "select";
    return annState();
  }

  // External sites open in a native webview with no parent to post to. There Nyxs starts a
  // command with __nyxsAgentRun (or __nyxsAgentRunFn for eval, whose code arrives inside the
  // calling script so the site's CSP can't block it) and collects it with __nyxsAgentTake.
  var results = {};
  function start(id, run) {
    results[id] = { pending: true };
    Promise.resolve()
      .then(run)
      .then(
        function (result) { results[id] = { ok: true, result: result }; },
        function (err) { results[id] = { ok: false, error: err && err.message ? err.message : String(err) }; }
      );
    return "started";
  }
  api.__nyxsAgentRun = function (id, cmd, args, host) {
    applyHost(host);
    hostId = id;
    hostTrusted = !!(host && host.trusted === true);
    var run = commands[cmd];
    if (!run) { results[id] = { ok: false, error: "Unknown command " + cmd }; return "started"; }
    return start(id, function () { return run(args || {}); });
  };
  api.__nyxsAgentRunFn = function (id, fn) {
    return start(id, function () { return Promise.resolve(fn()).then(serialize); });
  };
  api.__nyxsAgentTake = function (id, host) {
    applyHost(host);
    var r = results[id];
    // Gone: the page navigated and this is a new document.
    if (!r) return { missing: true, url: location.href };
    if (r.pending && settleCheck) settleCheck();
    // Still running, maybe waiting for Nyxs to do a click or keys for real (see hostInput).
    if (r.pending) return r.input ? { pending: true, input: r.input } : { pending: true };
    delete results[id];
    return r;
  };

  // The element picker for pages in a native webview, which Nyxs starts, stops and polls.
  var pickBox = null;
  var pickLast = null;
  var picked = null;
  function pickSel(el) {
    var t = el.tagName.toLowerCase();
    var id = el.id ? "#" + el.id : "";
    var c = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    return t + id + c;
  }
  function pickPath(el) {
    var p = [];
    var c = el;
    while (c && c.tagName && c.tagName.toLowerCase() !== "body" && p.length < 6) { p.unshift(pickSel(c)); c = c.parentElement; }
    return p.join(" > ");
  }
  // Which node was picked, told apart from the ones that look like it: inside a dialog box two
  // fields often share tag and classes, so the selector cannot be the identity of a pick. The id
  // follows the node (a WeakMap) and carries a token of this document, so a pick from before a
  // reload never looks like a pick of another element after it. It lives on the window so the
  // picker Nyxs injects into local files (agent/preview.rs) counts with the same numbers.
  var pickIds = api.__nyxsPickIds || (api.__nyxsPickIds = {
    n: 0,
    doc: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    map: typeof WeakMap === "function" ? new WeakMap() : null,
  });
  function pickUid(el) {
    if (!pickIds.map) return "";
    var k = pickIds.map.get(el);
    if (!k) { k = pickIds.doc + "-" + ++pickIds.n; pickIds.map.set(el, k); }
    return k;
  }
  function pickMove(e) {
    var t = e.target;
    if (!t || t === pickBox || !t.getBoundingClientRect) return;
    pickLast = t;
    if (!pickBox) {
      pickBox = document.createElement("div");
      pickBox.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;background:rgba(42,120,214,.18);outline:2px solid #2a78d6;border-radius:2px;";
      document.body.appendChild(pickBox);
    }
    var r = t.getBoundingClientRect();
    pickBox.style.left = r.left + "px";
    pickBox.style.top = r.top + "px";
    pickBox.style.width = r.width + "px";
    pickBox.style.height = r.height + "px";
  }
  // What the chat shows about a picked element (and sends to the model): its tag, text, place,
  // the styles that shape it, its HTML and its siblings, and where it is for a screenshot.
  var PICK_STYLES = ["display", "position", "flex-direction", "justify-content", "align-items", "width", "height", "padding", "margin",
    "background-color", "color", "font-size", "font-weight", "border-radius", "border-width", "border-style", "border-color"];
  function pickHtml(el, max) {
    var html = el.outerHTML.replace(/\s+/g, " ").trim();
    return html.length > max ? html.slice(0, max) + "\u2026" : html;
  }
  function pickDescribe(el) {
    var styles = {};
    var cs = getComputedStyle(el);
    PICK_STYLES.forEach(function (p) { styles[p] = cs.getPropertyValue(p); });
    var siblings = "";
    if (el.parentElement) {
      var kids = Array.prototype.slice.call(el.parentElement.children);
      var at = kids.indexOf(el);
      siblings = kids.slice(Math.max(0, at - 3), at + 4).map(function (k) {
        return (k === el ? "<!-- SELECTED -->\n" : "") + pickHtml(k, 240);
      }).join("\n");
    }
    var r = el.getBoundingClientRect();
    return {
      selector: pickSel(el),
      uid: pickUid(el),
      path: pickPath(el),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140),
      html: pickHtml(el, 700),
      tag: el.tagName.toLowerCase(),
      styles: styles,
      siblings: siblings,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }
    };
  }
  // The local pages' own picker (agent/preview.rs) uses it too.
  api.__nyxsDescribe = pickDescribe;
  function pickClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = pickLast || e.target;
    if (el && el.outerHTML) picked = pickDescribe(el);
    pickStop();
  }
  function pickStop() {
    document.removeEventListener("mousemove", pickMove, true);
    document.removeEventListener("click", pickClick, true);
    if (pickBox) { pickBox.remove(); pickBox = null; }
    if (document.body) document.body.style.cursor = "";
    return "stopped";
  }
  api.__nyxsPickStart = function () {
    pickStop();
    picked = null;
    document.addEventListener("mousemove", pickMove, true);
    document.addEventListener("click", pickClick, true);
    if (document.body) document.body.style.cursor = "crosshair";
    return "started";
  };
  api.__nyxsPickStop = pickStop;
  api.__nyxsPickTake = function () {
    var p = picked;
    picked = null;
    return p;
  };

  if (frameKey === null) window.addEventListener("message", function (e) {
    var d = e.data;
    if (e.source !== window.parent || !d || d.source !== "nyxs-agent") return;
    var reply = function (msg) {
      msg.source = "nyxs-agent-reply";
      msg.id = d.id;
      window.parent.postMessage(msg, "*");
    };
    var run = commands[d.cmd];
    if (!run) { reply({ ok: false, error: "Unknown command " + d.cmd }); return; }
    Promise.resolve()
      .then(function () { return run(d.args || {}); })
      .then(function (result) { reply({ ok: true, result: result }); }, function (err) { reply({ ok: false, error: err && err.message ? err.message : String(err) }); });
  });

  // The page's icon for its browser tab. Read here as a data URL, since the app can't load a
  // local server's http icon itself; an icon the page can't fetch (CORS, CSP) goes by address.
  function iconHref() {
    var best = null;
    var bestScore = -1;
    Array.prototype.forEach.call(document.querySelectorAll("link[rel][href]"), function (l) {
      if (!/(^|\s)icon(\s|$)/i.test(l.rel)) return;
      var size = parseInt((l.getAttribute("sizes") || "").split(/x/i)[0], 10) || 0;
      // An SVG is sharp at any size; else the closest to 32 px, a bigger one before a smaller.
      var score = /\.svg(\?|$)/i.test(l.href) || /svg/i.test(l.type) ? 1000 : size >= 32 ? 500 - size : size ? 100 + size : 200;
      if (score > bestScore) { best = l.href; bestScore = score; }
    });
    return best || (/^https?:$/.test(location.protocol) ? location.origin + "/favicon.ico" : null);
  }
  function loadIcon(href) {
    // The app shows an https icon itself, so there's no need to wait for a download.
    if (!href || /^(data:image\/|https:)/i.test(href) || !originalFetch) return Promise.resolve(href);
    return originalFetch.call(window, href, { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) return null;
        return r.blob().then(function (b) {
          if (!b.size || b.size > 256 * 1024 || /^text\//i.test(b.type)) return null;
          return new Promise(function (resolve) {
            var fr = new FileReader();
            fr.onload = function () {
              var url = String(fr.result);
              // A server that sends no type for its .ico still has an image.
              resolve(/^data:image\//i.test(url) ? url : url.replace(/^data:[^;,]*/, "data:image/x-icon"));
            };
            fr.onerror = function () { resolve(href); };
            fr.readAsDataURL(b);
          });
        });
      })
      .catch(function () { return href; });
  }
  // Nyxs reads it from the tab's status for websites; local pages post it. Like a browser, the
  // tab gets it as soon as the <head> names it, not once the whole page has loaded.
  api.__nyxsIcon = null;
  var iconSeen;
  function updateIcon(final) {
    var href = iconHref();
    var declared = href && !/\/favicon\.ico$/.test(href);
    // Until the <head> is parsed, /favicon.ico is only a guess: a <link> may still come.
    if (!declared && !final) return;
    if (href === iconSeen) return;
    iconSeen = href;
    loadIcon(href).then(function (icon) {
      if (href !== iconSeen) return;
      api.__nyxsIcon = icon || "";
      toParent({ source: "nyxs-agent-icon", icon: icon || "" });
    });
  }
  function isIconLink(n) { return n.nodeName === "LINK" && /(^|\s)icon(\s|$)/i.test(n.rel || ""); }
  // While the page is parsed, each <link> as it arrives; afterwards, the <head> alone, where
  // apps that change their icon (a badge for new messages) put the new one.
  var iconWatch = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === "attributes" ? isIconLink(r.target) : Array.prototype.some.call(r.addedNodes, isIconLink) || Array.prototype.some.call(r.removedNodes, isIconLink)) {
        updateIcon(document.readyState !== "loading");
        return;
      }
    }
  });
  function watchHead() {
    iconWatch.disconnect();
    if (document.head) iconWatch.observe(document.head, { childList: true, attributes: true, attributeFilter: ["href", "rel"], subtree: true });
    updateIcon(true);
  }
  if (frameKey !== null) {
    // No icon to read.
  } else if (document.readyState === "loading") {
    iconWatch.observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", watchHead);
  } else {
    watchHead();
  }

  // With the focus in the page the keys go to the page, not to Nyxs: the app's own shortcuts
  // (the same list as src/lib/pageShortcuts.ts) are passed on, once the page's handlers are done
  // and only if none of them took the key (preventDefault), so a site's Ctrl+K stays its own.
  function appShortcut(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
    var k = (e.key || "").toLowerCase();
    if (k === "tab" || k === "`" || k === "~" || e.code === "Backquote" || e.keyCode === 192) return true;
    if (e.shiftKey) return e.code === "BracketLeft" || e.code === "BracketRight" || ["s", "b", "d", "f"].indexOf(k) >= 0;
    return ["j", "o", "k", "n", "t", ",", "/", ";", "\\"].indexOf(k) >= 0;
  }
  if (frameKey === null) window.addEventListener("keydown", function (e) {
    if (!e.isTrusted || !appShortcut(e)) return;
    setTimeout(function () {
      if (e.defaultPrevented) return;
      var key = { key: e.key, code: e.code, keyCode: e.keyCode, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
      if (window.parent !== window) {
        key.source = "nyxs-agent-key";
        window.parent.postMessage(key, "*");
      } else if (window.chrome && window.chrome.webview) {
        key.nyxs = "key";
        window.chrome.webview.postMessage(key);
      }
    }, 0);
  });

  function ready() {
    toParent({ source: "nyxs-agent-ready", url: location.href, title: document.title });
  }
  if (document.readyState === "complete") ready();
  else window.addEventListener("load", ready);

  if (frameKey !== null) Object.defineProperty(window, frameKey, { value: api });
})();

// Dims the page under one of the app's dialogs by `alpha` (0 takes it away). A fixed layer
// covers the page, but not the window's scrollbar, which the browser draws outside it: that one
// is darkened through `scrollbar-color` and restored afterwards.
// The layer also stands in for the dialog's backdrop, which the page covers: it keeps clicks and
// scrolling from the page and reports a press to Nyxs, which handles it as a press on the
// backdrop. An object, not a string, so wry's IPC handler (strings only) never sees it. Only a
// real press sends it; Nyxs only listens while the page is dimmed. A page's script could still
// post it, but all that does is what a click on the backdrop does: close (cancel) the dialog.
(function (a) {
  var h = document.documentElement;
  var d = document.getElementById("__nyxs-dim");
  var s = window.__nyxsDimSb;
  function put(el, v) {
    if (v[0]) el.style.setProperty("scrollbar-color", v[0], v[1]);
    else el.style.removeProperty("scrollbar-color");
  }
  function saved(el) {
    return [el.style.getPropertyValue("scrollbar-color"), el.style.getPropertyPriority("scrollbar-color")];
  }
  if (!(a > 0)) {
    if (s) {
      put(h, s.h);
      if (s.b) put(s.b, s.bv);
      window.__nyxsDimSb = undefined;
    }
    if (d) {
      d.style.opacity = "0";
      d.style.pointerEvents = "none";
      setTimeout(function () {
        if (d.style.opacity === "0") d.remove();
      }, 120);
    }
    return;
  }
  if (!d) {
    d = document.createElement("div");
    d.id = "__nyxs-dim";
    d.setAttribute("aria-hidden", "true");
    d.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#000;opacity:0;transition:opacity .1s";
    function stop(e) {
      e.preventDefault();
      e.stopPropagation();
    }
    d.addEventListener("mousedown", function (e) {
      stop(e);
      if (e.isTrusted && e.button === 0 && window.chrome && chrome.webview) chrome.webview.postMessage({ nyxs: "backdrop" });
    });
    ["click", "dblclick", "auxclick", "contextmenu", "wheel", "touchmove"].forEach(function (t) {
      d.addEventListener(t, stop, { passive: false });
    });
    // Under the shadows of the panels shown through the page (preview_shadows.js), like the
    // dialog's backdrop is under the dialog.
    h.insertBefore(d, document.getElementById("__nyxs-shadows"));
    void d.offsetWidth;
  }
  d.style.opacity = String(a);
  d.style.pointerEvents = "auto";
  if (!s) {
    var cs = getComputedStyle(h);
    var cols = [];
    cs.scrollbarColor.replace(/rgba?\(([^)]+)\)/g, function (_, x) {
      cols.push(x.split(/[\s,/]+/).slice(0, 3).map(Number));
    });
    // "auto": the browser's own colors, measured from WebView2 (Windows 11).
    if (cols.length < 2) cols = /^(only )?dark/.test(cs.colorScheme) ? [[159, 159, 159], [44, 44, 44]] : [[139, 139, 139], [253, 253, 253]];
    var b = document.body;
    s = window.__nyxsDimSb = { h: saved(h), b: b, bv: b ? saved(b) : null, base: cols };
    // scrollbar-color is inherited: keep the page's inner scrollbars as they were, the layer
    // already dims those.
    if (b) b.style.setProperty("scrollbar-color", getComputedStyle(b).scrollbarColor, "important");
  }
  h.style.setProperty(
    "scrollbar-color",
    s.base
      .map(function (c) {
        return "rgb(" + c.map(function (v) { return Math.round(v * (1 - a)); }).join(",") + ")";
      })
      .join(" "),
    "important",
  );
})

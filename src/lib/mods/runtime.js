// The mod engine's side inside a mod's Worker. This file is plain JavaScript loaded as text
// (`?raw`) and put at the head of the Worker's one script, followed by the mod's compiled files
// (`__define`) and `__boot`: the app's CSP lets a Worker run its own blob, but no eval or
// import of other scripts. It mirrors Claude Code's function hooks: `register(on, options)`,
// hooks `($, e, next)`, `$` reaching everything outside, JSX through the global `h`.
var __modules = Object.create(null);
var __cache = Object.create(null);

function __define(id, factory) {
  __modules[id] = factory;
}

function __require(from, spec) {
  if (spec === "claude-code") return __claudeCode;
  if (spec === "claude-code/testing") throw new Error("claude-code/testing is only for tests");
  var id = __resolve(from, spec);
  if (id === null) throw new Error("Cannot find module '" + spec + "' from " + from);
  if (__cache[id]) return __cache[id].exports;
  var module = { exports: {} };
  __cache[id] = module;
  __modules[id](function (s) { return __require(id, s); }, module, module.exports);
  return module.exports;
}

var __EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js"];

function __resolve(from, spec) {
  if (spec.charAt(0) !== ".") return null;
  var parts = from.split("/");
  parts.pop();
  var segs = spec.split("/");
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    if (s === "." || s === "") continue;
    if (s === "..") parts.pop();
    else parts.push(s);
  }
  var base = parts.join("/");
  for (var j = 0; j < __EXTS.length; j++) {
    if (__modules[base + __EXTS[j]]) return base + __EXTS[j];
  }
  // `./x.js` written for a `x.ts` file, as TypeScript's module resolution allows.
  var m = /\.(m|c)?js$/.exec(base);
  if (m) {
    var stem = base.slice(0, -m[0].length);
    var alts = [".ts", ".tsx", ".mts", ".cts"];
    for (var k = 0; k < alts.length; k++) if (__modules[stem + alts[k]]) return stem + alts[k];
  }
  return null;
}

// ---- Talking to the app ----

var __seq = 0;
var __waiting = new Map();
var __plugin = "";
var __root = "";

function __errorOf(err) {
  var e = err && err.name === "TypeError" ? new TypeError(err.message) : new Error(err ? err.message : "failed");
  return e;
}

function __call(path, args) {
  var id = ++__seq;
  return new Promise(function (resolve, reject) {
    __waiting.set(id, { resolve: resolve, reject: reject });
    postMessage({ t: "call", id: id, path: path, args: __plain(args) });
  });
}

function __fire(path, args) {
  postMessage({ t: "call", id: 0, path: path, args: __plain(args) });
}

/** Values crossing to the app: functions can't, and are dropped. */
function __plain(v) {
  if (typeof v === "function") return undefined;
  if (Array.isArray(v)) return v.map(__plain);
  if (v && typeof v === "object") {
    var out = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = __plain(v[k]);
    return out;
  }
  return v;
}

// ---- Elements and JSX ----

var __ELEMENT_NAMES = ["Box", "Text", "Button", "Svg", "Link", "Markdown", "Progress", "Code", "Input", "Select", "Image", "Raster", "Spacer", "Newline", "Divider"];
var __elements = {};
__ELEMENT_NAMES.forEach(function (name) {
  var make = function (props) {
    var p = Object.assign({}, props || {});
    var children = p.children;
    delete p.children;
    return { $el: name, props: p, children: __flat(children) };
  };
  Object.defineProperty(make, "name", { value: name });
  __elements[name] = make;
});

function __flat(children) {
  var out = [];
  (function walk(c) {
    if (c === null || c === undefined || c === false || c === true) return;
    if (Array.isArray(c)) { c.forEach(walk); return; }
    out.push(typeof c === "number" ? String(c) : c);
  })(children);
  return out;
}

function h(tag, props) {
  var children = Array.prototype.slice.call(arguments, 2);
  var p = Object.assign({}, props || {});
  if (children.length) p.children = children.length === 1 ? children[0] : children;
  if (typeof tag === "function") return tag(p);
  var c = p.children;
  delete p.children;
  return { $el: String(tag), props: p, children: __flat(c) };
}

function Fragment(props) {
  return __elements.Box({ flexDirection: "column", children: props && props.children });
}

// Handlers in a drawn tree stay here; the app gets their numbers and presses them by number.
var __fnSeq = 0;
var __fns = new Map();
var __siteFns = new Map();

function __serialize(node, site) {
  var ids = [];
  function walk(n) {
    if (n === null || n === undefined || typeof n !== "object") return n;
    if (Array.isArray(n)) return n.map(walk);
    if (typeof n.$el !== "string") return n;
    var props = {};
    for (var k in n.props) {
      var v = n.props[k];
      if (typeof v === "function") {
        var id = ++__fnSeq;
        __fns.set(id, v);
        ids.push(id);
        props[k] = { $fn: id };
      } else {
        props[k] = __plain(v);
      }
    }
    return { $el: n.$el, props: props, children: (n.children || []).map(walk) };
  }
  var out = walk(node);
  var old = __siteFns.get(site);
  if (old) old.forEach(function (id) { __fns.delete(id); });
  __siteFns.set(site, ids);
  return out;
}

// ---- $ ----

function __timer(ms, fn, every) {
  var handle = every ? setInterval(fn, ms) : setTimeout(fn, ms);
  return { cancel: function () { every ? clearInterval(handle) : clearTimeout(handle); } };
}

var $ = {
  theme: {
    set: function (a) { return __call("theme.set", a); },
    clear: function () { return __call("theme.clear"); },
  },
  ui: {
    resolve: function () { return __elements; },
    toast: function (text, options) { __fire("ui.toast", [text, options]); },
    status: function (text) { __fire("ui.status", [text]); },
    log: function (text, options) { __fire("ui.log", [text, options]); },
    notice: function () {},
    invalidate: function (what) { __fire("ui.invalidate", [what]); },
    place: function (a) { return __call("ui.place", a); },
  },
  store: {
    get: function (k) { return __call("store.get", [k]); },
    set: function (k, v) { return __call("store.set", [k, v]); },
    delete: function (k) { return __call("store.delete", [k]); },
    keys: function () { return __call("store.keys", []); },
  },
  state: {
    get: function (ref) { return __call("state.get", [ref]); },
    set: function (ref, value, options) { return __call("state.set", [ref, value, options]); },
  },
  clock: {
    now: function () { return Promise.resolve(Date.now()); },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    after: function (ms, fn) { return __timer(ms, fn, false); },
    every: function (ms, fn) { return __timer(ms, fn, true); },
  },
  session: {
    id: function () { return __call("session.id", []); },
    cwd: function () { return __call("session.cwd", []); },
    root: function () { return __call("session.root", []); },
    repo: function () { return __call("session.repo", []); },
    model: function () { return __call("session.model", []); },
    turns: function () { return __call("session.turns", []); },
    surface: function () { return Promise.resolve("desktop"); },
    surfaces: function () { return Promise.resolve(["desktop"]); },
  },
  fs: {
    stat: function (p, o) { return __call("fs.stat", [p, o]); },
    exists: function (p) { return __call("fs.exists", [p]); },
    read: function (p) { return __call("fs.read", [p]); },
    list: function (p) { return __call("fs.list", [p]); },
  },
  env: {
    get: function (name) { return __call("env.get", [name]); },
  },
  command: {
    register: function (spec) { return __call("command.register", spec); },
    list: function () { return __call("command.list", []); },
  },
};

// ---- claude-code: the state helpers ----

function __decode(atom, value) {
  if (atom.shape !== undefined) {
    return value && typeof value === "object" && value.shape === atom.shape ? value.value : atom.initial;
  }
  return value === undefined ? atom.initial : value;
}

function __encode(atom, value) {
  return atom.shape !== undefined ? { shape: atom.shape, value: value } : value;
}

var __claudeCode = {
  atom: function (ref, initial, options) {
    return Object.freeze({ ref: Object.freeze(Object.assign({}, ref)), initial: initial, shape: options ? options.shape : undefined });
  },
  derive: function (sources, fn) {
    return Object.freeze({ $derived: true, sources: sources, fn: fn });
  },
  memberOf: function (family, e) {
    var id = typeof e === "string" ? e : e && (e.requestId || (e.props && e.props.id));
    return Object.freeze(Object.assign({}, family, { ref: Object.freeze(Object.assign({}, family.ref, { id: id })) }));
  },
  read: function read($$, source) {
    if (source && source.$derived) {
      var list = Array.isArray(source.sources) ? source.sources : [source.sources];
      return Promise.all(list.map(function (s) { return read($$, s); })).then(function (values) {
        return Array.isArray(source.sources) ? source.fn.apply(null, values) : source.fn(values[0]);
      });
    }
    return $$.state.get(source.ref).then(function (r) { return __decode(source, r.value); });
  },
  update: function update($$, atom, fn) {
    var tries = 0;
    function attempt() {
      return $$.state.get(atom.ref).then(function (r) {
        var next = fn(__decode(atom, r.value));
        return $$.state.set(atom.ref, __encode(atom, next), { ifVersion: r.version }).then(function (res) {
          if (res.isSet || ++tries > 20) return res;
          return attempt();
        });
      });
    }
    return attempt();
  },
};

// ---- Hooks ----

var __hooks = [];

function __matches(matcher, e) {
  if (!matcher) return true;
  for (var k in matcher) {
    var want = matcher[k];
    var have = e ? e[k] : undefined;
    if (want && typeof want === "object" && !Array.isArray(want)) {
      if (!have || typeof have !== "object" || !__matches(want, have)) return false;
    } else if (Array.isArray(want)) {
      if (want.indexOf(have) < 0) return false;
    } else if (have !== want) return false;
  }
  return true;
}

function __eventMatches(pattern, event) {
  if (pattern === event || pattern === "*") return true;
  return pattern.slice(-2) === ".*" && event.indexOf(pattern.slice(0, -1)) === 0;
}

function on(event, matcher, hook) {
  if (typeof matcher === "function") { hook = matcher; matcher = undefined; }
  var entry = { event: event, matcher: matcher, hook: hook, onError: undefined };
  __hooks.push(entry);
  var handle = { catch: function (fn) { entry.onError = fn; return handle; } };
  return handle;
}

function __dispatch(id, event, e) {
  var mine = __hooks.filter(function (h) { return __eventMatches(h.event, event) && __matches(h.matcher, e); });
  function below(ev) {
    var nid = ++__seq;
    return new Promise(function (resolve, reject) {
      __waiting.set(nid, { resolve: resolve, reject: reject });
      postMessage({ t: "next", id: nid, dispatch: id, e: __plain(ev) });
    });
  }
  function step(i, ev) {
    if (i >= mine.length) return below(ev);
    var entry = mine[i];
    var called = false;
    var settled;
    var next = function (e2) {
      called = true;
      settled = step(i + 1, e2 === undefined ? ev : e2);
      return settled;
    };
    next.signal = new AbortController().signal;
    Object.defineProperty(next, "called", { get: function () { return called; } });
    return Promise.resolve()
      .then(function () { return entry.hook($, ev, next); })
      .catch(function (err) {
        __fire("ui.log", ["[" + event + "] hook failed: " + (err && err.message ? err.message : String(err)), { to: "error" }]);
        if (entry.onError) return entry.onError($, ev, next);
        return called ? settled : step(i + 1, ev);
      });
  }
  return step(0, e);
}

onmessage = function (msg) {
  var m = msg.data;
  if (m.t === "result") {
    var w = __waiting.get(m.id);
    if (!w) return;
    __waiting.delete(m.id);
    if (m.ok) w.resolve(m.value);
    else w.reject(__errorOf(m.error));
    return;
  }
  if (m.t === "dispatch") {
    __dispatch(m.id, m.event, m.e).then(
      function (value) {
        var out = m.event === "ui.render" ? __serialize(value, m.site || "") : __plain(value);
        postMessage({ t: "done", id: m.id, ok: true, value: out });
      },
      function (err) {
        postMessage({ t: "done", id: m.id, ok: false, error: { name: err && err.name, message: err && err.message ? err.message : String(err) } });
      },
    );
    return;
  }
  if (m.t === "invoke") {
    var fn = __fns.get(m.fn);
    if (!fn) return;
    Promise.resolve()
      .then(function () { return fn.apply(null, m.args || []); })
      .catch(function (err) { __fire("ui.log", ["handler failed: " + (err && err.message ? err.message : String(err)), { to: "error" }]); });
  }
};

function __boot(entry, plugin, root, options) {
  __plugin = plugin;
  __root = root;
  try {
    var exp = __require("", entry);
    var register = exp.register || (exp.default && exp.default.register) || exp.default;
    if (typeof register !== "function") throw new Error("the hooks module exports no register function");
    var out = register(on, options || {});
    Promise.resolve(out).then(
      function () {
        postMessage({ t: "ready", hooks: __hooks.map(function (h) { return { event: h.event, matcher: __plain(h.matcher) }; }) });
      },
      function (err) { postMessage({ t: "failed", error: err && err.message ? err.message : String(err) }); },
    );
  } catch (err) {
    postMessage({ t: "failed", error: err && err.message ? err.message : String(err) });
  }
}

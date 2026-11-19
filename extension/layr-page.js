/* layr-page.js: problem reports from the content scripts of a Chrome extension inside a layr plugin
 * (docs/ARCHITECTURE.md › Problems, docs/PLUGINS.md › A Chrome extension in a plugin). Copy it into the extension next
 * to layr-ext.js (no code is loaded at runtime; the current one is at /_layr/layr-page.js) and list it before the
 * plugin's own content script, as a classic script:
 *
 *   "content_scripts": [{ "matches": ["https://www.youtube.com/*"], "js": ["layr-page.js", "content.js"] }]
 *
 *   // content.js: next to the code's own query
 *   layr.expect("videos", "ytd-rich-item-renderer", { min: 3, label: "Video tiles" });
 *
 * It gives content scripts `layr.expect`, `layr.problem`, `layr.ok` and `layr.problems.capture` (globalThis.layr,
 * added to when something already defined it). Content scripts can't reach layr themselves: reports go to the
 * extension's service worker as chrome.runtime.sendMessage({__layrProblem: report}), and its layr-ext.js sends them on
 * (so the service worker must import layr-ext.js). Uncaught errors of this extension's own scripts on the page (not
 * the page's) are reported too, as `extension` problems. Every report carries this page load's `visit`.
 */
(function () {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : window;
  var existing = root.layr && typeof root.layr === "object" ? root.layr : null;
  if (existing && existing.__layrPage) return; // loaded twice: keep the first
  var runtime = root.chrome && root.chrome.runtime;
  var base = "";
  try {
    base = runtime && runtime.getURL ? runtime.getURL("") : ""; // chrome-extension://<id>/
  } catch (e) {}

  // ---------- problems: what the shared block needs ----------

  var problemSource = "extension"; // uncaught errors of the extension's content scripts
  function problemSend(report) {
    if (!runtime || typeof runtime.sendMessage !== "function") {
      throw new Error("chrome.runtime.sendMessage isn't available (not a content script?)");
    }
    return new Promise(function (resolve, reject) {
      runtime.sendMessage({ __layrProblem: report }, function (answer) {
        var err = runtime.lastError;
        if (err) reject(new Error(err.message + " (does the service worker import layr-ext.js?)"));
        else resolve(answer);
      });
    });
  }
  /** Only errors whose script is this extension's: the page's own errors reach content scripts' listeners too. */
  function problemMine(stack, file) {
    return !!base && (file.indexOf(base) === 0 || stack.indexOf(base) !== -1);
  }

  // ---------- problems (the same block in layr.js, layr-ext.js and layr-page.js) ----------
  // docs/ARCHITECTURE.md › Problems. Before it each file defines problemSource ("panel" | "extension"),
  // problemSend(report) → a promise, and problemMine(stack, file): does an uncaught error belong to this plugin?

  var PROBLEM_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
  var PROBLEM_LIMIT = 30; // reports per page load (per service worker run)
  var OUTLINE_MAX = 30000;
  var OUTLINE_NODES = 5000;
  var OUTLINE_DEPTH = 25;
  var OUTLINE_ALIKE = 3; // siblings that look alike shown before "… N more"
  var OUTLINE_SKIP = { script: 1, style: 1, noscript: 1, template: 1, link: 1, meta: 1 };
  var OUTLINE_LEAF = { svg: 1, iframe: 1, canvas: 1, video: 1, audio: 1, object: 1, embed: 1 };
  var problemVisit = problemRandom(16); // this page load (service worker run)
  var problemSent = Object.create(null); // "<source>/<id>/<ok|fail>": sent this visit
  var problemCount = 0;
  var problemWarned = false;
  var problemCapturing = true;

  function problemRandom(digits) {
    var bytes = new Uint8Array(digits / 2);
    try {
      crypto.getRandomValues(bytes);
    } catch (e) {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var out = "";
    for (var j = 0; j < bytes.length; j++) out += (bytes[j] < 16 ? "0" : "") + bytes[j].toString(16);
    return out;
  }

  /** FNV-1a (32 bits) of the text's UTF-8 bytes as 8 hex digits: an uncaught error's id (the core's short_hash). */
  function problemHash(text) {
    var bytes = new TextEncoder().encode(text);
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
    return ("0000000" + h.toString(16)).slice(-8);
  }

  function problemClip(text, max) {
    text = String(text == null ? "" : text);
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }

  function problemJson(value) {
    if (typeof value === "string") return value;
    try {
      var text = JSON.stringify(value);
      return text === undefined ? String(value) : text;
    } catch (e) {
      return String(value);
    }
  }

  function problemErrorText(err) {
    if (err && typeof err === "object" && typeof err.message === "string") {
      return (err.name ? err.name + ": " : "") + err.message;
    }
    return problemJson(err);
  }

  /** A page to count selectors in and to outline (not in a service worker). */
  function problemDom() {
    return typeof document !== "undefined" && !!document && typeof document.querySelectorAll === "function";
  }

  function problemUrl() {
    return problemDom() && typeof location !== "undefined" ? String(location.href) : undefined;
  }

  function problemWarn(err) {
    if (problemWarned) return;
    problemWarned = true;
    console.warn("[layr] a problem report didn't reach layr (later ones aren't mentioned):", (err && err.message) ||
      err);
  }

  function problemKey(source, id, ok) {
    return (source || "self") + "/" + id + "/" + (ok ? "ok" : "fail");
  }

  /** Not sent yet this visit (per id and outcome), and the visit's quota isn't used up. */
  function problemWanted(source, id, ok) {
    return !problemSent[problemKey(source, id, ok)] && problemCount < PROBLEM_LIMIT;
  }

  /** Sends a report unless it isn't wanted (problemWanted) → whether it was sent. Never throws. */
  function problemReport(r) {
    if (typeof r.id !== "string" || !PROBLEM_ID.test(r.id)) {
      if (!problemSent["bad/" + r.id]) {
        problemSent["bad/" + r.id] = true;
        console.warn("[layr] a problem id is 1-100 letters, digits, _ . : or -, not " + problemJson(r.id));
      }
      return false;
    }
    if (!problemWanted(r.source, r.id, r.ok)) return false;
    problemSent[problemKey(r.source, r.id, r.ok)] = true;
    problemCount++;
    var report = { id: r.id, visit: problemVisit };
    var fields = ["ok", "title", "details", "url", "stack", "outline", "source"];
    for (var i = 0; i < fields.length; i++) {
      if (r[fields[i]] != null && r[fields[i]] !== "") report[fields[i]] = r[fields[i]];
    }
    try {
      var sent = problemSend(report);
      if (sent && typeof sent.then === "function") sent.then(null, problemWarn);
    } catch (e) {
      problemWarn(e);
    }
    return true;
  }

  function problemFrameFile(line) {
    var m = /([^\s(@]+):\d+:\d+\)?\s*$/.exec(line);
    return m ? m[1] : null;
  }

  /** The stack where the plugin called layr: its frames, without this file's own. */
  function problemStack() {
    var stack = "";
    var limit = Error.stackTraceLimit;
    try {
      if (typeof limit === "number") Error.stackTraceLimit = 40;
      stack = String(new Error().stack || "");
    } catch (e) {
      stack = "";
    } finally {
      if (typeof limit === "number") Error.stackTraceLimit = limit;
    }
    var own = null;
    var out = [];
    var lines = stack.split("\n");
    for (var i = 0; i < lines.length && out.length < 15; i++) {
      var file = problemFrameFile(lines[i]);
      if (!file) continue; // the "Error" line
      if (own === null) own = file; // the first frame is this function's
      if (file !== own) out.push(lines[i].trim());
    }
    return problemClip(out.join("\n"), 4000);
  }

  function problemIsList(v) {
    if (Array.isArray(v)) return true;
    return !!v && typeof v === "object" && v.nodeType === undefined && typeof v.length === "number" &&
      (typeof v.item === "function" || typeof v[Symbol.iterator] === "function");
  }

  function problemHasText(el, text) {
    var t = el != null && typeof el === "object" ? el.textContent : el;
    t = t == null ? "" : String(t);
    if (Object.prototype.toString.call(text) === "[object RegExp]") {
      text.lastIndex = 0;
      return text.test(t);
    }
    return t.trim() !== "";
  }

  /** {count, total (before the text filter)} of what `found` gave: a list's length, a number, 1 or 0. */
  function problemMeasure(v, text) {
    var list = problemIsList(v) ? Array.prototype.slice.call(v) : v && typeof v === "object" && v.nodeType === 1
      ? [v] : null;
    if (!list) {
      var n = typeof v === "number" ? (isNaN(v) ? 0 : v) : v ? 1 : 0;
      return { count: n, total: n };
    }
    var kept = text ? list.filter(function (el) { return problemHasText(el, text); }) : list;
    return { count: kept.length, total: list.length };
  }

  function problemWant(min, max) {
    if (max == null) return "≥ " + min;
    if (min === max) return String(min);
    if (min <= 0) return "≤ " + max;
    return min + "–" + max;
  }

  /** Calls fn after the page changes (50 ms after a DOM mutation) or after ms (at most 250). */
  function problemWait(ms, fn) {
    var done = false;
    var observer = null;
    var timer = setTimeout(go, Math.max(0, Math.min(250, ms)));
    function go() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (observer) observer.disconnect();
      fn();
    }
    if (problemDom() && typeof MutationObserver === "function") {
      try {
        observer = new MutationObserver(function () {
          observer.disconnect();
          clearTimeout(timer);
          timer = setTimeout(go, Math.max(0, Math.min(50, ms)));
        });
        observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true,
          characterData: true });
      } catch (e) {
        observer = null;
      }
    }
  }

  // ----- the page's outline -----

  function problemTag(el) {
    return String((el && el.tagName) || "").toLowerCase();
  }

  function problemClasses(el) {
    return String((el.getAttribute && el.getAttribute("class")) || "").split(/\s+/).filter(Boolean);
  }

  function problemAttrValue(v) {
    v = problemClip(String(v).replace(/\s+/g, " "), 40);
    return /^[\w.:\/-]+$/.test(v) ? v : JSON.stringify(v);
  }

  /** One element's line: tag#id.classes[attributes] "its own text". Never a value or what an input holds. */
  function problemOutlineLine(el, depth) {
    var tag = problemTag(el);
    var line = new Array(depth + 1).join("  ") + tag;
    var id = el.getAttribute ? el.getAttribute("id") : null;
    if (id) line += "#" + problemClip(id, 40);
    var cls = problemClasses(el);
    for (var i = 0; i < cls.length && i < 6; i++) line += "." + problemClip(cls[i], 40);
    if (cls.length > 6) line += ".…";
    var attrs = el.attributes || [];
    for (var j = 0, shown = 0; j < attrs.length && shown < 6; j++) {
      var name = String(attrs[j].name).toLowerCase();
      if (name === "id" || name === "class" || name === "style" || name === "value" || /^on/.test(name)) continue;
      shown++;
      line += "[" + name + (attrs[j].value === "" ? "" : "=" + problemAttrValue(attrs[j].value)) + "]";
    }
    var editable = el.getAttribute ? el.getAttribute("contenteditable") : null;
    if (tag !== "input" && tag !== "textarea" && (editable == null || editable === "false")) {
      var text = "";
      var nodes = el.childNodes || [];
      for (var k = 0; k < nodes.length && text.length < 200; k++) {
        if (nodes[k].nodeType === 3) text += nodes[k].nodeValue;
      }
      text = text.replace(/\s+/g, " ").trim();
      if (text) line += " " + JSON.stringify(problemClip(text, 40));
    }
    return line;
  }

  /** The header lines, then root's subtree as indented lines: at most OUTLINE_MAX characters. */
  function problemOutlineOf(root, header) {
    var lines = header.slice();
    var size = lines.join("\n").length;
    var nodes = 0;
    var cut = "";
    function add(line) {
      if (cut) return false;
      if (size + line.length + 1 > OUTLINE_MAX - 100) {
        cut = OUTLINE_MAX + " characters";
        return false;
      }
      lines.push(line);
      size += line.length + 1;
      return true;
    }
    function walk(el, depth) {
      if (cut) return;
      if (++nodes > OUTLINE_NODES) {
        cut = OUTLINE_NODES + " elements";
        return;
      }
      if (!add(problemOutlineLine(el, depth)) || OUTLINE_LEAF[problemTag(el)]) return;
      var kids = el.children || [];
      if (!kids.length) return;
      var indent = new Array(depth + 2).join("  ");
      if (depth >= OUTLINE_DEPTH) {
        add(indent + "… " + kids.length + " children not shown (deeper than " + OUTLINE_DEPTH + " levels)");
        return;
      }
      var seen = Object.create(null);
      var more = [];
      for (var i = 0; i < kids.length && !cut; i++) {
        var tag = problemTag(kids[i]);
        if (OUTLINE_SKIP[tag]) continue;
        var cls = problemClasses(kids[i]);
        var sig = tag + (cls.length ? "." + cls.join(".") : "");
        seen[sig] = (seen[sig] || 0) + 1;
        if (seen[sig] > OUTLINE_ALIKE) {
          if (seen[sig] === OUTLINE_ALIKE + 1) more.push(sig);
          continue;
        }
        walk(kids[i], depth + 1);
      }
      for (var j = 0; j < more.length; j++) add(indent + "… " + (seen[more[j]] - OUTLINE_ALIKE) + " more " + more[j]);
    }
    walk(root, 0);
    if (cut) lines.push("… (outline cut at " + cut + ")");
    return lines.join("\n");
  }

  /** A selector's first group as compound selectors with the combinator before each: [{comb, sel}]. */
  function problemSelectorParts(selector) {
    var parts = [];
    var cur = "";
    var comb = "";
    var depth = 0;
    var quote = null;
    for (var i = 0; i < selector.length; i++) {
      var ch = selector.charAt(i);
      if (ch === "\\") {
        cur += ch + selector.charAt(++i);
        continue;
      }
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "[" || ch === "(") depth++;
      else if (ch === "]" || ch === ")") depth--;
      else if (depth === 0 && ch === ",") break;
      else if (depth === 0 && /[\s>+~]/.test(ch)) {
        if (cur) {
          parts.push({ comb: comb, sel: cur });
          cur = "";
          comb = " ";
        }
        if (!/\s/.test(ch)) comb = ch;
        continue;
      }
      cur += ch;
    }
    if (cur) parts.push({ comb: comb, sel: cur });
    return parts;
  }

  function problemJoinParts(parts, keepFirstComb) {
    return parts.map(function (p, i) {
      var comb = i || keepFirstComb ? (p.comb === " " || !p.comb ? " " : " " + p.comb + " ") : "";
      return comb + p.sel;
    }).join("").trim();
  }

  /** The page's outline: around what still matches of the selector (its longest leading part), else from <body>. */
  function problemOutline(selector) {
    var root = document.body || document.documentElement;
    var header = ["Page: " + problemClip(problemUrl(), 300)];
    if (selector) {
      var parts = problemSelectorParts(selector);
      var matched = false;
      for (var k = parts.length; k > 0 && !matched; k--) {
        var part = problemJoinParts(parts.slice(0, k));
        var hits = null;
        try {
          hits = document.querySelectorAll(part);
        } catch (e) {}
        if (!hits || !hits.length) continue;
        matched = true;
        if (k === parts.length) {
          root = hits[0].parentElement || hits[0];
          header.push("`" + part + "` matches " + hits.length + "; outlined from the first one's parent");
        } else {
          root = hits[0];
          header.push("`" + part + "` matches " + hits.length + (hits.length > 1 ? " (outlined: the first)" : "") +
            "; `" + problemJoinParts(parts.slice(k), true) + "` after it matches nothing");
        }
      }
      if (!matched) header.push("No part of `" + selector + "` matches; outlined from <body>");
    }
    if (!root) return undefined;
    return problemClip(problemOutlineOf(root, header), OUTLINE_MAX);
  }

  // ----- the API -----

  /**
   * layr.expect(id, found, {min = 1, max, label, waitMs, text}) → a promise of true | false; reports a pass or a
   * failure (with the url, the caller's stack and the page's outline). found: a CSS selector (counted in the page;
   * not in a service worker), a function (called again every 250 ms and when the page changes, until it passes or
   * waitMs runs out; default 10000 for these two, 0 for values), a list or NodeList, a number, an element or anything
   * truthy (1) or falsy (0). text: true → only elements with text count; a RegExp → only those whose text matches.
   */
  function layrExpect(id, found, opts) {
    opts = opts || {};
    var stack = problemStack();
    var selector = typeof found === "string";
    var fn = typeof found === "function";
    var min = opts.min == null ? 1 : Number(opts.min);
    var max = opts.max == null ? null : Number(opts.max);
    var waitMs = opts.waitMs != null ? Math.max(0, Number(opts.waitMs) || 0) : selector || fn ? 10000 : 0;
    if (selector && !problemDom()) {
      var err = new Error("layr.expect: there is no page here to count `" + found + "` in (a service worker): count " +
        "it in a content script with layr-page.js, or pass the elements, a number or a function");
      err.name = "LayrError";
      err.code = -32602;
      return Promise.reject(err);
    }
    var started = Date.now();
    return new Promise(function (resolve) {
      var lastError = null;
      function step() {
        var got;
        try {
          got = selector ? document.querySelectorAll(found) : fn ? found() : found;
        } catch (e) {
          if (selector) {
            return finish({ count: 0, total: 0 }, false, "Not a valid CSS selector: " + problemErrorText(e));
          }
          got = Promise.reject(e);
        }
        Promise.resolve(got).then(function (v) { judge(v, null); }, function (e) { judge(undefined, e); });
      }
      function judge(v, error) {
        var m = { count: 0, total: 0 };
        try {
          m = problemMeasure(v, opts.text);
        } catch (e) {
          error = e;
        }
        lastError = error;
        var passed = !error && m.count >= min && (max == null || m.count <= max);
        var left = waitMs - (Date.now() - started);
        if (passed || left <= 0) finish(m, passed, null);
        else problemWait(left, step);
      }
      function finish(m, passed, invalid) {
        try {
          if (passed) problemReport({ id: id, ok: true, url: problemUrl() });
          else if (problemWanted(null, id, false)) problemReport(failure(m, invalid));
        } catch (e) {
          problemWarn(e);
        }
        resolve(!!passed);
      }
      function failure(m, invalid) {
        var want = problemWant(min, max);
        var what = selector ? "`" + found + "`" : fn ? "what " + (found.name || "the function") + "() gave"
          : "the value";
        var text = opts.text === true ? " with text" : opts.text ? " with text matching " + String(opts.text) : "";
        var lines = ["Expected " + want + " of " + what + text + "; found " + m.count +
          (m.total !== m.count ? " (" + m.total + " before the text filter)" : "") + "."];
        if (opts.label) lines.unshift(String(opts.label));
        if (waitMs && !invalid) lines.push("Waited " + (Date.now() - started) + " ms (waitMs " + waitMs + ").");
        if (invalid) lines.push(invalid);
        if (lastError) lines.push("It threw: " + problemErrorText(lastError));
        var outline;
        try {
          outline = problemDom() ? problemOutline(selector && !invalid ? found : null) : undefined;
        } catch (e) {}
        return {
          id: id,
          title: problemClip((opts.label || id) + ": found " + m.count + ", expected " + want, 200),
          details: problemClip(lines.join("\n"), 8000),
          url: problemUrl(),
          stack: stack,
          outline: outline,
        };
      }
      step();
    });
  }

  /** layr.problem(id, details?, {title}): something else went wrong → a promise of whether it was sent. */
  function layrProblem(id, details, opts) {
    return Promise.resolve(problemReport({
      id: id,
      title: problemClip((opts && opts.title) || id, 200),
      details: details == null ? undefined : problemClip(problemJson(details), 8000),
      url: problemUrl(),
      stack: problemStack(),
    }));
  }

  /** layr.ok(id): it works now → a promise of whether it was sent. */
  function layrOk(id) {
    return Promise.resolve(problemReport({ id: id, ok: true, url: problemUrl() }));
  }

  /** layr.problems.capture(on): uncaught errors as problems (on by default). */
  function problemsCapture(on) {
    problemCapturing = on !== false;
  }

  function problemUncaught(ev, rejection) {
    if (!problemCapturing || !ev) return;
    try {
      var err = rejection ? ev.reason : ev.error;
      var message = err != null ? problemErrorText(err) : String(ev.message || "");
      message = message.replace(/^Uncaught (\(in promise\) )?/, "");
      var stack = err && typeof err === "object" && typeof err.stack === "string" ? err.stack : "";
      var file = ev.filename ? ev.filename + ":" + (ev.lineno || 0) + ":" + (ev.colno || 0) : "";
      var first = message.split("\n")[0].trim();
      if (!first || first === "Script error." || !problemMine(stack, String(ev.filename || ""))) return;
      problemReport({
        id: "error-" + problemHash(first),
        source: problemSource,
        title: problemClip(first, 200),
        details: problemClip((rejection ? "Unhandled rejection: " : "Uncaught error: ") + message +
          (file ? "\nat " + file : ""), 8000),
        url: problemUrl(),
        stack: problemClip(stack || file, 4000),
      });
    } catch (e) {}
  }

  var problemGlobal = typeof globalThis !== "undefined" ? globalThis : self;
  if (problemGlobal && typeof problemGlobal.addEventListener === "function") {
    problemGlobal.addEventListener("error", function (ev) { problemUncaught(ev, false); });
    problemGlobal.addEventListener("unhandledrejection", function (ev) { problemUncaught(ev, true); });
  }

  // ---------- end of problems ----------

  var api = existing || {};
  api.__layrPage = 1;
  api.expect = layrExpect;
  api.problem = layrProblem;
  api.ok = layrOk;
  api.problems = api.problems && typeof api.problems === "object" ? api.problems : {};
  api.problems.capture = problemsCapture;
  root.layr = api;
})();

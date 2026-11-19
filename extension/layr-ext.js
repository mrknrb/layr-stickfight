/* layr-ext.js: the SDK for a Chrome extension inside a layr plugin (docs/ARCHITECTURE.md › Web panels › The extension
 * connection). Copy it into the extension (no code is loaded at runtime) and import it as an ES module, in the
 * service worker (`"background": {"service_worker": "background.js", "type": "module"}`) or an extension page:
 *
 *   import layr from "./layr-ext.js";
 *   await layr.ready;
 *   layr.tools.serve({ page_title: { description: "The open tab's title", run: async () => ({ title: "…" }) } });
 *
 * layr loads the extension from a copy that has `layr.connection.json` ({url, token, plugin}) next to the extension's
 * manifest.json; this file reads it, talks JSON-RPC 2.0 to the core over a WebSocket as the plugin, reconnects by
 * itself (reading the file again: a new core run has a new token), resubscribes events, serves the plugin's tools again
 * after a reconnect, and pings every 20 s, which keeps a Manifest V3 service worker alive while connected.
 * Loaded outside layr (no connection file), `ready` waits and `connected` stays false. Content scripts can't connect
 * themselves: they message the service worker (chrome.runtime.sendMessage), which calls layr.
 *
 * It also sends what the extension logs to layr (console.*, uncaught errors and rejections; content scripts' lines
 * sent as chrome.runtime.sendMessage({__layrLog: [{level, text}]})), where agents read it with
 * layr__extension_logs. layr.logs.capture(false) stops that.
 *
 * Problems (docs/ARCHITECTURE.md › Problems): layr.expect / layr.problem / layr.ok report what the extension relies
 * on (a selector can't be counted in the service worker, which has no page: pass elements, a number or a function
 * there, and count selectors in content scripts with layr-page.js); uncaught errors become `extension` problems
 * (layr.problems.capture(false) stops that); content scripts' reports (chrome.runtime.sendMessage({__layrProblem}),
 * sent by layr-page.js) are passed on with their own page load's visit.
 */
const CODES = {
  UNKNOWN_METHOD: -32601,
  BAD_PARAMS: -32602,
  NOT_ALLOWED: -32001,
  NOT_FOUND: -32002,
  NOT_AVAILABLE: -32003,
  FAILED: -32000,
  DISCONNECTED: -32099,
  NO_CONNECTION: -32098,
};
const PING_MS = 20_000;
const MAX_RETRY_MS = 15_000;

/** An error from layr: `err.code` is one of layr.errors. */
function layrError(code, message, data) {
  const err = new Error(message || `layr error ${code}`);
  err.name = "LayrError";
  err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

function connectionFileUrl() {
  const runtime = globalThis.chrome?.runtime;
  return runtime?.getURL ? runtime.getURL("layr.connection.json") : null;
}

let ws = null;
let connection = null; // {url, token, plugin}
let connected = false;
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject}
const listeners = new Map(); // topic -> Set(fn)
const connectionListeners = new Set();
let served = null; // {name: {description, inputSchema, run}}
let retryMs = 500;
let pingTimer = null;
let resolveReady;
const ready = new Promise((resolve) => (resolveReady = resolve));
let readyDone = false;

async function readConnection() {
  const url = connectionFileUrl();
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const c = await res.json();
    return c && typeof c.url === "string" && typeof c.token === "string" ? c : null;
  } catch {
    return null;
  }
}

function setConnected(on) {
  if (connected === on) return;
  connected = on;
  sdk.connected = on;
  for (const fn of connectionListeners) {
    try {
      fn(on);
    } catch (e) {
      console.error("[layr] connection listener:", e);
    }
  }
}

function send(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function rawCall(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    if (!send({ jsonrpc: "2.0", id, method, params: params ?? {} })) {
      pending.delete(id);
      reject(layrError(CODES.DISCONNECTED, "not connected to layr"));
    }
  });
}

/** A JSON-RPC call to the core; waits for the connection first. */
async function call(method, params) {
  if (!connected) await ready;
  return rawCall(method, params);
}

function scheduleReconnect() {
  clearInterval(pingTimer);
  pingTimer = null;
  const wait = retryMs;
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  setTimeout(() => void connect(), wait);
}

async function connect() {
  connection = await readConnection();
  if (!connection) {
    // Not loaded by layr (or the copy is being replaced): try again later.
    scheduleReconnect();
    return;
  }
  const url = `${connection.url}${connection.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(connection.token)}`;
  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.onopen = async () => {
    retryMs = 500;
    try {
      for (const topic of listeners.keys()) await rawCall("events.subscribe", { topic });
      sdk.info = await rawCall("layr.info", {});
      if (served) await rawCall("tools.serve", { tools: toolList() });
    } catch (e) {
      console.warn("[layr] setting up the connection:", e?.message ?? e);
    }
    setConnected(true);
    flushLogs();
    pingTimer = setInterval(() => void rawCall("ping", {}).catch(() => {}), PING_MS);
    if (!readyDone) {
      readyDone = true;
      resolveReady(sdk);
    }
  };
  socket.onmessage = (ev) => void onMessage(ev.data);
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setConnected(false);
    for (const [, p] of pending) p.reject(layrError(CODES.DISCONNECTED, "the connection to layr closed"));
    pending.clear();
    scheduleReconnect();
  };
  socket.onerror = () => {}; // onclose follows
}

async function onMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.method === "event" && msg.params) {
    const fns = listeners.get(msg.params.topic);
    if (fns) for (const fn of fns) safely(fn, msg.params.data, msg.params.topic);
    return;
  }
  if (msg.method === "tools.run") {
    await runTool(msg.id, msg.params ?? {});
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(layrError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve(msg.result);
  }
}

function safely(fn, ...args) {
  try {
    fn(...args);
  } catch (e) {
    console.error("[layr] listener:", e);
  }
}

// ---------- serving tools ----------

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function toolList() {
  return Object.entries(served ?? {}).map(([name, t]) => ({
    name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
  }));
}

/** A tool's return value as an MCP CallToolResult. */
function toResult(value) {
  if (value && typeof value === "object" && Array.isArray(value.content)) return value;
  const structured = value && typeof value === "object" && !Array.isArray(value) ? value : { result: value ?? null };
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

async function runTool(id, { tool, args, caller }) {
  const t = served?.[tool];
  let result;
  if (!t) result = { content: [{ type: "text", text: `No tool ${tool}` }], isError: true };
  else {
    try {
      result = toResult(await t.run(args ?? {}, caller ?? null));
    } catch (e) {
      result = { content: [{ type: "text", text: e?.message ?? String(e) }], isError: true };
    }
  }
  send({ jsonrpc: "2.0", id, result });
}

// ---------- logs ----------

const LOG_BUFFER = 300;
const LOG_BATCH = 100;
const logQueue = [];
let capturing = true;
let flushTimer = null;
const where =
  typeof ServiceWorkerGlobalScope !== "undefined" && globalThis instanceof ServiceWorkerGlobalScope
    ? "service worker"
    : globalThis.location?.pathname ?? "extension";

function textOf(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function queueLog(level, parts, source = where) {
  if (!capturing) return;
  logQueue.push({ level, text: parts.map(textOf).join(" "), source, at: Date.now() });
  if (logQueue.length > LOG_BUFFER) logQueue.splice(0, logQueue.length - LOG_BUFFER);
  if (connected && !flushTimer) flushTimer = setTimeout(flushLogs, 300);
}

function flushLogs() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!connected || !logQueue.length) return;
  const entries = logQueue.splice(0, LOG_BATCH);
  rawCall("extensions.log", { entries }).catch(() => {});
  if (logQueue.length) flushTimer = setTimeout(flushLogs, 300);
}

for (const level of ["debug", "log", "info", "warn", "error"]) {
  const original = console[level]?.bind(console);
  if (!original) continue;
  console[level] = (...args) => {
    original(...args);
    queueLog(level, args);
  };
}
globalThis.addEventListener?.("error", (ev) => queueLog("error", [ev.error ?? ev.message ?? "error"]));
globalThis.addEventListener?.("unhandledrejection", (ev) => queueLog("error", ["Unhandled rejection:", ev.reason]));
// Content scripts' lines (they can't connect themselves).
globalThis.chrome?.runtime?.onMessage?.addListener?.((message, sender) => {
  if (!Array.isArray(message?.__layrLog)) return;
  const source = `content script ${sender?.url ?? ""}`.trim();
  for (const e of message.__layrLog.slice(0, LOG_BATCH)) queueLog(String(e?.level ?? "log"), [e?.text ?? ""], source);
});

// ---------- problems: what the shared block needs ----------

const problemSource = "extension"; // uncaught errors in the service worker or an extension page
function problemSend(report) {
  return call("problems.report", report);
}
function problemMine() {
  return true; // only the extension's own code runs here
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

// Content scripts' reports (layr-page.js), each with its own page load's visit.
const FORWARDED = ["id", "ok", "title", "details", "url", "stack", "outline", "visit"];
globalThis.chrome?.runtime?.onMessage?.addListener?.((message, sender, sendResponse) => {
  const r = message?.__layrProblem;
  if (!r || typeof r !== "object") return;
  const report = {};
  for (const k of FORWARDED) if (r[k] != null) report[k] = r[k];
  if (r.source === "extension") report.source = "extension";
  if (!report.url && sender?.url) report.url = sender.url;
  call("problems.report", report).catch(problemWarn);
  sendResponse?.({ forwarded: true });
});

// ---------- the SDK ----------

function subscribe(topic, fn) {
  let fns = listeners.get(topic);
  if (!fns) {
    fns = new Set();
    listeners.set(topic, fns);
    if (connected) rawCall("events.subscribe", { topic }).catch(() => {});
  }
  fns.add(fn);
  return () => {
    fns.delete(fn);
    if (!fns.size) {
      listeners.delete(topic);
      if (connected) rawCall("events.unsubscribe", { topic }).catch(() => {});
    }
  };
}

const sdk = {
  __sdk: "layr-ext",
  errors: CODES,
  ready,
  connected: false,
  info: null,
  get plugin() {
    return connection?.plugin ?? null;
  },
  onConnection(fn) {
    connectionListeners.add(fn);
    return () => connectionListeners.delete(fn);
  },
  call,
  expect: layrExpect,
  problem: layrProblem,
  ok: layrOk,
  problems: { capture: problemsCapture },
  data: {
    get: (key) => call("data.get", { key }),
    set: (key, value) => call("data.set", { key, value }),
    delete: (key) => call("data.delete", { key }),
    list: (opts) => call("data.list", opts ?? {}),
  },
  db: {
    insert: (collection, value) => call("db.insert", { collection, value }),
    update: (collection, id, value) => call("db.update", { collection, id, value }),
    delete: (collection, id) => call("db.delete", { collection, id }),
    get: (collection, id) => call("db.get", { collection, id }),
    list: (collection, opts) => call("db.list", { collection, ...(opts ?? {}) }),
  },
  tools: {
    /** Calls a tool (default: the own plugin's); gives the MCP result {content, structuredContent?, isError?}. */
    call: (tool, args, opts) =>
      call("tools.call", { tool, args: args ?? {}, ...(opts?.plugin ? { plugin: opts.plugin } : {}) }),
    /** Like call, but gives the tool's value (structured, else its text as JSON when it is) and throws on isError. */
    async run(tool, args, opts) {
      const r = await sdk.tools.call(tool, args, opts);
      if (r?.isError) throw layrError(CODES.FAILED, r.content?.map((c) => c.text).join("\n") || `${tool} failed`);
      if (r?.structuredContent !== undefined) return r.structuredContent;
      const text = r?.content?.map((c) => c.text ?? "").join("") ?? "";
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    list: (opts) => call("tools.list", opts?.plugin ? { plugin: opts.plugin } : {}),
    /** Serves tools as `<plugin>__<name>` (replaces what was served; `{}` withdraws them). */
    async serve(tools) {
      for (const [name, t] of Object.entries(tools ?? {})) {
        if (!NAME.test(name)) throw layrError(CODES.BAD_PARAMS, `Tool names are letters, digits, _ and -: ${name}`);
        if (typeof t?.run !== "function") throw layrError(CODES.BAD_PARAMS, `Tool ${name} needs a run function`);
      }
      served = tools ?? {};
      if (connected) await rawCall("tools.serve", { tools: toolList() });
    },
  },
  events: {
    on: subscribe,
    emit: (topic, data) => call("events.emit", { topic, data }),
  },
  settings: {
    get: (id) => call("settings.get", id ? { id } : {}),
    set: (id, value) => call("settings.set", { id, value }),
  },
  ui: { notify: (text, kind) => call("ui.notify", { text, kind: kind ?? "info" }) },
  panels: { open: (panel, params, opts) => call("panels.open", { panel, params: params ?? {}, ...(opts ?? {}) }) },
  links: { open: (url) => call("links.open", { url }) },
  // Web views the plugin drives (permission webviews; docs/ARCHITECTURE.md › Web views for plugins).
  webviews: {
    open: (url, opts) => call("webviews.open", { url, ...(opts ?? {}) }),
    list: () => call("webviews.list", {}),
    navigate: (view, url, opts) => call("webviews.navigate", { view, url, ...(opts ?? {}) }),
    eval: async (view, script, opts) => (await call("webviews.eval", { view, script, ...(opts ?? {}) }))?.value,
    cdp: (view, method, params, opts) => call("webviews.cdp", { view, method, params: params ?? {}, ...(opts ?? {}) }),
    info: (view) => call("webviews.info", { view }),
    back: (view) => call("webviews.back", { view }),
    reload: (view) => call("webviews.reload", { view }),
    show: (view, where) => call("webviews.show", { view, where: where ?? "tab" }),
    hide: (view) => call("webviews.hide", { view }),
    close: (view) => call("webviews.close", { view }),
    // The user's web pages in tabs (permission webviews:pages); their ids work in info, navigate, eval, cdp, back.
    pages: () => call("webviews.pages", {}),
  },
  logs: {
    /** Send what the extension logs to layr (on by default). */
    capture(on) {
      capturing = on !== false;
      if (!capturing) logQueue.length = 0;
    },
  },
};

void connect();

export default sdk;
export { sdk as layr };

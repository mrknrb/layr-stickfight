/* Stick fight: the pure helpers of the game (no DOM, no physics), shared by the content script and the Node tests.
 * Loaded as a classic content script before game.js (globalThis.StickFightLib), or required by test/lib.test.mjs.
 */
(function (root) {
  "use strict";

  /** Only Wikipedia for now: any language, the mobile site, and wikipedia.org itself. */
  function isWikipedia(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host === "wikipedia.org" || host.endsWith(".wikipedia.org");
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /** Does the rectangle {x, y, w, h} touch the circle at (cx, cy) with radius r? */
  function rectTouchesCircle(rect, cx, cy, r) {
    const nx = clamp(cx, rect.x, rect.x + rect.w);
    const ny = clamp(cy, rect.y, rect.y + rect.h);
    const dx = cx - nx;
    const dy = cy - ny;
    return dx * dx + dy * dy <= r * r;
  }

  function rectContains(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  }

  /** Does the rectangle overlap the vertical band [top, bottom]? */
  function inBand(rect, top, bottom) {
    return rect.y + rect.h >= top && rect.y <= bottom;
  }

  /** The word runs of a text: [{start, end}] over non-whitespace, the pieces a line of text shatters into. */
  function splitWords(text) {
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(String(text))) !== null) out.push({ start: m.index, end: m.index + m[0].length });
    return out;
  }

  /** A rectangle worth a physics body: big enough to see and to stand on, not the size of the page. */
  function usableRect(rect, page) {
    if (!(rect.w >= 2 && rect.h >= 2)) return false;
    if (page && (rect.w > page.w * 0.98 && rect.h > page.h * 0.5)) return false;
    return Number.isFinite(rect.x) && Number.isFinite(rect.y);
  }

  /** Elements that are one thing as a whole (they fly in one piece); text is handled line by line instead. */
  const SOLID_TAGS = new Set(
    ["IMG", "SVG", "VIDEO", "CANVAS", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "HR", "PICTURE"],
  );
  /** Elements whose content is never a thing. */
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK", "IFRAME"]);

  function isSolidTag(tag) {
    return SOLID_TAGS.has(String(tag).toUpperCase());
  }

  function isSkippedTag(tag) {
    return SKIP_TAGS.has(String(tag).toUpperCase());
  }

  /** The game's action for a key (KeyboardEvent.code), or null. */
  function keyAction(code) {
    switch (code) {
      case "KeyA":
      case "ArrowLeft":
        return "left";
      case "KeyD":
      case "ArrowRight":
        return "right";
      case "KeyW":
      case "ArrowUp":
      case "Space":
        return "jump";
      case "KeyS":
      case "ArrowDown":
        return "down";
      case "KeyF":
      case "KeyE":
        return "melee";
      case "KeyG":
        return "grenade";
      case "KeyR":
        return "respawn";
      case "Escape":
        return "stop";
      default:
        return null;
    }
  }

  /** The unit vector and angle from (x0, y0) toward (x1, y1); straight ahead to the right when they are the same. */
  function aim(x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return { x: 1, y: 0, angle: 0 };
    return { x: dx / len, y: dy / len, angle: Math.atan2(dy, dx) };
  }

  /**
   * Two-bone inverse kinematics: the knee (or elbow) between a hip at (hx, hy) and a foot aimed at (fx, fy), with bone
   * lengths l1 and l2; `bend` +1 or -1 picks the side the joint bends to. A target out of reach is reached toward.
   * Returns {kx, ky, fx, fy} (the foot moves in when the target is too far).
   */
  function ik(hx, hy, fx, fy, l1, l2, bend) {
    let dx = fx - hx;
    let dy = fy - hy;
    let d = Math.hypot(dx, dy);
    const max = l1 + l2 - 1e-3;
    const min = Math.abs(l1 - l2) + 1e-3;
    if (d < 1e-6) {
      dx = 0;
      dy = 1;
      d = 1e-6;
    }
    const reach = clamp(d, min, max);
    const ux = dx / d;
    const uy = dy / d;
    const tx = hx + ux * reach;
    const ty = hy + uy * reach;
    // the law of cosines: how far along the hip-foot line the knee's foot of perpendicular is
    const a = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const s = bend < 0 ? -1 : 1;
    return { kx: hx + ux * a - uy * h * s, ky: hy + uy * a + ux * h * s, fx: tx, fy: ty };
  }

  /** How hard an explosion pushes something at distance d (1 at the centre, 0 at the edge of radius r). */
  function falloff(d, r) {
    if (d >= r) return 0;
    return 1 - d / r;
  }

  /** A small seeded random generator (mulberry32): the same seed gives the same numbers in [0, 1). */
  function seeded(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** The torn edge of a hole around (0, 0): `n` points going round, each between 0.62 r and 1.08 r from the centre,
   * every other one pulled in a little more, and now and then a deeper tear (a ragged, notched edge). */
  function tornOutline(rand, r, n) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = ((i + (rand() - 0.5) * 0.6) / n) * Math.PI * 2;
      const tear = rand() < 0.12 ? 0.18 : 0;
      const k = clamp(0.9 + (rand() - 0.5) * 0.2 - (i % 2 ? 0.09 * rand() : 0) - tear, 0.62, 1.08);
      pts.push({ x: Math.cos(a) * r * k, y: Math.sin(a) * r * k });
    }
    return pts;
  }

  /**
   * How far a fire at one spot has got, `a` steps after it caught: first a soot mark spreads (`scorch`, its radius),
   * flames on it (`heat`, 0..1), then the paper burns through (`r`, the hole's radius, growing to `max`), and the
   * flames die down. `start` is the share of `max` burnt at once (a grenade's blast). `done` once it's cold.
   */
  function burnStage(a, s) {
    if (a < 0) return { scorch: 0, r: 0, heat: 0, done: false };
    const ease = (t) => 1 - (1 - clamp(t, 0, 1)) ** 2;
    const start = s.start || 0;
    const scorch = s.max * Math.max(start * 1.8, 1.75 * ease(a / (s.scorchT + s.burnT * 0.5)));
    const holeAt = s.scorchT * 0.8;
    const r = a < holeAt ? s.max * start : s.max * (start + (1 - start) * ease((a - holeAt) / s.burnT));
    const end = holeAt + s.burnT;
    const heat = a < end ? (start ? 1 : clamp(a / 20, 0, 1)) : 1 - clamp((a - end) / s.coolT, 0, 1);
    return { scorch, r, heat, done: a >= end + s.coolT };
  }

  /** Keep at most `max` items, the newest: returns the ones to drop (the oldest first). */
  function overflow(items, max) {
    return items.length > max ? items.slice(0, items.length - max) : [];
  }

  const lib = {
    isWikipedia,
    clamp,
    lerp,
    rectTouchesCircle,
    rectContains,
    inBand,
    splitWords,
    usableRect,
    isSolidTag,
    isSkippedTag,
    keyAction,
    aim,
    ik,
    falloff,
    overflow,
    seeded,
    tornOutline,
    burnStage,
  };
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.StickFightLib = lib;
})(typeof globalThis !== "undefined" ? globalThis : this);

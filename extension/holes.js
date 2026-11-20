/* Stick fight: fire and holes. A grenade sets the page on fire: a soot mark spreads first, flames dance on it, then
 * the paper burns through, and the fire creeps on (upwards more than down) to new spots nearby until it dies down.
 * Behind the burnt holes is the back of the monitor: a circuit board (one SVG tile, repeated, lined up with the page).
 *
 * Everything is drawn on one canvas fixed over the screen, under the flying pieces: soot, the rims, then the board
 * clipped to all holes together (so holes that touch become one hole with one rim), the page's shadow in it, and
 * the flames, smoke and ash on top. The fire tells the game where it scorches and where it burnt through (hooks),
 * so the game chars the words there and turns them to ash.
 * Loaded as a classic content script after lib.js, before game.js (globalThis.StickFightHoles).
 */
(function () {
  "use strict";
  const L = globalThis.StickFightLib;
  if (!L) return;

  const TILE = 320;
  const MAX_HOLES = 30;
  const NS = "http://www.w3.org/2000/svg";

  // ---------- the circuit board tile ----------
  function boardTile() {
    const rnd = L.seeded(20261119);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const out = [];
    const C = { mask: "#0f5a32", maskDark: "#0a4425", trace: "#2f9a58", traceHi: "#46b874", gold: "#d8b04a",
      goldDark: "#9c7a26", silk: "#e9efe6", chip: "#161616", pin: "#c9c9c9" };
    // the substrate, with a faint weave
    out.push(`<rect width="${TILE}" height="${TILE}" fill="${C.mask}"/>`);
    for (let i = 0; i < TILE; i += 8) {
      out.push(`<path d="M${i} 0V${TILE}M0 ${i}H${TILE}" stroke="${C.maskDark}" stroke-width=".6" opacity=".35"/>`);
    }
    // buses that run across the whole tile (they line up with the next tile)
    for (const y of [36, 42, 48, 54]) out.push(`<path d="M0 ${y}H${TILE}" stroke="${C.trace}" stroke-width="2.2"/>`);
    for (const x of [268, 274, 280]) out.push(`<path d="M${x} 0V${TILE}" stroke="${C.trace}" stroke-width="2.2"/>`);
    out.push(`<path d="M0 214H${TILE}" stroke="${C.trace}" stroke-width="4"/>`);
    // routed traces: a few straight runs with 45° corners, a pad at one end and a via at the other
    const traces = [];
    for (let i = 0; i < 46; i++) {
      let x = 12 + Math.round(rnd() * 24) * 10;
      let y = 70 + Math.round(rnd() * 22) * 10;
      if (y > 300) y = 300;
      let d = `M${x} ${y}`;
      const start = { x, y };
      let dir = pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
      for (let s = 0; s < 3; s++) {
        const len = 10 + Math.round(rnd() * 5) * 10;
        x = Math.max(10, Math.min(TILE - 58, x + dir[0] * len));
        y = Math.max(64, Math.min(TILE - 10, y + dir[1] * len));
        d += `L${x} ${y}`;
        const diag = 10 + Math.round(rnd() * 2) * 10;
        const turn = dir[0] ? [dir[0], pick([1, -1])] : [pick([1, -1]), dir[1]];
        x = Math.max(10, Math.min(TILE - 58, x + turn[0] * diag));
        y = Math.max(64, Math.min(TILE - 10, y + turn[1] * diag));
        d += `L${x} ${y}`;
        dir = dir[0] ? [0, turn[1]] : [turn[0], 0];
      }
      const w = pick([1.4, 1.4, 1.8, 2.4]);
      traces.push(`<path d="${d}" stroke="${C.trace}" stroke-width="${w}"/>`);
      traces.push(`<rect x="${start.x - 3}" y="${start.y - 3}" width="6" height="6" fill="${C.gold}"/>`);
      traces.push(`<circle cx="${x}" cy="${y}" r="3.2" fill="${C.gold}"/><circle cx="${x}" cy="${y}" r="1.3" fill="#062b15"/>`);
    }
    out.push(`<g fill="none" stroke-linecap="round" stroke-linejoin="round">${traces.join("")}</g>`);
    // a highlight along the bus edges, like copper under the mask
    out.push(`<path d="M0 35H${TILE}M0 213H${TILE}" stroke="${C.traceHi}" stroke-width=".6" opacity=".7"/>`);
    // chips with pins and silkscreen
    const chip = (x, y, w, h, pins, label, part) => {
      const g = [];
      g.push(`<rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" fill="none" stroke="${C.silk}" stroke-width=".8" opacity=".8"/>`);
      const step = w / (pins + 1);
      for (let i = 1; i <= pins; i++) {
        g.push(`<rect x="${x + i * step - 1.2}" y="${y - 6}" width="2.4" height="7" fill="${C.pin}"/>`);
        g.push(`<rect x="${x + i * step - 1.2}" y="${y + h - 1}" width="2.4" height="7" fill="${C.pin}"/>`);
      }
      const vstep = h / (Math.round(pins * h / w) + 1);
      for (let yy = y + vstep; yy < y + h - 2; yy += vstep) {
        g.push(`<rect x="${x - 6}" y="${yy - 1.2}" width="7" height="2.4" fill="${C.pin}"/>`);
        g.push(`<rect x="${x + w - 1}" y="${yy - 1.2}" width="7" height="2.4" fill="${C.pin}"/>`);
      }
      g.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${C.chip}"/>`);
      g.push(`<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h * 0.35}" rx="1.5" fill="#fff" opacity=".05"/>`);
      g.push(`<circle cx="${x + 5}" cy="${y + 5}" r="1.6" fill="#333"/>`);
      g.push(`<text x="${x + w / 2}" y="${y + h / 2 + 2.5}" font-size="7" fill="#8a8a8a" text-anchor="middle">${part}</text>`);
      g.push(`<text x="${x - 4}" y="${y - 9}" font-size="7" fill="${C.silk}">${label}</text>`);
      return g.join("");
    };
    out.push(`<g font-family="monospace">`);
    out.push(chip(84, 96, 64, 64, 10, "U3", "LX-8820"));
    out.push(chip(196, 236, 44, 26, 6, "U7", "74HC04"));
    out.push(chip(20, 250, 34, 34, 5, "U12", "PWR3"));
    // small parts: resistors, capacitors, with labels
    for (let i = 0; i < 26; i++) {
      const x = 14 + Math.round(rnd() * 23) * 10;
      const y = 72 + Math.round(rnd() * 22) * 10;
      if (x > 74 && x < 160 && y > 86 && y < 170) continue; // not on U3
      const vert = rnd() < 0.4;
      const cap = rnd() < 0.45;
      const [w, h] = vert ? [5, 11] : [11, 5];
      const body = cap ? "#c9a46a" : "#1d1d1d";
      out.push(`<g transform="translate(${x} ${y})">`);
      out.push(`<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" fill="${C.pin}"/>`);
      out.push(vert
        ? `<rect x="${-w / 2}" y="${-h / 2 + 2.5}" width="${w}" height="${h - 5}" fill="${body}"/>`
        : `<rect x="${-w / 2 + 2.5}" y="${-h / 2}" width="${w - 5}" height="${h}" fill="${body}"/>`);
      out.push(`<text x="${vert ? 5 : -5}" y="${vert ? 2 : -5}" font-size="5.5" fill="${C.silk}" opacity=".85">${cap ? "C" : "R"}${1 + i * 3}</text>`);
      out.push(`</g>`);
    }
    // electrolytic capacitors seen from above
    for (const [x, y] of [[40, 16], [196, 160], [300, 292]]) {
      out.push(`<circle cx="${x}" cy="${y}" r="11" fill="#2b2b2b"/><circle cx="${x}" cy="${y}" r="9.5" fill="#a9b1b8"/>`);
      out.push(`<path d="M${x - 6} ${y}H${x + 6}M${x} ${y - 6}V${y + 6}" stroke="#7d858c" stroke-width="1.2"/>`);
      out.push(`<path d="M${x + 7} ${y - 6}A9.5 9.5 0 0 1 ${x + 7} ${y + 6}" stroke="#25466b" stroke-width="3" fill="none"/>`);
    }
    // a connector header, a mounting hole, a crystal
    for (let i = 0; i < 8; i++) {
      out.push(`<rect x="${100 + i * 9}" y="8" width="7" height="7" fill="${C.goldDark}"/><circle cx="${103.5 + i * 9}" cy="11.5" r="1.8" fill="#111"/>`);
    }
    out.push(`<rect x="97" y="5" width="${8 * 9 + 3}" height="13" fill="none" stroke="${C.silk}" stroke-width=".8"/>`);
    out.push(`<text x="97" y="27" font-size="6" fill="${C.silk}">J4 LVDS</text>`);
    out.push(`<circle cx="236" cy="120" r="10" fill="${C.gold}"/><circle cx="236" cy="120" r="5.5" fill="#0b0b0b"/>`);
    out.push(`<rect x="168" y="96" width="26" height="10" rx="5" fill="#cfd3d6"/><text x="168" y="116" font-size="5.5" fill="${C.silk}">Y1 24MHz</text>`);
    out.push(`<text x="12" y="312" font-size="6" fill="${C.silk}" opacity=".8">MAIN BOARD REV 2.1</text>`);
    out.push(`</g>`);
    const svg = `<svg xmlns="${NS}" width="${TILE}" height="${TILE}" viewBox="0 0 ${TILE} ${TILE}">${out.join("")}</svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }


  // ---------- tuning (steps are 1/60 s) ----------
  const MAX_SITES = 120; // burning or burnt spots on the page; the oldest cold ones go first
  const MAX_PER_FIRE = 16; // spots one grenade's fire spreads to
  const MAX_GEN = 5; // how many hops the fire spreads
  const MAX_PARTICLES = 1400;
  const HOOK_EVERY = 6; // steps between telling the game where it burns

  // ---------- the canvas ----------
  const style = document.createElement("style");
  style.textContent = `
    .sf-fire { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; z-index: 2147482999;
      pointer-events: none; display: none; }`;
  const canvas = document.createElement("canvas");
  canvas.className = "sf-fire";
  const ctx = canvas.getContext("2d");
  const fx = document.createElement("canvas"); // flames, smoke and sparks, over the holes
  fx.className = "sf-fire";
  const fctx = fx.getContext("2d");
  const off = document.createElement("canvas"); // the page around the holes, for their inner shadow
  const octx = off.getContext("2d");
  const off2 = document.createElement("canvas"); // the same, blurred
  const o2ctx = off2.getContext("2d");

  let board = null; // the board as a canvas pattern, once its image has loaded
  let boardImg = null;
  let sites = []; // {x, y, s (burnStage params), age, gen, fire, pts (torn outline, radius 1), soot, rot, st}
  let fires = 0;
  const fireSize = new Map(); // fire id → how many spots it has
  let particles = []; // {kind: flame|smoke|ash|ember, x, y, vx, vy, life, max, size, ph}
  let raf = 0;
  let last = 0;
  let acc = 0;
  let steps = 0;
  let holesAt = -99; // the step the holes were last drawn at
  let view = ""; // scroll and size of the last drawing
  let hooks = { scorch: null, burn: null };
  let kept = () => []; // the rectangles (page coordinates) the holes leave standing: the big pictures

  function boardPattern() {
    if (board || boardImg) return;
    boardImg = new Image();
    boardImg.onload = () => {
      // drawn once into a bitmap: a pattern straight from the SVG image renders the SVG again on every fill
      const c = document.createElement("canvas");
      c.width = c.height = TILE;
      c.getContext("2d").drawImage(boardImg, 0, 0, TILE, TILE);
      board = ctx.createPattern(c, "repeat");
      view = "";
      wake();
    };
    boardImg.onerror = () => globalThis.layr?.problem?.("board-image", "the circuit board SVG didn't load");
    boardImg.src = boardTile();
  }

  // ---------- sprites ----------
  function sprite(size, stops) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [at, color] of stops) grad.addColorStop(at, color);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }
  const FLAME_HOT = sprite(64, [[0, "rgba(255,236,170,.75)"], [0.3, "rgba(255,170,50,.5)"],
    [0.65, "rgba(240,80,10,.22)"], [1, "rgba(200,40,0,0)"]]);
  const FLAME = sprite(64, [[0, "rgba(255,150,40,.55)"], [0.45, "rgba(235,75,10,.28)"], [1, "rgba(170,25,0,0)"]]);
  const FLAME_TIP = sprite(64, [[0, "rgba(200,50,8,.35)"], [1, "rgba(120,10,0,0)"]]);
  const SMOKE = sprite(64, [[0, "rgba(38,34,30,.55)"], [0.6, "rgba(50,45,40,.25)"], [1, "rgba(60,55,50,0)"]]);
  const GLOW = sprite(32, [[0, "rgba(255,220,140,1)"], [0.4, "rgba(255,120,30,.7)"], [1, "rgba(255,60,0,0)"]]);

  /** A soot mark: overlapping soft blots, black in the middle, brown at the edge (a few kinds, drawn turned). */
  function sootSprite(seed) {
    const rand = L.seeded(seed);
    const size = 256;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const blot = (x, y, r, color) => {
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, color);
      grad.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    };
    for (let i = 0; i < 18; i++) {
      const a = rand() * Math.PI * 2;
      const d = 30 + rand() * 60;
      blot(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 25 + rand() * 30, "rgba(110,62,22,.22)");
    }
    for (let i = 0; i < 22; i++) {
      const a = rand() * Math.PI * 2;
      const d = rand() * 62;
      blot(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 26 + rand() * 34, "rgba(16,9,4,.38)");
    }
    blot(128, 128, 80, "rgba(8,5,2,.6)");
    g.fillStyle = "rgba(20,12,6,.55)";
    for (let i = 0; i < 40; i++) {
      const a = rand() * Math.PI * 2;
      const d = 70 + rand() * 50;
      g.beginPath();
      g.arc(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 0.6 + rand() * 1.6, 0, Math.PI * 2);
      g.fill();
    }
    return c;
  }
  const SOOT = [11, 23, 37, 41].map(sootSprite);

  // ---------- the fire ----------
  function addSite(x, y, max, gen, fire, start) {
    const rand = L.seeded((Math.random() * 2 ** 31) | 0);
    const s = {
      max, start,
      scorchT: 50 + rand() * 50,
      burnT: 150 + rand() * 140,
      coolT: 140 + rand() * 120,
    };
    const site = {
      x, y, s, age: 0, gen, fire, pts: L.tornOutline(rand, 1, 44),
      soot: SOOT[Math.floor(rand() * SOOT.length)], rot: rand() * Math.PI * 2,
      st: L.burnStage(0, s), spawns: [],
    };
    // when it spreads on: a few times while it burns, fewer the further the fire has gone
    const n = Math.max(0, Math.round(3.6 - gen * 0.75 + (rand() - 0.5) * 1.2));
    const from = s.scorchT * 0.5;
    const to = s.scorchT * 0.8 + s.burnT * 0.8;
    for (let i = 0; i < n; i++) site.spawns.push(from + rand() * (to - from));
    site.spawns.sort((a, b) => b - a); // the next one last
    sites.push(site);
    fireSize.set(fire, (fireSize.get(fire) || 0) + 1);
    if (sites.length > MAX_SITES) {
      const i = sites.findIndex((t) => t.st.done);
      sites.splice(i >= 0 ? i : 0, 1);
    }
    return site;
  }

  /** A grenade went off at (x, y): a hole of about `size` radius, burning on from there. */
  function ignite(x, y, size) {
    boardPattern();
    if (!canvas.isConnected) document.documentElement.append(style, canvas, fx);
    canvas.style.display = fx.style.display = "block";
    const site = addSite(x, y, size, 0, ++fires, 0.55);
    // the blast throws burning bits about
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 2 + Math.random() * 6;
      particles.push({ kind: "ember", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, life: 40 + Math.random() * 50,
        max: 90, size: 1 + Math.random() * 1.8, ph: 0 });
    }
    view = "";
    wake();
    return site;
  }

  /**
   * A small fire that starts with a soot mark (a flamethrower"s flame on the page): no hole at once, and it spreads
   * only a hop or two. Nothing when that spot is burning already; returns whether it caught.
   */
  function kindle(x, y, size) {
    for (const t of sites) if (Math.hypot(t.x - x, t.y - y) < Math.max(t.s.max, size) * 0.7) return false;
    boardPattern();
    if (!canvas.isConnected) document.documentElement.append(style, canvas, fx);
    canvas.style.display = fx.style.display = "block";
    addSite(x, y, size, MAX_GEN - 2, ++fires, 0);
    view = "";
    wake();
    return true;
  }

  /** The fire spreads from a burning spot to a new one nearby, upwards more often, not onto a spot already burning. */
  function spread(site) {
    if (site.gen >= MAX_GEN || (fireSize.get(site.fire) || 0) >= MAX_PER_FIRE) return;
    for (let tries = 0; tries < 5; tries++) if (spreadOnce(site)) return;
  }

  function spreadOnce(site) {
    const up = Math.random() < 0.55;
    const a = up ? -Math.PI / 2 + (Math.random() - 0.5) * 2.2 : Math.random() * Math.PI * 2;
    const d = site.s.max * (0.95 + Math.random() * 0.6);
    const x = site.x + Math.cos(a) * d;
    const y = site.y + Math.sin(a) * d;
    const max = site.s.max * (0.72 + Math.random() * 0.32);
    if (max < 16 || y < 0 || x < 0 || x > document.documentElement.scrollWidth) return false;
    for (const t of sites) if (Math.hypot(t.x - x, t.y - y) < Math.max(t.s.max, max) * 0.75) return false;
    addSite(x, y, max, site.gen + 1, site.fire, 0);
    return true;
  }

  function rimPoint(site, k) {
    const p = site.pts[Math.floor(Math.random() * site.pts.length)];
    return { x: site.x + p.x * k, y: site.y + p.y * k };
  }

  /** Is the point inside a hole already (so nothing is left there to burn)? */
  function burntAway(x, y, except) {
    for (const t of sites) {
      if (t !== except && t.st.r > 2 && Math.hypot(t.x - x, t.y - y) < t.st.r * 0.8) return true;
    }
    return false;
  }

  function emit(site, onScreen) {
    const { r, scorch, heat } = site.st;
    if (heat <= 0.01 || !onScreen) return;
    const budget = 1 - particles.length / MAX_PARTICLES; // fewer, the more there are
    // flames along the burning edge of the hole, and on the soot ahead of it
    const n = heat * (1 + (r + scorch * 0.5) / 14) * 0.9 * Math.max(0, budget);
    for (let i = 0; i < n || (i === 0 && Math.random() < n); i++) {
      const front = r > 2 && Math.random() < 0.7;
      const p = front ? rimPoint(site, r * (0.98 + Math.random() * 0.1)) : rimPoint(site, scorch * Math.random() * 0.62);
      if (burntAway(p.x, p.y, site)) continue;
      const big = (front ? 9 : 6) + Math.random() * (front ? 11 : 7);
      particles.push({ kind: "flame", x: p.x, y: p.y, vx: (Math.random() - 0.5) * 0.3, vy: -1.1 - Math.random() * 1.4,
        life: 18 + Math.random() * 26, max: 44, size: big * (0.6 + heat * 0.5), ph: Math.random() * 6.3 });
    }
    if (Math.random() < heat * 0.35) {
      const p = rimPoint(site, Math.max(r, scorch * 0.4));
      particles.push({ kind: "smoke", x: p.x, y: p.y - 10, vx: (Math.random() - 0.5) * 0.4, vy: -0.6 - Math.random() * 0.6,
        life: 90 + Math.random() * 60, max: 150, size: 10 + Math.random() * 10, ph: Math.random() * 6.3 });
    }
    if (Math.random() < heat * 0.12) {
      const p = rimPoint(site, r);
      particles.push({ kind: "ember", x: p.x, y: p.y, vx: (Math.random() - 0.5) * 1.5, vy: -1 - Math.random() * 2,
        life: 50 + Math.random() * 50, max: 100, size: 0.8 + Math.random() * 1.2, ph: Math.random() * 6.3 });
    }
  }

  /** A word or an image burnt away at this rectangle: ash flakes and sparks. */
  function ash(rect) {
    const n = Math.min(10, 2 + Math.round(rect.w / 10));
    for (let i = 0; i < n; i++) {
      const x = rect.x + Math.random() * rect.w;
      const y = rect.y + Math.random() * rect.h;
      const glow = Math.random() < 0.35;
      particles.push({ kind: glow ? "ember" : "ash", x, y, vx: (Math.random() - 0.5) * 1.2, vy: -0.6 - Math.random() * 1.4,
        life: 60 + Math.random() * 70, max: 130, size: glow ? 0.8 + Math.random() : 1.2 + Math.random() * 2.2,
        ph: Math.random() * 6.3 });
    }
  }

  function stepFire() {
    steps++;
    const top = scrollY - 300;
    const bottom = scrollY + innerHeight + 300;
    for (const site of sites) {
      if (site.st.done) continue;
      site.age++;
      site.st = L.burnStage(site.age, site.s);
      const { r, scorch, heat } = site.st;
      while (site.spawns.length && site.age >= site.spawns[site.spawns.length - 1]) {
        site.spawns.pop();
        spread(site);
      }
      emit(site, site.y > top && site.y < bottom);
      if ((steps + site.gen) % HOOK_EVERY === 0 && heat > 0) {
        if (hooks.scorch) hooks.scorch(site.x, site.y, scorch * 0.62);
        if (hooks.burn && r > 2) hooks.burn(site.x, site.y, r * 0.92);
      }
    }
    for (const p of particles) {
      p.life--;
      p.ph += 0.25;
      if (p.kind === "flame") {
        p.x += p.vx + Math.sin(p.ph) * 0.35;
        p.y += p.vy;
        p.vy -= 0.035;
      } else if (p.kind === "smoke") {
        p.x += p.vx + Math.sin(p.ph * 0.2) * 0.3;
        p.y += p.vy;
        p.size += 0.22;
      } else if (p.kind === "ember") {
        p.x += p.vx + Math.sin(p.ph) * 0.3;
        p.y += p.vy;
        p.vx *= 0.97;
        p.vy = p.vy * 0.97 - 0.02;
      } else {
        p.x += p.vx + Math.sin(p.ph * 0.4) * 0.6;
        p.y += p.vy;
        p.vy = Math.min(p.vy + 0.012, 0.6);
      }
    }
    particles = particles.filter((p) => p.life > 0);
    if (particles.length > MAX_PARTICLES) particles = particles.slice(particles.length - MAX_PARTICLES);
  }

  // ---------- drawing ----------
  function holePath(c, site, r, dx = 0, dy = 0) {
    const pts = site.pts;
    c.moveTo(site.x + pts[0].x * r + dx, site.y + pts[0].y * r + dy);
    for (let i = 1; i < pts.length; i++) c.lineTo(site.x + pts[i].x * r + dx, site.y + pts[i].y * r + dy);
    c.closePath();
  }

  /** Soot, rims, the board and its shadow: they change slowly, so drawn only every few steps or when scrolled. */
  function drawHoles() {
    const dpr = devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr);
    const h = Math.round(innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, -scrollX * dpr, -scrollY * dpr);
    const vx0 = scrollX - 200;
    const vy0 = scrollY - 200;
    const vx1 = scrollX + innerWidth + 200;
    const vy1 = scrollY + innerHeight + 200;
    const near = (s, r) => s.x + r > vx0 && s.x - r < vx1 && s.y + r > vy0 && s.y - r < vy1;
    const shown = sites.filter((s) => s.st.scorch > 0 && near(s, s.st.scorch * 1.2));
    const holes = shown.filter((s) => s.st.r > 1);

    // 1. soot
    for (const s of shown) {
      const k = s.st.scorch * 1.25;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.globalAlpha = Math.min(1, 0.35 + s.st.scorch / s.s.max);
      ctx.drawImage(s.soot, -k, -k, k * 2, k * 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    if (holes.length) {
      // the big pictures stay: what follows (rims, board, shadows) leaves them out, the soot above stays over them
      const keep = kept().filter((k) => k.x < vx1 && k.x + k.w > vx0 && k.y < vy1 && k.y + k.h > vy0);
      ctx.save();
      if (keep.length) {
        ctx.beginPath();
        ctx.rect(vx0, vy0, vx1 - vx0, vy1 - vy0);
        for (const k of keep) ctx.rect(k.x, k.y, k.w, k.h);
        ctx.clip("evenodd");
      }
      // 2. the rims: a charred band, the glowing edge where it still burns (the board covers their inner half, and
      // all of a rim that lies inside another hole: touching holes are one)
      ctx.lineJoin = "round";
      for (const s of holes) {
        ctx.beginPath();
        holePath(ctx, s, s.st.r);
        ctx.strokeStyle = "rgba(25,13,5,.85)";
        ctx.lineWidth = 9;
        ctx.stroke();
        ctx.strokeStyle = "#0e0703";
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "lighter";
      for (const s of holes) {
        if (s.st.heat <= 0.02) continue;
        const h = s.st.heat;
        ctx.beginPath();
        holePath(ctx, s, s.st.r);
        for (const [width, color] of [[16, `rgba(255,70,0,${0.12 * h})`], [9, `rgba(255,110,10,${0.3 * h})`],
          [4, `rgba(255,${120 + 60 * h},30,${0.8 * h})`], [1.4, `rgba(255,230,160,${h})`]]) {
          ctx.lineWidth = width;
          ctx.strokeStyle = color;
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = "source-over";

      // 3. the board, through all the holes at once
      ctx.save();
      ctx.beginPath();
      for (const s of holes) holePath(ctx, s, s.st.r);
      ctx.clip();
      // only around the holes, on the screen: filling the whole screen is slow
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const s of holes) {
        x0 = Math.min(x0, s.x - s.st.r * 1.1);
        y0 = Math.min(y0, s.y - s.st.r * 1.1);
        x1 = Math.max(x1, s.x + s.st.r * 1.1);
        y1 = Math.max(y1, s.y + s.st.r * 1.1);
      }
      x0 = Math.max(x0, scrollX) - 30;
      y0 = Math.max(y0, scrollY) - 30;
      x1 = Math.min(x1, scrollX + innerWidth) + 30;
      y1 = Math.min(y1, scrollY + innerHeight) + 30;
      ctx.fillStyle = board || "#0f5a32";
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.fillStyle = "rgba(0,0,0,.12)";
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      // 4. the page's shadow on the board: the page around the holes, drawn off screen, casts it
      if (x1 > x0 && y1 > y0) {
        // at a quarter of the size, blurred, then stretched: cheap, and a shadow is soft anyway
        const q = 0.25;
        const ow = Math.ceil((x1 - x0) * q) + 2;
        const oh = Math.ceil((y1 - y0) * q) + 2;
        for (const c of [off, off2]) {
          if (c.width < ow || c.height < oh) {
            c.width = Math.max(c.width, ow);
            c.height = Math.max(c.height, oh);
          }
        }
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.clearRect(0, 0, off.width, off.height);
        octx.fillStyle = "#000";
        octx.fillRect(0, 0, ow, oh);
        octx.globalCompositeOperation = "destination-out";
        octx.setTransform(q, 0, 0, q, -x0 * q, -y0 * q);
        octx.beginPath();
        for (const s of holes) holePath(octx, s, s.st.r, 5, 8); // the page's shadow falls down and right
        octx.fill();
        octx.globalCompositeOperation = "source-over";
        o2ctx.clearRect(0, 0, off2.width, off2.height);
        o2ctx.filter = "blur(2.5px)";
        o2ctx.drawImage(off, 0, 0);
        o2ctx.filter = "none";
        ctx.globalAlpha = 0.85;
        ctx.drawImage(off2, 0, 0, ow, oh, x0, y0, ow / q, oh / q);
        ctx.globalAlpha = 1;
      }
      // 5. the big pictures' shadow on the board (the pictures themselves are clipped out)
      if (keep.length) {
        ctx.filter = "blur(4px)";
        ctx.fillStyle = "rgba(0,0,0,.6)";
        for (const k of keep) ctx.fillRect(k.x + 5, k.y + 8, k.w, k.h);
        ctx.filter = "none";
      }
      ctx.restore();
      ctx.restore();
    }

  }

  /** Smoke, ash, flames and sparks, on their own canvas at half the resolution (they're soft anyway; a quarter of
   * the pixels), drawn every step. */
  function drawFx() {
    const k = (devicePixelRatio || 1) * 0.5;
    const w = Math.round(innerWidth * k);
    const h = Math.round(innerHeight * k);
    if (fx.width !== w || fx.height !== h) {
      fx.width = w;
      fx.height = h;
    }
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, w, h);
    fctx.setTransform(k, 0, 0, k, -scrollX * k, -scrollY * k);
    const vx0 = scrollX - 40;
    const vy0 = scrollY - 40;
    const vx1 = scrollX + innerWidth + 40;
    const vy1 = scrollY + innerHeight + 40;
    // 5. smoke and ash, then the flames and sparks (light adds up)
    for (const p of particles) {
      if (p.x < vx0 || p.x > vx1 || p.y < vy0 || p.y > vy1) continue;
      const a = p.life / p.max;
      if (p.kind === "smoke") {
        fctx.globalAlpha = Math.min(1, a * 1.6) * 0.5;
        fctx.drawImage(SMOKE, p.x - p.size, p.y - p.size, p.size * 2, p.size * 2);
      } else if (p.kind === "ash") {
        fctx.globalAlpha = Math.min(1, a * 2);
        fctx.fillStyle = "#1c1612";
        fctx.save();
        fctx.translate(p.x, p.y);
        fctx.rotate(p.ph);
        fctx.fillRect(-p.size, -p.size * 0.4, p.size * 2, p.size * 0.8);
        fctx.restore();
      }
    }
    fctx.globalCompositeOperation = "lighter";
    for (const p of particles) {
      if (p.x < vx0 || p.x > vx1 || p.y < vy0 || p.y > vy1) continue;
      const a = p.life / p.max;
      if (p.kind === "flame") {
        const k = p.size * (0.3 + 0.7 * Math.sqrt(a));
        const img = a > 0.6 ? FLAME_HOT : a > 0.28 ? FLAME : FLAME_TIP;
        fctx.globalAlpha = Math.min(1, a * 2.5);
        fctx.drawImage(img, p.x - k * 0.4, p.y - k * 1.5, k * 0.8, k * 2.4);
      } else if (p.kind === "ember") {
        const k = p.size * 4 * (0.7 + 0.3 * Math.sin(p.ph * 2));
        fctx.globalAlpha = Math.min(1, a * 1.5);
        fctx.drawImage(GLOW, p.x - k / 2, p.y - k / 2, k, k);
      }
    }
    fctx.globalCompositeOperation = "source-over";
    fctx.globalAlpha = 1;
  }

  function active() {
    return particles.length > 0 || sites.some((s) => !s.st.done);
  }

  function loop(now) {
    raf = 0;
    const dt = Math.min(100, now - (last || now));
    last = now;
    acc += dt;
    let stepped = false;
    while (acc >= 1000 / 60) {
      acc -= 1000 / 60;
      stepFire();
      stepped = true;
    }
    const v = `${scrollX},${scrollY},${innerWidth},${innerHeight},${devicePixelRatio}`;
    const moved = v !== view;
    if (moved || (stepped && steps - holesAt >= 3 && sites.some((s) => !s.st.done))) {
      holesAt = steps;
      drawHoles();
    }
    if (moved || stepped) drawFx();
    view = v;
    if (active()) raf = requestAnimationFrame(loop);
    else last = 0;
  }

  function wake() {
    if (!raf && sites.length) raf = requestAnimationFrame(loop);
  }
  // when the fire is out, the holes still follow the page
  addEventListener("scroll", wake, { passive: true });
  addEventListener("resize", wake, { passive: true });

  function clear() {
    sites = [];
    particles = [];
    fireSize.clear();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    acc = 0;
    view = "";
    holesAt = -99;
    for (const [c, g] of [[canvas, ctx], [fx, fctx]]) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, c.width, c.height);
      c.style.display = "none";
    }
  }

  globalThis.StickFightHoles = {
    ignite,
    kindle,
    ash,
    clear,
    /** `scorch(x, y, r)`: the paper within r is scorched; `burn(x, y, r)`: it burnt through within r. */
    hooks(h) {
      hooks = { ...hooks, ...h };
    },
    /** `fn()` gives the rectangles the holes leave standing (the big pictures). */
    keep(fn) {
      kept = fn;
    },
    count: () => sites.length,
    burning: () => sites.filter((s) => !s.st.done && s.st.heat > 0).length,
    canvas,
  };
})();

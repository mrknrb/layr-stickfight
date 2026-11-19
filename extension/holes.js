/* Stick fight: grenade holes. A blast burns a ragged hole through the page, and behind it is the back of the monitor:
 * a circuit board (one SVG tile, repeated, lined up with the page so every hole shows the same board).
 *
 * Each hole is two SVGs in document coordinates: its scorch mark (in a layer under all the holes, so one hole's
 * soot never covers another's board) and the hole itself: the board, the page's shadow on it, the burnt rim with
 * cooling embers, torn paper flaps bent back into the hole, and hairline cracks.
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

  // ---------- layers ----------
  const style = document.createElement("style");
  style.textContent = `
    .sf-holes, .sf-scorches { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none;
      overflow: visible; }
    .sf-scorches { z-index: 2147482998; }
    .sf-holes { z-index: 2147482999; }
    .sf-holes > svg, .sf-scorches > svg { position: absolute; overflow: visible; pointer-events: none; }
    @keyframes sf-cool { 0% { opacity: 1; } 70% { opacity: .55; } 100% { opacity: 0; } }
    @keyframes sf-flicker { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
    .sf-ember { animation: sf-cool 5s ease-out forwards; }
    .sf-ember circle { animation: sf-flicker .35s ease-in-out infinite; }`;
  const scorchLayer = document.createElement("div");
  scorchLayer.className = "sf-scorches";
  const holeLayer = document.createElement("div");
  holeLayer.className = "sf-holes";
  let tile = null;
  let count = 0;
  const holes = []; // {scorch, hole}

  function paper() {
    for (const el of [document.body, document.documentElement]) {
      const c = el && getComputedStyle(el).backgroundColor;
      if (c && c !== "transparent" && !/rgba\(.*,\s*0\)$/.test(c)) return c;
    }
    return "#fff";
  }

  const f1 = (v) => v.toFixed(1);
  const pathOf = (pts) => "M" + pts.map((p) => `${f1(p.x)} ${f1(p.y)}`).join("L") + "Z";

  function svgEl(cls, size, x, y, inner) {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("class", cls);
    s.setAttribute("width", String(size));
    s.setAttribute("height", String(size));
    s.setAttribute("viewBox", `${-size / 2} ${-size / 2} ${size} ${size}`);
    s.style.left = `${f1(x - size / 2)}px`;
    s.style.top = `${f1(y - size / 2)}px`;
    s.innerHTML = inner;
    return s;
  }

  /** Burn a hole of radius r centred on (x, y), in document coordinates. */
  function add(x, y, r) {
    if (!tile) tile = boardTile();
    if (!holeLayer.isConnected) document.documentElement.append(scorchLayer, holeLayer);
    const id = `sf-h${++count}`;
    const rand = L.seeded((Math.random() * 2 ** 31) | 0);
    const edge = L.tornOutline(rand, r, 44);
    const hole = pathOf(edge);
    const page = paper();

    // the scorch: a soot blot well past the hole, blotchy, plus specks
    const blot = pathOf(L.tornOutline(rand, r * 1.9, 22));
    let specks = "";
    for (let i = 0; i < 26; i++) {
      const a = rand() * Math.PI * 2;
      const d = r * (1.05 + rand() * 0.7);
      specks += `<circle cx="${f1(Math.cos(a) * d)}" cy="${f1(Math.sin(a) * d)}" r="${f1(0.5 + rand() * 1.4)}"/>`;
    }
    const sSize = Math.ceil(r * 5);
    const scorch = svgEl("sf-scorch", sSize, x, y, `
      <defs>
        <radialGradient id="${id}-s">
          <stop offset="0" stop-color="#0d0805" stop-opacity=".97"/>
          <stop offset=".42" stop-color="#21130a" stop-opacity=".85"/>
          <stop offset=".62" stop-color="#4a2a12" stop-opacity=".4"/>
          <stop offset=".8" stop-color="#6b4019" stop-opacity="0"/>
        </radialGradient>
        <filter id="${id}-r" x="-30%" y="-30%" width="160%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency=".045" numOctaves="3" seed="${count}"/>
          <feDisplacementMap in="SourceGraphic" scale="${f1(r * 0.35)}" xChannelSelector="R" yChannelSelector="G"/>
          <feGaussianBlur stdDeviation="1.5"/>
        </filter>
      </defs>
      <path d="${blot}" fill="url(#${id}-s)" filter="url(#${id}-r)"/>
      <g fill="#140b06" opacity=".7">${specks}</g>`);

    // torn paper flaps bent back into the hole: a base on the edge, the tip towards the middle, its end charred
    let flaps = "";
    const nFlaps = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < nFlaps; i++) {
      const k = Math.floor(rand() * edge.length);
      const a = edge[k];
      const b = edge[(k + 3) % edge.length];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const reach = 0.35 + rand() * 0.3;
      const tip = { x: mx * (1 - reach) + (rand() - 0.5) * r * 0.2, y: my * (1 - reach) + (rand() - 0.5) * r * 0.2 };
      const side = { x: (a.x + tip.x) / 2 + (rand() - 0.5) * 6, y: (a.y + tip.y) / 2 + (rand() - 0.5) * 6 };
      const pts = [a, side, tip, b];
      flaps += `
        <linearGradient id="${id}-f${i}" gradientUnits="userSpaceOnUse" x1="${f1(mx)}" y1="${f1(my)}" x2="${f1(tip.x)}" y2="${f1(tip.y)}">
          <stop offset="0" stop-color="${page}"/><stop offset=".45" stop-color="#cfc6b8"/>
          <stop offset=".8" stop-color="#5b3a1f"/><stop offset="1" stop-color="#140b05"/>
        </linearGradient>
        <path d="${pathOf(pts.map((p) => ({ x: p.x + 5, y: p.y + 7 })))}" fill="#000" opacity=".55" filter="url(#${id}-b)"/>
        <path d="${pathOf(pts)}" fill="url(#${id}-f${i})" stroke="#2a1a0e" stroke-width=".6"/>`;
    }

    // cracks from the rim outwards
    let cracks = "";
    for (let i = 0; i < 7; i++) {
      const p = edge[Math.floor(rand() * edge.length)];
      const d = Math.hypot(p.x, p.y) || 1;
      let cx = p.x;
      let cy = p.y;
      let dd = `M${f1(cx)} ${f1(cy)}`;
      const len = r * (0.2 + rand() * 0.45);
      for (let s = 0; s < 4; s++) {
        cx += (p.x / d) * (len / 4) + (rand() - 0.5) * 8;
        cy += (p.y / d) * (len / 4) + (rand() - 0.5) * 8;
        dd += `L${f1(cx)} ${f1(cy)}`;
      }
      cracks += `<path d="${dd}"/>`;
    }

    // embers along the rim
    let embers = "";
    for (let i = 0; i < 14; i++) {
      const p = edge[Math.floor(rand() * edge.length)];
      embers += `<circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(0.8 + rand() * 1.6)}" style="animation-delay:${f1(rand() * 0.3)}s"/>`;
    }

    const hSize = Math.ceil(r * 3.2);
    const big = `M${-hSize} ${-hSize}H${hSize}V${hSize}H${-hSize}Z`;
    const ox = ((x % TILE) + TILE) % TILE;
    const oy = ((y % TILE) + TILE) % TILE;
    const holeSvg = svgEl("sf-hole", hSize, x, y, `
      <defs>
        <pattern id="${id}-p" patternUnits="userSpaceOnUse" width="${TILE}" height="${TILE}" x="${f1(-ox)}" y="${f1(-oy)}">
          <image href="${tile}" width="${TILE}" height="${TILE}"/>
        </pattern>
        <clipPath id="${id}-c"><path d="${hole}"/></clipPath>
        <radialGradient id="${id}-d">
          <stop offset=".45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/>
        </radialGradient>
        <filter id="${id}-b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
        <filter id="${id}-g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter>
      </defs>
      <g clip-path="url(#${id}-c)">
        <rect x="${-hSize}" y="${-hSize}" width="${hSize * 2}" height="${hSize * 2}" fill="url(#${id}-p)"/>
        <circle r="${f1(r * 1.1)}" fill="url(#${id}-d)"/>
        <path d="${big}${pathOf(edge.map((p) => ({ x: p.x - 6, y: p.y - 8 })))}" fill-rule="evenodd" fill="#000" opacity=".5" filter="url(#${id}-b)"/>
        ${flaps}
      </g>
      <path d="${hole}" fill="none" stroke="#e8dccb" stroke-width="5" stroke-linejoin="round" opacity=".55"/>
      <path d="${hole}" fill="none" stroke="#120a05" stroke-width="3.2" stroke-linejoin="round"/>
      <g fill="none" stroke="#1a110a" stroke-width=".7" opacity=".55">${cracks}</g>
      <g class="sf-ember">
        <path d="${hole}" fill="none" stroke="#ff6a00" stroke-width="3" filter="url(#${id}-g)"/>
        <path d="${hole}" fill="none" stroke="#ffb347" stroke-width=".9"/>
        <g fill="#ffd27a">${embers}</g>
      </g>`);
    scorchLayer.appendChild(scorch);
    holeLayer.appendChild(holeSvg);
    holes.push({ scorch, hole: holeSvg });
    for (const old of L.overflow(holes, MAX_HOLES)) {
      old.scorch.remove();
      old.hole.remove();
    }
    if (holes.length > MAX_HOLES) holes.splice(0, holes.length - MAX_HOLES);
    return holeSvg;
  }

  function clear() {
    for (const h of holes.splice(0)) {
      h.scorch.remove();
      h.hole.remove();
    }
  }

  document.documentElement.appendChild(style);
  globalThis.StickFightHoles = { add, clear, count: () => holes.length, layers: [style, scorchLayer, holeLayer] };
})();

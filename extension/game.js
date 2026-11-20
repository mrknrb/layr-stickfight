/* Stick fight: a stick figure loose on a Wikipedia page. Everything visible on the page (lines of text, words, images,
 * buttons) is a solid thing it stands on and bumps into; what it shoots, kicks or blows up gets physics and flies.
 * Enemies (red stick figures) drop in from the top of the screen when the difficulty is above Off.
 *
 * Text and tall images are one-way platforms for the figures: they land on them from above and run and jump through
 * them (a solid line of text would trap them under the one above); the player kicks loose pieces out of its way.
 *
 * Aiming has no cursor: the mouse's movement turns the aim (the pointer is locked to the page while playing), so
 * moving the mouse left aims left. Weapons: pistol, machine gun, shotgun, flamethrower and the word shooter (type a
 * word, Enter fires its letters, only real English words: words.txt, the public-domain ENABLE list, loaded when that
 * weapon is picked). Grenades are on the right button.
 *
 * How it works: the page's things are collected as rectangles in document coordinates and become static bodies of a
 * matter.js world (only those near the screen). A hit line of text is split into one <span class="sf-w"> per word
 * (inline, so the layout doesn't move), and the words near the hit become loose pieces: each a copy of the word or
 * element in an overlay layer, moved with a CSS transform every frame, while the original is hidden and leaves its
 * hole. The figures, bullets, grenades and effects are drawn on a canvas over the page. Reset puts the page back.
 *
 * The page sees what state it is in on <html data-stickfight="idle|placing|playing">, with data-sf-pieces (loose
 * pieces), data-sf-builds (how often the things were collected), data-sf-enemies, data-sf-kills, data-sf-hp,
 * data-sf-weapon, data-sf-level, data-sf-aim (degrees) and data-sf-word ("<word>:ok|no"); the end-to-end test reads
 * them.
 */
(function () {
  "use strict";
  const L = globalThis.StickFightLib;
  const M = globalThis.Matter;
  const Holes = globalThis.StickFightHoles; // grenade fire and holes, the circuit board behind (holes.js)
  if (!L || !M || !L.isWikipedia(location.hostname)) return;
  if (document.documentElement.dataset.stickfight) return; // injected twice
  const { Engine, Composite, Bodies, Body, Query, Sleeping, Bounds } = M;

  // ---------- tuning (velocities are px per 1/60 s step) ----------
  const STEP = 1000 / 60;
  const FIG_W = 14;
  const FIG_H = 40;
  const RUN = 4.6;
  const JUMP = 9.2;
  const STEP_UP = 24; // px: a ledge up to this high (a small image, a button) is walked onto
  const BLAST_RADIUS = 120;
  const HOLE_RADIUS = 62; // px: the hole a grenade burns through the page (the fire spreads on from it)
  const FUSE = 80; // steps
  const MAX_PIECES = 500;
  const BAND_MARGIN = 500; // px above and below the screen with bodies
  const LEDGE = 8; // px: running along a line, the figure steps onto a box this much higher (a [1] reference)
  const DROP = 12; // steps the figure falls through text after S
  const MELEE_RADIUS = 20;
  const AIM_R = 120; // px of mouse movement that turn the aim right round
  const HP = 100;
  const ENEMY_INK = "#b3261e";
  // text and tall images are one-way platforms for the figures (they land on them from above, run and jump through
  // them; their sides are still walls to jump off): the physics only keeps pieces and grenades off them. Small images,
  // buttons and the page's edges are solid for everybody
  const CAT = { figure: 0x1, solid: 0x2, piece: 0x4, nade: 0x8, text: 0x10, enemy: 0x20 };
  const INK = "#111";

  /** The player's weapons: `every` steps between shots while the button is held; bullets' speed, range, the radius
   * of page they knock loose, damage to enemies and push. */
  const WEAPONS = [
    { id: "pistol", name: "Pistol", every: 7, shots: 1, spread: 0.05, speed: 38, range: 2200, radius: 24, dmg: 1.4,
      push: 1, shake: 2 },
    { id: "rifle", name: "Machine gun", every: 3, shots: 1, spread: 0.13, speed: 44, range: 2200, radius: 15, dmg: 0.8,
      push: 0.7, shake: 1.5 },
    { id: "shotgun", name: "Shotgun", every: 32, shots: 9, spread: 0.5, speed: 30, range: 650, radius: 18, dmg: 1,
      push: 1.4, shake: 6 },
    { id: "flamer", name: "Flamethrower", every: 2 },
    { id: "words", name: "Word shooter", every: 0 },
    { id: "hands", name: "Punch", every: 13 }, // bare hands: hanging relaxed until it punches
  ];

  // ---------- state ----------
  let mode = "idle"; // idle | placing | playing
  let engine = null;
  let things = []; // {kind: "text"|"word"|"el", node?, el, rect, body?, dead?}
  const nodeThings = new WeakMap(); // a text node → its line things
  let bandBodies = []; // the static bodies of things near the screen
  let bounds = []; // floor and walls
  let pieces = []; // {body, wrap, ox, oy, synced}
  const hidden = []; // {el, prev}: originals hidden behind their flying copies, or burnt away
  const charred = []; // elements the fire has charred (class sf-burning)
  let fig = null; // the figure's body
  const anim = {
    facing: 1, run: 0, flip: 0, flipDir: 1, melee: 0, meleeKind: "punch", recoil: 0, flash: 0, wave: 0, jabArm: false,
  };
  const WAVE = 100; // steps a wave lasts
  const ctl = {
    grounded: false, onText: false, drop: 0, coyote: 0, jumps: 1, wall: 0, fireWait: 0, nadeWait: 0, lastJump: false,
  };
  const keys = { left: false, right: false, jump: false, down: false };
  const mouse = { x: innerWidth / 2, y: innerHeight / 3, down: false, clicked: false }; // clicked: fire once, however short
  let aimOff = { x: AIM_R, y: 0 }; // the aim point around the figure, moved by the mouse's movement
  let weapon = 0;
  let level = 0; // the difficulty: L.LEVELS
  let enemies = []; // {body, hp, max, speed, shooter, cool, drop, onText, grounded, ...}
  let enemyShots = []; // {x, y, vx, vy, left}
  let letters = []; // the word shooter's letters in flight: {ch, x, y, vx, vy, rot, spin, left}
  let flames = []; // the flamethrower's: {x, y, vx, vy, life, max, size, stuck}
  let spawnWait = 0;
  let kindleWait = 0;
  let kills = 0;
  const me = { hp: HP, invuln: 0, hurt: 0, dead: 0 };
  const word = { text: "", bad: 0, queue: [], wait: 0 };
  let dict = null; // the English words (a Set), once loaded
  let dictLoad = null;
  let bullets = [];
  let nades = [];
  let particles = [];
  let flashes = [];
  let shake = 0;
  let raf = 0;
  let last = 0;
  let acc = 0;
  let frame = 0;
  let wrecked = false;
  let hadLock = false;
  let lastWheel = 0;
  let hudText = "";
  let anchors = []; // {el, x, y, page}: a few elements spread over the page, to see when its layout moves

  const pinnedMemo = new WeakMap();
  const html = document.documentElement;
  html.dataset.stickfight = "idle";

  // ---------- page layers ----------
  // no cursor while playing. layr's web panels draw the cursor themselves: for `none` (no cursor at all) they show the
  // arrow, and a cursor image with no alpha in it they read by its mask (it can come out as a black square). So: a
  // cursor image that is see-through but for one pixel at 2% (its alpha is used as it is, and nobody sees it), with
  // `none` behind it for browsers without image cursors
  const NO_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E` +
    `%3Crect width='2' height='2' fill-opacity='.02'/%3E%3C/svg%3E") 0 0, none`;
  const style = document.createElement("style");
  style.textContent = `
    html[data-stickfight="playing"], html[data-stickfight="playing"] *,
    html[data-stickfight="placing"], html[data-stickfight="placing"] * { cursor: ${NO_CURSOR} !important; }
    html[data-stickfight="playing"] *, html[data-stickfight="placing"] * { user-select: none !important; }
    .sf-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483000;
      pointer-events: none; overflow: visible; }
    .sf-piece { position: absolute; transform-origin: 50% 50%; will-change: transform; pointer-events: none;
      box-sizing: border-box; margin: 0; white-space: pre; overflow: visible; }
    .sf-piece > * { margin: 0 !important; box-sizing: border-box; }
    .sf-letter { font: bold 24px/26px Georgia, "Times New Roman", serif; color: #111; text-align: center; }
    @keyframes sf-char {
      0% { text-shadow: 0 0 2px #ffd27a, 0 0 8px #ff5a00; }
      55% { color: #5a2508; text-shadow: 0 0 2px #ff7a1a, 0 0 5px rgba(255,80,0,.55); }
      100% { color: #1f0f04; text-shadow: none; } }
    .sf-burning { animation: sf-char 3.5s ease-out forwards; }
    img.sf-burning, svg.sf-burning, video.sf-burning, canvas.sf-burning, picture.sf-burning {
      filter: sepia(1) saturate(1.5) brightness(.38) contrast(1.2) !important; transition: filter 2.5s; }
    .sf-canvas { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; z-index: 2147483001;
      pointer-events: none; }`;
  html.appendChild(style);
  const layer = document.createElement("div");
  layer.className = "sf-layer";
  html.appendChild(layer);
  const canvas = document.createElement("canvas");
  canvas.className = "sf-canvas";
  canvas.style.display = "none";
  html.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  // ---------- the bar: a small dot at the bottom left, its controls show on hover (in a shadow root) ----------
  const host = document.createElement("div");
  host.className = "sf-toolbar";
  host.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round">
    <circle cx="12" cy="5" r="3" fill="#fff" stroke="none"/><path d="M12 8v7M12 15l-4 6M12 15l4 6M12 10l-5 3M12 10l6-1"/>
    </svg>`;
  shadow.innerHTML = `
    <style>
      .dock { display: flex; flex-direction: column-reverse; align-items: flex-start; gap: 6px; cursor: default;
        font: 12px/1.3 system-ui, sans-serif; color: #fff; }
      .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .tab { width: 26px; height: 26px; border-radius: 50%; background: rgba(17,17,17,.6); display: grid;
        place-items: center; opacity: .45; transition: opacity .2s; }
      .tab svg { width: 16px; height: 16px; }
      .hud { padding: 3px 9px; border-radius: 999px; background: rgba(17,17,17,.55); opacity: .5; white-space: nowrap;
        transition: opacity .5s; }
      .hud.flash, .hud.place { opacity: 1; }
      .panel { display: none; flex-direction: column; gap: 7px; padding: 9px; border-radius: 10px; max-width: 380px;
        background: rgba(17,17,17,.92); box-shadow: 0 2px 12px rgba(0,0,0,.35); }
      :host(:hover) .panel { display: flex; }
      :host(:hover) .tab, :host(:hover) .hud { opacity: 1; }
      button { font: inherit; color: #fff; background: #333; border: 1px solid #555; border-radius: 999px;
        padding: 3px 10px; cursor: pointer; white-space: nowrap; }
      button:hover { background: #444; }
      button.go, button.on { background: #c62828; border-color: #e53935; font-weight: 600; }
      button.go:hover, button.on:hover { background: #d32f2f; }
      .label { opacity: .7; min-width: 54px; }
      .lvl { min-width: 50px; text-align: center; font-weight: 600; }
      .hint { opacity: .8; font-size: 11px; }
      [hidden] { display: none !important; }
    </style>
    <div class="dock">
      <div class="row"><div class="tab" title="Stick fight">${ICON}</div><div class="hud" hidden></div></div>
      <div class="panel">
        <div class="row">
          <button class="go" data-act="start" title="Let a stick figure loose on this page">&#9654; Stick fight</button>
          <button data-act="stop" hidden title="Stop (Esc): the page stays as it is">&#9632; Stop</button>
          <button data-act="reset" hidden title="Put the page back">&#8634; Reset</button>
        </div>
        <div class="row"><span class="label">Weapon</span>${WEAPONS.map((w, i) =>
          `<button data-weapon="${i}" title="Key ${i + 1}">${i + 1} ${w.name}</button>`).join("")}</div>
        <div class="row"><span class="label">Enemies</span>
          <button data-act="easier" title="Fewer enemies (−)">&minus;</button><span class="lvl"></span>
          <button data-act="harder" title="More enemies (+): they drop in from the top">+</button></div>
        <div class="hint"></div>
      </div>
    </div>`;
  html.appendChild(host);
  const ui = {
    start: shadow.querySelector('[data-act="start"]'),
    stop: shadow.querySelector('[data-act="stop"]'),
    reset: shadow.querySelector('[data-act="reset"]'),
    hud: shadow.querySelector(".hud"),
    hint: shadow.querySelector(".hint"),
    lvl: shadow.querySelector(".lvl"),
    weapons: [...shadow.querySelectorAll("[data-weapon]")],
  };
  ui.start.addEventListener("click", () => start());
  ui.stop.addEventListener("click", () => stop());
  ui.reset.addEventListener("click", () => reset());
  shadow.querySelector('[data-act="easier"]').addEventListener("click", () => setLevel(level - 1));
  shadow.querySelector('[data-act="harder"]').addEventListener("click", () => setLevel(level + 1));
  for (const b of ui.weapons) b.addEventListener("click", () => selectWeapon(Number(b.dataset.weapon)));

  const HINT_PLACE = "Click to drop the stick figure";
  const HINT_PLAY = "Move the mouse to aim (no cursor) · click fire · right click grenade · 1–6 or wheel: weapon · " +
    "+ / − enemies · V wave · A/D run · W jump, twice, off walls · S drop · F kick · R respawn · Esc stop";
  const HINT_WORDS = "Word shooter: type a word, Enter (or click) fires its letters, only real English words. " +
    "Letters type now: move with the arrows and Space; Enter on an empty word waves.";

  function hud() {
    const W = WEAPONS[weapon];
    let text = "";
    if (mode === "placing") text = HINT_PLACE;
    else if (mode === "playing") {
      text = `${W.name} · Enemies: ${L.level(level).name} · ♥ ${Math.ceil(me.hp)}${kills ? ` · ${kills} down` : ""}`;
    }
    if (text !== hudText) {
      hudText = text;
      ui.hud.textContent = text;
    }
    ui.hud.hidden = !text;
    ui.hud.classList.toggle("place", mode === "placing");
  }

  let flashTimer = 0;
  function hudFlash() {
    ui.hud.classList.add("flash");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => ui.hud.classList.remove("flash"), 1600);
  }

  function showUi() {
    ui.start.hidden = mode !== "idle";
    ui.stop.hidden = mode === "idle";
    ui.reset.hidden = !wrecked && mode === "idle";
    ui.hint.hidden = mode === "idle";
    ui.hint.textContent = mode === "placing" ? HINT_PLACE : WEAPONS[weapon].id === "words" ? HINT_WORDS : HINT_PLAY;
    ui.lvl.textContent = L.level(level).name;
    ui.weapons.forEach((b, i) => b.classList.toggle("on", i === weapon));
    hud();
    html.dataset.stickfight = mode;
    html.dataset.sfPieces = String(pieces.length);
    html.dataset.sfHoles = String(Holes ? Holes.count() : 0);
    html.dataset.sfWeapon = WEAPONS[weapon].id;
    html.dataset.sfLevel = String(level);
    html.dataset.sfEnemies = String(enemies.length);
    html.dataset.sfKills = String(kills);
    html.dataset.sfHp = String(Math.ceil(me.hp));
  }

  // the difficulty is kept between pages
  const store = globalThis.chrome?.storage?.local;
  try {
    store?.get("level", (v) => {
      if (v && Number.isFinite(v.level) && mode === "idle") {
        level = L.LEVELS.indexOf(L.level(v.level));
        showUi();
      }
    });
  } catch {}

  function setLevel(n) {
    const next = L.LEVELS.indexOf(L.level(n));
    if (next === level) return;
    level = next;
    if (level === 0) for (const e of enemies.slice()) removeEnemy(e, true);
    spawnWait = Math.min(spawnWait, 45);
    try {
      store?.set({ level });
    } catch {}
    hudFlash();
    showUi();
  }

  function selectWeapon(i) {
    const n = WEAPONS.length;
    weapon = ((i % n) + n) % n;
    if (WEAPONS[weapon].id === "words") {
      loadDict();
      keys.left = keys.right = keys.jump = keys.down = false; // letters type now, a held D would run on
    }
    word.text = "";
    mouse.down = mouse.clicked = false;
    hudFlash();
    showUi();
  }

  function loadDict() {
    if (dict || dictLoad) return;
    dictLoad = fetch(chrome.runtime.getURL("words.txt"))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        dict = L.wordSet(text);
        html.dataset.sfDict = String(dict.size);
        if (dict.size < 1000) globalThis.layr?.problem?.("word-list", `the word list has only ${dict.size} words`);
      })
      .catch((e) => {
        dictLoad = null;
        globalThis.layr?.problem?.("word-list", `the word list didn't load: ${e && e.message}`);
      });
  }

  // ---------- collecting the page's things ----------
  const docX = (r) => r.left + scrollX;
  const docY = (r) => r.top + scrollY;
  const toRect = (r) => ({ x: docX(r), y: docY(r), w: r.width, h: r.height });
  const ours = (n) => n === host || n === layer || n === canvas || n === style;

  /** Fixed and sticky things move with the screen, not the page: they're never things. */
  function pinned(el) {
    if (!el || el === document.body || el === html) return false;
    if (pinnedMemo.has(el)) return pinnedMemo.get(el);
    const pos = getComputedStyle(el).position;
    const v = pos === "fixed" || pos === "sticky" || pinned(el.parentElement);
    pinnedMemo.set(el, v);
    return v;
  }

  function visible(el) {
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  }

  function collect() {
    const page = { w: html.scrollWidth, h: html.scrollHeight };
    const out = [];
    const range = document.createRange();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.TEXT_NODE) return /\S/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        if (ours(n) || L.isSkippedTag(n.tagName) || !visible(n)) return NodeFilter.FILTER_REJECT;
        if (L.isSolidTag(n.tagName)) {
          if (!pinned(n)) {
            const rect = toRect(n.getBoundingClientRect());
            if (L.usableRect(rect, page)) out.push({ kind: "el", el: n, rect, fixed: L.bigPicture(n.tagName, rect) });
          }
          return NodeFilter.FILTER_REJECT; // its insides fly with it
        }
        return NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType !== Node.TEXT_NODE) continue;
      const parent = n.parentElement;
      if (!parent || pinned(parent)) continue;
      const word = parent.classList.contains("sf-w");
      range.selectNodeContents(n);
      const lines = [];
      for (const r of range.getClientRects()) {
        const rect = toRect(r);
        if (!L.usableRect(rect, page)) continue;
        const thing = word ? { kind: "word", el: parent, rect } : { kind: "text", node: n, el: parent, rect };
        out.push(thing);
        lines.push(thing);
        if (word) break; // a word broken over two lines is one piece
      }
      if (!word && lines.length) nodeThings.set(n, lines);
    }
    return out;
  }

  /** Text is a one-way platform; elements (big pictures, icons, buttons) are solid all round. */
  function oneWay(thing) {
    return thing.kind !== "el";
  }

  function addStatic(thing) {
    const { x, y, w, h } = thing.rect;
    thing.body = Bodies.rectangle(x + w / 2, y + h / 2, w, h, {
      isStatic: true,
      friction: 0.6,
      restitution: 0,
      collisionFilter: { category: oneWay(thing) ? CAT.text : CAT.solid },
    });
    thing.body.sfThing = thing;
    Composite.add(engine.world, thing.body);
    bandBodies.push(thing.body); // the next updateBand makes the list again
  }

  function dropStatic(thing) {
    if (!thing.body) return;
    Composite.remove(engine.world, thing.body);
    thing.body = null;
  }

  /** Bodies for the things near the screen and the figure, none for the rest. */
  function updateBand() {
    const figY = fig ? fig.position.y : scrollY;
    const top = Math.min(scrollY, figY) - BAND_MARGIN;
    const bottom = Math.max(scrollY + innerHeight, figY) + BAND_MARGIN;
    const band = [];
    let dead = 0;
    for (const t of things) {
      if (t.dead) {
        dead++;
        continue;
      }
      const want = L.inBand(t.rect, top, bottom);
      if (want && !t.body) addStatic(t);
      else if (!want && t.body) dropStatic(t);
      if (t.body) band.push(t.body);
    }
    bandBodies = band;
    if (dead > things.length / 3) things = things.filter((t) => !t.dead);
  }

  function buildBounds() {
    for (const b of bounds) Composite.remove(engine.world, b);
    const w = Math.max(html.scrollWidth, innerWidth);
    const h = Math.max(html.scrollHeight, innerHeight);
    const o = { isStatic: true, friction: 0.8, collisionFilter: { category: CAT.solid } };
    bounds = [
      Bodies.rectangle(w / 2, h + 100, w + 400, 200, o),
      Bodies.rectangle(-100, h / 2, 200, h * 2 + 2000, o),
      Bodies.rectangle(w + 100, h / 2, 200, h * 2 + 2000, o),
    ];
    Composite.add(engine.world, bounds);
  }

  function rebuild() {
    if (!engine) return;
    for (const t of things) dropStatic(t);
    things = collect();
    buildBounds();
    updateBand();
    html.dataset.sfBuilds = String(Number(html.dataset.sfBuilds || 0) + 1);
    anchors = [];
    const n = things.length;
    for (let i = 0; i < 12 && n; i++) {
      const el = things[Math.floor((i * (n - 1)) / 11)].el;
      const r = el.getBoundingClientRect();
      anchors.push({ el, x: docX(r), y: docY(r), page: html.scrollHeight });
    }
  }

  /** The page's layout moved under the things (a banner came in, an image loaded, a section opened)? */
  function layoutMoved() {
    for (const a of anchors) {
      if (!a.el.isConnected || a.page !== html.scrollHeight) return true;
      const r = a.el.getBoundingClientRect();
      if (Math.abs(docX(r) - a.x) > 2 || Math.abs(docY(r) - a.y) > 2) return true;
    }
    return false;
  }

  // ---------- breaking things ----------
  /** A line of text becomes one span per word (the layout stays), each a static thing; returns the word things. */
  function shatterText(thing) {
    const node = thing.node;
    const lines = nodeThings.get(node) || [thing];
    for (const t of lines) {
      t.dead = true;
      dropStatic(t);
    }
    nodeThings.delete(node);
    if (!node.isConnected || !node.parentNode) return [];
    const text = node.data;
    const frag = document.createDocumentFragment();
    const spans = [];
    let at = 0;
    for (const w of L.splitWords(text)) {
      if (w.start > at) frag.appendChild(document.createTextNode(text.slice(at, w.start)));
      const span = document.createElement("span");
      span.className = "sf-w";
      span.textContent = text.slice(w.start, w.end);
      frag.appendChild(span);
      spans.push(span);
      at = w.end;
    }
    if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));
    node.parentNode.replaceChild(frag, node);
    wrecked = true;
    const words = [];
    for (const span of spans) {
      const r = span.getClientRects()[0];
      if (!r) continue;
      const rect = toRect(r);
      if (!L.usableRect(rect)) continue;
      const t = { kind: "word", el: span, rect };
      things.push(t);
      addStatic(t);
      words.push(t);
    }
    return words;
  }

  /** A copy of the thing for the overlay layer, looking like the original. */
  function copyOf(thing) {
    const { rect } = thing;
    const wrap = document.createElement("div");
    wrap.className = "sf-piece";
    wrap.style.left = `${rect.x}px`;
    wrap.style.top = `${rect.y}px`;
    wrap.style.width = `${rect.w}px`;
    wrap.style.height = `${rect.h}px`;
    const cs = getComputedStyle(thing.el);
    if (thing.kind === "word") {
      wrap.textContent = thing.el.textContent;
      wrap.style.font = cs.font;
      wrap.style.color = cs.color;
      wrap.style.letterSpacing = cs.letterSpacing;
      wrap.style.textDecoration = cs.textDecoration;
      wrap.style.lineHeight = `${rect.h}px`;
    } else {
      const copy = thing.el.cloneNode(true);
      copy.removeAttribute("id");
      for (const el of copy.querySelectorAll("[id]")) el.removeAttribute("id");
      copy.style.width = `${rect.w}px`;
      copy.style.height = `${rect.h}px`;
      copy.style.maxWidth = "none";
      copy.style.color = cs.color;
      copy.style.font = cs.font;
      if (cs.backgroundColor !== "rgba(0, 0, 0, 0)") copy.style.backgroundColor = cs.backgroundColor;
      wrap.appendChild(copy);
    }
    return wrap;
  }

  function hide(el) {
    hidden.push({ el, prev: el.style.visibility });
    el.style.visibility = "hidden";
  }

  /** A loose piece: `wrap` (in the overlay layer) shows it, a body of w × h centred at (cx, cy) moves it. */
  function addPiece(wrap, cx, cy, w, h, vx, vy) {
    layer.appendChild(wrap);
    const body = Bodies.rectangle(cx, cy, Math.max(w, 3), Math.max(h, 3), {
      density: 0.0012,
      friction: 0.5,
      restitution: 0.15,
      frictionAir: 0.008,
      collisionFilter: { category: CAT.piece },
    });
    Composite.add(engine.world, body);
    Body.setVelocity(body, { x: vx, y: vy });
    Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.3 * (40 / Math.max(20, w)));
    const piece = { body, wrap, ox: cx, oy: cy, synced: false };
    body.sfPiece = piece;
    pieces.push(piece);
    for (const old of L.overflow(pieces, MAX_PIECES)) {
      Composite.remove(engine.world, old.body);
      old.wrap.remove();
    }
    if (pieces.length > MAX_PIECES) pieces = pieces.slice(pieces.length - MAX_PIECES);
    return piece;
  }

  /** The thing comes loose: a body of its own with the given velocity, its copy flying in the overlay layer. */
  function loosen(thing, vx, vy) {
    if (thing.dead || !thing.el.isConnected) return null;
    thing.dead = true;
    dropStatic(thing);
    const { x, y, w, h } = thing.rect;
    const wrap = copyOf(thing);
    hide(thing.el);
    wrecked = true;
    return addPiece(wrap, x + w / 2, y + h / 2, w, h, vx, vy);
  }

  /**
   * A hit at (px, py): the things within `radius` come loose. `dir` pushes them one way (a bullet, a kick); `blast`
   * pushes them away from the point (a grenade) with that strength.
   */
  function hitAt(px, py, radius, dir, blast) {
    // big pictures stay where they are (bullets still stop at them)
    const touched = bandBodies.filter((b) => b.sfThing && !b.sfThing.fixed &&
      L.rectTouchesCircle(b.sfThing.rect, px, py, radius));
    const loose = [];
    for (const b of touched) {
      const t = b.sfThing;
      if (t.dead) continue;
      if (t.kind === "text") {
        for (const w of shatterText(t)) if (L.rectTouchesCircle(w.rect, px, py, radius)) loose.push(w);
      } else loose.push(t);
    }
    for (const t of loose) {
      const cx = t.rect.x + t.rect.w / 2;
      const cy = t.rect.y + t.rect.h / 2;
      const d = Math.hypot(cx - px, cy - py);
      const f = 0.4 + L.falloff(d, radius * 1.5);
      let vx = (Math.random() - 0.5) * 2;
      let vy = -1.5 - Math.random() * 2;
      if (dir) {
        vx += dir.x * 6 * f;
        vy += dir.y * 6 * f;
      }
      if (blast) {
        const a = L.aim(px, py, cx, cy);
        vx += a.x * blast * f;
        vy += a.y * blast * f - 3 * f;
      }
      loosen(t, vx, vy);
    }
    // pieces already loose get a shove
    const reach = radius * (blast ? 1.6 : 1.2);
    for (const p of pieces) {
      const b = p.body;
      const d = Math.hypot(b.position.x - px, b.position.y - py);
      if (d > reach) continue;
      const f = L.falloff(d, reach);
      Sleeping.set(b, false);
      if (dir) Body.setVelocity(b, { x: b.velocity.x + dir.x * 7 * f, y: b.velocity.y + dir.y * 7 * f - 1 });
      if (blast) {
        const a = L.aim(px, py, b.position.x, b.position.y);
        Body.setVelocity(b, { x: b.velocity.x + a.x * blast * f, y: b.velocity.y + a.y * blast * f - 2 * f });
      }
      Body.setAngularVelocity(b, b.angularVelocity + (Math.random() - 0.5) * 0.3 * f);
    }
    bandBodies = bandBodies.filter((b) => !b.sfThing.dead);
    showUi();
    return loose.length;
  }

  // ---------- moving a figure (the player's and the enemies' bodies) ----------
  /** Everything a bullet stops at. */
  function solids() {
    return pieces.length ? bandBodies.concat(bounds, pieces.map((p) => p.body)) : bandBodies.concat(bounds);
  }

  /** What the figures bump into from every side: not text (see landOnText), not loose pieces (see wade). */
  function figureSolids() {
    return bandBodies.filter((b) => !oneWay(b.sfThing) && !b.sfThing.dead).concat(bounds);
  }

  function figureBody(x, y, category) {
    return Bodies.rectangle(x, y, FIG_W, FIG_H, {
      inertia: Infinity,
      friction: 0,
      frictionStatic: 0,
      frictionAir: 0,
      restitution: 0,
      density: 0.02, // heavy enough to shove piles of loose words
      sleepThreshold: Infinity, // a sleeping body ignores the velocity the controls give it
      chamfer: { radius: [4, 4, 6.5, 6.5] }, // round feet slide over the seams between boxes
      collisionFilter: { category, mask: CAT.solid },
    });
  }

  /** Loose pieces the figure runs or falls into are kicked out of its way (a pile of them would trap it). */
  function wade() {
    if (!pieces.length) return;
    const v = fig.velocity;
    if (Math.abs(v.x) < 0.5 && Math.abs(v.y) < 1) return;
    const b = fig.bounds;
    const hit = Query.region(pieces.map((p) => p.body), {
      min: { x: b.min.x - 3, y: b.min.y }, max: { x: b.max.x + 3, y: b.max.y + 2 },
    });
    for (const body of hit) {
      Sleeping.set(body, false);
      const away = Math.sign(body.position.x - fig.position.x) || Math.sign(v.x) || 1;
      Body.setVelocity(body, {
        x: body.velocity.x * 0.5 + v.x * 1.1 + away * 0.8,
        y: Math.min(body.velocity.y, -1.5 - Math.abs(v.x) * 0.35 - Math.max(0, v.y) * 0.3),
      });
      Body.setAngularVelocity(body, body.angularVelocity + (Math.random() - 0.5) * 0.15);
    }
  }

  /** The tops of the live text boxes under a figure's feet span, for each: fn(top). */
  function textTops(body, fn) {
    const p = body.position;
    const left = p.x - FIG_W / 2 + 3;
    const right = p.x + FIG_W / 2 - 3;
    for (const b of bandBodies) {
      const t = b.sfThing;
      if (!oneWay(t) || t.dead) continue;
      if (t.rect.x > right || t.rect.x + t.rect.w < left) continue;
      fn(t.rect.y);
    }
  }

  /**
   * One-way text: after a physics step, feet that went down past the top of a line (or, running along a line, a box
   * at most LEDGE higher) stand on it. Jumping up or running sideways goes through text; S drops through it. `st`
   * is the figure's {drop, onText}.
   */
  function landOnText(body, st, prevFeet) {
    if (!body || st.drop > 0 || body.velocity.y < 0) return;
    const feet = body.position.y + FIG_H / 2;
    const from = prevFeet - (st.onText ? LEDGE : 0.5);
    let best = Infinity;
    textTops(body, (top) => {
      if (top >= from && top <= feet + 0.5 && top < best) best = top;
    });
    if (best === Infinity) return;
    Body.setPosition(body, { x: body.position.x, y: best - FIG_H / 2 });
    Body.setVelocity(body, { x: body.velocity.x, y: 0 });
  }

  function standingOnText(body, st) {
    if (st.drop > 0) return false;
    const feet = body.position.y + FIG_H / 2;
    let on = false;
    textTops(body, (top) => {
      if (Math.abs(top - feet) <= 1.5) on = true;
    });
    return on;
  }

  function touching(x0, y0, x1, y1, list) {
    return Query.region(list, { min: { x: x0, y: y0 }, max: { x: x1, y: y1 } }).length > 0;
  }

  /** Up out of whatever the figure was dropped into. */
  function unstick(x, y) {
    updateBand();
    const list = figureSolids();
    let cy = y;
    for (let i = 0; i < 400; i++) {
      if (!touching(x - FIG_W / 2, cy - FIG_H / 2, x + FIG_W / 2, cy + FIG_H / 2, list)) break;
      cy -= 4;
    }
    return cy;
  }

  function placeFigure(x, y) {
    const cy = unstick(x, y);
    if (fig) Composite.remove(engine.world, fig);
    fig = figureBody(x, cy, CAT.figure);
    Composite.add(engine.world, fig);
    ctl.jumps = 1;
    me.hp = HP;
    me.dead = 0;
    me.invuln = 40;
  }

  /** Back at the top of the screen, in the middle (there's no cursor to put it at). */
  function respawn() {
    placeFigure(scrollX + innerWidth / 2, scrollY + innerHeight * 0.25);
    showUi();
  }

  function aimDir() {
    return L.aim(0, 0, aimOff.x, aimOff.y);
  }

  function control(list) {
    const p = fig.position;
    const feet = p.y + FIG_H / 2;
    const rising = fig.velocity.y < -0.5;
    const onSolid = !rising && touching(p.x - FIG_W / 2 + 2, feet - 1, p.x + FIG_W / 2 - 2, feet + 3, list);
    const onText = !rising && standingOnText(fig, ctl);
    if (keys.down && onText && !onSolid) ctl.drop = DROP; // down through the line
    ctl.onText = onText && ctl.drop === 0;
    const grounded = onSolid || ctl.onText;
    const wallL = touching(p.x - FIG_W / 2 - 3, p.y - 10, p.x - FIG_W / 2, p.y + 10, list);
    const wallR = touching(p.x + FIG_W / 2, p.y - 10, p.x + FIG_W / 2 + 3, p.y + 10, list);
    ctl.grounded = grounded;
    ctl.wall = grounded ? 0 : wallR ? 1 : wallL ? -1 : 0;
    if (grounded) {
      ctl.coyote = 6;
      ctl.jumps = 1;
    } else if (ctl.coyote > 0) ctl.coyote--;

    let vx = fig.velocity.x;
    let vy = fig.velocity.y;
    const want = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    if (want && (grounded || ctl.coyote > 0)) stepUp(fig, want, list);
    if (grounded) vx = L.lerp(vx, want * RUN, 0.35);
    else if (want) vx = L.lerp(vx, want * RUN, 0.1);

    const pressed = keys.jump && !ctl.lastJump;
    ctl.lastJump = keys.jump;
    if (pressed) {
      if (grounded || ctl.coyote > 0) {
        vy = -JUMP;
        ctl.coyote = 0;
      } else if (ctl.wall) {
        vy = -JUMP * 0.95;
        vx = -ctl.wall * RUN * 1.4;
        startFlip(-ctl.wall);
      } else if (ctl.jumps > 0) {
        ctl.jumps--;
        vy = -JUMP * 0.9;
        startFlip(want || anim.facing);
      }
    }
    if (!grounded && !keys.jump && vy < -4) vy += 0.45; // a short tap is a short hop
    if (ctl.wall && want === ctl.wall && vy > 2.5) vy = 2.5; // sliding down a wall
    if (!grounded && keys.down) vy += 0.5;
    vy = Math.min(vy, 22);
    Body.setVelocity(fig, { x: vx, y: vy });

    // keep the figure on screen while it moves off it by itself
    const sy = p.y - scrollY;
    const bottom = innerHeight - 120;
    if (vy > 0.5 && sy > bottom) scrollTo({ top: scrollY + (sy - bottom), behavior: "instant" });
    else if (vy < -0.5 && sy < 110) scrollTo({ top: scrollY + (sy - 110), behavior: "instant" });
  }

  /**
   * A line of text is many boxes whose tops differ by a few pixels (links, bold words, [1] references), and loose words
   * lie around: a ledge in front of the feet that is low enough lifts the figure onto it instead of stopping it.
   */
  function stepUp(body, dir, list) {
    const p = body.position;
    const feet = p.y + FIG_H / 2;
    const x0 = dir > 0 ? p.x + FIG_W / 2 - 1 : p.x - FIG_W / 2 - 4;
    if (!touching(x0, feet - STEP_UP, x0 + 5, feet - 1.5, list)) return;
    const x = p.x + dir * 4;
    for (let dy = 1; dy <= STEP_UP + 1; dy += 1) {
      if (!touching(x - FIG_W / 2, p.y - FIG_H / 2 - dy, x + FIG_W / 2, feet - dy - 0.5, list)) {
        Body.setPosition(body, { x: p.x + dir * 1, y: p.y - dy });
        return;
      }
    }
  }

  function startFlip(dir) {
    anim.flip = 1;
    anim.flipDir = dir >= 0 ? 1 : -1;
  }

  function muzzle() {
    const a = aimDir();
    const s = shoulder();
    return { x: s.x + a.x * 25, y: s.y + a.y * 25, a };
  }

  function shoulder() {
    const p = fig.position;
    return { x: p.x + lean() * 0.6, y: p.y - 6 };
  }

  function lean() {
    return L.clamp(fig ? fig.velocity.x * 0.7 : 0, -4, 4);
  }

  // ---------- weapons ----------
  function fire(W) {
    const m = muzzle();
    for (let i = 0; i < W.shots; i++) {
      const ang = m.a.angle + (Math.random() - 0.5) * W.spread;
      const speed = W.speed * (W.shots > 1 ? 0.8 + Math.random() * 0.4 : 1);
      bullets.push({
        x: m.x, y: m.y, vx: Math.cos(ang), vy: Math.sin(ang), left: W.range * (W.shots > 1 ? 0.7 + Math.random() * 0.3 : 1),
        trail: [], speed, radius: W.radius, dmg: W.dmg, push: W.push, shake: W.shake,
      });
    }
    anim.recoil = 1;
    anim.flash = 3;
    if (W.id === "shotgun") {
      Body.setVelocity(fig, { x: fig.velocity.x - m.a.x * 2.5, y: fig.velocity.y - m.a.y * 1.5 });
      shake = Math.max(shake, 3);
    }
    // a spent case flies out
    particles.push({
      kind: "shell", x: m.x - m.a.x * 14, y: m.y - m.a.y * 14, vx: -anim.facing * (1 + Math.random()),
      vy: -2.5 - Math.random(), life: 50, max: 50, size: W.id === "shotgun" ? 3.5 : 2.5,
      color: W.id === "shotgun" ? "#c62828" : "#b8860b", spin: Math.random() * 6,
    });
  }

  /** The flamethrower: a stream of fire that sets what it touches alight and burns enemies. */
  function flame() {
    const m = muzzle();
    for (let i = 0; i < 3; i++) {
      const ang = m.a.angle + (Math.random() - 0.5) * 0.22;
      const v = 7 + Math.random() * 2.5;
      flames.push({
        x: m.x + m.a.x * 4, y: m.y + m.a.y * 4, vx: Math.cos(ang) * v + fig.velocity.x * 0.5,
        vy: Math.sin(ang) * v + fig.velocity.y * 0.3, life: 26 + Math.random() * 8, max: 34, size: 3, stuck: false,
      });
    }
    if (flames.length > 400) flames = flames.slice(flames.length - 400);
  }

  function stepFlames() {
    if (!flames.length) return;
    for (const f of flames) {
      f.x += f.vx;
      f.y += f.vy;
      f.vx *= 0.95;
      f.vy = f.vy * 0.95 - 0.06;
      f.size += 0.75;
      f.life--;
      if (f.stuck) continue;
      const e = enemyAt(f.x, f.y, f.size * 0.4);
      if (e) {
        e.burn = 90;
        hurtEnemy(e, 0.05, { x: f.vx * 0.04, y: 0 });
      }
      const hit = Query.point(bandBodies, { x: f.x, y: f.y }).find((h) => h.sfThing && !h.sfThing.dead);
      if (!hit) continue;
      f.stuck = true;
      f.vx *= 0.15;
      f.vy *= 0.15;
      if (Holes && kindleWait <= 0 && Math.random() < 0.2 && Holes.kindle(f.x, f.y, 24 + Math.random() * 16)) {
        kindleWait = 16;
        wrecked = true;
        showUi();
      }
    }
    flames = flames.filter((f) => f.life > 0);
  }

  /** Enter (or a click) with the word shooter: a real English word flies off letter by letter. */
  function fireWord() {
    if (!word.text && !word.bad && !word.queue.length) {
      wave(); // nothing typed: Enter waves the megaphone (V types a letter here)
      return;
    }
    const w = L.shootable(word.text);
    if (!w || word.bad || word.queue.length) return;
    if (!dict) {
      loadDict();
      return;
    }
    if (!dict.has(w)) {
      word.bad = 45; // shown red and shaking, then gone
      html.dataset.sfWord = `${w}:no`;
      return;
    }
    html.dataset.sfWord = `${w}:ok`;
    word.queue = w.toUpperCase().split("");
    word.text = "";
    word.wait = 0;
  }

  function stepWord() {
    if (word.bad > 0 && --word.bad === 0) word.text = "";
    if (!word.queue.length || !fig || --word.wait > 0) return;
    const m = muzzle();
    const ang = m.a.angle + (Math.random() - 0.5) * 0.04;
    letters.push({
      ch: word.queue.shift(), x: m.x, y: m.y, vx: Math.cos(ang) * 17, vy: Math.sin(ang) * 17, rot: 0,
      spin: (Math.random() - 0.5) * 0.3, left: 1500,
    });
    word.wait = 5;
    anim.recoil = 1;
  }

  function stepLetters() {
    if (!letters.length) return;
    const list = solids();
    for (const l of letters) {
      l.vy += 0.12;
      l.rot += l.spin;
      for (let s = 0; s < 3 && l.left > 0; s++) {
        l.x += l.vx / 3;
        l.y += l.vy / 3;
        const e = enemyAt(l.x, l.y, 8);
        if (e) {
          hurtEnemy(e, 3, { x: l.vx * 0.5, y: l.vy * 0.5 - 2 });
          land(l);
          break;
        }
        const hit = Query.point(list, { x: l.x, y: l.y }).find((h) => !(h.sfThing && h.sfThing.dead));
        if (!hit) continue;
        const d = Math.hypot(l.vx, l.vy) || 1;
        if (hit.sfThing) hitAt(l.x, l.y, 30, { x: (l.vx / d) * 1.2, y: (l.vy / d) * 1.2 }, 0);
        else if (hit.sfPiece) {
          Sleeping.set(hit, false);
          Body.setVelocity(hit, { x: hit.velocity.x + l.vx * 0.5, y: hit.velocity.y + l.vy * 0.5 - 1 });
        }
        burst(l.x, l.y, 5, "#555", 3);
        shake = Math.max(shake, 3);
        land(l);
        break;
      }
      l.left -= 17;
      if (l.left <= 0 && !l.landed) land(l);
    }
    letters = letters.filter((l) => !l.landed);
  }

  /** A letter that hit something drops onto the page as a loose piece. */
  function land(l) {
    l.landed = true;
    l.left = 0;
    const wrap = document.createElement("div");
    wrap.className = "sf-piece sf-letter";
    wrap.textContent = l.ch;
    const w = 18;
    const h = 26;
    wrap.style.left = `${l.x - w / 2}px`;
    wrap.style.top = `${l.y - h / 2}px`;
    wrap.style.width = `${w}px`;
    wrap.style.height = `${h}px`;
    addPiece(wrap, l.x - (l.vx / 17) * 6, l.y - (l.vy / 17) * 6, w, h, -l.vx * 0.15, -2 - Math.random() * 2);
    wrecked = true;
  }

  function throwNade() {
    const m = muzzle();
    const body = Bodies.circle(m.x, m.y, 4.5, {
      density: 0.004, restitution: 0.45, friction: 0.4, frictionAir: 0.004,
      collisionFilter: { category: CAT.nade, mask: CAT.solid | CAT.piece | CAT.text },
    });
    Composite.add(engine.world, body);
    Body.setVelocity(body, { x: m.a.x * 11 + fig.velocity.x * 0.5, y: m.a.y * 11 + fig.velocity.y * 0.5 - 1.5 });
    Body.setAngularVelocity(body, anim.facing * 0.3);
    nades.push({ body, fuse: FUSE });
  }

/** Punch mode: a jab along the aim, the hands taking turns. */
  function punch() {
    anim.melee = 1;
    anim.meleeKind = "jab";
    anim.meleeHit = false;
    anim.jabArm = !anim.jabArm;
    anim.wave = 0;
  }

  /** V: the figure waves, with whatever it holds (or its bare hand). */
  function wave() {
    anim.wave = WAVE;
  }

  function melee() {
    if (anim.melee > 0) return;
    anim.melee = 1;
    anim.meleeKind = ctl.grounded && anim.meleeKind === "kick" ? "punch" : "kick";
    anim.meleeHit = false;
  }

  function meleeStrike() {
    const a = aimDir();
    const p = fig.position;
    if (anim.meleeKind === "jab") {
      const s = shoulder();
      const hx = s.x + a.x * 22;
      const hy = s.y + a.y * 22;
      const n = hitAt(hx, hy, MELEE_RADIUS, { x: a.x * 1.4, y: a.y * 1.4 - 0.3 }, 0);
      const e = enemyAt(hx, hy, MELEE_RADIUS * 0.6);
      if (e) hurtEnemy(e, 2, { x: a.x * 10, y: a.y * 6 - 4 });
      if (n || e) {
        shake = Math.max(shake, 4);
        burst(hx, hy, 6, "#666", 3);
      }
      return;
    }
    const dir = Math.abs(a.y) < 0.5 ? { x: anim.facing, y: a.y * 0.5 } : a;
    const reach = anim.meleeKind === "kick" ? 22 : 18;
    const hx = p.x + dir.x * reach;
    const hy = p.y + (anim.meleeKind === "kick" ? 6 : -6) + dir.y * reach;
    const n = hitAt(hx, hy, MELEE_RADIUS, { x: dir.x * 1.3, y: dir.y * 1.3 - 0.3 }, 0);
    const e = enemyAt(hx, hy, MELEE_RADIUS * 0.6);
    if (e) hurtEnemy(e, 1.5, { x: dir.x * 9, y: -4 });
    if (n || e) {
      shake = Math.max(shake, 4);
      burst(hx, hy, 6, "#666", 3);
    }
  }

  function explode(x, y) {
    hitAt(x, y, BLAST_RADIUS, null, 13);
    if (fig) {
      const d = Math.hypot(fig.position.x - x, fig.position.y - y);
      const f = L.falloff(d, BLAST_RADIUS * 1.2);
      if (f > 0) {
        const a = L.aim(x, y, fig.position.x, fig.position.y);
        Body.setVelocity(fig, { x: fig.velocity.x + a.x * 12 * f, y: fig.velocity.y + a.y * 12 * f - 4 * f });
        startFlip(a.x);
      }
    }
    for (const e of enemies.slice()) {
      const d = Math.hypot(e.body.position.x - x, e.body.position.y - y);
      const f = L.falloff(d, BLAST_RADIUS * 1.3);
      if (f <= 0) continue;
      const a = L.aim(x, y, e.body.position.x, e.body.position.y);
      hurtEnemy(e, 1 + 9 * f, { x: a.x * 14 * f, y: a.y * 14 * f - 5 * f });
    }
    if (Holes) {
      Holes.ignite(x, y, HOLE_RADIUS * (0.85 + Math.random() * 0.3));
      wrecked = true;
      showUi();
    }
    flashes.push({ x, y, t: 0 });
    burst(x, y, 26, "#444", 6);
    burst(x, y, 14, "#ff9800", 5);
    for (let i = 0; i < 12; i++) {
      particles.push({
        kind: "smoke", x: x + (Math.random() - 0.5) * 40, y: y + (Math.random() - 0.5) * 40,
        vx: (Math.random() - 0.5) * 1.5, vy: -0.5 - Math.random(), life: 60 + Math.random() * 40, max: 100,
        size: 10 + Math.random() * 14, color: "#777",
      });
    }
    shake = Math.max(shake, 14);
  }

  // ---------- enemies ----------
  /** A new enemy drops in from above the screen, not right on top of the player. */
  function spawnEnemy() {
    const lv = L.level(level);
    let x = 0;
    for (let i = 0; i < 8; i++) {
      x = scrollX + 50 + Math.random() * Math.max(10, innerWidth - 100);
      if (!fig || Math.abs(x - fig.position.x) > 160) break;
    }
    const body = figureBody(x, scrollY - 40 - Math.random() * 60, CAT.enemy);
    Composite.add(engine.world, body);
    Body.setVelocity(body, { x: 0, y: 2 });
    enemies.push({
      body, hp: lv.hp, max: lv.hp, speed: lv.speed * (0.85 + Math.random() * 0.3), shooter: Math.random() < lv.shooters,
      cool: 60, drop: 0, onText: false, grounded: false, jumpWait: 0, stuck: 0, facing: 1, run: 0, melee: 0, hurt: 0,
      flip: 0, burn: 0, recoil: 0, flash: 0, prevFeet: 0, wander: Math.random() < 0.5 ? -1 : 1,
    });
  }

  function enemyAt(x, y, pad) {
    for (const e of enemies) {
      const b = e.body.bounds;
      if (x >= b.min.x - pad && x <= b.max.x + pad && y >= b.min.y - pad && y <= b.max.y + pad) return e;
    }
    return null;
  }

  function hurtEnemy(e, dmg, push) {
    if (!enemies.includes(e)) return;
    e.hp -= dmg;
    e.hurt = 8;
    if (push) Body.setVelocity(e.body, { x: e.body.velocity.x + push.x, y: e.body.velocity.y + push.y });
    if (e.hp <= 0) {
      kills++;
      removeEnemy(e, true);
      shake = Math.max(shake, 3);
      showUi();
    }
  }

  /** Gone from the world: in pieces (`smash`) or quietly (fell off the page). */
  function removeEnemy(e, smash) {
    Composite.remove(engine.world, e.body);
    enemies = enemies.filter((x) => x !== e);
    if (smash) ragdoll(e.body.position, e.body.velocity, ENEMY_INK);
  }

  /** The figure falls apart: its bones and head tumble away. */
  function ragdoll(p, v, color) {
    const parts = [[0, -8, 0, 4], [0, 4, -5, 20], [0, 4, 5, 20], [0, -6, -10, 2], [0, -6, 10, 2]];
    for (const [x0, y0, x1, y1] of parts) {
      particles.push({
        kind: "bone", x: p.x + (x0 + x1) / 2, y: p.y + (y0 + y1) / 2, len: Math.hypot(x1 - x0, y1 - y0),
        ang: Math.atan2(y1 - y0, x1 - x0), spin: (Math.random() - 0.5) * 0.5,
        vx: v.x * 0.5 + (Math.random() - 0.5) * 7, vy: v.y * 0.5 - 3 - Math.random() * 4, life: 110, max: 110,
        size: 3, color,
      });
    }
    particles.push({
      kind: "head", x: p.x, y: p.y - 14, vx: v.x * 0.5 + (Math.random() - 0.5) * 5, vy: -5 - Math.random() * 3,
      life: 110, max: 110, size: 5.5, color, spin: 0,
    });
    burst(p.x, p.y, 10, color, 4);
  }

  function hurtPlayer(dmg, dir) {
    if (!fig || me.invuln > 0) return;
    me.hp = Math.max(0, me.hp - dmg);
    me.invuln = 22;
    me.hurt = 14;
    shake = Math.max(shake, 5);
    Body.setVelocity(fig, { x: fig.velocity.x + dir * 5, y: fig.velocity.y - 3 });
    burst(fig.position.x, fig.position.y - 6, 6, "#c62828", 3);
    if (me.hp <= 0) {
      ragdoll(fig.position, fig.velocity, INK);
      Composite.remove(engine.world, fig);
      fig = null;
      me.dead = 110; // steps before it's back
      shake = Math.max(shake, 10);
    }
    showUi();
  }

  /** An enemy's mind: run at the player, jump up to it, drop down to it, punch it; some shoot. */
  function enemyThink(e, list, lv) {
    const b = e.body;
    const p = b.position;
    const v = b.velocity;
    const feet = p.y + FIG_H / 2;
    const rising = v.y < -0.5;
    const onSolid = !rising && touching(p.x - FIG_W / 2 + 2, feet - 1, p.x + FIG_W / 2 - 2, feet + 3, list);
    const onText = !rising && standingOnText(b, e);
    e.onText = onText && e.drop === 0;
    const grounded = onSolid || e.onText;
    e.grounded = grounded;
    if (e.drop > 0) e.drop--;
    if (e.jumpWait > 0) e.jumpWait--;
    if (e.cool > 0) e.cool--;
    let want = 0;
    let vx = v.x;
    let vy = v.y;
    if (fig) {
      const t = fig.position;
      const dx = t.x - p.x;
      const dy = t.y - p.y;
      e.facing = dx >= 0 ? 1 : -1;
      if (Math.abs(dx) > 18) want = e.facing;
      if (e.shooter && Math.abs(dx) < 200 && Math.abs(dy) < 60) want = 0; // close enough to shoot
      if (grounded && e.jumpWait <= 0) {
        if ((dy < -40 && Math.abs(dx) < 260 && Math.random() < 0.05) || e.stuck > 20) {
          vy = -JUMP * (0.9 + Math.random() * 0.15);
          e.jumpWait = 45;
          e.stuck = 0;
          if (Math.random() < 0.3) e.flip = 1;
        } else if (dy > 60 && e.onText && Math.random() < 0.04) {
          e.drop = DROP;
          e.jumpWait = 20;
        }
      }
      if (Math.abs(dx) < 24 && Math.abs(dy) < 34 && e.cool <= 0) {
        e.melee = 1;
        e.cool = 55;
        hurtPlayer(lv.dmg, e.facing);
      } else if (e.shooter && e.cool <= 0 && Math.hypot(dx, dy) < 700 && Math.random() < 0.03) {
        const s = { x: p.x, y: p.y - 6 };
        const a = L.aim(s.x, s.y, t.x, t.y - 6);
        const ang = a.angle + (Math.random() - 0.5) * 0.12;
        enemyShots.push({ x: s.x + a.x * 20, y: s.y + a.y * 20, vx: Math.cos(ang) * 9, vy: Math.sin(ang) * 9, left: 900 });
        e.cool = 80 + Math.random() * 60;
        e.recoil = 1;
        e.flash = 3;
      }
    } else {
      want = e.wander;
      if (Math.random() < 0.01) e.wander = -e.wander;
    }
    if (grounded) vx = L.lerp(vx, want * e.speed, 0.3);
    else if (want) vx = L.lerp(vx, want * e.speed, 0.08);
    if (want && grounded) stepUp(b, want, list);
    if (want && grounded && Math.abs(v.x) < 0.4) e.stuck++;
    else e.stuck = Math.max(0, e.stuck - 1);
    Body.setVelocity(b, { x: vx, y: Math.min(vy, 22) });
    if (grounded) e.run += Math.abs(vx) * 0.075;
    if (e.melee > 0) e.melee = Math.max(0, e.melee - 1 / 14);
    if (e.flip > 0) e.flip = Math.max(0, e.flip - 1 / 26);
    if (e.hurt > 0) e.hurt--;
    if (e.flash > 0) e.flash--;
    e.recoil *= 0.75;
    if (e.burn > 0) {
      e.burn--;
      if (e.burn % 8 === 0) hurtEnemy(e, 0.12, null);
    }
  }

  function stepEnemies(list) {
    const lv = L.level(level);
    if (lv.max > 0 && enemies.length < lv.max && (fig || me.dead)) {
      if (--spawnWait <= 0) {
        spawnEnemy();
        spawnWait = lv.every * (0.6 + Math.random() * 0.8);
      }
    }
    for (const e of enemies.slice()) {
      e.prevFeet = e.body.position.y + FIG_H / 2;
      enemyThink(e, list, lv);
    }
  }

  function stepEnemyShots() {
    if (!enemyShots.length) return;
    // like the player's bullets: stopped by words, images and loose pieces, and knocking them loose
    const list = solids();
    for (const s of enemyShots) {
      for (let k = 0; k < 3 && s.left > 0; k++) {
        s.x += s.vx / 3;
        s.y += s.vy / 3;
        s.left -= 3;
        if (fig && Bounds.contains(fig.bounds, { x: s.x, y: s.y })) {
          hurtPlayer(L.level(level).dmg * 0.8, Math.sign(s.vx) || 1);
          s.left = 0;
          break;
        }
        const hit = Query.point(list, { x: s.x, y: s.y }).find((h) => !(h.sfThing && h.sfThing.dead));
        if (!hit) continue;
        s.left = 0;
        html.dataset.sfShotsStopped = String(Number(html.dataset.sfShotsStopped || 0) + 1);
        burst(s.x, s.y, 4, "#555", 3);
        burst(s.x, s.y, 2, "#e53935", 3);
        const d = Math.hypot(s.vx, s.vy) || 1;
        if (hit.sfThing) hitAt(s.x, s.y, 18, { x: (s.vx / d) * 0.8, y: (s.vy / d) * 0.8 }, 0);
        else if (hit.sfPiece) {
          Sleeping.set(hit, false);
          Body.setVelocity(hit, { x: hit.velocity.x + (s.vx / d) * 4, y: hit.velocity.y + (s.vy / d) * 4 - 1 });
        }
      }
    }
    enemyShots = enemyShots.filter((s) => s.left > 0);
  }

  // ---------- fire (holes.js tells where it scorches and where it burnt through) ----------
  /** The things touching the circle, lines of text broken into their words first. */
  function thingsIn(x, y, r) {
    const out = [];
    const n = things.length; // shatterText adds the words at the end
    for (let i = 0; i < n; i++) {
      const t = things[i];
      if (t.dead || !L.rectTouchesCircle(t.rect, x, y, r)) continue;
      if (t.kind === "text") {
        for (const w of shatterText(t)) if (L.rectTouchesCircle(w.rect, x, y, r)) out.push(w);
      } else out.push(t);
    }
    return out;
  }

  const centreIn = (t, x, y, r) => Math.hypot(t.rect.x + t.rect.w / 2 - x, t.rect.y + t.rect.h / 2 - y) < r;

  /** Soot reached here: the words glow and go black, images go dark (a big picture as soon as the soot touches it). */
  function scorchAt(x, y, r) {
    if (!engine) return;
    for (const t of thingsIn(x, y, r)) {
      if (t.charred || (!t.fixed && !centreIn(t, x, y, r))) continue;
      t.charred = true;
      t.el.classList.add("sf-burning");
      charred.push(t.el);
    }
  }

  /**
   * The paper burnt through here: what's on it turns to ash and is gone (the figure falls through the hole). A big
   * picture stays, dark and solid, over the hole.
   */
  function burnAt(x, y, r) {
    if (!engine) return;
    let n = 0;
    for (const t of thingsIn(x, y, r)) {
      if (t.fixed) {
        if (!t.charred) {
          t.charred = true;
          t.el.classList.add("sf-burning");
          charred.push(t.el);
        }
        continue;
      }
      if (!centreIn(t, x, y, r)) continue;
      t.dead = true;
      dropStatic(t);
      if (t.el.isConnected) hide(t.el);
      Holes.ash(t.rect);
      n++;
    }
    if (n) {
      bandBodies = bandBodies.filter((b) => !b.sfThing || !b.sfThing.dead);
      wrecked = true;
    }
    showUi();
  }

  if (Holes) {
    Holes.hooks({ scorch: scorchAt, burn: burnAt });
    // the holes leave the big pictures standing
    Holes.keep(() => {
      const out = [];
      for (const t of things) if (t.fixed && !t.dead) out.push(t.rect);
      return out;
    });
  }

  function burst(x, y, n, color, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = Math.random() * speed;
      particles.push({
        kind: "bit", x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1.5, life: 30 + Math.random() * 30, max: 60,
        size: 1.5 + Math.random() * 2.5, color, spin: Math.random() * 6,
      });
    }
  }

  // ---------- one step of the world ----------
  function step() {
    frame++;
    if (frame % 60 === 0 && layoutMoved()) rebuild();
    else if (frame % 10 === 0) updateBand();
    const list = figureSolids();
    const W = WEAPONS[weapon];
    if (fig) {
      control(list);
      wade();
      if ((mouse.down || mouse.clicked) && ctl.fireWait <= 0 && W.every) {
        if (W.id === "hands") punch();
        else if (W.id === "flamer") flame();
        else fire(W);
        anim.wave = 0;
        ctl.fireWait = W.every;
        mouse.clicked = false;
      }
      if (anim.melee > 0) {
        anim.melee -= 1 / 14;
        if (!anim.meleeHit && anim.melee < 0.6) {
          anim.meleeHit = true;
          meleeStrike();
        }
      }
    }
    stepWord();
    stepEnemies(list);
    if (ctl.fireWait > 0) ctl.fireWait--;
    if (ctl.nadeWait > 0) ctl.nadeWait--;
    if (kindleWait > 0) kindleWait--;
    const prevFeet = fig ? fig.position.y + FIG_H / 2 : 0;
    if (ctl.drop > 0) ctl.drop--;
    Engine.update(engine, STEP);
    landOnText(fig, ctl, prevFeet);
    for (const e of enemies) landOnText(e.body, e, e.prevFeet);
    stepBullets();
    stepEnemyShots();
    stepLetters();
    stepFlames();
    for (const n of nades) {
      if (--n.fuse <= 0) {
        Composite.remove(engine.world, n.body);
        explode(n.body.position.x, n.body.position.y);
      }
    }
    nades = nades.filter((n) => n.fuse > 0);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.kind === "smoke") {
        p.size += 0.4;
        p.vx *= 0.97;
        p.vy *= 0.97;
      } else p.vy += 0.3;
      if (p.kind === "bone") p.ang += p.spin;
      p.life--;
    }
    particles = particles.filter((p) => p.life > 0);
    for (const f of flashes) f.t++;
    flashes = flashes.filter((f) => f.t < 18);
    // fallen out of the page's bottom: back at the top. Enemies far off the screen are gone
    if (fig && fig.position.y > html.scrollHeight + 400) respawn();
    for (const e of enemies.slice()) {
      const y = e.body.position.y;
      if (y > html.scrollHeight + 400 || y < scrollY - 2500 || y > scrollY + innerHeight + 2500) removeEnemy(e, false);
    }
    if (!fig && me.dead > 0 && --me.dead === 0) respawn();
    if (me.invuln > 0) me.invuln--;
    if (me.hurt > 0) me.hurt--;
    if (anim.flip > 0) anim.flip = Math.max(0, anim.flip - 1 / 26);
    if (anim.wave > 0) anim.wave--;
    if (fig && ctl.grounded) anim.run += Math.abs(fig.velocity.x) * 0.075;
    anim.recoil *= 0.75;
    if (anim.flash > 0) anim.flash--;
  }

  function stepBullets() {
    if (!bullets.length) return;
    const list = solids();
    for (const b of bullets) {
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 3) b.trail.shift();
      for (let s = 0; s < b.speed && b.left > 0; s += 6) {
        b.x += b.vx * 6;
        b.y += b.vy * 6;
        b.left -= 6;
        const e = enemyAt(b.x, b.y, 3);
        if (e) {
          b.left = 0;
          burst(b.x, b.y, 4, ENEMY_INK, 3);
          hurtEnemy(e, b.dmg, { x: b.vx * 2.5 * b.push, y: b.vy * 2.5 * b.push - 1 });
          break;
        }
        const hit = Query.point(list, { x: b.x, y: b.y }).find((h) => !(h.sfThing && h.sfThing.dead));
        if (!hit) continue;
        b.left = 0;
        burst(b.x, b.y, 5, "#555", 3);
        burst(b.x, b.y, 3, "#ffc107", 4);
        if (hit.sfThing) hitAt(b.x, b.y, b.radius, { x: b.vx * b.push, y: b.vy * b.push }, 0);
        else if (hit.sfPiece) {
          Sleeping.set(hit, false);
          Body.setVelocity(hit, { x: hit.velocity.x + b.vx * 6 * b.push, y: hit.velocity.y + b.vy * 6 * b.push - 1 });
          Body.setAngularVelocity(hit, hit.angularVelocity + (Math.random() - 0.5) * 0.4);
        }
        shake = Math.max(shake, b.shake);
      }
    }
    bullets = bullets.filter((b) => b.left > 0);
  }

  // ---------- drawing ----------
  function syncPieces() {
    for (const p of pieces) {
      const b = p.body;
      if (b.isSleeping && p.synced) continue;
      p.wrap.style.transform =
        `translate(${(b.position.x - p.ox).toFixed(1)}px, ${(b.position.y - p.oy).toFixed(1)}px) ` +
        `rotate(${b.angle.toFixed(3)}rad)`;
      p.synced = b.isSleeping;
    }
  }

  function resizeCanvas() {
    const dpr = devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr);
    const h = Math.round(innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return dpr;
  }

  function line(x0, y0, x1, y1) {
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  }

  /** How the player looks this frame (see pose). */
  function playerLook(falling) {
    return {
      facing: anim.facing, lean: lean(), air: falling || !ctl.grounded, wall: falling ? 0 : ctl.wall,
      vx: fig ? fig.velocity.x : 0, vy: fig ? fig.velocity.y : 0, run: anim.run, melee: anim.melee,
      meleeKind: anim.meleeKind, aim: aimDir(), recoil: anim.recoil, flip: anim.flip, flipDir: anim.flipDir,
      weapon: WEAPONS[weapon].id, flash: anim.flash, armsUp: false, wave: anim.wave, jabArm: anim.jabArm,
    };
  }

  function enemyLook(e) {
    const v = e.body.velocity;
    const p = e.body.position;
    const aim = e.shooter && fig ? L.aim(p.x, p.y - 6, fig.position.x, fig.position.y - 6) : { x: e.facing, y: 0.2,
      angle: e.facing > 0 ? 0.2 : Math.PI - 0.2 };
    return {
      facing: e.facing, lean: L.clamp(v.x * 0.7, -4, 4), air: !e.grounded, wall: 0, vx: v.x, vy: v.y, run: e.run,
      melee: e.melee, meleeKind: "punch", aim, recoil: e.recoil, flip: e.flip, flipDir: e.facing,
      weapon: e.shooter ? "pistol" : "guard", flash: e.flash, armsUp: !e.grounded && v.y > 3,
    };
  }

  /** A stick figure's bones for this frame (document coordinates), from its body and what it's doing. */
  function pose(cx, cy, o) {
    const f = o.facing;
    const lx = o.lean;
    const head = { x: cx + lx, y: cy - 14 };
    const neck = { x: cx + lx * 0.8, y: cy - 8 };
    const hip = { x: cx, y: cy + 4 };
    const feetY = cy + FIG_H / 2;
    let footA;
    let footB;
    const a = o.aim;
    if (o.melee > 0 && o.meleeKind === "kick") {
      const t = Math.sin((1 - o.melee) * Math.PI);
      const dy = Math.abs(a.y) < 0.5 ? a.y * 0.5 : a.y;
      footA = { x: hip.x + f * 17 * t + f * 2, y: hip.y + 15 * (1 - t) + dy * 14 * t };
      footB = { x: hip.x - f * 4, y: o.air ? hip.y + 12 : feetY };
    } else if (o.air) {
      const tuck = o.vy < 0 ? 5 : 1;
      if (o.wall) {
        footA = { x: hip.x + o.wall * 7, y: hip.y + 9 };
        footB = { x: hip.x + o.wall * 5, y: hip.y + 15 };
      } else {
        footA = { x: hip.x + f * 6, y: hip.y + 15 - tuck };
        footB = { x: hip.x - f * 4, y: hip.y + 16 - tuck * 0.5 };
      }
    } else if (Math.abs(o.vx) > 0.4) {
      const dir = Math.sign(o.vx);
      const p = o.run;
      footA = { x: hip.x + Math.sin(p) * 8 * dir, y: feetY - Math.max(0, Math.cos(p)) * 6 };
      footB = { x: hip.x + Math.sin(p + Math.PI) * 8 * dir, y: feetY - Math.max(0, Math.cos(p + Math.PI)) * 6 };
    } else {
      footA = { x: hip.x + 4, y: feetY };
      footB = { x: hip.x - 4, y: feetY };
    }
    const kneeA = L.ik(hip.x, hip.y, footA.x, footA.y, 8.5, 8.5, -f);
    const kneeB = L.ik(hip.x, hip.y, footB.x, footB.y, 8.5, 8.5, -f);

    const sh = { x: neck.x, y: neck.y + 2 };
    const back = o.recoil * 4;
    let gun = { x: sh.x + a.x * (14 - back), y: sh.y + a.y * (14 - back) };
    let off = { x: sh.x + a.x * 10 - a.y * 2 * f, y: sh.y + a.y * 10 + a.x * 2 * f };
    // bare hands hang relaxed, swinging a little as it runs
    const swing = !o.air && Math.abs(o.vx) > 0.4 ? Math.sin(o.run) * 4 : 0;
    const relaxedA = { x: sh.x + f * 8 + swing, y: sh.y + 12 };
    const relaxedB = { x: sh.x - f * 7 - swing, y: sh.y + 12 };
    if (o.melee > 0 && o.meleeKind === "jab") {
      // one fist shoots out along the aim, the other guards the chin
      const t = Math.sin((1 - o.melee) * Math.PI);
      const fist = { x: sh.x + a.x * (5 + 12 * t), y: sh.y + a.y * (5 + 12 * t) };
      const guard = { x: sh.x + f * 6, y: sh.y - 2 };
      gun = o.jabArm ? fist : guard;
      off = o.jabArm ? guard : fist;
    } else if (o.melee > 0 && o.meleeKind === "punch") {
      const t = Math.sin((1 - o.melee) * Math.PI);
      off = { x: sh.x + f * (6 + 9 * t), y: sh.y + a.y * 6 * t };
      gun = { x: sh.x - f * 4 + a.x * 6, y: sh.y + 6 };
    } else if (o.wave > 0) {
      // the hand (and what it holds) up over the head, waving side to side
      gun = { x: sh.x + f * 5 + Math.sin(o.wave * 0.32) * 6, y: sh.y - 14 };
      if (o.weapon === "hands") off = relaxedB;
    } else if (o.armsUp) {
      gun = { x: sh.x - 6, y: sh.y - 13 };
      off = { x: sh.x + 6, y: sh.y - 13 };
    } else if (o.weapon === "hands") {
      gun = relaxedA;
      off = relaxedB;
    } else if (o.weapon === "guard") {
      gun = { x: sh.x + f * 8, y: sh.y + 2 };
      off = { x: sh.x + f * 12, y: sh.y - 3 };
    }
    const elbowG = L.ik(sh.x, sh.y, gun.x, gun.y, 7.5, 7.5, o.wave > 0 ? -f : a.x >= 0 ? 1 : -1);
    const elbowO = L.ik(sh.x, sh.y, off.x, off.y, 7.5, 7.5, a.x >= 0 ? 1 : -1);
    return { head, neck, hip, kneeA, kneeB, sh, elbowG, elbowO, a, f };
  }

  /** What the figure holds, drawn along the aim at its hand (the barrel's end at x = its length). */
  function drawItem(id, flash) {
    let len = 10;
    if (id === "pistol") {
      ctx.fillRect(-1, -3.5, 11, 3.5);
      ctx.fillRect(-1, -1, 3, 5);
    } else if (id === "rifle") {
      ctx.fillRect(-7, -3.5, 25, 3.5);
      ctx.fillRect(-1, -1, 3, 5);
      ctx.fillRect(7, -1, 3, 6);
      len = 18;
    } else if (id === "shotgun") {
      ctx.fillRect(-6, -4, 22, 4.5);
      ctx.fillRect(-1, 0, 3, 4);
      ctx.fillStyle = "#6d4c41";
      ctx.fillRect(8, 0.5, 6, 2.5);
      len = 16;
    } else if (id === "flamer") {
      ctx.fillRect(-1, -3, 17, 3);
      ctx.fillStyle = "#b71c1c";
      ctx.fillRect(-7, -1, 7, 8);
      if (Math.random() < 0.8) {
        ctx.fillStyle = "#ff9800";
        ctx.beginPath();
        ctx.arc(17.5, -1.5, 1.5 + Math.random(), 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    } else if (id === "words") {
      ctx.fillStyle = "#1565c0";
      ctx.beginPath();
      ctx.moveTo(-1, -2.5);
      ctx.lineTo(7, -2.5);
      ctx.lineTo(15, -7);
      ctx.lineTo(15, 4);
      ctx.lineTo(7, 0.5);
      ctx.lineTo(-1, 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(1, 0, 2.5, 4);
      return;
    } else return;
    if (flash > 0) {
      ctx.fillStyle = "#ffb300";
      ctx.beginPath();
      ctx.moveTo(len, -1.75);
      ctx.lineTo(len + 9 + Math.random() * 4, -6);
      ctx.lineTo(len + 7, -1.75);
      ctx.lineTo(len + 9 + Math.random() * 4, 3);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawFigure(cx, cy, o, ink) {
    const b = pose(cx, cy, o);
    ctx.save();
    if (o.flip > 0) {
      ctx.translate(cx, cy);
      ctx.rotate(o.flipDir * (1 - o.flip) * Math.PI * 2);
      ctx.translate(-cx, -cy);
    }
    const bones = () => {
      ctx.beginPath();
      line(b.neck.x, b.neck.y, b.hip.x, b.hip.y);
      line(b.hip.x, b.hip.y, b.kneeA.kx, b.kneeA.ky);
      line(b.kneeA.kx, b.kneeA.ky, b.kneeA.fx, b.kneeA.fy);
      line(b.hip.x, b.hip.y, b.kneeB.kx, b.kneeB.ky);
      line(b.kneeB.kx, b.kneeB.ky, b.kneeB.fx, b.kneeB.fy);
      line(b.sh.x, b.sh.y, b.elbowG.kx, b.elbowG.ky);
      line(b.elbowG.kx, b.elbowG.ky, b.elbowG.fx, b.elbowG.fy);
      line(b.sh.x, b.sh.y, b.elbowO.kx, b.elbowO.ky);
      line(b.elbowO.kx, b.elbowO.ky, b.elbowO.fx, b.elbowO.fy);
      ctx.stroke();
    };
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // a light halo first, so it reads on dark pages too
    ctx.strokeStyle = "rgba(255,255,255,.7)";
    ctx.lineWidth = 6;
    bones();
    ctx.beginPath();
    ctx.arc(b.head.x, b.head.y, 7.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,.7)";
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 3;
    bones();
    ctx.beginPath();
    ctx.arc(b.head.x, b.head.y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = ink;
    ctx.fill();
    if (o.melee > 0 && o.meleeKind === "jab") {
      const h = o.jabArm ? b.elbowG : b.elbowO;
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.arc(h.fx, h.fy, 2.8, 0, Math.PI * 2);
      ctx.fill();
    } else if (!o.armsUp && o.weapon !== "hands") {
      const g = b.elbowG;
      ctx.save();
      ctx.translate(g.fx, g.fy);
      if (o.wave > 0) {
        // held up and waved: pointing up, tilting with the hand
        ctx.rotate(-Math.PI / 2 + b.f * 0.3 + Math.sin(o.wave * 0.32) * 0.45);
        if (b.f < 0) ctx.scale(1, -1);
      } else {
        ctx.rotate(b.a.angle);
        if (b.a.x < 0) ctx.scale(1, -1);
      }
      ctx.fillStyle = INK;
      drawItem(o.weapon, o.wave > 0 ? 0 : o.flash);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawBar(x, y, w, share, color) {
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.fillRect(x - w / 2 - 1, y - 1, w + 2, 5);
    ctx.fillStyle = color;
    ctx.fillRect(x - w / 2, y, w * L.clamp(share, 0, 1), 3);
  }

  /** The word being typed, over the figure's head (red and shaking when it isn't a word). */
  function drawWord(x, y) {
    let text = word.text;
    let faint = false;
    if (!dict) {
      text = dictLoad ? "loading words…" : "no word list";
      faint = true;
    } else if (!text && !word.queue.length) {
      text = "type a word";
      faint = true;
    } else if (!text) return;
    ctx.font = faint ? "12px system-ui, sans-serif" : "bold 16px Consolas, ui-monospace, monospace";
    const caret = !faint && !word.bad && frame % 60 < 30 ? "_" : "";
    const w = ctx.measureText(text + "_").width + 12;
    const dx = word.bad ? Math.sin(word.bad * 1.7) * 4 : 0;
    ctx.globalAlpha = faint ? 0.6 : 0.92;
    ctx.fillStyle = word.bad ? "#ffebee" : "#fff";
    ctx.strokeStyle = word.bad ? "#c62828" : "#1565c0";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x - w / 2 + dx, y - 11, w, 22, 6);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = word.bad ? "#c62828" : faint ? "#555" : "#111";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text + caret, x - w / 2 + 6 + dx, y + 1);
  }

  const FLAME_GLOW = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,240,180,1)");
    grad.addColorStop(0.35, "rgba(255,150,40,.8)");
    grad.addColorStop(1, "rgba(220,40,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    return c;
  })();

  function draw() {
    const dpr = resizeCanvas();
    const sx = shake > 0.3 ? (Math.random() - 0.5) * shake : 0;
    const sy = shake > 0.3 ? (Math.random() - 0.5) * shake : 0;
    shake *= 0.85;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, (sx - scrollX) * dpr, (sy - scrollY) * dpr);

    for (const p of particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.globalAlpha = p.kind === "smoke" ? a * 0.35 : Math.min(1, a * 1.5);
      ctx.fillStyle = p.color;
      if (p.kind === "smoke") {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === "bone") {
        const c = Math.cos(p.ang) * p.len * 0.5;
        const s = Math.sin(p.ang) * p.len * 0.5;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size;
        ctx.lineCap = "round";
        ctx.beginPath();
        line(p.x - c, p.y - s, p.x + c, p.y + s);
        ctx.stroke();
      } else if (p.kind === "head") {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    for (const f of flashes) {
      const t = f.t / 18;
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = t < 0.3 ? "#fff3c4" : "#ff9800";
      ctx.beginPath();
      ctx.arc(f.x, f.y, BLAST_RADIUS * (0.3 + t * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#ffcc33";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (const b of bullets) {
      const t = b.trail[0] || b;
      ctx.beginPath();
      line(t.x, t.y, b.x, b.y);
      ctx.stroke();
    }
    ctx.fillStyle = "#e53935";
    for (const s of enemyShots) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const n of nades) {
      const p = n.body.position;
      ctx.fillStyle = "#33691e";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      if ((n.fuse >> 2) % 2 === 0 || n.fuse < 20) {
        ctx.fillStyle = "#f44336";
        ctx.beginPath();
        ctx.arc(p.x, p.y - 4.5, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // the word shooter's letters in flight
    if (letters.length) {
      ctx.font = 'bold 24px Georgia, "Times New Roman", serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(255,255,255,.8)";
      ctx.fillStyle = "#111";
      for (const l of letters) {
        ctx.save();
        ctx.translate(l.x, l.y);
        ctx.rotate(l.rot);
        ctx.strokeText(l.ch, 0, 0);
        ctx.fillText(l.ch, 0, 0);
        ctx.restore();
      }
    }
    for (const e of enemies) {
      const p = e.body.position;
      drawFigure(p.x, p.y, enemyLook(e), e.hurt > 0 && e.hurt % 4 < 2 ? "#ff8a80" : ENEMY_INK);
      if (e.burn > 0) {
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < 3; i++) {
          const s = 10 + Math.random() * 10;
          ctx.drawImage(FLAME_GLOW, p.x - s / 2 + (Math.random() - 0.5) * 10, p.y - s / 2 - Math.random() * 20, s, s);
        }
        ctx.globalCompositeOperation = "source-over";
      }
      if (e.hp < e.max) drawBar(p.x, p.y - 32, 22, e.hp / e.max, "#e53935");
    }
    if (flames.length) {
      ctx.globalCompositeOperation = "lighter";
      for (const f of flames) {
        const t = f.life / f.max;
        ctx.globalAlpha = Math.min(1, t * 1.6) * 0.8;
        const s = f.size * 2;
        ctx.drawImage(FLAME_GLOW, f.x - s / 2, f.y - s / 2, s, s);
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
    if (mode === "placing") {
      ctx.globalAlpha = 0.65;
      anim.facing = 1;
      drawFigure(mouse.x + scrollX, mouse.y + scrollY, playerLook(true), INK);
      ctx.globalAlpha = 1;
    } else if (fig) {
      const a = aimDir();
      anim.facing = a.x >= 0 ? 1 : -1;
      const p = fig.position;
      if (!(me.invuln > 0 && me.hurt > 0 && frame % 4 < 2)) drawFigure(p.x, p.y, playerLook(false), INK);
      // no cursor and no aim marks: the arm and what it holds show which way it aims
      let top = p.y - 34;
      if (me.hp < HP) {
        drawBar(p.x, top, 26, me.hp / HP, me.hp > 35 ? "#43a047" : "#e53935");
        top -= 8;
      }
      if (WEAPONS[weapon].id === "words") drawWord(p.x, top - 12);
    }
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(100, now - (last || now));
    last = now;
    if (mode === "playing") {
      acc += dt;
      let n = 0;
      while (acc >= STEP && n < 4) {
        step();
        acc -= STEP;
        n++;
      }
      if (n === 4) acc = 0;
      syncPieces();
      html.dataset.sfPieces = String(pieces.length);
      if (frame % 6 === 0) {
        if (fig) html.dataset.sfFigure = `${Math.round(fig.position.x)},${Math.round(fig.position.y)}`;
        html.dataset.sfWave = anim.wave > 0 ? "1" : "0";
        html.dataset.sfAim = String(Math.round((aimDir().angle * 180) / Math.PI));
        html.dataset.sfEnemies = String(enemies.length);
        html.dataset.sfKills = String(kills);
        html.dataset.sfHp = String(Math.ceil(me.hp));
        const foe = fig && enemies.length ? enemies.reduce((m, e) =>
          Math.abs(e.body.position.x - fig.position.x) < Math.abs(m.body.position.x - fig.position.x) ? e : m) : null;
        html.dataset.sfFoe = foe ? `${Math.round(foe.body.position.x)},${Math.round(foe.body.position.y)}` : "";
        hud();
      }
    }
    draw();
  }

  // ---------- input (only while the game runs) ----------
  const fromToolbar = (e) => e.composedPath().includes(host);
  const typing = (e) => {
    const t = e.target;
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""));
  };

  function swallow(e) {
    if (fromToolbar(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /** The mouse locked to the page while playing: no cursor, and it can't wander off the panel. */
  function lockMouse() {
    if (document.pointerLockElement === html || typeof html.requestPointerLock !== "function") return;
    try {
      const p = html.requestPointerLock();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
  }

  function onLockChange() {
    const now = document.pointerLockElement === html;
    const lost = hadLock && !now;
    hadLock = now;
    html.dataset.sfLocked = String(now);
    if (lost && mode === "playing") stop(); // Esc (the browser takes it back first) or another window
  }
  document.addEventListener("pointerlockchange", onLockChange);

  function onMove(e) {
    if (!document.pointerLockElement) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    }
    if (mode === "playing") aimOff = L.aimStep(aimOff, e.movementX, e.movementY, AIM_R);
  }

  function onDown(e) {
    if (fromToolbar(e)) return;
    swallow(e);
    onMove(e);
    if (mode === "placing" && e.button === 0) {
      placeFigure(mouse.x + scrollX, mouse.y + scrollY);
      aimOff = { x: AIM_R, y: 0 };
      mode = "playing";
      acc = 0;
      lockMouse();
      showUi();
    } else if (mode === "playing") {
      lockMouse();
      if (e.button === 0) {
        if (WEAPONS[weapon].id === "words") fireWord();
        else mouse.down = mouse.clicked = true;
      } else if (e.button === 2 && ctl.nadeWait <= 0 && fig) {
        throwNade();
        ctl.nadeWait = 30;
      }
    }
  }

  function onUp(e) {
    if (e.button === 0) mouse.down = false;
    swallow(e);
  }

  function onWheel(e) {
    if (mode !== "playing" || fromToolbar(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const now = performance.now();
    if (now - lastWheel < 140 || !e.deltaY) return;
    lastWheel = now;
    selectWeapon(weapon + Math.sign(e.deltaY));
  }

  function onKey(e, down) {
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const act = L.keyAction(e.code);
    // the word shooter: letters type the word (movement is on the arrows and Space then)
    if (mode === "playing" && WEAPONS[weapon].id === "words" && /^[a-zA-Z]$/.test(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!down && act in keys) keys[act] = false;
      if (down && !word.bad && word.text.length < 24) word.text += e.key.toLowerCase();
      return;
    }
    if (!act) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (act in keys) keys[act] = down;
    if (!down) return;
    if (act === "backspace") {
      if (!word.bad) word.text = word.text.slice(0, -1);
      return;
    }
    if (e.repeat) return;
    if (act === "stop") stop();
    else if (mode !== "playing") return;
    else if (act === "melee" && fig) melee();
    else if (act === "wave" && fig) wave();
    else if (act === "grenade" && fig && ctl.nadeWait <= 0) {
      throwNade();
      ctl.nadeWait = 30;
    } else if (act === "respawn") respawn();
    else if (act.startsWith("weapon")) selectWeapon(Number(act.slice(6)) - 1);
    else if (act === "harder") setLevel(level + 1);
    else if (act === "easier") setLevel(level - 1);
    else if (act === "enter") fireWord();
  }

  const onKeyDown = (e) => onKey(e, true);
  const onKeyUp = (e) => onKey(e, false);
  const onBlur = () => {
    keys.left = keys.right = keys.jump = keys.down = false;
    mouse.down = mouse.clicked = false;
  };
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rebuild, 300);
  };
  const LISTENERS = [
    ["mousemove", onMove],
    ["mousedown", onDown],
    ["mouseup", onUp],
    ["click", swallow],
    ["auxclick", swallow],
    ["dblclick", swallow],
    ["contextmenu", swallow],
    ["dragstart", swallow],
    ["selectstart", swallow],
    ["wheel", onWheel],
    ["keydown", onKeyDown],
    ["keyup", onKeyUp],
    ["blur", onBlur],
    ["resize", onResize],
  ];

  // ---------- start, stop, reset ----------
  function start() {
    if (mode !== "idle") return;
    if (!engine) {
      engine = Engine.create({ enableSleeping: true, positionIterations: 6, velocityIterations: 4 });
      engine.gravity.y = 1.3;
    }
    rebuild();
    mode = "placing";
    kills = 0;
    me.hp = HP;
    spawnWait = 90;
    canvas.style.display = "block";
    for (const [type, fn] of LISTENERS) addEventListener(type, fn, { capture: true, passive: false });
    last = 0;
    if (!raf) raf = requestAnimationFrame(loop);
    if (WEAPONS[weapon].id === "words") loadDict();
    showUi();
  }

  function stop() {
    if (mode === "idle") return;
    mode = "idle";
    for (const [type, fn] of LISTENERS) removeEventListener(type, fn, true);
    hadLock = false;
    if (document.pointerLockElement === html) document.exitPointerLock();
    onBlur();
    cancelAnimationFrame(raf);
    raf = 0;
    if (fig) Composite.remove(engine.world, fig);
    fig = null;
    for (const n of nades) Composite.remove(engine.world, n.body);
    for (const e of enemies) Composite.remove(engine.world, e.body);
    enemies = [];
    enemyShots = [];
    letters = [];
    flames = [];
    nades = [];
    bullets = [];
    particles = [];
    flashes = [];
    word.text = "";
    word.queue = [];
    word.bad = 0;
    me.dead = 0;
    canvas.style.display = "none";
    showUi();
  }

  function reset() {
    stop();
    for (const p of pieces) p.wrap.remove();
    if (Holes) Holes.clear();
    for (const el of charred.splice(0)) {
      el.classList.remove("sf-burning");
      if (!el.classList.length) el.removeAttribute("class");
    }
    pieces = [];
    for (const { el, prev } of hidden.splice(0)) el.style.visibility = prev;
    const parents = new Set();
    for (const span of document.querySelectorAll("span.sf-w")) {
      parents.add(span.parentNode);
      span.replaceWith(document.createTextNode(span.textContent));
    }
    for (const p of parents) p && p.normalize();
    things = [];
    bandBodies = [];
    bounds = [];
    engine = null;
    wrecked = false;
    kills = 0;
    showUi();
  }

  showUi();
})();

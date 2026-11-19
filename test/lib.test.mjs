// The game's pure helpers (extension/lib.js): node --test test/lib.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const L = createRequire(import.meta.url)("../extension/lib.js");

test("only Wikipedia", () => {
  for (const h of ["en.wikipedia.org", "hu.m.wikipedia.org", "wikipedia.org", "EN.WIKIPEDIA.ORG"]) {
    assert.equal(L.isWikipedia(h), true, h);
  }
  for (const h of ["wikipedia.org.evil.com", "notwikipedia.org", "en.wikimedia.org", "", null]) {
    assert.equal(L.isWikipedia(h), false, String(h));
  }
});

test("words of a text", () => {
  const text = "  Stick figures\tfight\n on pages ";
  const words = L.splitWords(text).map((w) => text.slice(w.start, w.end));
  assert.deepEqual(words, ["Stick", "figures", "fight", "on", "pages"]);
  assert.deepEqual(L.splitWords("   "), []);
  assert.deepEqual(L.splitWords("a"), [{ start: 0, end: 1 }]);
});

test("rectangles and circles", () => {
  const r = { x: 10, y: 10, w: 20, h: 10 };
  assert.equal(L.rectTouchesCircle(r, 20, 15, 1), true); // inside
  assert.equal(L.rectTouchesCircle(r, 35, 15, 5), true); // touching the right edge
  assert.equal(L.rectTouchesCircle(r, 36, 15, 5), false);
  assert.equal(L.rectTouchesCircle(r, 33, 23, 4), false); // the corner is 5 away
  assert.equal(L.rectContains(r, 30, 20), true);
  assert.equal(L.rectContains(r, 31, 20), false);
  assert.equal(L.inBand(r, 0, 10), true);
  assert.equal(L.inBand(r, 21, 100), false);
});

test("which rectangles become things", () => {
  assert.equal(L.usableRect({ x: 0, y: 0, w: 40, h: 18 }), true);
  assert.equal(L.usableRect({ x: 0, y: 0, w: 1, h: 18 }), false);
  assert.equal(L.usableRect({ x: 0, y: 0, w: 40, h: NaN }), false);
  assert.equal(L.usableRect({ x: NaN, y: 0, w: 40, h: 18 }), false);
  // the size of the whole page is a wrapper, not a thing
  assert.equal(L.usableRect({ x: 0, y: 0, w: 1000, h: 3000 }, { w: 1000, h: 4000 }), false);
  assert.equal(L.usableRect({ x: 0, y: 0, w: 1000, h: 30 }, { w: 1000, h: 4000 }), true);
  assert.equal(L.isSolidTag("img"), true);
  assert.equal(L.isSolidTag("SVG"), true);
  assert.equal(L.isSolidTag("p"), false);
  assert.equal(L.isSkippedTag("script"), true);
  assert.equal(L.isSkippedTag("div"), false);
});

test("keys", () => {
  assert.equal(L.keyAction("KeyA"), "left");
  assert.equal(L.keyAction("ArrowRight"), "right");
  assert.equal(L.keyAction("Space"), "jump");
  assert.equal(L.keyAction("KeyW"), "jump");
  assert.equal(L.keyAction("KeyF"), "melee");
  assert.equal(L.keyAction("KeyG"), "grenade");
  assert.equal(L.keyAction("KeyR"), "respawn");
  assert.equal(L.keyAction("Escape"), "stop");
  assert.equal(L.keyAction("KeyQ"), null);
});

test("aiming", () => {
  const a = L.aim(0, 0, 3, 4);
  assert.equal(a.x, 0.6);
  assert.equal(a.y, 0.8);
  assert.equal(L.aim(5, 5, 5, 5).x, 1); // no direction: straight ahead
  assert.ok(Math.abs(L.aim(0, 0, -1, 0).angle - Math.PI) < 1e-9);
});

test("two-bone IK keeps bone lengths and bends the chosen way", () => {
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  for (const [fx, fy] of [[0, 15], [6, 12], [-5, 10], [3, 16.5]]) {
    for (const bend of [1, -1]) {
      const k = L.ik(0, 0, fx, fy, 8.5, 8.5, bend);
      assert.ok(near(Math.hypot(k.kx, k.ky), 8.5), "thigh");
      assert.ok(near(Math.hypot(k.fx - k.kx, k.fy - k.ky), 8.5), "shin");
      assert.ok(near(k.fx, fx) && near(k.fy, fy), "reaches the foot");
    }
  }
  // straight down: bend -1 puts the knee to the right (facing right), +1 to the left
  assert.ok(L.ik(0, 0, 0, 15, 8.5, 8.5, -1).kx > 0);
  assert.ok(L.ik(0, 0, 0, 15, 8.5, 8.5, 1).kx < 0);
  // out of reach: stretched straight toward it
  const far = L.ik(0, 0, 0, 100, 8.5, 8.5, 1);
  assert.ok(far.fy < 17 && far.fy > 16.9);
  assert.ok(Math.abs(far.kx) < 0.2);
  // on the hip: still finite
  const zero = L.ik(0, 0, 0, 0, 8.5, 8.5, 1);
  assert.ok(Number.isFinite(zero.kx) && Number.isFinite(zero.fy));
});

test("blast falloff, the piece cap", () => {
  assert.equal(L.falloff(0, 100), 1);
  assert.equal(L.falloff(50, 100), 0.5);
  assert.equal(L.falloff(100, 100), 0);
  assert.equal(L.falloff(150, 100), 0);
  assert.deepEqual(L.overflow([1, 2, 3, 4, 5], 3), [1, 2]);
  assert.deepEqual(L.overflow([1, 2], 3), []);
  assert.equal(L.clamp(5, 0, 3), 3);
  assert.equal(L.lerp(0, 10, 0.25), 2.5);
});

test("torn holes", () => {
  const a = L.seeded(7);
  const b = L.seeded(7);
  const xs = [a(), a(), a()];
  assert.deepEqual(xs, [b(), b(), b()]);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const pts = L.tornOutline(L.seeded(3), 50, 28);
  assert.equal(pts.length, 28);
  for (const p of pts) {
    const d = Math.hypot(p.x, p.y);
    assert.ok(d >= 50 * 0.62 - 1e-9 && d <= 50 * 1.08 + 1e-9, `distance ${d}`);
  }
  // it goes round: the angles grow
  const ang = pts.map((p) => (Math.atan2(p.y, p.x) + Math.PI * 2.05) % (Math.PI * 2));
  for (let i = 2; i < ang.length; i++) assert.ok(ang[i] > ang[i - 1] - 1e-9, `angle ${i}`);
});

test("a fire's stages", () => {
  const s = { max: 50, scorchT: 60, burnT: 150, coolT: 120 };
  assert.deepEqual(L.burnStage(-1, s), { scorch: 0, r: 0, heat: 0, done: false });
  const early = L.burnStage(30, s);
  assert.ok(early.scorch > 0 && early.r === 0 && early.heat > 0, "soot and flames before the hole");
  let prev = { scorch: 0, r: 0 };
  for (let a = 0; a < 400; a += 5) {
    const st = L.burnStage(a, s);
    assert.ok(st.scorch >= prev.scorch - 1e-9 && st.r >= prev.r - 1e-9, `grows at ${a}`);
    assert.ok(st.r <= s.max + 1e-9 && st.scorch >= st.r, `soot ahead of the hole at ${a}`);
    prev = st;
  }
  const end = L.burnStage(48 + 150 + 120, s);
  assert.equal(end.heat, 0);
  assert.equal(end.done, true);
  assert.ok(Math.abs(end.r - 50) < 1e-9);
  const blast = L.burnStage(0, { ...s, start: 0.5 });
  assert.equal(blast.r, 25);
  assert.equal(blast.heat, 1);
});

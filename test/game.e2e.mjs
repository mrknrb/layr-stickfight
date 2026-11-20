// End-to-end test of the Stick fight extension in Chromium (Playwright), with no network and no layr: the extension
// is loaded unpacked, and https://en.wikipedia.org/... is answered with test/fixture.html. It starts the game, drops
// the figure, shoots a paragraph, throws a grenade, runs and kicks, checks links don't open, resets the page back to
// how it was, and checks other sites get nothing.
//
//   node plugins/stickfight/test/game.e2e.mjs [--out <screenshot dir>] [--headed]
//
// Playwright comes from plugins/dev (npm install there) or ~/pwtools.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const extension = path.resolve(here, "..", "extension");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-stickfight-"));
const OUT = path.resolve(arg("out", path.join(tmp, "shots")));
mkdirSync(OUT, { recursive: true });

function loadPlaywright() {
  const bases = [
    path.join(repoRoot, "plugins", "dev", "package.json"),
    path.join(os.homedir(), "pwtools", "package.json"),
  ];
  for (const base of bases) {
    try {
      return createRequire(base)("playwright");
    } catch {}
  }
  throw new Error("playwright not found (plugins/dev: npm install)");
}
const { chromium } = loadPlaywright();
const fixture = readFileSync(path.join(here, "fixture.html"), "utf8");

const context = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
  channel: "chromium",
  headless: !process.argv.includes("--headed"),
  viewport: { width: 1200, height: 800 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const errors = [];
try {
  await context.route("https://en.wikipedia.org/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixture }));
  await context.route("https://example.org/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><p>Not Wikipedia</p>" }));
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  // other sites: nothing
  await page.goto("https://example.org/");
  await page.waitForTimeout(800);
  assert.equal(await page.locator(".sf-toolbar").count(), 0, "no toolbar outside Wikipedia");

  const url = "https://en.wikipedia.org/wiki/Stick_figure";
  await page.goto(url);
  await page.waitForSelector("html[data-stickfight='idle']", { timeout: 10000 });
  const state = () => page.evaluate(() => document.documentElement.dataset.stickfight);
  const pieces = () => page.evaluate(() => Number(document.documentElement.dataset.sfPieces || 0));
  const original = await page.evaluate(() => document.querySelector("#mw-content-text").innerHTML);
  const p1Text = await page.evaluate(() => document.querySelector("#p1").textContent);
  await page.screenshot({ path: path.join(OUT, "1-idle.png") });

  // the bar is a small dot at the bottom left: its buttons show on hover
  const bar = async (sel) => {
    await page.hover(".sf-toolbar .tab");
    await page.locator(`.sf-toolbar ${sel}`).click();
  };
  assert.equal(await page.locator(".sf-toolbar button[data-act='start']").isVisible(), false, "the bar is hidden");
  const box = await page.locator(".sf-toolbar").boundingBox();
  assert.ok(box.x < 40 && box.y > 700, `the bar is at the bottom left: ${JSON.stringify(box)}`);

  // start: the figure hangs at the cursor until a click drops it
  await bar("button[data-act='start']");
  assert.equal(await state(), "placing");
  await page.mouse.move(300, 120);
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(OUT, "2-placing.png") });
  await page.mouse.click(300, 120);
  assert.equal(await state(), "playing");
  await page.waitForTimeout(1200); // it falls onto the page

  // the layout moves after the start (Wikipedia's banners do): the things follow within a second
  const builds = () => page.evaluate(() => Number(document.documentElement.dataset.sfBuilds || 0));
  const buildsBefore = await builds();
  await page.waitForTimeout(1100);
  assert.equal(await builds(), buildsBefore, "no rebuild while the page stays put");
  await page.evaluate(() => {
    const banner = document.createElement("div");
    banner.id = "banner";
    banner.style.cssText = "height:120px;background:#fee;";
    document.querySelector(".content").prepend(banner);
  });
  await page.waitForTimeout(1500);
  assert.equal(await builds(), buildsBefore + 1, "the things are collected again after the layout moved");

  // there's no cursor: moving the mouse turns the aim. aimAt moves it toward the target (in page coordinates)
  const figure = async () =>
    (await page.evaluate(() => document.documentElement.dataset.sfFigure)).split(",").map(Number);
  const aimAngle = () => page.evaluate(() => Number(document.documentElement.dataset.sfAim));
  const aimAt = async (tx, ty) => {
    const [fx, fy] = await figure();
    const d = Math.hypot(tx - fx, ty - (fy - 6)) || 1;
    const ux = (tx - fx) / d;
    const uy = (ty - (fy - 6)) / d;
    await page.mouse.move(600 - ux * 280, 400 - uy * 280);
    await page.mouse.move(600 + ux * 280, 400 + uy * 280, { steps: 8 });
    await page.waitForTimeout(120);
    return (Math.atan2(uy, ux) * 180) / Math.PI;
  };
  const docPoint = (sel, fx, fy) => page.evaluate(([sel, fx, fy]) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.left + scrollX + r.width * fx, y: r.top + scrollY + r.height * fy };
  }, [sel, fx, fy]);
  const [fx0, fy0] = await figure();
  await aimAt(fx0 - 300, fy0 - 6); // to the left
  assert.ok(Math.abs(Math.abs(await aimAngle()) - 180) < 8, `moving the mouse left aims left (${await aimAngle()}°)`);
  await aimAt(fx0 + 300, fy0 - 6);
  assert.ok(Math.abs(await aimAngle()) < 8, `and right aims right (${await aimAngle()}°)`);
  const cursor = await page.evaluate(() => getComputedStyle(document.querySelector("#p1")).cursor);
  assert.ok(/^url\("data:image\/svg\+xml.*none$/.test(cursor), `no cursor while playing: ${cursor}`);

  // shoot at the first paragraph: its words come loose and their places stay empty
  const target = await docPoint("#p1", 0.6, 0.1);
  await aimAt(target.x, target.y);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterShots = await pieces();
  assert.ok(afterShots > 0, `shots loosen words (pieces: ${afterShots})`);
  const shotWords = await page.evaluate(() => [...document.querySelectorAll("span.sf-w")]
    .filter((s) => s.style.visibility === "hidden").map((s) => s.closest("p")?.id));
  assert.ok(shotWords.length && shotWords.every((id) => id === "p1"), `the shots hit #p1 where it is: ${shotWords}`);
  await page.screenshot({ path: path.join(OUT, "3-shot.png") });

  // a grenade (right click) breaks more
  const img = await docPoint("#pic", 0.5, 0.2);
  await aimAt(img.x, img.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(1900);
  const afterBlast = await pieces();
  assert.ok(afterBlast > afterShots, `the grenade loosens more (${afterShots} → ${afterBlast})`);
  const holes = await page.evaluate(() => ({
    count: Number(document.documentElement.dataset.sfHoles),
    canvas: getComputedStyle(document.querySelector("canvas.sf-fire")).display,
  }));
  assert.ok(holes.count >= 1 && holes.canvas === "block", `the grenade burns a hole: ${JSON.stringify(holes)}`);
  await page.screenshot({ path: path.join(OUT, "4-grenade.png") });

  // run, jump, kick
  await page.keyboard.down("d");
  await page.waitForTimeout(400);
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  await page.keyboard.press("Space");
  await page.waitForTimeout(400);
  await page.keyboard.up("d");
  await page.keyboard.press("f");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "5-moves.png") });

  // clicking a link shoots instead of opening it
  const link = await page.evaluate(() => {
    const r = document.querySelector("#link").getBoundingClientRect();
    return { x: r.left + 3, y: r.top + r.height / 2 };
  });
  await page.mouse.click(link.x, link.y);
  await page.waitForTimeout(300);
  assert.equal(page.url(), url, "links don't open while playing");

  // running along a line of links, bold words and [18] references: no getting stuck on its ledges
  // (R puts the figure back at the top of the screen, in the middle: the page is scrolled so that's over #p5)
  for (const dir of ["d", "a"]) {
    await page.evaluate(() => {
      const r = document.querySelector("#p5").getBoundingClientRect();
      scrollTo({ top: r.top + scrollY - innerHeight * 0.25 - 25, behavior: "instant" });
    });
    await page.keyboard.press("r");
    await page.waitForTimeout(700);
    const [x0] = await figure();
    await page.keyboard.down(dir);
    await page.waitForTimeout(1500);
    await page.keyboard.up(dir);
    await page.waitForTimeout(100);
    const [x1] = await figure();
    const moved = dir === "d" ? x1 - x0 : x0 - x1;
    assert.ok(moved > 300, `runs along the line with "${dir}" (moved ${moved} px)`);
  }
  // text is a one-way platform: S drops through the line it stands on, W jumps up through the one above
  const [, yStand] = await figure();
  await page.keyboard.down("s");
  await page.waitForTimeout(120);
  await page.keyboard.up("s");
  await page.waitForTimeout(600);
  const [, yDropped] = await figure();
  assert.ok(yDropped > yStand + 10, `S drops through the line (${yStand} → ${yDropped})`);
  await page.keyboard.down("w");
  await page.waitForTimeout(500);
  await page.keyboard.up("w");
  await page.waitForTimeout(600);
  const [, yJumped] = await figure();
  assert.ok(yJumped < yDropped - 10, `W jumps up through text and lands on a line (${yDropped} → ${yJumped})`);

  // the grenade's fire has spread on by now
  const spots = Number(await page.evaluate(() => document.documentElement.dataset.sfHoles));
  assert.ok(spots > 1, `the fire spreads (${spots} burnt spots)`);

  const data = (key) => page.evaluate((key) => document.documentElement.dataset[key], key);
  const until = async (what, fn, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return;
      assert.ok(Date.now() < end, what);
      await page.waitForTimeout(150);
    }
  };

  // weapons: 1–5 pick them; the shotgun knocks words loose, the flamethrower sets the page alight
  await page.evaluate(() => {
    const r = document.querySelector("#p3").getBoundingClientRect();
    scrollTo({ top: r.top + scrollY - innerHeight * 0.25 - 25, behavior: "instant" });
  });
  await page.keyboard.press("r");
  await page.waitForTimeout(700);
  await page.keyboard.press("3");
  assert.equal(await data("sfWeapon"), "shotgun");
  const beforeShotgun = await pieces();
  const p4 = await docPoint("#p4", 0.5, 0.3);
  await aimAt(p4.x, p4.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.ok(await pieces() > beforeShotgun, "the shotgun knocks words loose");
  await page.keyboard.press("4");
  assert.equal(await data("sfWeapon"), "flamer");
  const beforeFlames = Number(await data("sfHoles"));
  const p3 = await docPoint("#p3", 0.3, 0.5);
  await aimAt(p3.x, p3.y);
  await page.mouse.down();
  await page.waitForTimeout(1200);
  await page.mouse.up();
  assert.ok(Number(await data("sfHoles")) > beforeFlames, "the flamethrower sets the page alight");

  // the word shooter: letters type, Enter fires a real word letter by letter, anything else is refused
  await page.keyboard.press("5");
  assert.equal(await data("sfWeapon"), "words");
  await until("the word list loads", async () => Number(await data("sfDict")) > 100000, 8000);
  const [xBefore] = await figure();
  await page.keyboard.type("zdawq");
  await page.keyboard.press("Enter");
  assert.equal(await data("sfWord"), "zdawq:no", "not a word: nothing flies");
  const [xAfter] = await figure();
  assert.ok(Math.abs(xAfter - xBefore) < 30, "typing a, d, w... doesn't move the figure");
  await page.waitForTimeout(900);
  const p2 = await docPoint("#p2", 0.5, 0.5);
  await aimAt(p2.x, p2.y);
  await page.keyboard.type("Cat");
  await page.keyboard.press("Enter");
  assert.equal(await data("sfWord"), "cat:ok");
  await until("the three letters land as loose pieces", async () =>
    (await page.locator(".sf-piece.sf-letter").count()) === 3, 4000);
  await page.screenshot({ path: path.join(OUT, "6-words.png") });
  await page.keyboard.press("2");
  assert.equal(await data("sfWeapon"), "rifle");

  // enemies: none at Off; + brings them in from the top, they can be shot down; − back to Off sends them away
  assert.equal(await data("sfEnemies"), "0", "no enemies at Off");
  await page.keyboard.press("Equal");
  await page.keyboard.press("Equal");
  assert.equal(await data("sfLevel"), "2");
  await until("enemies drop in", async () => Number(await data("sfEnemies")) >= 1, 6000);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, "7-enemies-in.png") });
  await until("an enemy is shot down", async () => {
    const foe = (await data("sfFoe")) || "";
    if (foe) {
      const [x, y] = foe.split(",").map(Number);
      await aimAt(x, y);
      await page.mouse.down();
      await page.waitForTimeout(500);
      await page.mouse.up();
    }
    return Number(await data("sfKills")) >= 1;
  }, 15000);
  await page.screenshot({ path: path.join(OUT, "8-enemy-down.png") });
  await page.keyboard.press("Minus");
  await page.keyboard.press("Minus");
  assert.equal(await data("sfLevel"), "0");
  assert.equal(await data("sfEnemies"), "0", "Off sends them away");
  await page.keyboard.press("1");

  // Esc stops, the page stays wrecked; Reset puts it back
  await page.keyboard.press("Escape");
  assert.equal(await state(), "idle");
  assert.ok(await page.locator(".sf-piece").count() > 0, "pieces stay after Stop");
  await bar("button[data-act='reset']");
  assert.equal(await page.locator(".sf-piece").count(), 0, "Reset removes the pieces");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.sfHoles), "0", "Reset mends the holes");
  assert.equal(await page.locator("canvas.sf-fire:visible").count(), 0, "Reset puts the fire out");
  assert.equal(await page.locator(".sf-burning").count(), 0, "Reset cleans the charred words");
  assert.equal(await page.locator("span.sf-w").count(), 0, "Reset joins the words again");
  assert.equal(await page.evaluate(() => document.querySelector("#p1").textContent), p1Text);
  const back = await page.evaluate(() => document.querySelector("#mw-content-text").innerHTML);
  assert.equal(back.replace(/ style=""/g, ""), original, "Reset gives the page back as it was");

  // and it starts again
  await bar("button[data-act='start']");
  await page.mouse.click(500, 150);
  assert.equal(await state(), "playing");
  await page.keyboard.press("Escape");

  const ours = errors.filter((e) => !/favicon/i.test(e));
  assert.deepEqual(ours, [], "no errors");
  console.log(`ok: stick fight e2e passed (screenshots in ${OUT})`);
} catch (e) {
  if (errors.length) console.error("page errors:", errors);
  await context.pages().at(-1)?.screenshot({ path: path.join(OUT, "failed.png") }).catch(() => {});
  throw e;
} finally {
  await context.close();
  if (!arg("out")) rmSync(path.join(tmp, "profile"), { recursive: true, force: true });
}

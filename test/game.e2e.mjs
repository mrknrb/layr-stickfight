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

  // start: the figure hangs at the cursor until a click drops it
  await page.locator(".sf-toolbar button[data-act='start']").click();
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

  // shoot at the first paragraph: its words come loose and their places stay empty
  const target = await page.evaluate(() => {
    const r = document.querySelector("#p1").getBoundingClientRect();
    return { x: r.left + r.width * 0.6, y: r.top + 10 };
  });
  await page.mouse.move(target.x, target.y);
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
  const img = await page.evaluate(() => {
    const r = document.querySelector("#pic").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(img.x, img.y, { button: "right" });
  await page.waitForTimeout(1900);
  const afterBlast = await pieces();
  assert.ok(afterBlast > afterShots, `the grenade loosens more (${afterShots} → ${afterBlast})`);
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
  const figure = async () =>
    (await page.evaluate(() => document.documentElement.dataset.sfFigure)).split(",").map(Number);
  for (const dir of ["d", "a"]) {
    const start = await page.evaluate((dir) => {
      const p = document.querySelector("#p5");
      p.scrollIntoView({ block: "center" });
      const r = p.getBoundingClientRect();
      return { x: dir === "d" ? r.left + 20 : r.left + 560, y: r.top - 30 };
    }, dir);
    await page.mouse.move(start.x, start.y);
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

  // Esc stops, the page stays wrecked; Reset puts it back
  await page.keyboard.press("Escape");
  assert.equal(await state(), "idle");
  assert.ok(await page.locator(".sf-piece").count() > 0, "pieces stay after Stop");
  await page.locator(".sf-toolbar button[data-act='reset']").click();
  assert.equal(await page.locator(".sf-piece").count(), 0, "Reset removes the pieces");
  assert.equal(await page.locator("span.sf-w").count(), 0, "Reset joins the words again");
  assert.equal(await page.evaluate(() => document.querySelector("#p1").textContent), p1Text);
  const back = await page.evaluate(() => document.querySelector("#mw-content-text").innerHTML);
  assert.equal(back.replace(/ style=""/g, ""), original, "Reset gives the page back as it was");

  // and it starts again
  await page.locator(".sf-toolbar button[data-act='start']").click();
  await page.mouse.click(500, 150);
  assert.equal(await state(), "playing");
  await page.keyboard.press("Escape");

  const ours = errors.filter((e) => !/favicon/i.test(e));
  assert.deepEqual(ours, [], "no errors");
  console.log(`ok: stick fight e2e passed (screenshots in ${OUT})`);
} finally {
  await context.close();
  if (!arg("out")) rmSync(path.join(tmp, "profile"), { recursive: true, force: true });
}

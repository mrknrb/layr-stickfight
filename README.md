# Stick fight

A toy for trying things: a stick figure loose on a Wikipedia page. Everything you can see on the page (lines of text,
words, images, buttons) is solid: the figure stands on it and bumps into it. What it shoots, kicks or blows up comes
loose, gets physics and flies apart, and leaves its hole in the page.

A plugin that is nothing but its Chrome extension (`"extension": "extension"` in `layr.json`): layr loads it into
its web panels on Windows; it also loads in Chrome as an unpacked extension. Only on `*.wikipedia.org` for now.

## Playing
- **▶ Stick fight** at the top of the page starts it; the figure hangs at your cursor, a click drops it there.
- **A / D** (or ← →) run, **W / Space** (or ↑) jump, again in the air (a flip), and off walls; **S** (or ↓)
  drops through the line the figure stands on, and falls faster.
- Text and tall images are platforms you land on from above: you run and jump through them from the side and from
  below (else the figure gets stuck under the line above). Small images and buttons are solid all round; the sides
  of tall images are walls to jump off. Loose pieces are kicked out of the way.
- The gun follows the mouse; **click** (hold) shoots, **right click** (or **G**) throws a grenade, **F** (or **E**)
  kicks and punches.
- **R** puts the figure back at the cursor, **Esc** (or ■ Stop) stops: the page stays as it is. **↺ Reset** puts
  the page back.
- While it runs, clicks don't open links: they shoot.

## How it works
- `extension/game.js` (the content script) collects the page's things as rectangles in page coordinates: each line
  of a text node (`Range.getClientRects`), and whole images, SVGs, buttons and inputs. Fixed and sticky parts (the
  header, banners) are left out. Those near the screen are static bodies of a [matter.js](https://brm.io/matter-js/)
  world (`extension/vendor/matter.min.js`, 0.20.0, MIT, unchanged).
- A hit line of text is split into a `<span class="sf-w">` per word (inline, so nothing moves) and the words near
  the hit come loose: each a copy in an overlay layer moved with a CSS transform every frame, the original hidden
  with `visibility: hidden` (its hole stays). At most 500 pieces; the oldest go.
- When the page's layout moves under it (a banner comes in, an image loads), it collects the things again within a
  second.
- The figure, bullets, grenades and effects are drawn on a canvas over the page; the figure is a physics body that
  doesn't turn (and never sleeps), its bones are posed by two-bone IK every frame. It collides in the physics only
  with small images, buttons and the page's edges; text and tall images are one-way platforms its controller lands
  it on (feet that cross a top from above stand on it; running along a line, a box up to 8 px higher too), and loose
  pieces it touches get kicked away.
- `extension/lib.js` holds the pure helpers (tested in Node); `background.js` only imports `layr-ext.js`, which
  passes the content script's problem reports (`layr-page.js`) on to layr.

## Tests
- `npm test`: the helpers.
- `node test/game.e2e.mjs [--out <dir>] [--headed]`: the extension in Chromium on a fake Wikipedia page (no
  network): start, drop, shoot, grenade, moves, running along a line of links and references both ways, S and W
  through text, layout changes, links, Stop, Reset. Playwright from `plugins/dev` or
  `~/pwtools`.

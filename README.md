# Stick fight

A toy for trying things: a stick figure loose on a Wikipedia page. Everything you can see on the page (lines of text,
words, images, buttons) is solid: the figure stands on it and bumps into it. What it shoots, kicks or blows up comes
loose, gets physics and flies apart, and leaves its hole in the page.

A plugin that is nothing but its Chrome extension (`"extension": "extension"` in `layr.json`): layr loads it into
its web panels on Windows; it also loads in Chrome as an unpacked extension. Only on `*.wikipedia.org` for now.

## Playing
- The bar is a small dot at the **bottom left**: hover it for **▶ Stick fight**, Stop, Reset, the weapons and the
  enemies' difficulty. While playing it shows one faint line: weapon, difficulty, health, enemies down.
- The figure hangs where the mouse is; a click drops it there. There's **no cursor** while playing: the mouse is locked
  to the page and its movement turns the aim (move it left, it aims left); the arm and what it holds show which way, there are no aim marks.
- **A / D** (or ← →) run, **W / Space** (or ↑) jump, again in the air (a flip), and off walls; **S** (or ↓)
  drops through the line the figure stands on, and falls faster.
- Text is a platform you land on from above: you run and jump through it from the side and from below (else the
  figure gets stuck under the line above). Images and buttons are solid all round. Loose pieces are kicked out of the
  way.
- **Big pictures** (both sides over about 50 px, one over 70) never move: shots, kicks and grenades don't knock them
  loose, and fire only darkens them; the burnt hole goes round them, they stay hanging over the circuit board with
  their shadow on it, and stay solid. Small ones (icons, flags) fly and burn away like words.
- Weapons, **1–6** or the mouse wheel: pistol, machine gun, shotgun, flamethrower (sets the page alight), the
  **word shooter**: type a word, **Enter** (or click) fires its letters one by one, only if it's a real English word
  (they land on the page as loose letters), and **Punch**: bare hands, hanging relaxed until a click jabs along
  the aim. While the word shooter is out, letters type, so the figure moves with the arrows and Space. **Click** (hold) fires, **right click** (or **G**) throws a grenade, **F** (or **E**) kicks and punches, **V** waves (with the word shooter: **Enter** on an empty word)
  with whatever is in its hand.
- Enemies: **+ / −** (or the bar) set the difficulty, Off (the start), Easy, Normal, Hard, Brutal, Insane. Above Off
  red stick figures drop in from the top of the screen, more and faster the harder it is; they run at the figure,
  jump and drop after it and punch, from Normal on some shoot. Bullets, letters, kicks, flames and grenades take
  them down. The figure has 100 health; when it's gone it falls apart and comes back at the top. The difficulty is
  kept for the next page.
- **R** puts the figure back at the top of the screen, **Esc** (or ■ Stop) stops: the page stays as it is.
  **↺ Reset** puts the page back.
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
- A grenade sets the page on fire (`extension/holes.js`): at each burning spot a soot mark spreads first, flames
  dance on it, then the paper burns through, and the fire spreads on to a few spots nearby (upwards more often),
  fewer at each hop, until it dies down. Behind the holes is the back of the monitor: a circuit board drawn as one SVG
  tile (rendered once to a bitmap) that repeats, lined up with the page. All of it is drawn on two canvases fixed over
  the screen, under the flying pieces: soot, rims and the board clipped to all holes at once (so touching holes are
  one hole with one rim), redrawn every few steps or on scroll; flames, smoke and ash at half resolution every step.
  The fire tells the game where it scorches (words there glow and go black, images go dark: class `sf-burning`) and
  where it burnt through (the things there are hidden, turn to ash and stop being solid). Stop leaves it burning;
  Reset puts it out and mends the page.
- Enemies are figure bodies like the player's (they only collide with solid things; text is one-way for them the
  same way), with a small mind each step: run at the player, jump when it is above or they are stuck, drop through
  text when it is below, punch when close, shoot now and then. The word list (`extension/words.txt`, ENABLE, public
  domain, 173k words) is fetched once the word shooter is picked.
- `extension/lib.js` holds the pure helpers (tested in Node); `background.js` only imports `layr-ext.js`, which
  passes the content script's problem reports (`layr-page.js`) on to layr.

## Tests
- `npm test`: the helpers.
- `node test/game.e2e.mjs [--out <dir>] [--headed]`: the extension in Chromium on a fake Wikipedia page (no
  network): the hidden bar, aiming by the mouse's movement, start, drop, shoot, grenade, moves, the weapons, the
  word shooter (a word and a non-word), enemies dropping in and shot down, running along a line of links and references both ways, S and W
  through text, layout changes, links, Stop, Reset. Playwright from `plugins/dev` or
  `~/pwtools`.

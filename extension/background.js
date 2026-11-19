// Stick fight: the extension's service worker. layr-ext.js connects it to layr as the plugin "stickfight", which
// passes on the content script's problem reports and logs (docs/ARCHITECTURE.md › The extension connection). The game
// itself is all in the content script (game.js); it needs nothing else from layr.
import "./layr-ext.js";

/* Live check for the music page, through the console's own interface.
 *
 * Loads the real shell (/static/music-page.js) and the installed skill's real
 * page script into jsdom, bridges window.fetch to the running console, and
 * drives the page the way a user does: open it, wait for the shelves to read
 * OpenDeck, open a playlist, type a search, repeat the search, work the
 * transport, write shuffle/repeat, line tracks up in the queue and drag one, and
 * (with NIX_MUSIC_LIVE_PLAY=1) tap a track through the speaker handoff. It
 * prints the measured time of every request so the page's latency claims can be
 * checked against the real server.
 *
 * Usage:
 *   NIX_CONSOLE_URL=http://127.0.0.1:49117 node scripts/check_music_page_live.mjs
 *   NIX_MUSIC_LIVE_PLAY=1 ... (also sends one real play + pause to the speaker)
 *   NIX_MUSIC_PAGE_SCRIPT=skills/opendeck/ui/music.js ... (drive this page file
 *     instead of the installed one, so a working tree can be checked against a
 *     running console before the package is published and reinstalled)
 *
 * jsdom is a test-only dependency; point NIX_JSDOM_ROOT at an install when it is
 * not in a local node_modules. Exit codes: 0 pass, 1 fail, 77 skipped - and a
 * jsdom that exists but cannot load says so on the skip line rather than
 * letting a broken install look like the same skip as an absent one.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const BASE = process.env.NIX_CONSOLE_URL || "http://127.0.0.1:49117";
const LIVE_PLAY = process.env.NIX_MUSIC_LIVE_PLAY === "1";

function loadJsdom() {
  const roots = [
    process.env.NIX_JSDOM_ROOT,
    path.join(process.cwd(), "node_modules"),
    "/tmp/node_modules",
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules"),
  ].filter(Boolean);
  let failure = "";
  for (const candidate of ["jsdom", ...roots.map((root) => path.join(root, "jsdom"))]) {
    try {
      return { jsdom: require(candidate), failure: "" };
    } catch (error) {
      // No jsdom at that location is the ordinary skip; a jsdom that is there
      // but cannot load (too new for this Node, a missing dependency) means the
      // page was never really checked, so the reason travels with the skip.
      if (error && error.code !== "MODULE_NOT_FOUND") {
        failure = String(error.message).split("\n")[0];
      }
    }
  }
  return { jsdom: null, failure };
}

const { jsdom, failure } = loadJsdom();
if (!jsdom) {
  process.stdout.write(`skip: jsdom is not installed (set NIX_JSDOM_ROOT)${failure ? `: ${failure}` : ""}\n`);
  process.exit(77);
}
const { JSDOM } = jsdom;

const timings = [];
const counts = new Map();
const requested = [];

async function timed(label, url, init) {
  const started = process.hrtime.bigint();
  const response = await fetch(url, init);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  timings.push({ label, ms: Math.round(ms) });
  return response;
}

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    process.stdout.write("ok   " + name + "\n");
  } else {
    failures.push(name);
    process.stdout.write("FAIL " + name + (detail ? "\n     " + detail : "") + "\n");
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shell = await (await fetch(BASE + "/static/music-page.js")).text();
const capabilities = await (await fetch(BASE + "/api/music")).json();
check("a music skill contributes the page", Boolean(capabilities.page && capabilities.provider),
  JSON.stringify(capabilities.page || null));
if (!capabilities.page) {
  process.stdout.write("no music page is installed on this console\n");
  process.exit(1);
}
// The installed page by default; a working tree file when NIX_MUSIC_PAGE_SCRIPT
// names one, which is how an unpublished change is checked against a live API.
const localPage = process.env.NIX_MUSIC_PAGE_SCRIPT || "";
const pageScript = localPage
  ? await readFile(localPage, "utf8")
  : await (await fetch(BASE + capabilities.page.script)).text();

const dom = new JSDOM(
  `<!doctype html><html><head></head><body>
     <button data-page="music" id="navMusicItem" hidden></button>
     <section class="view active" id="music">
       <div class="page-heading"><h1 id="musicHeading">Music</h1><p id="musicBlurb"></p>
         <div class="music-heading-actions"><span id="musicSourceState"></span><button id="musicRefresh"></button></div>
       </div>
       <div id="musicShell"></div>
     </section>
   </body></html>`,
  { runScripts: "outside-only", pretendToBeVisual: true, url: BASE }
);
const window = dom.window;

// Bridge the page's fetches to the running console and count them per route.
// Node's fetch only accepts a Node AbortSignal, so the jsdom signal the page
// passes is relayed onto a real one - which also proves the page's cancel
// actually reaches the server request.
window.fetch = async function bridge(input, init) {
  const raw = typeof input === "string" ? input : input.url;
  const url = new URL(raw, BASE);
  const options = Object.assign({}, init || {});
  delete options.signal;
  if (init && init.signal) {
    const relay = new AbortController();
    if (init.signal.aborted) relay.abort();
    else init.signal.addEventListener("abort", () => relay.abort());
    options.signal = relay.signal;
  }
  counts.set(url.pathname, (counts.get(url.pathname) || 0) + 1);
  requested.push(url.pathname + url.search);
  if (url.pathname === "/api/music/search" && searchStateOnTheWire === null) {
    const title = window.document.querySelector(".music-sheet-title");
    searchStateOnTheWire = title ? title.textContent : "";
  }
  return timed(url.pathname + url.search, url.toString(), options);
};

// jsdom does not execute external <script> tags: pre-register the declared page
// script so the shell's loader resolves, then evaluate the real file.
const marker = window.document.createElement("script");
marker.dataset.musicScript = capabilities.page.script;
marker.dataset.loaded = "1";
window.document.head.appendChild(marker);
window.eval(pageScript);

window.eval(shell);
await window.loadMusicPage();
await wait(600);

const root = window.document.getElementById("musicShell");
// While a search is on the wire the page has to say so, and the answer can land
// in milliseconds against a warm console, so the state is read at the moment the
// request leaves rather than by racing the reply afterwards.
let searchStateOnTheWire = null;
// The page is the PUCA Panel's design, so its parts are the panel's: shelves of
// sleeves, a results sheet, the hero card, and "Up next" beside them.
const tiles = () => [...root.querySelectorAll(".music-shelves .music-tile")];
const shelfTiles = (kind) => [...root.querySelectorAll(`.shelf[data-shelf="${kind}"] .music-tile`)];
const sheet = root.querySelector(".music-sheet");
const sheetRows = () => [...sheet.querySelectorAll(".music-resline")];
const sheetTitle = () => sheet.querySelector(".music-sheet-title").textContent;
// What the sheet is holding *now*: a closed sheet keeps the last list it drew,
// and a search replaces it only once its own answer lands, so a row count has to
// be read from an open sheet that is showing a search's result.
const searchRows = () => (!sheet.hidden && /Results for|Searching OpenDeck/.test(sheetTitle()) ? sheetRows() : []);
const shelfNote = (kind) => root.querySelector(`.shelf[data-shelf="${kind}"] .music-shelf-note`).textContent;
const opened = await fetch(BASE + "/api/music/now-playing").then((r) => r.json()).catch(() => null);
check("the page mounts into the console shell", Boolean(root.querySelector(".music-app")));
check("the page is the panel's shape", Boolean(root.querySelector(".music-app .top .searchbar"))
  && Boolean(root.querySelector(".music-app .grid .left .hero"))
  && Boolean(root.querySelector(".music-app .grid > .side.music-queue-card"))
  && Boolean(root.querySelector(".music-app .left > .shelves")),
  "a searchbar, a hero, shelves and Up next are the panel's arrangement");
check("the page finds the speaker and current track",
  Boolean(root.querySelector(".music-badge")) && root.querySelector(".music-now-title").textContent.length > 0,
  root.querySelector(".music-now-title") && root.querySelector(".music-now-title").textContent);

// The shelves are real OpenDeck round trips (seconds against a live speaker), and
// jsdom has no IntersectionObserver, so the page reads them at load: the check
// polls for sleeves rather than assuming a moment.
const shelfDeadline = Date.now() + 30000;
while (tiles().length === 0 && Date.now() < shelfDeadline) await wait(250);
check("the shelves paint real sleeves from OpenDeck", tiles().length > 0,
  `${tiles().length} sleeves; playlists="${shelfNote("playlists")}" likes="${shelfNote("likes")}" history="${shelfNote("history")}"`);
// The skill runtime refuses an argument format it does not declare instead of
// clamping it, so a limit above the declared maximum yields an empty library.
// Search is declared at 12 and the library reads at 500 (one shelf is a rail of
// 20; a playlist opened from it is read whole).
const limitsFor = (route) => requested
  .filter((entry) => entry.startsWith(route))
  .map((entry) => /[?&]limit=(\d+)/.exec(entry))
  .filter(Boolean)
  .map((match) => Number(match[1]));
const searchLimits = limitsFor("/api/music/search");
const libraryLimits = limitsFor("/api/music/library");
check("every search stays inside the declared limit",
  searchLimits.every((limit) => limit <= 12), JSON.stringify(searchLimits));
check("every library read stays inside the declared limit",
  libraryLimits.every((limit) => limit <= 500), JSON.stringify(libraryLimits));
// The shell states what the handoff control can do, from the same capabilities
// this run just read. A speaker skill that declares working controls has to read
// "Player control ready"; with no speaker skill installed the shell must say so
// in words rather than leave the heading looking like a broken player.
const sourceState = window.document.getElementById("musicSourceState").textContent;
const player = capabilities.player || {};
const playerCommands = player.commands || {};
const declaredCommands = Object.keys(playerCommands);
const healthyControls = Boolean(player.skill_id)
  && declaredCommands.some((name) => playerCommands[name])
  && declaredCommands.every((name) => playerCommands[name] || name === "play");
check("the header states the handoff play control's real state",
  healthyControls
    ? sourceState === "Player control ready"
    : player.skill_id
      ? sourceState.length > 0 && !/ready$/i.test(sourceState)
      : /no speaker skill/i.test(sourceState),
  `state="${sourceState}" player=${JSON.stringify(player)}`);
check("the shell mirrors the spoken snapshot", Boolean(opened && opened.ok), JSON.stringify(opened && opened.error));

// ── a playlist opens from its sleeve ──────────────────────────────────────
// The sleeves are the account's own OpenDeck playlists, and the sheet is where a
// list is read at the size of the glass. A live playlist read is seconds, so the
// rows are polled for; the sheet has to be titled with the playlist's own name.
const firstPlaylist = shelfTiles("playlists")[0];
if (firstPlaylist) {
  const playlistName = firstPlaylist.querySelector(".music-tile-name").textContent;
  firstPlaylist.click();
  const playlistDeadline = Date.now() + 30000;
  while (sheetRows().length === 0 && Date.now() < playlistDeadline) await wait(250);
  check("a playlist opens as a list of its own songs",
    sheetRows().length > 0 && sheetTitle().includes(playlistName.slice(0, 10)),
    `title="${sheetTitle()}" rows=${sheetRows().length}`);
  // Every listed song can be lined up without playing it: one add control per
  // row, as a sibling of the row's own button.
  check("a listed song offers its own queue control",
    sheetRows().every((row) => Boolean(row.querySelector(".music-queue-add"))),
    sheetRows().map((row) => row.querySelector(".music-queue-add") ? "add" : "none").join(" | "));
  const closeButton = root.querySelector(".music-sheet-close");
  check("the sheet can be closed", Boolean(closeButton));
  if (closeButton) closeButton.click();
  await wait(200);
} else {
  check("a playlist sleeve is listed on the Playlists shelf", false, shelfNote("playlists"));
}

// ── search: debounced, then cached on the repeat ──────────────────────────
const input = root.querySelector('input[type="search"]');
const searchesBefore = counts.get("/api/music/search") || 0;
for (const value of ["d", "da", "daf", "daft punk"]) {
  input.value = value;
  input.dispatchEvent(new window.Event("input"));
  await wait(60);
}
// A real OpenDeck search is a round trip out to the speaker's YouTube session
// (seconds, not milliseconds), so the page is polled for the results rather than
// assuming them inside a fixed wait; whether it announced the wait is read from
// the title at the moment the request left (see the fetch bridge).
let searchDeadline = Date.now() + 30000;
while (!(searchRows().length > 0 && /Results for/.test(sheetTitle())) && Date.now() < searchDeadline) await wait(100);
const searchesAfter = counts.get("/api/music/search") || 0;
check("typing searches once and renders real results",
  searchesAfter - searchesBefore === 1 && searchRows().length > 0,
  `searches=${searchesAfter - searchesBefore} rows=${searchRows().length} title="${sheetTitle()}"`);
check("the page says it is searching while the search is on the wire",
  /Searching OpenDeck/.test(searchStateOnTheWire || ""),
  `title on the wire="${searchStateOnTheWire}"`);
check("the results replace the searching state",
  /Results for “daft punk”/.test(sheetTitle()) && !sheet.querySelector(".music-skeleton"),
  sheetTitle());

const rowsBeforeRepeat = searchRows().length;
input.value = "daft punk";
input.dispatchEvent(new window.Event("input"));
await wait(800);
check("repeating the search is served from cache",
  (counts.get("/api/music/search") || 0) === searchesAfter && searchRows().length === rowsBeforeRepeat,
  `searches=${counts.get("/api/music/search")} rows=${rowsBeforeRepeat}->${searchRows().length}`);

// ── transport and volume, against the real shell ───────────────────────────
// One transport: the play/pause toggle, and the speaker's own mute control. The
// panel's control row is shuffle - previous - play/pause - next - repeat, and
// nothing else: a second pause repeated the toggle and a stop only ever meant
// "pause a moment".
const controls = [...root.querySelectorAll(".music-controls button")];
const playControls = controls.filter((button) => button.classList.contains("music-play"));
check("the transport is one play/pause control", playControls.length === 1,
  controls.map((button) => button.textContent).join(" | "));
check("no separate pause or stop control exists",
  !controls.some((button) => /^\s*(pause|stop)\s*$/i.test(button.textContent)),
  controls.map((button) => button.textContent).join(" | "));
const mute = root.querySelector(".music-mute");
check("the page offers the speaker's own mute control", Boolean(mute), mute ? mute.getAttribute("aria-label") : "no mute control");
const dial = root.querySelector('.music-volwheel[role="slider"]');
check("the volume control is the graphical slider, not a range input",
  Boolean(dial) && !root.querySelector('input[type="range"]'),
  dial ? `aria-valuenow=${dial.getAttribute("aria-valuenow")} value=${root.querySelector(".music-volnum").textContent}` : "no slider");
check("the slider shows the speaker's live level",
  Boolean(dial) && /^(\d+%|Muted)$/.test(root.querySelector(".music-volnum").textContent),
  root.querySelector(".music-volnum").textContent);

// ── shuffle, repeat, like and playlist ────────────────────────────────────
// Shuffle and repeat are real queue writes, so they are driven and read back.
const shuffleButton = root.querySelector('.music-extra[data-control="shuffle"]');
const repeatButton = root.querySelector('.music-extra[data-control="repeat"]');
const likeButton = root.querySelector('.music-extra[data-control="like"]');
const playlistButton = root.querySelector('.music-extra[data-control="playlist"]');
check("the page offers shuffle, repeat, like and playlist controls",
  Boolean(shuffleButton && repeatButton && likeButton && playlistButton),
  [shuffleButton, repeatButton, likeButton, playlistButton].map((button) => button && button.textContent).join(" | "));
const readQueueMode = () => fetch(BASE + "/api/music/queue").then((r) => r.json());
const modeBefore = await readQueueMode();
shuffleButton.click();
await wait(1500);
let modeAfter = await readQueueMode();
check("the shuffle button reaches the provider and is lit by its reply",
  modeAfter.shuffle === !modeBefore.shuffle
    && shuffleButton.getAttribute("aria-pressed") === String(modeAfter.shuffle),
  `before=${modeBefore.shuffle} after=${modeAfter.shuffle} pressed=${shuffleButton.getAttribute("aria-pressed")}`);
shuffleButton.click();
await wait(1500);
check("shuffle turns back off", (await readQueueMode()).shuffle === modeBefore.shuffle,
  JSON.stringify((await readQueueMode()).shuffle));

/* Repeat is a real queue write too, and this console may already be in any of
   the three modes, so the cycle is checked against the mode that was actually
   found rather than assuming a fresh "off" - the same way the shuffle presses
   above compare with `modeBefore`. The page's cycle is off -> all -> one -> off,
   and its labels are the panel's own. */
const REPEAT_NEXT = { off: "all", all: "one", one: "off" };
const repeatLabels = { off: "Repeat", all: "Repeat all", one: "Repeat one" };
const firstRepeat = repeatLabels[modeBefore.repeat] ? modeBefore.repeat : "off";
const expectedRepeat = [firstRepeat, REPEAT_NEXT[firstRepeat], REPEAT_NEXT[REPEAT_NEXT[firstRepeat]]];
const repeatSteps = [
  [`the repeat button moves the queue to repeat-${expectedRepeat[1]}`, expectedRepeat[1]],
  [`the next press moves it to repeat-${expectedRepeat[2]}`, expectedRepeat[2]],
  [`the third press cycles back to repeat-${expectedRepeat[0]}`, expectedRepeat[0]],
];
for (const [name, expected] of repeatSteps) {
  repeatButton.click();
  await wait(1500);
  const repeatMode = await readQueueMode();
  check(name,
    repeatMode.repeat === expected && repeatButton.textContent.includes(repeatLabels[expected]),
    `expected=${expected} repeat=${repeatMode.repeat} label=${repeatButton.textContent}`);
}

// Liking and adding to a playlist write to the user's own account, so the live
// check verifies the controls and the playlists they read and leaves the writes
// to tests/music_page_dom.mjs, which drives the same page against a fake.
check("the like button follows whether a track is playing",
  likeButton.disabled === !(opened && opened.track),
  `disabled=${likeButton.disabled} track=${opened && opened.track && opened.track.title}`);
playlistButton.click();
const pickerDeadline = Date.now() + 15000;
while (!root.querySelector(".music-picker-row") && Date.now() < pickerDeadline) await wait(250);
const pickerRows = [...root.querySelectorAll(".music-picker-row")];
check("the playlist picker lists the account's own playlists", pickerRows.length > 0,
  root.querySelector(".music-picker .music-empty")
    ? root.querySelector(".music-picker .music-empty").textContent
    : "no note");
check("Liked Music is not offered as a playlist to add to",
  !pickerRows.some((row) => /^Liked Music$/i.test(row.querySelector(".music-picker-name").textContent)),
  pickerRows.map((row) => row.querySelector(".music-picker-name").textContent).join(" | "));
playlistButton.click();
await wait(200);

// ── queue ─────────────────────────────────────────────────────────────────
// Queueing is its own action: the big control is the whole transport, and lining
// a track up must not interrupt what is playing.
const queueRows = () => [...root.querySelectorAll(".music-queue-row")];
const queueAdds = [...root.querySelectorAll(".music-shelves .music-queue-add")];
check("every sleeve offers a queue control",
  queueAdds.length > 0 && queueAdds.length === tiles().filter((tile) => !tile.classList.contains("music-playlist-tile")).length,
  `${queueAdds.length} add controls for ${tiles().length} sleeves`);
const playsBeforeQueue = counts.get("/api/music/play") || 0;
// Start from an empty queue: what is measured below is the card agreeing with the
// provider, not what an earlier run happened to leave behind.
await fetch(BASE + "/api/music/queue", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "clear" }),
});
// The card is the page's copy of a queue that lives in the provider, so the two
// are polled to agreement rather than compared once: the page re-reads the queue
// on its own timer, and a write's own reply paints it at least as fast.
const readQueue = () => fetch(BASE + "/api/music/queue").then((r) => r.json()).catch(() => null);
const settledQueue = async (expected, ms = 12000) => {
  const deadline = Date.now() + ms;
  let api = null;
  while (Date.now() < deadline) {
    api = await readQueue();
    if (api && api.count === expected && queueRows().length === expected) return api;
    await wait(250);
  }
  return api;
};
let queued = await settledQueue(0, 6000);
check("the queue starts and empties together", Boolean(queued) && queued.count === 0 && queueRows().length === 0,
  `card=${queueRows().length} api=${queued && queued.count}`);
// Line up two tracks from two different shelves: a shelf can list the same track
// twice, and one entry is not a queue to reorder. The add control rides a
// track's sleeve, so the name that was lined up is the sleeve that owns it -
// not the first sleeve on the page, which is a playlist and cannot be queued.
const addFor = (kind) => root.querySelector(`.shelf[data-shelf="${kind}"] .music-queue-add`);
const titleOf = (control) => control.closest(".music-tile-wrap").querySelector(".music-tile-name").textContent;
const firstAdd = addFor("likes") || addFor("history") || queueAdds[0];
const queuedTitle = titleOf(firstAdd);
firstAdd.click();
queued = await settledQueue(1);
check("a queued sleeve reaches the provider and the card together",
  Boolean(queued) && queued.count === 1 && queueRows().length === 1,
  JSON.stringify(queued && { count: queued.count, message: queued.message, error: queued.error }) + ` card=${queueRows().length}`);
check("the queue card names the queued track",
  queueRows().some((row) => row.textContent.includes(queuedTitle.slice(0, 12))), queuedTitle);
check("queueing never starts playback by itself", (counts.get("/api/music/play") || 0) === playsBeforeQueue,
  `play calls=${counts.get("/api/music/play")} before=${playsBeforeQueue}`);
// A second, different track: two entries are what a reorder needs, and the same
// track twice would make the drag assertion say nothing.
const secondAdd = [addFor("history"), addFor("likes")].find((control) => control && titleOf(control) !== queuedTitle);
if (secondAdd) {
  secondAdd.click();
  queued = await settledQueue(2);
  check("a second queued sleeve joins the first in both places",
    Boolean(queued) && queued.count === 2 && queueRows().length === 2,
    `card=${queueRows().length} api=${queued && queued.count}`);
}

// Reordering: the queue is rearranged by dragging a row, and the gesture is a
// pointer drag so a finger works. The drop has to land as one `move` on the
// console, so its own order is what is read back - not the page's copy of it.
if (!queued || queued.count < 2) {
  process.stdout.write(`     only ${queued && queued.count} track(s) came back from OpenDeck; the drag check needs two\n`);
} else {
  const dragRows = queueRows();
  const titlesBefore = queued.queue.map((item) => item.title);
  // Rows have no layout in jsdom, so the geometry the drag reads is supplied:
  // each row is 40px tall with the first starting at y=100.
  dragRows.forEach((row, index) => {
    row.getBoundingClientRect = () => ({
      top: 100 + index * 40, height: 40, bottom: 140 + index * 40, left: 0, right: 0, width: 0,
    });
  });
  // jsdom has no PointerEvent, so a bubbling Event carrying the pointer fields
  // the page reads stands in for one.
  const pointer = (type, clientY, target) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    event.clientY = clientY;
    event.clientX = 0;
    event.button = 0;
    event.pointerId = 1;
    target.dispatchEvent(event);
  };
  pointer("pointerdown", 110, dragRows[0]);
  pointer("pointermove", 170, dragRows[0]);
  const marked = dragRows[0].classList.contains("is-dragging")
    && Boolean(root.querySelector(".is-drop-before, .is-drop-after"));
  pointer("pointerup", 170, dragRows[0]);
  await wait(2000);
  const afterDrag = await fetch(BASE + "/api/music/queue").then((r) => r.json());
  const titlesAfter = afterDrag.queue.map((item) => item.title);
  check("a dragged row shows where it will land", marked);
  check("the console's queue itself is reordered by the drag",
    JSON.stringify(titlesAfter) === JSON.stringify([titlesBefore[1], titlesBefore[0], ...titlesBefore.slice(2)]),
    `${JSON.stringify(titlesBefore)} -> ${JSON.stringify(titlesAfter)}`);
  // Put the queue back in the order this run found it.
  await fetch(BASE + "/api/music/queue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "move", index: 1, to: 0 }),
  });
}

const settledBeforeRemove = await readQueue();
const beforeRemove = settledBeforeRemove ? settledBeforeRemove.count : 0;
const removeButton = queueRows()[0] && queueRows()[0].querySelector(".music-queue-remove");
check("a queued row can be removed", Boolean(removeButton));
if (removeButton && beforeRemove > 0) {
  removeButton.click();
  const afterRemove = await settledQueue(beforeRemove - 1);
  check("removing drops exactly one entry in both places",
    Boolean(afterRemove) && afterRemove.count === beforeRemove - 1 && queueRows().length === beforeRemove - 1,
    `${beforeRemove} -> ${afterRemove && afterRemove.count} (card=${queueRows().length})`);
  queued = afterRemove || queued;
}

const clearButton = [...root.querySelectorAll(".music-queue-actions button")]
  .find((button) => button.textContent === "Clear");
check("the queue offers a clear control", Boolean(clearButton));
if (clearButton) {
  clearButton.click();
  queued = await settledQueue(0);
  const note = root.querySelector(".music-queue-note");
  check("clearing empties the queue", Boolean(queued) && queued.count === 0 && queueRows().length === 0,
    `api=${queued && queued.count} rows=${queueRows().length}`);
  check("the empty queue says so", /queue is empty/i.test(note.textContent), note.textContent);
}

if (LIVE_PLAY && tiles().length) {
  // The page re-renders its shelves, so the sleeve is looked up again: a stale
  // reference would be detached and its classes would prove nothing.
  const first = tiles()[0];
  const label = first.querySelector(".music-tile-name").textContent;
  const note = root.querySelector(".music-state");
  const notice = root.querySelector(".music-error");
  first.click();
  check("the tapped sleeve answers before the speaker does", first.classList.contains("is-pending"),
    "is-pending was not set synchronously");

  // The provider can take many seconds to resolve a stream, so the interface has
  // to show progress; and a refused stream has to end as a stated failure rather
  // than a sleeve that stays pending forever.
  const startedAt = Date.now();
  let countedOut = false;
  let settled = false;
  while (Date.now() - startedAt < 30000) {
    await wait(300);
    if (!countedOut && /Resolving .* with OpenDeck… [1-9]\d*s/.test(note.textContent)) countedOut = true;
    if (!first.classList.contains("is-pending")) { settled = true; break; }
  }
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  check("the wait counts itself out instead of looking frozen", countedOut, note.textContent);
  check("the tap settles (playing or an explicit failure), never a stuck sleeve", settled,
    `still pending after ${elapsed}s; tileConnected=${first.isConnected} class="${first.className}" ` +
    `sleeves=${tiles().length} note="${note.textContent}" notice="${notice.textContent}" ` +
    `playCalls=${counts.get("/api/music/play")}`);

  const snapshot = await fetch(BASE + "/api/music/now-playing").then((r) => r.json());
  const reported = notice.textContent.trim();
  const refused = reported.length > 0;
  const speakerPlaying = Boolean(snapshot.player && snapshot.player.state === "playing");
  // Two honest outcomes: the speaker is playing the tapped track, or the page
  // says why it is not. Silence, or a sleeve left pending, is the failure.
  check("the outcome is reported to the user", speakerPlaying || refused,
    `speaker=${snapshot.player && snapshot.player.state} notice="${reported.slice(0, 120)}"`);
  if (speakerPlaying && !refused) {
    check("the speaker switched to the tapped track", valuesMatch(snapshot, label),
      `session=${snapshot.track && snapshot.track.title} tapped=${label}`);
    check("the tapped sleeve is marked as playing",
      tiles().some((tile) => tile.classList.contains("is-playing")), "no sleeve carried is-playing");
    check("the hero shows the playing track",
      root.querySelector(".music-now-title").textContent.length > 0
        && root.querySelector(".music-app").classList.contains("playing"),
      root.querySelector(".music-now-title").textContent);
  } else {
    process.stdout.write(`     the provider refused this stream after ${elapsed}s: ${reported.slice(0, 200)}\n`);
    check("a refused stream still marks the track it recorded",
      valuesMatch(snapshot, label), `session=${snapshot.track && snapshot.track.title} tapped=${label}`);
  }
  // The queue's play-next path hands a queued track over like any other play,
  // so it has to end the same two honest ways: playing, or a stated refusal.
  const queueCallsBefore = counts.get("/api/music/queue") || 0;
  const addForNext = root.querySelector(".music-shelves .music-queue-add");
  if (addForNext) {
    addForNext.click();
    await wait(2000);
    const nextButton = [...root.querySelectorAll(".music-queue-actions button")]
      .find((button) => button.textContent.includes("Play next"));
    check("the queue has a play-next control", Boolean(nextButton));
    if (nextButton) {
      nextButton.click();
      const nextStarted = Date.now();
      let report = null;
      while (Date.now() - nextStarted < 30000) {
        await wait(500);
        report = await fetch(BASE + "/api/music/queue").then((r) => r.json());
        if (report.index >= 0) break;
      }
      check("play next reached the provider", (counts.get("/api/music/queue") || 0) > queueCallsBefore,
        `queue calls=${counts.get("/api/music/queue")}`);
      const afterNext = await fetch(BASE + "/api/music/now-playing").then((r) => r.json());
      const playedNext = Boolean(report && report.index >= 0 && afterNext.player && afterNext.player.state === "playing");
      const refusedNext = (notice.textContent + root.querySelector(".music-error").textContent).trim().length > 0;
      check("a queued track either plays or is reported as refused", playedNext || refusedNext,
        `index=${report && report.index} speaker=${afterNext.player && afterNext.player.state} ` +
        `note="${notice.textContent.slice(0, 80)}" notice="${root.querySelector(".music-error").textContent.slice(0, 80)}"`);
      if (playedNext) {
        // The page marks the entry from its own play-next response, which can
        // land a moment after the API poll above, so it is polled too.
        const markDeadline = Date.now() + 4000;
        const marked = () => root.querySelector(".music-queue-row.is-current") !== null;
        while (!marked() && Date.now() < markDeadline) await wait(200);
        check("the queue marks the entry that is playing", marked(),
          `rows=${queueRows().map((row) => row.className).join(", ")}`);
      }
      const clearAfter = [...root.querySelectorAll(".music-queue-actions button")]
        .find((button) => button.textContent === "Clear");
      if (clearAfter) {
        clearAfter.click();
        await wait(1500);
      }
    }
  }

  // Leave the speaker as it was found.
  await fetch(BASE + "/api/music/control", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "pause" }),
  });
  process.stdout.write("     (paused the speaker again after the check)\n");
}

function valuesMatch(snapshot, label) {
  const current = snapshot && snapshot.track ? String(snapshot.track.title || "") : "";
  return Boolean(current) && (current === label || label.includes(current) || current.includes(label));
}

process.stdout.write("\nmeasured request times\n");
["/api/music/now-playing", "/api/music/search", "/api/music/library", "/api/music/play", "/api/music/queue"].forEach((route) => {
  const hits = timings.filter((entry) => entry.label.startsWith(route));
  if (!hits.length) return;
  const times = hits.map((entry) => entry.ms);
  process.stdout.write(
    `  ${route.padEnd(26)} calls=${String(hits.length).padStart(2)} min=${String(Math.min(...times)).padStart(4)}ms ` +
    `max=${String(Math.max(...times)).padStart(5)}ms\n`
  );
});

process.stdout.write(failures.length ? `\n${failures.length} music page check(s) failed\n` : "\nall live music page checks passed\n");
process.exit(failures.length ? 1 : 0);

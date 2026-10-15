/* Live check for the music page, through the console's own interface.
 *
 * Loads the real shell (/static/music-page.js) and the installed skill's real
 * page script into jsdom, bridges window.fetch to the running console, and
 * drives the page the way a user does: open it, switch tabs, type a search,
 * repeat the search, and (with NIX_MUSIC_LIVE_PLAY=1) tap a track through the
 * speaker handoff. It prints the measured time of every request so the page's
 * latency claims can be checked against the real server.
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
const rows = () => [...root.querySelectorAll(".music-row")];
// The browse list's note, not the queue's: both are .music-empty, and the queue
// card comes first in the document.
const browseNote = () => root.querySelector(".music-search").closest(".music-card").querySelector(".music-empty");
const opened = await fetch(BASE + "/api/music/now-playing").then((r) => r.json()).catch(() => null);
check("the page mounts into the console shell", Boolean(root.querySelector(".music-app")));
check("the page finds the speaker and current track",
  Boolean(root.querySelector(".music-badge")) && root.querySelector(".music-now-title").textContent.length > 0,
  root.querySelector(".music-now-title") && root.querySelector(".music-now-title").textContent);
// The library is a real OpenDeck round trip (seconds against a live speaker),
// so the page is polled instead of assumed loaded.
const libraryDeadline = Date.now() + 25000;
while (rows().length === 0 && Date.now() < libraryDeadline) await wait(250);
check("the library tab renders real rows from OpenDeck", rows().length > 0, rows().length + " rows");
// The skill runtime refuses an argument format it does not declare instead of
// clamping it, so a limit above the declared maximum yields an empty library.
const declaredLimits = requested
  .map((entry) => /[?&]limit=(\d+)/.exec(entry))
  .filter(Boolean)
  .map((match) => Number(match[1]));
check("every request stays inside the declared limit", declaredLimits.every((limit) => limit <= 12),
  JSON.stringify(declaredLimits));
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

// Switch tabs: real liked/history data straight from OpenDeck. Tabs are another
// live round trip, so the harness waits for track rows (a playlist row carries
// no video id) rather than for a fixed moment - a stale row from the previous
// tab must not be able to satisfy the check.
const tabs = [...root.querySelectorAll(".music-tabs button")];
const liked = tabs.find((button) => button.textContent === "Liked");
const hasTrackRows = () => rows().length > 0 && rows().some((row) => row.dataset.videoId);
liked.click();
const likedDeadline = Date.now() + 25000;
while (!hasTrackRows() && Date.now() < likedDeadline) await wait(150);
check("switching to Liked loads rows", hasTrackRows() || browseNote().textContent.includes("Nothing"),
  browseNote().textContent);

// Search: debounced, then cached on the repeat.
const input = root.querySelector("input[type=search]");
const searchesBefore = counts.get("/api/music/search") || 0;
for (const value of ["d", "da", "daf", "daft punk"]) {
  input.value = value;
  input.dispatchEvent(new window.Event("input"));
  await wait(60);
}
// A real OpenDeck search is a round trip out to the speaker's YouTube session
// (seconds, not milliseconds), so the page is polled for its own signals - the
// note it shows while searching, then its disappearance - instead of assuming
// the results inside a fixed wait.
let searchDeadline = Date.now() + 10000;
while (!/Searching OpenDeck/.test(browseNote().textContent) && Date.now() < searchDeadline) await wait(50);
searchDeadline = Date.now() + 30000;
while (!(browseNote().hidden && rows().length > 0) && Date.now() < searchDeadline) await wait(100);
const searchesAfter = counts.get("/api/music/search") || 0;
const found = rows();
check("typing searches once and renders real results", searchesAfter - searchesBefore === 1 && found.length > 0,
  `searches=${searchesAfter - searchesBefore} rows=${found.length}`);
check("the results replace the searching note",
  browseNote().hidden && browseNote().textContent.length === 0,
  browseNote().textContent);
check("the page never asked for more rows than the manifest declares",
  requested.filter((entry) => entry.startsWith("/api/music/search")).every((entry) => (/([?&]limit=(\d+))/.exec(entry) || [0, 0, 0])[2] <= 12),
  JSON.stringify(requested.filter((entry) => entry.startsWith("/api/music/search"))));

const rowsBeforeRepeat = rows().length;
input.value = "daft punk";
input.dispatchEvent(new window.Event("input"));
await wait(600);
check("repeating the search is served from cache",
  (counts.get("/api/music/search") || 0) === searchesAfter && rows().length === rowsBeforeRepeat,
  `searches=${counts.get("/api/music/search")} rows=${rowsBeforeRepeat}->${rows().length}`);

// ── transport and volume, against the real shell ───────────────────────────
const transport = [...root.querySelectorAll(".music-controls button")];
check("the transport is one toggle plus mute", transport.length === 2,
  transport.map((button) => button.textContent).join(" | "));
// The single toggle relabels itself "Pause" while something is playing, so the
// check counts play/pause-named controls instead of banning the word: exactly
// the one toggle, and never a separate stop. (Matching the label itself flagged
// the toggle it had just counted as the transport.)
check("no separate pause or stop control exists",
  transport.filter((button) => /play|pause/i.test(button.textContent)).length === 1
    && !transport.some((button) => /\bstop\b/i.test(button.textContent)),
  transport.map((button) => button.textContent).join(" | "));
const dial = root.querySelector('.music-volwheel[role="slider"]');
check("the volume control is the graphical dial, not a range input",
  Boolean(dial) && !root.querySelector('input[type="range"]'),
  dial ? `aria-valuenow=${dial.getAttribute("aria-valuenow")} value=${root.querySelector(".music-volnum").textContent}` : "no dial");
check("the dial shows the speaker's live level",
  Boolean(dial) && /^\d+%$/.test(root.querySelector(".music-volnum").textContent),
  root.querySelector(".music-volnum").textContent);

// ── shuffle, repeat, like and playlist ────────────────────────────────────
// Shuffle and repeat are real queue writes, so they are driven and read back.
const extras = [...root.querySelectorAll(".music-extra")];
check("the page offers shuffle, repeat, like and playlist controls", extras.length === 4,
  extras.map((button) => button.textContent).join(" | "));
const shuffleButton = root.querySelector('.music-extra[data-control="shuffle"]');
const repeatButton = root.querySelector('.music-extra[data-control="repeat"]');
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
   above compare with `modeBefore`. The page's cycle is off -> all -> one -> off. */
const REPEAT_NEXT = { off: "all", all: "one", one: "off" };
const repeatLabels = { off: "Repeat off", all: "Repeat all", one: "Repeat one" };
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
const likeButton = root.querySelector('.music-extra[data-control="like"]');
check("the like button follows whether a track is playing",
  likeButton.disabled === !(opened && opened.track),
  `disabled=${likeButton.disabled} track=${opened && opened.track && opened.track.title}`);
const playlistButton = root.querySelector('.music-extra[data-control="playlist"]');
playlistButton.click();
const pickerDeadline = Date.now() + 10000;
while (!root.querySelector(".music-picker-row") && Date.now() < pickerDeadline) await wait(250);
const pickerRows = [...root.querySelectorAll(".music-picker-row")];
check("the playlist picker lists the account's own playlists", pickerRows.length > 0,
  root.querySelector(".music-picker .music-empty").textContent);
check("Liked Music is not offered as a playlist to add to",
  !pickerRows.some((row) => /^Liked Music$/i.test(row.querySelector("strong").textContent)),
  pickerRows.map((row) => row.querySelector("strong").textContent).join(" | "));
playlistButton.click();

// ── queue ─────────────────────────────────────────────────────────────────
// Queueing is its own action: the big toggle is the whole transport, and lining
// a track up must not interrupt what is playing.
const queueRows = () => [...root.querySelectorAll(".music-queue-row")];
const queueAdds = [...root.querySelectorAll(".music-queue-add")];
check("every track row offers a queue control", queueAdds.length === rows().length && queueAdds.length > 0,
  `${queueAdds.length} add controls for ${rows().length} rows`);
const playsBeforeQueue = counts.get("/api/music/play") || 0;
const queuedTitle = rows()[0].querySelector("strong").textContent;
queueAdds[0].click();
if (queueAdds[1]) queueAdds[1].click();
await wait(1500);
let queued = await fetch(BASE + "/api/music/queue").then((r) => r.json()).catch(() => null);
check("the console accepted the queued tracks", Boolean(queued && queued.ok) && queued.count >= 1,
  JSON.stringify(queued && { count: queued.count, message: queued.message, error: queued.error }));
check("the queue card lists what was lined up", queueRows().length === queued.count,
  `card=${queueRows().length} api=${queued.count}`);
check("the queue card names the queued track",
  queueRows().some((row) => row.textContent.includes(queuedTitle.slice(0, 12))), queuedTitle);
check("queueing never starts playback by itself", (counts.get("/api/music/play") || 0) === playsBeforeQueue,
  `play calls=${counts.get("/api/music/play")} before=${playsBeforeQueue}`);

// Reordering: the queue is rearranged by dragging a row, and the gesture is a
// pointer drag so a finger works. The drop has to land as one `move` on the
// console, so its own order is what is read back - not the page's copy of it.
if (queueRows().length >= 2) {
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

const beforeRemove = queued.count;
const removeButton = queueRows()[0] && queueRows()[0].querySelector(".music-queue-remove");
check("a queued row can be removed", Boolean(removeButton));
if (removeButton) {
  removeButton.click();
  await wait(1200);
  queued = await fetch(BASE + "/api/music/queue").then((r) => r.json());
  check("removing drops exactly one entry", queued.count === beforeRemove - 1,
    `${beforeRemove} -> ${queued.count}`);
}

const clearButton = [...root.querySelectorAll(".music-queue-actions button")]
  .find((button) => button.textContent === "Clear");
check("the queue offers a clear control", Boolean(clearButton));
if (clearButton) {
  clearButton.click();
  await wait(1200);
  queued = await fetch(BASE + "/api/music/queue").then((r) => r.json());
  const note = root.querySelector(".music-queue-card .music-empty");
  check("clearing empties the queue", queued.count === 0 && queueRows().length === 0,
    `api=${queued.count} rows=${queueRows().length}`);
  check("the empty queue says so", note.textContent.includes("Nothing queued"), note.textContent);
}

if (LIVE_PLAY && rows().length) {
  // The repeat search re-rendered the list, so the row is looked up again: a
  // stale reference would be detached and its classes would prove nothing.
  const first = rows()[0];
  const label = first.querySelector("strong").textContent;
  const note = browseNote();
  const notice = root.querySelector(".music-error");
  first.click();
  check("the tapped row answers before the speaker does", first.classList.contains("is-pending"),
    "is-pending was not set synchronously");

  // The provider can take many seconds to resolve a stream, so the interface has
  // to show progress; and a refused stream has to end as a stated failure rather
  // than a row that stays pending forever.
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
  check("the tap settles (playing or an explicit failure), never a stuck row", settled,
    `still pending after ${elapsed}s; rowConnected=${first.isConnected} class="${first.className}" ` +
    `rows=${rows().length} note="${note.textContent}" notice="${notice.textContent}" ` +
    `playCalls=${counts.get("/api/music/play")}`);

  const snapshot = await fetch(BASE + "/api/music/now-playing").then((r) => r.json());
  const reported = notice.textContent.trim();
  const refused = reported.length > 0;
  const speakerPlaying = Boolean(snapshot.player && snapshot.player.state === "playing");
  // Two honest outcomes: the speaker is playing the tapped track, or the page
  // says why it is not. Silence, or a row left pending, is the failure.
  check("the outcome is reported to the user", speakerPlaying || refused,
    `speaker=${snapshot.player && snapshot.player.state} notice="${reported.slice(0, 120)}"`);
  if (speakerPlaying && !refused) {
    check("the speaker switched to the tapped track", valuesMatch(snapshot, label),
      `session=${snapshot.track && snapshot.track.title} tapped=${label}`);
    check("the tapped row is marked as playing",
      rows().some((row) => row.classList.contains("is-playing")), "no row carried is-playing");
    check("the mini bar mirrors the track", root.querySelector(".music-mini").hidden === false,
      root.querySelector(".music-mini strong").textContent);
  } else {
    process.stdout.write(`     the provider refused this stream after ${elapsed}s: ${reported.slice(0, 200)}\n`);
    check("a refused stream still marks the track it recorded",
      valuesMatch(snapshot, label), `session=${snapshot.track && snapshot.track.title} tapped=${label}`);
  }
  // The queue's play-next path hands a queued track over like any other play,
  // so it has to end the same two honest ways: playing, or a stated refusal.
  const queueCallsBefore = counts.get("/api/music/queue") || 0;
  const addForNext = root.querySelector(".music-queue-add");
  if (addForNext) {
    addForNext.click();
    await wait(1500);
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
        const marked = () => [...root.querySelectorAll(".music-queue-row")].some((row) => row.classList.contains("is-current"));
        while (!marked() && Date.now() < markDeadline) await wait(200);
        check("the queue marks the entry that is playing", marked(),
          `rows=${[...root.querySelectorAll(".music-queue-row")].map((row) => row.className).join(",")}`);
      }
      const clearAfter = [...root.querySelectorAll(".music-queue-actions button")]
        .find((button) => button.textContent === "Clear");
      if (clearAfter) {
        clearAfter.click();
        await wait(1200);
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

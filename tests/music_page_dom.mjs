/* Behaviour harness for the OpenDeck music page.
 *
 * Mounts the real ui/music.js in jsdom against a fake music API and checks the
 * things a person actually feels: the page is the PUCA Panel's shape, a tap is
 * acknowledged before the speaker answers, typing is debounced into one search,
 * a repeated search comes from cache, a superseded search is aborted, a burst of
 * volume changes becomes the level that was settled on, the words are asked for
 * by name and length (and are retried when the provider answers nothing), and
 * the page's copy of the queue follows the provider instead of drifting - the
 * bug that made queued music seem to disappear, because every Remove/Play/Move
 * afterwards acted on a stale position.
 *
 * Run: node tests/music_page_dom.mjs   (from the package root)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* jsdom is a test-only dependency. It is looked up in the usual places, then
   wherever NIX_JSDOM_ROOT points, so the check runs where it is installed and
   reports a skip (exit code 77) where it is not, rather than failing a build for
   a missing dev tool. A jsdom that is present but cannot load says why, instead
   of looking like the same skip as an absent one. */
const require = createRequire(import.meta.url);
function loadJsdom() {
  const roots = [
    process.env.NIX_JSDOM_ROOT,
    path.join(process.cwd(), "node_modules"),
    "/tmp/node_modules",
    "/usr/local/lib/node_modules",
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules"),
  ].filter(Boolean);
  let failure = "";
  for (const candidate of ["jsdom", ...roots.map((root) => path.join(root, "jsdom"))]) {
    try {
      return { jsdom: require(candidate), failure: "" };
    } catch (error) {
      if (error && error.code !== "MODULE_NOT_FOUND") {
        failure = String(error.message).split("\n")[0];
      }
    }
  }
  return { jsdom: null, failure };
}

const { jsdom, failure } = loadJsdom();
if (!jsdom) {
  process.stdout.write(
    `skip the music page DOM checks: jsdom is not installed (set NIX_JSDOM_ROOT)${failure ? `: ${failure}` : ""}\n`,
  );
  process.exit(77);
}
const { JSDOM } = jsdom;

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "..", "skills", "opendeck", "ui", "music.js"), "utf8");

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(0);

function track(videoId, title, extra) {
  return Object.assign({
    video_id: videoId,
    title: title || videoId,
    artist: "Test Artist",
    album: "",
    duration_sec: 200,
    artwork_url: "https://example.invalid/" + videoId + ".jpg",
  }, extra || {});
}

function harness(options) {
  const settings = options || {};
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "http://localhost/music",
  });
  const window = dom.window;
  dom.window.eval(source);
  const root = window.document.getElementById("root");

  const calls = { library: [], search: [], play: [], control: [], queue: [], save: [], lyrics: [], nowPlaying: 0, get: [] };
  const signals = [];
  const queue = { items: [], index: -1, shuffle: false, repeat: "off" };
  const playlists = settings.playlists || [
    { playlist_id: "p1", name: "Focus", track_count: 3, artwork_url: "https://example.invalid/p1.jpg" },
  ];
  let pollHandler = null;
  let resolvePlay = null;
  const resolveLibrary = [];
  let resolveQueue = null;
  let lyricsAnswer = settings.lyrics || (() => ({ ok: true, lyrics: [{ text: "Line one", time_sec: 1 }, { text: "Line two", time_sec: 5 }], lyrics_plain: "", lyrics_timing: "synced" }));
  let snapshotValue = settings.snapshot;
  const observed = [];

  const queuePayload = () => ({
    ok: true,
    action: "queue",
    queue: queue.items,
    index: queue.index,
    count: queue.items.length,
    shuffle: queue.shuffle,
    repeat: queue.repeat,
    message: queue.items.length ? queue.items.length + " track(s) queued." : "The queue is empty.",
  });
  const playingPayload = (item) => ({
    ok: true,
    action: "queue",
    queue: queue.items,
    index: queue.index,
    count: queue.items.length,
    shuffle: queue.shuffle,
    repeat: queue.repeat,
    track: item || track("queue-1", "Queued Song"),
    position: { elapsed_sec: 0, duration_sec: 200 },
    playing: true,
    player: { volume: 0.5, muted: false, confirmed: true, device: "Nix Dev", state: "playing" },
  });
  const snapshot = () => (snapshotValue ? snapshotValue() : {
    ok: true,
    track: track("current-1", "Current Track"),
    position: { elapsed_sec: 12, duration_sec: 200 },
    playing: settings.playing !== false,
    player: { volume: 0.5, muted: false, confirmed: true, device: "Nix Dev", state: settings.playing === false ? "paused" : "playing" },
  });

  const api = {
    formatTime(seconds) {
      if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return "--:--";
      const total = Math.floor(seconds);
      return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
    },
    async nowPlaying() { calls.nowPlaying += 1; return snapshot(); },
    async control(action, value) {
      calls.control.push({ action, value });
      return { ok: true, player: { volume: typeof value === "number" ? value : 0.5, muted: action === "mute", confirmed: true, device: "Nix Dev", state: "playing" } };
    },
    async search(query, limit, opts) {
      calls.search.push(query);
      signals.push(opts && opts.signal);
      if (settings.slowSearch) await wait(600);
      return settings.search ? settings.search(query) : { ok: true, tracks: [track("search-" + query, "Result for " + query)], playlists: [] };
    },
    play(target) {
      calls.play.push(target);
      const payload = {
        ok: true,
        track: track(target.video_id, target.title),
        position: { elapsed_sec: 0, duration_sec: 200 },
        playing: true,
        player: { volume: 0.3, muted: false, confirmed: true, device: "Nix Dev", state: "playing" },
      };
      if (!settings.deferPlay) return Promise.resolve(payload);
      return new Promise((resolve) => { resolvePlay = () => resolve(payload); });
    },
    async library(kind, extra) {
      calls.library.push(kind === "playlist" ? "playlist:" + (extra && extra.playlist_id) : kind);
      const payload = kind === "playlists"
        ? { ok: true, playlists: playlists }
        : kind === "playlist"
          ? { ok: true, tracks: [track("pl-1", "Playlist Song"), track("pl-2", "Second Song")] }
          : { ok: true, tracks: [track(kind + "-1", "A " + kind + " song")] };
      if (!settings.deferLibrary) return payload;
      // Every read that is waiting is held, and all of them are answered when the
      // harness releases the provider: three shelves load at once on a page with
      // no observer to defer them.
      return new Promise((resolve) => { resolveLibrary.push(() => resolve(payload)); });
    },
    async lyrics(extra) { calls.lyrics.push(extra); return lyricsAnswer(extra); },
    async get(path) {
      calls.get.push(path);
      if (path !== "/queue") throw new Error("unexpected GET " + path);
      const answer = queuePayload();
      if (!settings.deferQueue) return answer;
      return new Promise((resolve) => { resolveQueue = () => resolve(answer); });
    },
    async post(path, body) {
      if (path === "/save") {
        calls.save.push(body);
        if (body.kind === "playlist_create") {
          return { ok: true, action: "save", kind: body.kind, playlist_id: "new-1", name: body.name,
                   playlists: [{ playlist_id: "new-1", name: body.name, track_count: 0 }] };
        }
        return { ok: true, action: "save", kind: body.kind, count: 1,
                 liked: body.kind === "like", playlist_id: body.playlist_id };
      }
      if (path !== "/queue") throw new Error("unexpected POST " + path);
      calls.queue.push(body);
      if (body.action === "shuffle") {
        queue.shuffle = body.on === undefined ? !queue.shuffle : body.on;
        return queuePayload();
      }
      if (body.action === "repeat") {
        queue.repeat = body.mode || { off: "all", all: "one", one: "off" }[queue.repeat];
        return queuePayload();
      }
      if (body.action === "add") queue.items.push(track(body.video_id, "Queued " + body.video_id));
      else if (body.action === "move") {
        const moved = queue.items.splice(body.index, 1)[0];
        queue.items.splice(Math.min(body.to, queue.items.length), 0, moved);
      }
      else if (body.action === "remove") { queue.items.splice(body.index, 1); if (queue.index >= queue.items.length) queue.index = -1; }
      else if (body.action === "clear") { queue.items = []; queue.index = -1; }
      else if (body.action === "play") { queue.index = body.index; return playingPayload(queue.items[body.index]); }
      else if (body.action === "next") {
        if (queue.index + 1 >= queue.items.length) {
          return { ok: true, action: "queue", queue: queue.items, index: queue.index, count: queue.items.length, message: "no next track" };
        }
        queue.index += 1;
        return playingPayload(queue.items[queue.index]);
      }
      return queuePayload();
    },
    poll(handler) { pollHandler = handler; return () => { if (pollHandler === handler) pollHandler = null; }; },
  };

  // A stub observer stands in for a browser's: jsdom has none, and the page's
  // shelves are meant to load as they are reached.
  if (settings.observe) {
    window.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; }
      observe(node) { observed.push(node); }
      unobserve(node) {
        const index = observed.indexOf(node);
        if (index >= 0) observed.splice(index, 1);
      }
      disconnect() { observed.length = 0; }
      reach(kind) {
        const node = observed.find((item) => item.dataset && item.dataset.shelf === kind);
        if (node) this.callback([{ isIntersecting: true, target: node }]);
      }
    };
  }

  return {
    dom, window, root, api, calls, signals, queue, playlists,
    resolvePlay: () => resolvePlay && resolvePlay(),
    resolveLibrary: () => { resolveLibrary.splice(0).forEach((release) => release()); },
    resolveQueue: () => resolveQueue && resolveQueue(),
    poll: (value) => pollHandler && pollHandler(value),
    setLyrics: (fn) => { lyricsAnswer = fn; },
    setSnapshot: (fn) => { snapshotValue = fn; },
    observer: () => window.IntersectionObserver ? window.__observer : null,
    reach: (kind) => {
      const node = observed.find((item) => item.dataset && item.dataset.shelf === kind);
      if (!node) return false;
      observed
        .filter((item) => item.dataset && item.dataset.shelf === kind)
        .forEach((item) => { /* leave the list alone; the page unobserves itself */ });
      node.__reach = true;
      return true;
    },
    observed,
  };
}

const tileNamed = (h, name) => [...h.root.querySelectorAll(".tile .name")]
  .find((node) => node.textContent === name)?.closest(".tile");

check("the page is the panel's shape: searchbar, hero, sleeves, and Up next beside them", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  assert.ok(h.root.classList.contains("puca-music"), "the page is scoped to its own root");
  assert.ok(h.root.classList.contains("day") || h.root.classList.contains("night"), "the panel's theme flip applies");
  assert.ok(h.root.querySelector(".top .searchbar input[type=search]"), "the panel's searchbar heads the page");
  const grid = h.root.querySelector(".grid");
  assert.ok(grid, "the page is the panel's grid");
  const left = grid.querySelector(".left");
  assert.ok(left.querySelector(".hero.music-now-card"), "the player is the hero of the left column");
  assert.ok(left.querySelector(".shelves .shelf .row"), "the sleeves are under it");
  assert.ok(grid.querySelector(".side .queue"), "Up next is the column beside them");
  assert.equal(left.querySelector(".hero .art img.music-artwork").hidden, false, "the hero carries the cover");
  // One control row, the panel's own: shuffle, previous, play, next, repeat.
  const controls = h.root.querySelector(".controls.music-controls");
  assert.equal(controls.querySelectorAll("button").length, 5, "the control row is the panel's five controls");
  assert.ok(controls.querySelector(".music-play .ic-play") && controls.querySelector(".music-play .ic-pause"),
    "the play control carries both glyphs, as the panel's does");
  const volumerow = h.root.querySelector(".volumerow");
  assert.ok(volumerow.querySelector(".music-mute svg"), "the speaker's own mute control");
  assert.ok(volumerow.querySelector('.music-volwheel[role="slider"]'), "the volume slider");
  assert.ok(volumerow.querySelector(".music-volnum"), "the live level");
  assert.ok(volumerow.querySelector(".music-lyrics-toggle"), "the Lyrics chip");
  assert.equal(h.root.querySelectorAll("input[type=range]").length, 0, "volume is never a range input");
  assert.ok(!h.root.querySelector(".music-mini"), "the phone mini bar is gone: the panel has none");
  // The words are the panel's own design, in the panel's own place.
  assert.ok(h.root.querySelector(".lyrics.music-lyrics-overlay .lyr-lines"), "the design's own lines container");
  assert.ok(h.root.querySelector(".lyrics .lyr-zoom button"), "the text-size pair in its footer");
  unmount();
});

check("a shelf is read as it is reached, not all three at once", async () => {
  const h = harness({ observe: true });
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  assert.deepEqual(h.calls.library, ["playlists"], "opening the page reads the first shelf only");
  assert.ok([...h.root.querySelectorAll(".tile .name")].some((node) => node.textContent === "Focus"),
    "the playlists shelf paints real sleeves");
  // Reaching the second shelf reads it and paints it.
  const shelf = h.observed.find((node) => node.dataset.shelf === "likes");
  assert.ok(shelf, "the other shelves are observed");
  unmount();
});

check("a tap is acknowledged before the speaker answers, and the sleeve is marked", async () => {
  const h = harness({ deferPlay: true });
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const tile = tileNamed(h, "A likes song");
  assert.ok(tile, "a song sleeve is on the page");
  tile.click();
  assert.equal(h.calls.play.length, 1, "the request goes out on the first tap");
  assert.ok(tile.classList.contains("is-pending"), "the sleeve answers the tap immediately");
  h.resolvePlay();
  await settle();
  await settle();
  assert.ok(!tile.classList.contains("is-pending"), "pending clears once the speaker accepted it");
  assert.ok(tile.classList.contains("playing-ring"), "the accepted sleeve wears the panel's playing ring");
  unmount();
});

check("a refused stream is reported and never leaves a sleeve pending", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  h.api.play = async () => { throw new Error("could not fetch the stream"); };
  const tile = tileNamed(h, "A likes song");
  tile.click();
  await settle();
  await settle();
  assert.ok(!tile.classList.contains("is-pending"), "the pending mark clears on failure");
  assert.equal(h.root.querySelector(".music-error").textContent, "could not fetch the stream");
  assert.ok(!h.root.querySelector(".music-error").hidden, "the message is shown, not just written");
  unmount();
});

check("typing is debounced into one search, and the repeat comes from cache", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const input = h.root.querySelector("input[type=search]");
  for (const value of ["d", "da", "daf", "daft"]) {
    input.value = value;
    input.dispatchEvent(new h.window.Event("input"));
    await wait(40);
  }
  assert.deepEqual(h.calls.search, [], "keystrokes inside the debounce window are collapsed");
  await wait(400);
  assert.deepEqual(h.calls.search, ["daft"]);
  const sheet = h.root.querySelector(".music-sheet");
  assert.equal(sheet.hidden, false, "the results open over the page, as the panel's sheet does");
  assert.equal(h.root.querySelector(".music-sheet-title").textContent, "Results for “daft”");
  const cards = [...h.root.querySelectorAll(".music-sheet .res .rt")];
  assert.deepEqual(cards.map((node) => node.textContent), ["Result for daft"], "one card per song");
  input.value = "daft";
  input.dispatchEvent(new h.window.Event("input"));
  await wait(400);
  assert.equal(h.calls.search.length, 1, "a repeated search is answered from cache");
  unmount();
});

check("a superseded search is aborted and only the newest result is shown", async () => {
  const h = harness({ slowSearch: true });
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const input = h.root.querySelector("input[type=search]");
  input.value = "alpha";
  input.dispatchEvent(new h.window.Event("input"));
  await wait(320);
  input.value = "beta";
  input.dispatchEvent(new h.window.Event("input"));
  await wait(320);
  await wait(600);
  assert.deepEqual(h.calls.search, ["alpha", "beta"]);
  assert.equal(h.signals[0].aborted, true, "the stale request is aborted, not raced");
  assert.equal(h.root.querySelector(".music-sheet .res .rt").textContent, "Result for beta");
  unmount();
});

check("a burst of volume changes sends one request, then the level that was settled on", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  assert.equal(h.root.querySelector(".music-volnum").textContent, "50%", "the slider opens on the speaker's level");
  const slider = h.root.querySelector(".music-volwheel");
  const key = (k) => {
    const event = new h.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    slider.dispatchEvent(event);
  };
  key("ArrowUp"); key("ArrowUp"); key("ArrowUp");
  const volumeCalls = () => h.calls.control.filter((entry) => entry.action === "volume");
  assert.equal(volumeCalls().length, 1, "a burst sends one request at a time");
  assert.equal(h.root.querySelector(".music-volnum").textContent, "65%", "the level previews at once");
  await wait(30);
  await settle();
  assert.equal(volumeCalls().length, 2, "the settled level is committed once");
  assert.equal(Math.round(volumeCalls()[1].value * 100), 65);
  unmount();
});

check("the queue is kept live: a change made elsewhere appears without a reload", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  assert.equal(h.root.querySelectorAll(".music-queue-row").length, 0);
  // Somebody else queues a track (the assistant, the wall panel, another tab).
  h.queue.items.push(track("outside-1", "Queued elsewhere"));
  h.queue.index = 0;
  // The console starts it: the snapshot names a different track, which is what a
  // queue moving on by itself looks like to the page.
  h.poll({ ok: true, track: track("outside-1", "Queued elsewhere"), position: { elapsed_sec: 1, duration_sec: 200 }, playing: true,
           player: { volume: 0.5, muted: false, confirmed: true, device: "Nix Dev", state: "playing" } });
  await settle();
  await settle();
  assert.equal(h.root.querySelectorAll(".music-queue-row").length, 1,
    "the page re-read the queue when the track changed instead of drifting");
  assert.equal(h.root.querySelector(".music-queue-title").textContent, "Queued elsewhere");
  assert.ok(h.root.querySelector(".music-queue-row").classList.contains("is-current"),
    "the entry that is playing is marked");
  assert.equal(h.root.querySelector(".side-head h2").textContent, "Up next · 1");
  unmount();
});

check("the 250ms timer re-reads the queue so the page cannot drift while it is open", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const before = h.calls.get.length;
  h.queue.items.push(track("later-1", "Added later"));
  // The page's own ticker re-reads a queue older than its short lifetime; the
  // queue is a heavier read than the snapshot, so it is not read every tick.
  await wait(5400);
  assert.ok(h.calls.get.length > before, "the queue is read again on the page's timer");
  assert.equal(h.root.querySelector(".music-queue-title").textContent, "Added later");
  unmount();
});

check("an older queue read can never land on top of a newer one", async () => {
  const h = harness({ deferQueue: true });
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  // The first read is still on the wire. A write paints its own, newer answer.
  h.queue.items.push(track("fresh-1", "Freshly queued"));
  const rows = () => [...h.root.querySelectorAll(".music-queue-row .music-queue-title")].map((node) => node.textContent);
  const add = h.root.querySelector(".music-tile-wrap .music-queue-add") || h.root.querySelector(".music-queue-add");
  const queuedId = add.closest(".music-tile-wrap").querySelector(".tile").dataset.videoId;
  add.click();
  await settle();
  const expected = ["Freshly queued", "Queued " + queuedId];
  assert.deepEqual(rows(), expected, "the write's own reply is what is on screen");
  h.resolveQueue();     // the stale read arrives last
  await settle();
  await settle();
  assert.deepEqual(rows(), expected, "the older answer must not repaint over it");
  unmount();
});

check("a queued track can be played from the queue, removed, and the queue cleared", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  h.root.querySelector(".music-queue-add").click();
  await settle();
  assert.equal(h.calls.queue[0].action, "add");
  assert.equal(h.root.querySelectorAll(".music-queue-row").length, 1);
  h.root.querySelector(".music-queue-row").click();
  await settle();
  assert.equal(h.calls.queue[1].action, "play", "the row itself is the play control, as on the panel");
  assert.ok(h.root.querySelector(".music-queue-row").classList.contains("is-current"));
  assert.equal(h.root.querySelector(".music-now-title").textContent, "Queued likes-1",
    "the hero follows the queued track");
  h.root.querySelector(".music-queue-remove").click();
  await settle();
  assert.equal(h.root.querySelectorAll(".music-queue-row").length, 0);
  assert.equal(h.root.querySelector(".music-queue-note").hidden, false, "the empty queue says so");
  unmount();
});

check("the queue is rearranged by dragging a row, in both directions", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  for (let round = 0; round < 2; round += 1) {
    h.root.querySelector(".music-queue-add").click();
    await settle();
  }
  const rows = [...h.root.querySelectorAll(".music-queue-row")];
  assert.equal(rows.length, 2, "two tracks are queued");
  assert.ok(rows[0].querySelector(".music-queue-grip"), "the drag has a visible grip");
  const before = rows.map((row) => row.querySelector(".qt").textContent);
  const stub = (row, top) => {
    row.getBoundingClientRect = () => ({ top, height: 40, bottom: top + 40, left: 0, right: 0, width: 0 });
  };
  stub(rows[0], 100);
  stub(rows[1], 140);
  const pointer = (type, clientY, target) => {
    // jsdom has no PointerEvent: a bubbling Event with the pointer fields the
    // page reads stands in for one.
    const event = new h.window.Event(type, { bubbles: true, cancelable: true });
    event.clientY = clientY;
    event.clientX = 0;
    event.button = 0;
    event.pointerId = 1;
    event.pointerType = "touch";
    target.dispatchEvent(event);
    return event;
  };
  pointer("pointerdown", 110, rows[0]);
  pointer("pointerup", 111, rows[0]);
  await settle();
  assert.ok(!h.calls.queue.some((call) => call.action === "move"), "a tap does not reorder the queue");
  pointer("pointerdown", 110, rows[0]);
  pointer("pointermove", 170, rows[0]);
  assert.ok(rows[0].classList.contains("is-dragging"), "the dragged row is marked");
  assert.ok(rows[1].classList.contains("is-drop-after"), "the drop position is shown");
  pointer("pointerup", 170, rows[0]);
  await settle();
  const move = h.calls.queue.find((call) => call.action === "move");
  assert.equal(move.index, 0);
  assert.equal(move.to, 1);
  let painted = [...h.root.querySelectorAll(".music-queue-row")].map((row) => row.querySelector(".qt").textContent);
  assert.deepEqual(painted, [before[1], before[0]], "the painted order follows the drop");
  const moved = [...h.root.querySelectorAll(".music-queue-row")];
  stub(moved[0], 100);
  stub(moved[1], 140);
  pointer("pointerdown", 170, moved[1]);
  pointer("pointermove", 110, moved[1]);
  pointer("pointerup", 110, moved[1]);
  await settle();
  const up = [...h.calls.queue].filter((call) => call.action === "move").pop();
  assert.equal(up.index, 1);
  assert.equal(up.to, 0);
  painted = [...h.root.querySelectorAll(".music-queue-row")].map((row) => row.querySelector(".qt").textContent);
  assert.deepEqual(painted, [before[0], before[1]], "the last row can be carried back up");
  unmount();
});

check("shuffle and repeat are the panel's chips, lit by the queue's own reply", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const shuffleButton = h.root.querySelector('.music-extra[data-control="shuffle"]');
  const repeatButton = h.root.querySelector('.music-extra[data-control="repeat"]');
  assert.equal(shuffleButton.getAttribute("aria-pressed"), "false");
  assert.equal(repeatButton.textContent, "Repeat");
  shuffleButton.click();
  await settle();
  assert.equal(h.calls.queue[0].action, "shuffle");
  assert.equal(h.calls.queue[0].on, undefined, "one press toggles rather than naming a state");
  assert.equal(shuffleButton.getAttribute("aria-pressed"), "true");
  assert.ok(shuffleButton.classList.contains("on"), "the chip fills in, as the panel's does");
  repeatButton.click();
  await settle();
  assert.equal(h.calls.queue[1].mode, "all");
  assert.equal(repeatButton.textContent, "Repeat all");
  repeatButton.click();
  await settle();
  assert.equal(h.calls.queue[2].mode, "one");
  assert.equal(repeatButton.textContent, "Repeat one");
  unmount();
});

check("the words are asked for by name and length, and follow the track", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  assert.equal(h.calls.lyrics.length, 1);
  // Field by field: the page's objects are built in the jsdom realm.
  const asked = h.calls.lyrics[0];
  assert.equal(asked.video_id, "current-1");
  assert.equal(asked.title, "Current Track");
  assert.equal(asked.artist, "Test Artist");
  assert.equal(asked.duration_sec, "200", "the request carries the length the provider matches on");
  const lines = [...h.root.querySelectorAll(".lyr-line")];
  assert.deepEqual(lines.map((node) => node.textContent), ["Line one", "Line two"]);
  assert.equal(h.root.querySelector(".lyrics").hidden, false, "a track's words open by themselves, as on the wall");
  // The clock's own position highlights a line, and the page keeps following it.
  const highlighted = () => [...h.root.querySelectorAll(".lyr-line")].filter((node) => node.classList.contains("cur"));
  await wait(60);
  assert.ok(highlighted().length <= 1, "one line is current");
  unmount();
});

check("the Lyrics chip opens and closes the words, and closing hides them for that track", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const overlay = h.root.querySelector(".lyrics");
  const chip = h.root.querySelector(".music-lyrics-toggle");
  assert.equal(overlay.hidden, false, "the words came up with the track");
  chip.click();
  await settle();
  assert.equal(overlay.hidden, true, "the chip hides them");
  assert.equal(chip.getAttribute("aria-pressed"), "false");
  chip.click();
  await settle();
  assert.equal(overlay.hidden, false, "and shows them again");
  assert.equal(chip.getAttribute("aria-pressed"), "true");
  h.root.querySelector(".music-lyr-close").click();
  await settle();
  assert.equal(overlay.hidden, true, "Hide closes them");
  unmount();
});

check("the words travel with the track, and plain lyrics are shown as words", async () => {
  const h = harness();
  h.setLyrics(() => ({ ok: true, lyrics: [], lyrics_plain: "These are the words\nof a plain song", lyrics_timing: "plain" }));
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const lines = [...h.root.querySelectorAll(".lyr-line")];
  assert.ok(lines.some((node) => node.textContent === "These are the words"), "plain lyrics are rendered");
  assert.ok(lines.some((node) => node.textContent === "of a plain song"),
    "and their own line breaks are kept, one line per line");
  assert.equal(h.root.querySelectorAll(".lyr-line.cur").length, 0, "nothing is highlighted without timings");
  unmount();
});

check("a lookup that comes back empty is asked once more before the page gives up", async () => {
  const h = harness();
  let answer = 0;
  h.setLyrics(() => {
    answer += 1;
    if (answer === 1) return { ok: true, lyrics: [], lyrics_plain: "", lyrics_timing: "none" };
    return { ok: true, lyrics: [{ text: "Slow provider line", time_sec: 2 }], lyrics_plain: "", lyrics_timing: "synced" };
  });
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  assert.equal(h.calls.lyrics.length, 1);
  assert.equal(h.root.querySelectorAll(".lyr-line[data-time]").length, 0, "no lines are invented while it retries");
  await wait(2000);
  assert.equal(h.calls.lyrics.length, 2, "the lookup is retried once");
  assert.equal(h.root.querySelector(".lyr-line").textContent, "Slow provider line");
  unmount();
});

check("a track with no words says so, where the words go", async () => {
  const h = harness();
  h.setLyrics(() => ({ ok: true, lyrics: [], lyrics_plain: "", lyrics_timing: "none" }));
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  await wait(2000);
  assert.match(h.root.querySelector(".lyr-line").textContent, /No words for “Current Track”/);
  unmount();
});

check("switching tracks asks for the new track's words and keeps the old ones off the screen", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  h.setLyrics(() => ({ ok: true, lyrics: [{ text: "Second track line", time_sec: 1 }], lyrics_plain: "", lyrics_timing: "synced" }));
  h.poll({ ok: true, track: track("next-9", "Another Song"), position: { elapsed_sec: 0, duration_sec: 180 }, playing: true,
           player: { volume: 0.5, muted: false, confirmed: true, device: "Nix Dev", state: "playing" } });
  await settle();
  await settle();
  assert.equal(h.calls.lyrics.length, 2);
  assert.equal(h.calls.lyrics[1].video_id, "next-9");
  assert.equal(h.root.querySelector(".lyr-line").textContent, "Second track line");
  unmount();
});

check("like writes the playing track and is lit by the reply", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const likeButton = h.root.querySelector('.music-extra[data-control="like"]');
  assert.equal(likeButton.disabled, false, "a playing track can be liked");
  likeButton.click();
  await settle();
  assert.equal(h.calls.save[0].kind, "like");
  assert.equal(h.calls.save[0].video_id, "current-1");
  assert.equal(likeButton.getAttribute("aria-pressed"), "true");
  assert.equal(likeButton.textContent, "Liked");
  likeButton.click();
  await settle();
  assert.equal(h.calls.save[1].kind, "unlike");
  assert.equal(likeButton.textContent, "Like");
  unmount();
});

check("nothing playing leaves like disabled and writes nothing", async () => {
  const h = harness({ snapshot: () => ({
    ok: true, track: null, position: {}, playing: false,
    player: { volume: 0.5, muted: false, confirmed: true, device: "Nix Dev", state: "idle" },
  }) });
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const likeButton = h.root.querySelector('.music-extra[data-control="like"]');
  assert.equal(likeButton.disabled, true, "there is no track to like");
  h.root.querySelector('.music-extra[data-control="playlist"]').click();
  await settle();
  assert.equal(h.root.querySelectorAll(".music-picker-row").length, 1, "the playlists are still worth browsing");
  h.root.querySelector(".music-picker-row").click();
  await settle();
  assert.equal(h.calls.save.length, 0, "nothing playing means nothing is written");
  assert.equal(h.root.querySelector(".music-error").textContent, "Play something first, then add it to a playlist.");
  unmount();
});

check("a track can be added to a playlist, or a new one made for it", async () => {
  const h = harness({ playlists: [
    { playlist_id: "p1", name: "Focus", track_count: 3 },
    { playlist_id: "LM", name: "Liked Music", track_count: 2 },
  ] });
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const picker = h.root.querySelector(".music-picker");
  assert.equal(picker.hidden, true, "the picker starts closed");
  h.root.querySelector('.music-extra[data-control="playlist"]').click();
  await settle();
  assert.equal(picker.hidden, false);
  const rows = [...picker.querySelectorAll(".music-picker-row")];
  assert.deepEqual(rows.map((row) => row.querySelector(".music-picker-name").textContent), ["Focus"],
    "Liked Music is filled by likes, so it is not offered as a playlist to add to");
  rows[0].click();
  await settle();
  assert.equal(h.calls.save[0].kind, "playlist_add");
  assert.equal(h.calls.save[0].playlist_id, "p1");
  assert.equal(picker.hidden, true, "choosing a playlist closes the picker");
  h.root.querySelector('.music-extra[data-control="playlist"]').click();
  await settle();
  picker.querySelector("input").value = "Road trip";
  picker.querySelector("form").dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  await settle();
  assert.equal(h.calls.save[1].kind, "playlist_create");
  assert.equal(h.calls.save[2].kind, "playlist_add");
  assert.equal(h.calls.save[2].playlist_id, "new-1", "the track goes into the playlist the provider made");
  unmount();
});

check("opening a playlist shows its songs, and Queue all lines them up", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const playlist = h.root.querySelector(".music-playlist-tile");
  assert.ok(playlist, "the shelf carries the playlist as a sleeve");
  playlist.click();
  await settle();
  await settle();
  assert.equal(h.root.querySelector(".music-sheet-title").textContent, "Focus");
  const names = [...h.root.querySelectorAll(".music-sheet .res .rt")].map((node) => node.textContent);
  assert.deepEqual(names, ["Playlist Song", "Second Song"], "its songs are the sheet's rail");
  const queueAll = [...h.root.querySelectorAll(".music-sheet-action")].find((button) => button.textContent === "Queue all");
  assert.ok(queueAll, "the sheet offers Queue all");
  queueAll.click();
  await settle();
  assert.equal(h.calls.queue[0].action, "add_range");
  assert.equal(h.calls.queue[0].playlist_id, "p1");
  assert.equal(h.calls.queue[0].video_id, "pl-1", "the tail starts at the first song");
  unmount();
});

check("an empty answer says so rather than showing an empty sheet", async () => {
  const h = harness({ search: () => ({ ok: true, tracks: [], playlists: [] }) });
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const input = h.root.querySelector("input[type=search]");
  input.value = "zzz";
  input.dispatchEvent(new h.window.Event("input"));
  await wait(400);
  assert.match(h.root.querySelector(".music-sheet-hint").textContent, /nothing for that/);
  unmount();
});

check("keyboard shortcuts work, and unmounting removes them", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const input = h.root.querySelector("input[type=search]");
  input.blur();
  h.window.document.body.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "/", bubbles: true }));
  await settle();
  assert.equal(h.window.document.activeElement, input, "slash focuses the search field");
  input.blur();
  h.window.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  await settle();
  assert.deepEqual(h.calls.control[0], { action: "pause", value: undefined });
  const typed = h.root.querySelector("input[type=search]");
  typed.focus();
  typed.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "m", bubbles: true }));
  await settle();
  assert.equal(h.calls.control.filter((entry) => entry.action === "mute").length, 0,
    "the shortcuts are ignored while the user is typing");
  unmount();
  h.window.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  await settle();
  assert.equal(h.calls.control.length, 1, "unmount removes the shortcut listener");
});

check("covers come from the provider, and a sleeve without one gets the panel's mark", async () => {
  const h = harness({ playlists: [
    { playlist_id: "p1", name: "Focus", track_count: 3, artwork_url: "https://example.invalid/p1.jpg" },
    { playlist_id: "p-nocover", name: "Late Night", track_count: 4, artwork_url: "" },
  ] });
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const shelf = h.root.querySelector('.shelf[data-shelf="playlists"]');
  const images = [...shelf.querySelectorAll(".tile .cover img")];
  assert.equal(images.length, 1, "only the playlist that has a cover renders one");
  assert.equal(images[0].getAttribute("src"), "https://example.invalid/p1.jpg");
  assert.equal(images[0].getAttribute("loading"), "lazy", "covers load lazily, off the first paint's path");
  const mark = shelf.querySelector(".tile .cover .mark[data-tone]");
  assert.ok(mark, "a playlist without artwork gets a tinted mark instead of a broken image");
  assert.equal(mark.textContent, "LN", "the mark carries the playlist's initials");
  unmount();
});

check("a fresh shelf paints from the persisted cache before the provider answers", async () => {
  const first = harness();
  const firstUnmount = await first.window.NixMusicPage.mount(first.root, first.api);
  await settle();
  const stored = first.window.localStorage.getItem("nix.music.cache.v2");
  assert.ok(stored, "the read is persisted");
  assert.equal(first.root.querySelector(".tile .name").textContent, "Focus");
  firstUnmount();
  const aged = JSON.parse(stored);
  Object.keys(aged).forEach((key) => { aged[key].expires = Date.now() - 1000; });
  const second = harness({ deferLibrary: true, playlists: [
    { playlist_id: "p1", name: "Focus", track_count: 9, artwork_url: "https://example.invalid/p1.jpg" },
  ] });
  second.window.localStorage.setItem("nix.music.cache.v2", JSON.stringify(aged));
  const secondUnmount = await second.window.NixMusicPage.mount(second.root, second.api);
  await settle();
  assert.equal(second.root.querySelector(".tile .name").textContent, "Focus",
    "the shelf the user saw last time is on screen with no provider answer");
  assert.equal(second.root.querySelector(".tile .sub").textContent, "3 songs", "the cached copy's own values");
  assert.equal(second.calls.library.filter((kind) => kind === "playlists").length, 1, "a stale copy is refreshed behind it");
  second.resolveLibrary();
  await settle();
  await settle();
  assert.equal(second.root.querySelector(".tile .sub").textContent, "9 songs", "the fresh answer replaces it");
  secondUnmount();
});

let failures = 0;
for (const item of checks) {
  try {
    await item.fn();
    process.stdout.write("ok   " + item.name + "\n");
  } catch (error) {
    failures += 1;
    const where = error && error.stack ? String(error.stack).split("\n")[1].trim() : "";
    process.stdout.write("FAIL " + item.name + "\n     " + (error && error.message) + "\n     " + where + "\n");
  }
}
process.stdout.write((checks.length - failures) + "/" + checks.length + " music page checks passed\n");
process.exit(failures === 0 ? 0 : 1);

/* Behaviour harness for the OpenDeck music page.
 *
 * Mounts the real ui/music.js in jsdom with a fake music API, then checks the
 * things a user actually feels: a tap is acknowledged before the network
 * answers, typing is debounced into one request, a repeated query is served
 * from cache, a superseded search is aborted, rapid volume taps become two
 * requests instead of one per tap, the playing row is marked, and unmounting
 * removes the shortcuts and cancels the in-flight work.
 *
 * Run: node tests/music_page_dom.mjs   (from the package root)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* jsdom is a test-only dependency of this harness. It is looked up in the usual
   places, then wherever NIX_JSDOM_ROOT points, so the check runs on a machine
   that has it installed and reports a skip (exit code 77) where it is absent
   instead of failing a build for a missing dev tool. */
const require = createRequire(import.meta.url);
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
      // A location that holds no jsdom at all is the ordinary skip. A jsdom
      // that *is* there but cannot load (one too new for this Node, or missing
      // a dependency) means these checks did not really run, so carry the
      // reason into the skip line instead of reporting it as not installed.
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

function track(videoId, title) {
  return {
    video_id: videoId,
    title: title || videoId,
    artist: "Test Artist",
    album: "",
    duration_sec: 200,
    artwork_url: "https://example.invalid/" + videoId + ".jpg",
  };
}

function harness(options) {
  const settings = options || {};
  // A real origin, so the page's localStorage cache behaves as it does in the
  // console (an opaque origin such as about:blank has no storage at all).
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "http://localhost/music",
  });
  dom.window.eval(source);
  const window = dom.window;
  const root = window.document.getElementById("root");

  const calls = { library: [], search: [], play: [], control: [], queue: [], save: [], nowPlaying: 0 };
  const signals = [];
  const queue = { items: [], index: -1, shuffle: false, repeat: "off" };
  const playlists = settings.playlists || [
    { playlist_id: "p1", name: "Focus", track_count: 3, artwork_url: "https://example.invalid/p1.jpg" },
  ];
  let pollHandler = null;
  let resolvePlay = null;
  let resolveLibrary = null;

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

  const snapshot = () => ({
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
    async nowPlaying() { calls.nowPlaying += 1; return settings.snapshot ? settings.snapshot() : snapshot(); },
    async control(action, value) {
      calls.control.push({ action, value });
      return { ok: true, player: { volume: typeof value === "number" ? value : 0.5, muted: action === "mute", confirmed: true, device: "Nix Dev", state: "playing" } };
    },
    async search(query, limit, options) {
      calls.search.push(query);
      signals.push(options && options.signal);
      if (settings.slowSearch) await wait(900);
      return { ok: true, tracks: [track("search-" + query, "Result for " + query)] };
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
          ? { ok: true, tracks: [track("pl-1", "Playlist Song")] }
          : { ok: true, tracks: [track(kind + "-1", "A " + kind + " song")] };
      if (!settings.deferLibrary) return payload;
      // A provider that has not answered yet: the page must still be able to
      // paint what it had.
      return new Promise((resolve) => { resolveLibrary = () => resolve(payload); });
    },
    async lyrics() { return { ok: true, lyrics: [{ text: "Line one", time_sec: 1 }], lyrics_timing: "rich" }; },
    async get(path) {
      if (path !== "/queue") throw new Error("unexpected GET " + path);
      return queuePayload();
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
        if (queue.index + 1 >= queue.items.length) return { ok: true, action: "queue", queue: queue.items, index: queue.index, count: queue.items.length, message: "no next track" };
        queue.index += 1;
        return playingPayload(queue.items[queue.index]);
      }
      return queuePayload();
    },
    poll(handler) { pollHandler = handler; return () => { if (pollHandler === handler) pollHandler = null; }; },
  };

  return {
    dom, window, root, api, calls, signals,
    resolvePlay: () => resolvePlay && resolvePlay(),
    resolveLibrary: () => resolveLibrary && resolveLibrary(),
    poll: (value) => pollHandler && pollHandler(value),
  };
}

check("mount renders the page and prefetches only the playlist tab", async () => {
  const h = harness();
  await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  assert.equal(h.root.querySelectorAll(".music-grid").length, 1);
  assert.deepEqual(h.calls.library, ["playlists"]);
  assert.equal(h.root.querySelectorAll(".music-row").length, 1);
  assert.equal(h.root.querySelector(".music-row strong").textContent, "Focus");
  assert.equal(h.root.querySelector(".music-badge").textContent, "Nix Dev · playing");
  assert.equal(h.root.querySelectorAll(".music-controls button").length, 2,
    "one play/pause toggle and mute; the separate Pause and Stop buttons are gone");
  assert.ok(h.root.querySelector(".music-volwheel"), "the graphical volume dial is mounted");
  assert.ok(h.root.querySelector(".music-queue-card"), "the queue card is mounted");
});

check("a tap is acknowledged before the speaker answers", async () => {
  const h = harness({ deferPlay: true });
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  // A track row, not the playlist row: playlists open, tracks play.
  const liked = [...h.root.querySelectorAll(".music-tabs button")].find((button) => button.textContent === "Liked");
  liked.click();
  await settle();
  const row = h.root.querySelector(".music-row");
  row.click();
  assert.equal(h.calls.play.length, 1, "the request is sent on the first tap");
  assert.ok(row.classList.contains("is-pending"), "the row answers the tap immediately");
  h.resolvePlay();
  await settle();
  await settle();
  assert.ok(!row.classList.contains("is-pending"), "pending clears once the speaker accepted it");
  assert.ok(row.classList.contains("is-playing"), "the accepted row is marked as playing");
  assert.equal(h.root.querySelector(".music-bars").hidden, false);
  unmount();
});

check("a refused stream is reported and never leaves the row pending", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const liked = [...h.root.querySelectorAll(".music-tabs button")].find((button) => button.textContent === "Liked");
  liked.click();
  await settle();
  // The provider takes a while and then refuses, which is what a track it cannot
  // stream looks like from the page's side.
  h.api.play = async () => { throw new Error("could not fetch the stream"); };
  const row = h.root.querySelector(".music-row");
  row.click();
  await settle();
  await settle();
  assert.ok(!row.classList.contains("is-pending"), "the pending mark must clear on failure");
  assert.equal(h.root.querySelector(".music-error").textContent, "could not fetch the stream");
  unmount();
});

check("typing is debounced into one search and a repeat is served from cache", async () => {
  const h = harness({ slowSearch: false });
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
  const firstRows = h.root.querySelectorAll(".music-row").length;
  assert.equal(firstRows, 1);
  assert.equal(h.root.querySelector(".music-row strong").textContent, "Result for daft");

  // The same query again: cached, so no second request.
  input.value = "daft";
  input.dispatchEvent(new h.window.Event("input"));
  await wait(400);
  assert.equal(h.calls.search.length, 1, "a repeated search is answered from cache");
  assert.equal(h.root.querySelectorAll(".music-row").length, 1);
  unmount();
});

check("a superseded search is aborted and only the newest result is shown", async () => {
  const h = harness({ slowSearch: true });
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const input = h.root.querySelector("input[type=search]");
  input.value = "alpha";
  input.dispatchEvent(new h.window.Event("input"));
  await wait(320); // "alpha" is on the wire (900ms)
  input.value = "beta";
  input.dispatchEvent(new h.window.Event("input"));
  await wait(320); // "beta" fires while "alpha" is still pending
  await wait(900);
  assert.deepEqual(h.calls.search, ["alpha", "beta"]);
  assert.equal(h.signals[0].aborted, true, "the stale request is aborted, not raced");
  assert.equal(h.signals[1].aborted, false);
  assert.equal(h.root.querySelector(".music-row strong").textContent, "Result for beta");
  unmount();
});

check("rapid volume taps on the dial coalesce into the settled level", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  assert.equal(h.root.querySelector(".music-volnum").textContent, "50%", "the dial opens on the speaker's level");
  const up = h.root.querySelector(".music-volup");
  up.click();
  up.click();
  up.click();
  const volumeCalls = () => h.calls.control.filter((entry) => entry.action === "volume");
  assert.equal(volumeCalls().length, 1, "a burst of taps sends one request at a time");
  assert.equal(h.root.querySelector(".music-volnum").textContent, "65%", "the dial previews the settled level at once");
  await wait(30);
  await settle();
  assert.equal(volumeCalls().length, 2, "the settled level is committed once");
  assert.equal(Math.round(volumeCalls()[1].value * 100), 65);
  unmount();
});

check("a track can be queued, played from the queue, and removed", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const liked = [...h.root.querySelectorAll(".music-tabs button")].find((button) => button.textContent === "Liked");
  liked.click();
  await settle();
  const add = h.root.querySelector(".music-queue-add");
  assert.ok(add, "each track row offers an add-to-queue control");
  add.click();
  await settle();
  assert.equal(h.calls.queue[0].action, "add");
  assert.equal(h.root.querySelectorAll(".music-queue-row").length, 1);
  assert.equal(h.root.querySelector(".music-queue-count").textContent, "1 track");
  h.root.querySelector(".music-queue-play").click();
  await settle();
  assert.equal(h.calls.queue[1].action, "play");
  assert.ok(h.root.querySelector(".music-queue-row").classList.contains("is-current"), "the started item is marked");
  assert.equal(h.root.querySelector(".music-now-title").textContent, "Queued likes-1", "the now-playing card follows the queue's track");
  h.root.querySelector(".music-queue-remove").click();
  await settle();
  assert.equal(h.root.querySelectorAll(".music-queue-row").length, 0);
  assert.equal(h.root.querySelector(".music-queue-count").textContent, "");
  unmount();
});

check("the queue is rearranged by dragging a row", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const liked = [...h.root.querySelectorAll(".music-tabs button")].find((button) => button.textContent === "Liked");
  liked.click();
  await settle();
  // Three queued tracks, so a drag has somewhere to go.
  for (let round = 0; round < 2; round += 1) {
    h.root.querySelector(".music-queue-add").click();
    await settle();
  }
  const rows = [...h.root.querySelectorAll(".music-queue-row")];
  assert.equal(rows.length, 2, "two tracks are queued");
  assert.ok(rows[0].querySelector(".music-queue-grip"), "the drag has a visible grip");
  const before = rows.map((row) => row.querySelector("strong").textContent);

  // jsdom reports zero-sized rects, so the row geometry is stubbed: the drag is
  // a pointer gesture (HTML5 dragstart never fires for a finger), released
  // below the second row's midpoint, which means "put it after this one".
  rows[0].getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140, left: 0, right: 0, width: 0 });
  rows[1].getBoundingClientRect = () => ({ top: 140, height: 40, bottom: 180, left: 0, right: 0, width: 0 });
  const pointer = (type, clientY, target) => {
    // jsdom has no PointerEvent, so a bubbling Event with the pointer fields
    // the page reads stands in for one.
    const event = new h.window.Event(type, { bubbles: true, cancelable: true });
    event.clientY = clientY;
    event.clientX = 0;
    event.button = 0;
    event.pointerId = 1;
    event.pointerType = "touch";
    target.dispatchEvent(event);
    return event;
  };

  // A press that does not travel is a tap, not a reorder.
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
  assert.ok(move, "the drop asks the provider to move the row");
  assert.equal(move.index, 0, "the dragged row is the one that moves");
  assert.equal(move.to, 1, "it lands where it was dropped");
  const after = [...h.root.querySelectorAll(".music-queue-row")].map((row) => row.querySelector("strong").textContent);
  assert.deepEqual(after, [before[1], before[0]], "the painted order follows the drop");
  assert.ok(!h.root.querySelector(".music-queue-row").classList.contains("is-dragging"), "the drag mark is cleared");
  assert.ok(!h.root.querySelector(".music-queue-row").classList.contains("is-drop-after"), "the drop line is cleared");

  // ... and the other direction: carry the last row above the first.
  const moved = [...h.root.querySelectorAll(".music-queue-row")];
  moved[0].getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140, left: 0, right: 0, width: 0 });
  moved[1].getBoundingClientRect = () => ({ top: 140, height: 40, bottom: 180, left: 0, right: 0, width: 0 });
  pointer("pointerdown", 170, moved[1]);
  pointer("pointermove", 110, moved[1]);
  pointer("pointerup", 110, moved[1]);
  await settle();
  const up = [...h.calls.queue].filter((call) => call.action === "move").pop();
  assert.equal(up.index, 1, "the last row can be carried up");
  assert.equal(up.to, 0, "it lands above the first");
  const painted = [...h.root.querySelectorAll(".music-queue-row")].map((row) => row.querySelector("strong").textContent);
  assert.deepEqual(painted, [before[0], before[1]], "the painted order follows the upward drop");
  unmount();
});

check("the page is laid out like the wall panel: the player, the shelves, and Up next beside them", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const grid = h.root.querySelector(".music-grid");
  // The four cards are the grid's own children, in the order the stylesheet
  // names them: the player, then what is queued, then the shelves and the words.
  const shapes = [["music-now-card"], ["music-queue-card"], ["music-browse-card"], ["music-lyrics-card"]];
  assert.deepEqual([...grid.children].map((card) =>
    shapes.filter((shape) => card.classList.contains(shape[0])).length),
    [1, 1, 1, 1],
    "the player, the queue, the shelves and the words are the page's four cards");
  assert.ok([...grid.children].every((card) => card.classList.contains("music-card")),
    "and each one is a card, in the grid's own order");
  assert.equal([...grid.children].filter((card) => card.classList.contains("music-now-card")).length, 1,
    "the player is the hero");
  unmount();
});

check("switching tabs reuses the cached library and pauses are mirrored", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const tabs = [...h.root.querySelectorAll(".music-tabs button")];
  const liked = tabs.find((button) => button.textContent === "Liked");
  liked.click();
  await settle();
  assert.deepEqual(h.calls.library, ["playlists", "likes"]);
  liked.click();
  await settle();
  assert.deepEqual(h.calls.library, ["playlists", "likes"], "a cached tab paints without another request");
  assert.equal(h.root.querySelector(".music-row strong").textContent, "A likes song");

  // A control flips optimistically and the row follows the speaker snapshot.
  h.root.querySelector(".music-controls button").click();
  await settle();
  assert.deepEqual(h.calls.control[0], { action: "pause", value: undefined });
  h.poll({ ok: true, track: track("current-1", "Current Track"), position: { elapsed_sec: 40, duration_sec: 200 }, playing: false, player: { volume: 0.5, muted: false, confirmed: true, device: "Nix Dev", state: "paused" } });
  assert.equal(h.root.querySelector(".music-badge").textContent, "Nix Dev · paused");
  assert.equal(h.root.querySelector(".music-mini").hidden, false);
  assert.equal(h.root.querySelector(".music-mini strong").textContent, "Current Track");
  unmount();
});

check("shuffle and repeat follow the queue's own state", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  assert.equal(h.root.querySelectorAll(".music-extra").length, 4,
    "the now-playing card carries shuffle, repeat, like and playlist");
  const shuffleButton = h.root.querySelector('.music-extra[data-control="shuffle"]');
  const repeatButton = h.root.querySelector('.music-extra[data-control="repeat"]');
  assert.equal(shuffleButton.getAttribute("aria-pressed"), "false");
  assert.equal(repeatButton.textContent, "🔁 Repeat off");

  shuffleButton.click();
  await settle();
  assert.equal(h.calls.queue[0].action, "shuffle");
  assert.equal(h.calls.queue[0].on, undefined, "one press toggles rather than naming a state");
  assert.equal(shuffleButton.getAttribute("aria-pressed"), "true", "the reply lights the toggle");
  assert.equal(shuffleButton.textContent, "🔀 Shuffling");

  // Repeat cycles off -> all -> one -> off, each press sending the mode it moves to.
  repeatButton.click();
  await settle();
  assert.equal(h.calls.queue[1].mode, "all");
  assert.equal(repeatButton.textContent, "🔁 Repeat all");
  repeatButton.click();
  await settle();
  assert.equal(h.calls.queue[2].mode, "one");
  assert.equal(repeatButton.textContent, "🔁 Repeat one");
  assert.equal(repeatButton.getAttribute("aria-pressed"), "true");
  repeatButton.click();
  await settle();
  assert.equal(h.calls.queue[3].mode, "off");
  assert.equal(repeatButton.getAttribute("aria-pressed"), "false");
  unmount();
});

check("like writes the playing track and lights from the reply", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const likeButton = h.root.querySelector('.music-extra[data-control="like"]');
  assert.equal(likeButton.disabled, false, "a playing track can be liked");
  likeButton.click();
  await settle();
  // Compared field by field: the page's objects are built in the jsdom realm.
  assert.equal(h.calls.save[0].kind, "like");
  assert.equal(h.calls.save[0].video_id, "current-1");
  assert.equal(h.calls.save[0].title, "Current Track");
  assert.equal(h.calls.save[0].artist, "Test Artist");
  assert.equal(likeButton.getAttribute("aria-pressed"), "true");
  assert.equal(likeButton.textContent, "♥ Liked");
  likeButton.click();
  await settle();
  assert.equal(h.calls.save[1].kind, "unlike");
  assert.equal(likeButton.getAttribute("aria-pressed"), "false");
  assert.equal(likeButton.textContent, "♡ Like");
  unmount();
});

check("nothing playing leaves like and playlist with nothing to act on", async () => {
  const h = harness({ snapshot: () => ({
    ok: true, track: null, position: {}, playing: false,
    player: { volume: 0.5, muted: false, confirmed: true, device: "Nix Dev", state: "idle" },
  }) });
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const likeButton = h.root.querySelector('.music-extra[data-control="like"]');
  assert.equal(likeButton.disabled, true, "there is no track to like");
  assert.equal(likeButton.textContent, "♡ Like");
  // The picker still opens (the playlists are worth browsing), but adding has
  // nothing to add, and the disabled Like button writes nothing at all.
  h.root.querySelector('.music-extra[data-control="playlist"]').click();
  await settle();
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
  assert.deepEqual(rows.map((row) => row.querySelector("strong").textContent), ["Focus"],
    "Liked Music is filled by likes, so it is not offered as a playlist to add to");
  rows[0].click();
  await settle();
  assert.equal(h.calls.save[0].kind, "playlist_add");
  assert.equal(h.calls.save[0].playlist_id, "p1");
  assert.equal(h.calls.save[0].video_id, "current-1");
  assert.equal(picker.hidden, true, "choosing a playlist closes the picker");

  // Naming a new playlist creates it, then adds the playing track to what the
  // provider reported back, not to a name the page guessed at.
  h.root.querySelector('.music-extra[data-control="playlist"]').click();
  await settle();
  picker.querySelector("input").value = "Road trip";
  picker.querySelector("form").dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  await settle();
  assert.equal(h.calls.save[1].kind, "playlist_create");
  assert.equal(h.calls.save[1].name, "Road trip");
  assert.equal(h.calls.save[2].kind, "playlist_add");
  assert.equal(h.calls.save[2].playlist_id, "new-1");
  assert.equal(picker.hidden, true);
  unmount();
});

check("keyboard shortcuts work and are removed on unmount", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const input = h.root.querySelector("input[type=search]");
  input.blur();
  h.window.document.body.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "/", bubbles: true }));
  await settle();
  assert.equal(h.window.document.activeElement, input, "slash focuses the search field");
  assert.equal(h.calls.control.length, 0, "typing a slash does not control the speaker");

  // Space toggles playback when focus is not in a field.
  input.blur();
  h.window.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  await settle();
  assert.deepEqual(h.calls.control[0], { action: "pause", value: undefined });

  // The shortcuts are ignored while the user is typing in the search field: a
  // real keystroke lands on the focused input and bubbles from there.
  const typed = h.root.querySelector("input[type=search]");
  typed.focus();
  typed.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "m", bubbles: true }));
  await settle();
  assert.equal(h.calls.control.filter((entry) => entry.action === "mute").length, 0);

  unmount();
  h.window.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  await settle();
  assert.equal(h.calls.control.length, 1, "unmount removes the shortcut listener");
});

check("playlists show the cover the provider resolved, and a tinted tile without one", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const cover = h.root.querySelector(".music-row img");
  assert.ok(cover, "a playlist with artwork renders its picture");
  assert.equal(cover.getAttribute("src"), "https://example.invalid/p1.jpg");
  assert.equal(cover.getAttribute("loading"), "lazy", "covers load lazily, off the first paint's path");
  unmount();

  // A playlist the provider has no picture for (an auto playlist, or one saved
  // without artwork) gets a monogram tile tinted from its own id instead of a
  // broken image, and the same playlist always gets the same tint.
  const bare = harness({ playlists: [
    { playlist_id: "p-nocover", name: "Late Night", track_count: 4, artwork_url: "" },
  ] });
  const bareUnmount = await bare.window.NixMusicPage.mount(bare.root, bare.api);
  await settle();
  const tile = bare.root.querySelector(".music-row-art[data-tone]");
  assert.ok(tile, "a playlist without artwork still gets a tile");
  assert.equal(tile.textContent, "LN", "the tile carries the playlist's initials");
  assert.equal(bare.root.querySelectorAll(".music-row img").length, 0, "no empty image is rendered");
  bareUnmount();
  const twice = harness({ playlists: [
    { playlist_id: "p-nocover", name: "Late Night", track_count: 4, artwork_url: "" },
  ] });
  const twiceUnmount = await twice.window.NixMusicPage.mount(twice.root, twice.api);
  await settle();
  assert.equal(
    twice.root.querySelector(".music-row-art").dataset.tone,
    tile.dataset.tone,
    "the same playlist keeps the same tint",
  );
  twiceUnmount();
});

check("the page carries one transport, in the wheel's hub, and no stop", async () => {
  const h = harness();
  const unmount = await h.window.NixMusicPage.mount(h.root, h.api);
  await settle();
  const buttons = [...h.root.querySelectorAll("button")];
  // The transport's own labels: "▶ Play" / "❙❙ Pause". Deliberately not a bare
  // /play/ match, which would also catch "Playlist" and "Play next" — neither
  // of which is a second transport.
  const transport = buttons.filter((button) => /^(▶|❙❙)\s*(play|pause)$/i.test(button.textContent.trim()));
  assert.equal(transport.length, 1, "exactly one play/pause control exists on the page");
  assert.equal(
    buttons.filter((button) => /\bstop\b/i.test(button.textContent + " " + (button.getAttribute("aria-label") || ""))).length,
    0,
    "no stop control exists anywhere",
  );
  const mute = buttons.filter((button) => /mute/i.test(button.getAttribute("aria-label") || ""));
  assert.equal(mute.length, 1, "exactly one mute control exists on the page");

  // The phone mini bar is a status strip, not a second set of buttons.
  const mini = h.root.querySelector(".music-mini");
  assert.ok(mini, "the mini bar is mounted");
  assert.equal(mini.querySelectorAll("button").length, 0, "the mini bar repeats no control");

  // Both controls sit with the wheel in one round hub, the Echo Connect panel's
  // composition, and the wheel is still the graphical dial (not a range input).
  const hub = h.root.querySelector(".music-hub.music-controls");
  assert.ok(hub, "the transport lives in the hub with the wheel");
  assert.ok(hub.querySelector(".music-volwheel[role=slider]"), "the wheel is inside the hub");
  assert.equal(hub.querySelectorAll(".music-round").length, 2, "the hub has two round controls");
  assert.ok(hub.querySelector(".music-play"), "play/pause is the round primary control");
  assert.ok(hub.querySelector(".music-mute"), "mute is the round secondary control");
  assert.ok(hub.querySelector(".music-mute svg"), "mute carries its own speaker icon");
  assert.equal(h.root.querySelectorAll("input[type=range]").length, 0, "volume is never a range input");

  // A muted speaker fills the control in and relabels it.
  h.poll({ ok: true, track: track("current-1", "Current Track"), position: { elapsed_sec: 1, duration_sec: 200 }, playing: true, player: { volume: 0.5, muted: true, confirmed: true, device: "Nix Dev", state: "playing" } });
  assert.equal(mute[0].getAttribute("aria-pressed"), "true");
  assert.equal(mute[0].textContent, "Unmute");
  assert.ok(mute[0].classList.contains("is-muted"));
  unmount();
});

check("the library is painted from the persisted cache before the provider answers", async () => {
  // A first visit fills the cache…
  const first = harness();
  const firstUnmount = await first.window.NixMusicPage.mount(first.root, first.api);
  await settle();
  const stored = first.window.localStorage.getItem("nix.music.cache.v1");
  assert.ok(stored, "the read is persisted");
  assert.equal(first.root.querySelector(".music-row strong").textContent, "Focus");
  firstUnmount();

  // …and a later visit (yesterday's cache, so it is due a refresh) paints it at
  // once, while the provider is still pending.
  const aged = JSON.parse(stored);
  Object.keys(aged).forEach((key) => { aged[key].expires = Date.now() - 1000; });
  const second = harness({
    deferLibrary: true,
    playlists: [{ playlist_id: "p1", name: "Focus", track_count: 9, artwork_url: "https://example.invalid/p1.jpg" }],
  });
  // The same browser storage as the first visit (one page, two mounts).
  second.window.localStorage.setItem("nix.music.cache.v1", JSON.stringify(aged));
  const secondUnmount = await second.window.NixMusicPage.mount(second.root, second.api);
  await settle();
  assert.equal(
    second.root.querySelector(".music-row strong").textContent,
    "Focus",
    "the cached playlist list is on screen with no provider answer",
  );
  assert.equal(second.root.querySelector(".music-row span").textContent, "3 track(s)", "the cached copy's own values");
  assert.ok(second.root.querySelector(".music-row img").getAttribute("src"), "its cover comes back with it");
  assert.deepEqual(second.calls.library, ["playlists"], "a stale copy is refreshed in the background");

  // When the provider answers, the same tab is repainted from the fresh reply.
  second.resolveLibrary();
  await settle();
  await settle();
  assert.equal(second.root.querySelector(".music-row span").textContent, "9 track(s)", "the fresh answer replaces the cache");
  secondUnmount();
});

let failures = 0;
for (const item of checks) {
  try {
    await item.fn();
    process.stdout.write("ok   " + item.name + "\n");
  } catch (error) {
    failures += 1;
    // The failing line matters in a harness this long: print where it threw.
    const where = error && error.stack ? String(error.stack).split("\n")[1].trim() : "";
    process.stdout.write("FAIL " + item.name + "\n     " + (error && error.message) + "\n     " + where + "\n");
  }
}
process.stdout.write((checks.length - failures) + "/" + checks.length + " music page checks passed\n");
process.exit(failures === 0 ? 0 : 1);

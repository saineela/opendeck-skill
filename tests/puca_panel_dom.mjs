/* Behaviour harness for the PUCA Panel.
 *
 * The look is the Nix-Physical-Display-panel "PUCA Panel" (its markup and its
 * stylesheet, unchanged); the behaviour is this package's adapter, which fills
 * that design from the console's own music API. So the real PUCA-Panel/panel.js
 * and panel.html are mounted in jsdom with a stubbed console API on the same
 * origin, and what the person in front of the wall display feels is checked:
 * the screen paints what is playing into the design's own elements, the theme
 * follows the console's clock rather than the browser's, the lyrics design opens
 * by itself for a track and stays closed once it is closed, a spoken request
 * becomes the same play call the assistant makes, and the console's question is
 * answered by the card the user taps or the number they say.
 *
 * Run: node tests/puca_panel_dom.mjs   (from the package root)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
    `skip the PUCA Panel DOM checks: jsdom is not installed (set NIX_JSDOM_ROOT)${failure ? `: ${failure}` : ""}\n`,
  );
  process.exit(77);
}
const { JSDOM, VirtualConsole } = jsdom;

const here = path.dirname(fileURLToPath(import.meta.url));
const panelDir = path.join(here, "..", "skills", "opendeck", "PUCA-Panel");
const source = readFileSync(path.join(panelDir, "panel.js"), "utf8");
const design = readFileSync(path.join(panelDir, "panel.html"), "utf8");
const stylesheet = readFileSync(path.join(panelDir, "panel.css"), "utf8");
/* The page as it ships, minus its own <script>: the harness mounts it and then
   evaluates panel.js itself, so the stubs are in place before the panel boots. */
const page = design.replace(/<script src="panel\.js"><\/script>/, "");

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* Enough macrotasks for the boot's own fetches, the library's follow-up reads
   and the lyrics fetch to finish. */
const settle = async () => { for (let i = 0; i < 12; i += 1) await wait(0); };

/* Payloads the panel builds are created in the jsdom realm, whose Object
   prototype is not this module's, so strict deep equality (§ across realms)
   needs them copied into plain values first. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const IMG = "https://i.ytimg.com/vi/v1/hqdefault.jpg";

/* The box the panel is pointed at: the address the console reports as its own on
   the network, which is what a wall has to end up talking to. */
const BOX_HOST = "192.168.0.230";
const BOX_HTTP = `http://${BOX_HOST}:49170/`;
const BOX_HTTPS = `https://${BOX_HOST}:49171/`;

function track(videoId, title, extra) {
  return {
    video_id: videoId,
    title: title || videoId,
    artist: "Test Artist",
    album: "Test Album",
    duration_sec: 200,
    artwork_url: "https://example.invalid/" + videoId + ".jpg",
    ...(extra || {}),
  };
}

/* A fake speech recognizer, because jsdom has none. It records itself so the
   checks can hand it a transcript and drive the panel's real handler. The panel
   reads window.SpeechRecognition once, when it loads, so this has to be
   installed before the script is evaluated. */
function installFakeSpeech(window) {
  window.SpeechRecognition = class FakeRecognition {
    constructor() { window.__recognizer = this; }
    start() {
      if (this.onstart) this.onstart();
      const spoken = window.__spoken;
      if (spoken) window.__spoken = null;
      // A real recognizer answers asynchronously and ends the session when the
      // phrase ends, which is what returns the panel to "not listening".
      setTimeout(() => {
        if (spoken && this.onresult) this.onresult(transcript(spoken));
        if (this.onend) this.onend();
      }, 0);
    }
    stop() { if (this.onend) this.onend(); }
  };
}

function transcript(text) {
  const result = [{ transcript: text }];
  result.isFinal = true;
  return { resultIndex: 0, results: [result] };
}

/* A fake microphone and a fake Web Audio stack, because jsdom has neither. The
   panel records through AudioContext + a ScriptProcessorNode, so the fake hands
   the check the node whose `onaudioprocess` it can call with samples — the same
   path a real microphone drives — and the check owns the clock the panel reads,
   so a phrase and the silence after it are a few milliseconds of test time. */
function installFakeAudio(window, options) {
  const settings = options || {};
  const state = {
    processors: [], closed: 0, tracks: 0, constraints: null,
    // What the analyser reports: the check sets this as it pumps samples, so a
    // phrase and the silence after it look different to the panel.
    level: settings.level === undefined ? 0.2 : settings.level,
  };
  class FakeBlob {
    constructor(parts, opts) {
      this.parts = parts;
      this.type = (opts && opts.type) || "";
    }
  }
  class FakeAudioContext {
    constructor() {
      this.sampleRate = settings.sampleRate || 48000;
      this.destination = { id: "destination" };
      state.sampleRate = this.sampleRate;
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      return {
        fftSize: 1024,
        connect() {}, disconnect() {},
        getFloatTimeDomainData: (array) => {
          for (let i = 0; i < array.length; i++) array[i] = state.level;
        },
      };
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      const node = { onaudioprocess: null, connect() {}, disconnect() {} };
      state.processors.push(node);
      return node;
    }
    close() { state.closed += 1; return Promise.resolve(); }
  }
  window.AudioContext = FakeAudioContext;
  window.Blob = FakeBlob;
  window.navigator.mediaDevices = {
    getUserMedia: (constraints) => {
      state.constraints = constraints;
      if (settings.micBlocked) {
        const error = new Error("denied");
        error.name = "NotAllowedError";
        return Promise.reject(error);
      }
      return Promise.resolve({
        getTracks: () => [
          { stop: () => { state.tracks += 1; } },
        ],
      });
    },
  };
  return state;
}

/* jsdom ships a WebSocket that would try to reach a real server; the panel's
   push channel is driven here by hand instead, so a check can say "the console
   just told the wall something" without a listener on the other end. */
function installFakeSocket(window) {
  const sockets = [];
  function FakeSocket(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    sockets.push(this);
  }
  FakeSocket.CONNECTING = 0; FakeSocket.OPEN = 1; FakeSocket.CLOSING = 2; FakeSocket.CLOSED = 3;
  FakeSocket.prototype.send = function () {};
  FakeSocket.prototype.close = function () {
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  };
  window.WebSocket = FakeSocket;
  return sockets;
}

function harness(options) {
  const settings = options || {};
  /* jsdom cannot navigate: an attempt comes back as a "Not implemented" error.
     The wall's own decision is what the checks read (from the page's `local()`
     seam), but the attempts are kept here as well — a move this page believes it
     made, and the browser was never even asked, is a different bug from one the
     browser refused. */
  const navigations = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    const message = (error && error.message) || "";
    if (/not implemented: navigation/i.test(message)) {
      navigations.push(message);
      return;
    }
    console.error(error);
  });
  const dom = new JSDOM(page, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: settings.url || "http://localhost:49170/",
    virtualConsole,
  });
  const window = dom.window;
  const document = window.document;

  // jsdom ships without matchMedia, fetch or speech; the panel uses all three.
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  });
  if (settings.speech) installFakeSpeech(window);
  const microphone = settings.microphone ? installFakeAudio(window, settings.microphone === true ? {} : settings.microphone) : null;
  if (settings.insecure) {
    Object.defineProperty(window, "isSecureContext", { configurable: true, get: () => false });
  }

  const calls = {
    state: 0, play: [], control: [], queue: [], library: [],
    answer: [], dismiss: 0, search: [], lyrics: [], failed: 0,
    voice: [], clips: [],
  };
  const mode = settings.mode || "light";
  const state = {
    panel: {
      skill_id: "opendeck", skill_name: "OpenDeck", port: 49170, available: true,
      // Where the push channel is, as the console advertises it.
      stream: "/api/panel/socket",
      // Where the console says it lives on its own network: the address a wall
      // display is meant to be pointed at, and what the panel moves itself onto
      // when it was opened anywhere else.
      url: BOX_HTTP,
      tls_port: 49171, url_https: BOX_HTTPS,
      // Which panel the console is serving: the display compares it with the one
      // it booted into, so a check moves the console on by changing this.
      build: settings.build || "build-1",
    },
    theme: {
      mode: mode,
      hour: mode === "dark" ? 22 : 12,
      minute: 0,
      timezone: "America/Chicago",
      dark_from_hour: 22,
      dark_until_hour: 6,
      local_time: settings.localTime || (mode === "dark" ? "22:00" : "12:00"),
    },
    track: settings.track === null ? null : (settings.track || track("v1", "First Song")),
    playing: settings.playing === undefined ? false : settings.playing,
    // Whether the console started this track out of the queue, and would follow
    // it: the panel waits for that advance, and plays the next song itself when
    // it is not coming.
    queueActive: settings.queueActive === undefined ? true : settings.queueActive,
    player: { volume: 0.5, muted: false, confirmed: true, device: "Nix Dev", state: "paused" },
    // The console's own position: a check moves the song by moving this.
    position: settings.position || 0,
    queue: settings.queue || [
      { video_id: "q1", title: "Queued One", artist: "Someone", duration_sec: 120, artwork_url: "https://example.invalid/q1.jpg" },
      { video_id: "q2", title: "Queued Two", artist: "Someone", duration_sec: 130, artwork_url: "" },
    ],
    shuffle: false,
    repeat: "all",
    question: settings.question || null,
    lyrics: settings.lyrics || [
      { time_sec: 0, text: "First line" },
      { time_sec: 20, text: "Second line" },
    ],
  };
  // Answers the check decides when to hand over, for the case that matters most
  // on a wall display: what is on the screen before the console answers.
  const holdings = [];
  const hold = () => new Promise((resolve) => { holdings.push(resolve); });

  const nowPlaying = () => ({
    ok: true,
    track: state.track,
    playing: state.playing,
    player: state.player,
    position: { elapsed_sec: state.position, duration_sec: state.track ? state.track.duration_sec : 0 },
    queue_active: state.queueActive,
    handoff: { supported: true },
  });

  /* The console's own end-of-track behaviour, as the panel finds it: on a state
     read, a queue-sourced track whose speaker has gone idle at the end of it is
     handed over to the next queued song (this is `_maybe_advance_queue` in
     nix_core/music_api.py, driven by the panel's own poll). */
  function maybeAdvance() {
    if (!state.queueActive || state.playing || !state.track) return;
    if (state.position < (state.track.duration_sec || 0) - 1) return;
    const next = state.queue.filter((item) => item.video_id !== state.track.video_id)[0];
    if (!next) return;
    state.track = next;
    state.position = 0;
    state.playing = true;
  }

  const queuePayload = () => ({
    ok: true,
    action: "queue",
    queue: state.queue,
    index: state.queue.findIndex((item) => state.track && item.video_id === state.track.video_id),
    count: state.queue.length,
    shuffle: state.shuffle,
    repeat: state.repeat,
    message: "",
  });

  // The console, as the panel listener serves it: the same routes and the same
  // payload shapes the real handlers answer with.
  const routes = {
    "GET /api/panel/state": async () => {
      calls.state += 1;
      if (settings.hold) await hold();
      if (settings.stateFail) {
        return { ok: false, error: "the console is not there" };
      }
      maybeAdvance();
      return {
        ok: true,
        panel: state.panel,
        theme: state.theme,
        question: state.question,
        server_time: new Date().toISOString(),
        now_playing: nowPlaying(),
        queue: queuePayload(),
      };
    },
    "GET /api/music/queue": () => queuePayload(),
    // The console's own recogniser, and the clip that arrives at it: what the
    // page records is checked as a WAV before it is answered.
    "GET /api/voice": () => ({
      ok: true,
      available: settings.voiceEngine !== false,
      engine: "whisper",
      model: "openai/whisper-small.en",
      device: "cuda",
      loaded: true,
      max_seconds: 30,
    }),
    "POST /api/voice/transcribe": (url, body, raw) => {
      calls.clips.push(raw);
      if (settings.voiceFail) return { ok: false, code: "stt_failed", error: "the model could not read that" };
      const said = settings.transcript === undefined ? "Play Bohemian Rhapsody." : settings.transcript;
      calls.voice.push(said);
      return { ok: true, text: said, seconds: 2.1, silent: !said, engine: "whisper", device: "cuda" };
    },
    "GET /api/music/library": (url) => {
      const kind = url.searchParams.get("kind") || "playlists";
      calls.library.push([
        kind,
        url.searchParams.get("playlist_id") || undefined,
        Number(url.searchParams.get("limit") || 0) || 0,
      ]);
      if (settings.hold) return hold().then(() => libraryPayload(kind, url));
      return libraryPayload(kind, url);
    },
    "GET /api/music/search": (url) => {
      calls.search.push(url.searchParams.get("q"));
      return { ok: true, tracks: [track("s1", "Search Result")], count: 1 };
    },
    "GET /api/music/lyrics": (url) => {
      calls.lyrics.push(url.searchParams.get("video_id"));
      if (settings.lyricsFail) return Promise.reject(new Error("the console is not there"));
      // The other two answers the console really gives: words with no timings
      // (plain text), and no words at all. Both leave the page holding an empty
      // `synced`, which is a list, not a truthy line.
      if (settings.lyricsPlain !== undefined) {
        return { ok: true, lyrics: [], lyrics_plain: settings.lyricsPlain, lyrics_timing: "plain", count: 0 };
      }
      return { ok: true, lyrics: state.lyrics, lyrics_timing: "synced", count: state.lyrics.length };
    },
    "POST /api/music/control": (url, body) => {
      calls.control.push(body.value === undefined ? [body.action] : [body.action, body.value]);
      if (body.action === "volume") state.player.volume = body.value;
      if (body.action === "resume") state.playing = true;
      if (body.action === "pause") state.playing = false;
      if (body.action === "mute") state.player.muted = true;
      if (body.action === "unmute") state.player.muted = false;
      return { ok: true, player: state.player };
    },
    "POST /api/music/play": (url, body) => {
      calls.play.push(body);
      if (state.failNextPlay) {
        state.failNextPlay = false;
        return { ok: false, error: "the speaker is not answering" };
      }
      // The console resolves the request and hands it to the speaker.
      if (body.video_id && state.track && body.video_id === state.track.video_id) {
        return { ok: true, track: state.track };
      }
      const found = findTrack(body.video_id || body.query);
      if (found) { state.track = found; state.playing = true; state.position = 0; }
      return { ok: true, track: state.track, now_playing: nowPlaying() };
    },
    "POST /api/music/queue": (url, body) => {
      calls.queue.push(body);
      if (body.action === "clear") state.queue = [];
      if (body.action === "add") state.queue.push(findTrack(body.video_id));
      if (body.action === "next") {
        // The console's next starts the queue's next track, which is what the
        // provider's `op: next` does; the track being played is the one the
        // queue has already handed over, so it is not the next one.
        const next = state.queue.filter((item) => !state.track || item.video_id !== state.track.video_id)[0];
        if (next) { state.track = next; state.position = 0; state.playing = true; }
        else { state.track = track("next", "Next Song"); state.position = 0; }
      }
      if (body.action === "play" && state.queue[body.index]) {
        state.track = findTrack(state.queue[body.index].video_id) || state.queue[body.index];
        state.playing = true;
        state.position = 0;
      }
      return { ...queuePayload(), now_playing: nowPlaying() };
    },
    "POST /api/panel/answer": (url, body) => {
      calls.answer.push(body.index);
      const chosen = (state.question && state.question.options || [])[body.index];
      state.question = null;   // the console closes the question it just answered
      if (chosen) {
        state.track = chosen;
        state.playing = true;
        state.position = 0;
      }
      return { ok: true, chosen: chosen || null };
    },
    // Deliberately left pending: the console clears a dismissed question, and the
    // point of the check is what the panel does when one comes back anyway.
    "POST /api/panel/dismiss": () => {
      calls.dismiss += 1;
      return { ok: true, dismissed: true };
    },
  };

  function findTrack(id) {
    if (!id) return null;
    const pool = [state.track, ...(state.queue || []), ...(state.question ? state.question.options : []),
      track("t1", "Playlist Track"), track("t9", "Liked Track"), track("s1", "Search Result")];
    const hit = pool.filter(Boolean).find((item) => item && item.video_id === id);
    return hit || track(id, id);
  }

  // A library big enough to have more songs than a shelf row can show, which is
  // the case the panel has to be honest about ("See all", not a shelf that
  // claims a 439-song playlist is three songs long).
  const likedTracks = [track("t9", "Liked Track"), track("t10", "Another Like"), track("t11", "Third Like")];
  const frequentTracks = Array.from({ length: 30 }, (_, index) => ({
    ...track("f" + index, "Often Played " + (index + 1)),
    plays: 30 - index,
  }));
  // Fifty songs, most of them past the page a shelf row reads.
  const longHaulTracks = Array.from({ length: 50 }, (_, index) =>
    track("h" + index, "Long Haul " + (index + 1)));

  function libraryPayload(kind, url) {
    if (kind === "playlists") {
      return {
        ok: true, kind: "playlists", count: 3,
        playlists: [
          { playlist_id: "p1", name: "Focus", track_count: 3, artwork_url: "https://example.invalid/p1.jpg" },
          // A big playlist whose songs this build will not read back: the shelf
          // still has to show the count the console knows.
          { playlist_id: "p2", name: "Long Haul", track_count: 50, artwork_url: "https://example.invalid/p2.jpg" },
          // The liked songs as the account's own client lists them: an auto
          // playlist with a cover of its own and far more songs than one row.
          { playlist_id: "LM", name: "Liked Music", track_count: 439, artwork_url: "https://example.invalid/lm.jpg" },
        ],
      };
    }
    if (kind === "playlist") {
      const id = url.searchParams.get("playlist_id");
      const limit = Number(url.searchParams.get("limit") || 24) || 24;
      // Long Haul is fifty songs, and it answers a read with as many of them as
      // were asked for: the shelf reads the first page, See all reads the rest,
      // so most of its songs are ones the wall has never seen — which is where
      // the ids used to be shown instead of the names.
      if (id === "p2") {
        return { ok: true, kind: "playlist", playlist_id: id, count: longHaulTracks.length, tracks: longHaulTracks.slice(0, limit) };
      }
      return {
        ok: true, kind: "playlist", playlist_id: id, count: 3,
        tracks: [track("t1", "Playlist Track"), track("t2", "Second Track"), track("t3", "Third Track")],
      };
    }
    if (kind === "frequent") {
      return { ok: true, kind: "frequent", count: frequentTracks.length, tracks: frequentTracks };
    }
    if (kind === "likes") {
      return { ok: true, kind: "likes", count: likedTracks.length, tracks: likedTracks };
    }
    return { ok: true, kind: kind, count: 1, tracks: [track("t9", "Liked Track")] };
  }

  window.fetch = (target, init) => {
    const url = new URL(String(target), "http://localhost:49170/");
    const method = (init && init.method) || "GET";
    const key = `${method} ${url.pathname}`;
    // A display that is nowhere near the box: its own address does not answer at
    // all, which is what a wall watched from outside the house sees.
    if (settings.boxUnreachable && url.hostname === BOX_HOST) {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    const rawBody = init && init.body ? init.body : null;
    if (url.pathname.startsWith("/api/music/artwork")) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
    }
    const handler = routes[key];
    if (!handler) {
      calls.failed += 1;
      return Promise.resolve({
        ok: false, status: 404,
        text: () => Promise.resolve(JSON.stringify({ ok: false, error: "no such panel route", path: key })),
      });
    }
    let body = {};
    if (init && init.body) { try { body = JSON.parse(init.body); } catch (error) { body = {}; } }
    let answer;
    try {
      // Handlers take (url, parsed body, raw body): the voice route is answered
      // from the clip itself, which is audio rather than JSON.
      answer = handler(url, body, rawBody);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(answer).then((payload) => ({
      ok: payload && payload.ok !== false,
      status: payload && payload.ok === false ? 500 : 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
    }));
  };

  // The wall's own push channel, answered by hand: see installFakeSocket.
  const sockets = installFakeSocket(window);

  // A boot with something already stored: the storage goes in before the panel
  // hydrates from it, the way a real second visit works.
  Object.keys(settings.storage || {}).forEach((keyName) => {
    window.localStorage.setItem(keyName, settings.storage[keyName]);
  });

  window.eval(source);

  return {
    window,
    document,
    calls,
    state,
    microphone,
    navigations,
    settle,
    wait,
    /* The budget is generous on purpose: several of these waits are for a real
       timer (the idle page after a quiet second), and a busy machine — a test run
       beside a build, a browser being driven in the next process — was seen to
       take longer than six seconds to reach one. The wait is bounded either way,
       so a panel that really never gets there still fails. */
    until: async (what, test, ms) => {
      const started = Date.now();
      for (;;) {
        if (test()) return;
        if (Date.now() - started > (ms || 20000)) throw new Error("timed out waiting for " + what);
        await wait(120);
      }
    },
    release: () => { holdings.splice(0).forEach((resolve) => resolve()); },
    stored: () => {
      const raw = window.localStorage.getItem("nix.panel.cache.v2");
      return raw ? JSON.parse(raw) : null;
    },
    /* The panel polls on its own timer, the way a wall display does; a check that
       has moved the world on asks for the next poll by handing the page back its
       own visibility signal, which is also what a real screen coming back does. */
    poll: async () => {
      document.dispatchEvent(new window.Event("visibilitychange"));
      await settle();
    },
    text: (selector) => {
      const el = document.querySelector(selector);
      return el ? el.textContent : null;
    },
    el: (selector) => document.querySelector(selector),
    els: (selector) => [...document.querySelectorAll(selector)],
    click: (selector) => {
      const el = typeof selector === "string" ? document.querySelector(selector) : selector;
      assert.ok(el, `nothing to click for ${selector}`);
      el.click();
      return el;
    },
    key: (selector, name) => {
      const el = typeof selector === "string" ? document.querySelector(selector) : selector;
      el.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    },
    /* A thumb on a slider: the panel's own pointer path, not a private method. */
    drag: (selector, clientX) => {
      const el = document.querySelector(selector);
      el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 12, right: 100, bottom: 12, x: 0, y: 0 });
      el.dispatchEvent(new window.MouseEvent("pointerdown", { clientX: clientX, bubbles: true, cancelable: true }));
      window.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true }));
    },
    /* The microphone, driven by hand: the check owns the clock the panel reads,
       so a spoken phrase and the quiet after it cost milliseconds of test time
       instead of the seconds a real recording takes. */
    speak: async ({ phrase = 900, quiet = 1800, level = 0.3 } = {}) => {
      if (!microphone || !microphone.processors.length) throw new Error("nothing is recording");
      const node = microphone.processors.at(-1);
      const started = Date.now();
      let offset = 0;
      window.Date.now = () => started + offset;
      // One callback per 4096-sample buffer, the size the panel asks for, for as
      // long as the moment it is imitating lasts.
      const stepMs = (4096 / (microphone.sampleRate || 48000)) * 1000;
      const pump = (ms, sample) => {
        const chunk = new Float32Array(4096).fill(sample);
        microphone.level = sample;
        for (let at = 0; at < ms; at += stepMs) {
          // The panel ends the recording itself (the silence rule), and then
          // there is no handler left to drive — exactly like a real node.
          if (typeof node.onaudioprocess !== "function") return;
          offset += stepMs;
          node.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } });
        }
      };
      pump(phrase, level);
      pump(quiet, 0);
      await settle();
    },
    pagehide: () => window.dispatchEvent(new window.Event("pagehide")),
    unmount: () => window.close(),
    /* The panel's push channel, driven from the check: what the console saying
       "something moved" does to the wall, and what a dropped channel costs. */
    socket: {
      count: () => sockets.length,
      last: () => sockets.at(-1) || null,
      open: () => {
        const ws = sockets.at(-1);
        assert.ok(ws, "the panel opened no push channel");
        ws.readyState = 1;
        if (ws.onopen) ws.onopen({});
        return ws;
      },
      event: (name) => {
        const ws = sockets.at(-1);
        assert.ok(ws, "the panel opened no push channel");
        ws.readyState = 1;
        if (ws.onopen) ws.onopen({});
        ws.onmessage({ data: JSON.stringify({ type: "event", event: name || "change" }) });
      },
      drop: () => {
        const ws = sockets.at(-1);
        assert.ok(ws, "the panel opened no push channel");
        ws.readyState = 3;
        if (ws.onclose) ws.onclose({});
      },
    },
  };
}

/* The lyrics design moves the words by transform, not by scrolling, so the
   follow-along is measured from the computed offset. jsdom has no layout: every
   element reports zero, so the scrolling box and the rendered lines are given
   the geometry a real panel has, and the transform the panel writes is read back
   through the live style — the same value the compositor would be handed. */
function lyricGeometry(h) {
  const viewport = 200;
  const lineHeight = 40;
  const win = h.window;
  /* A line is taller the more the words are zoomed, the way a real layout grows:
     the follow-along is measured against this, so the zoom has to re-measure for
     the block to stay centred rather than drift by half a line. */
  const zoom = () => parseFloat(h.el("#lyricsOverlay").style.getPropertyValue("--lyr-zoom")) || 1;
  Object.defineProperty(win.Element.prototype, "clientHeight", {
    configurable: true,
    get() { return this.id === "lyrScroller" ? viewport : 0; },
  });
  Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() { return this.classList && this.classList.contains("lyr-line") ? lineHeight * zoom() : 0; },
  });
  Object.defineProperty(win.HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get() {
      const parent = this.parentElement;
      if (!parent || !(this.classList && this.classList.contains("lyr-line"))) return 0;
      const peers = [...parent.children].filter((child) => child.matches(".lyr-line[data-t]"));
      return Math.max(0, peers.indexOf(this)) * lineHeight * zoom();
    },
  });
  // A display that is measured differently re-measures: the panel listens for
  // the screen changing, exactly as a real rotation or font swap would.
  win.dispatchEvent(new win.Event("resize"));
  return { viewport, lineHeight, offset: () => h.el("#lyrLines").style.transform };
}

/* The centre the follow-along must land on, computed from the same geometry:
   the box's middle minus the middle of the line being sung. */
function centredOffset(geometry, index, zoom) {
  const line = geometry.lineHeight * (zoom || 1);
  return geometry.viewport / 2 - (index * line + line / 2);
}

const transformFor = (value) => `translate3d(0,${value.toFixed(2)}px,0)`;

/* ── checks ──────────────────────────────────────────────────────────────── */

check("the panel paints what the console says is playing into the design", async () => {
  const h = harness({ track: track("v1", "First Song", { artwork_url: IMG }) });
  await h.settle();
  assert.equal(h.text("#npTitle"), "First Song");
  assert.equal(h.text("#npArtist"), "Test Artist");
  assert.equal(h.text("#npAlbum"), "Test Album · 3:20", "the album and the length share one line");
  assert.equal(h.text("#npSource"), "Playing from Nix PUCA");
  assert.equal(h.text("#tCur"), "0:00");
  assert.equal(h.text("#tLeft"), "-3:20");
  assert.equal(h.text("#volPct"), "50%");
  assert.equal(h.document.title, "First Song · Test Artist — PUCA");
  const art = h.el("#heroImg");
  assert.equal(art.hidden, false, "the design's cover slot carries the artwork");
  assert.ok(
    art.src.includes("/api/music/artwork?src=" + encodeURIComponent(IMG)),
    "the console's own cached copy is asked for, not the CDN: " + art.src,
  );
  assert.equal(h.el("#heroGlyph").hidden, true, "and the fallback glyph steps aside");
  assert.equal(h.window.__puca.connected(), true, "the panel is talking to the console");
  assert.equal(h.text(".brand").trim(), "", "and its brand is the mark alone, with no lettering");
  assert.equal(h.calls.failed, 0, "every route the panel asked for is one the console serves");
  h.unmount();
});

check("the panel fills the design's own elements, and no others", async () => {
  const h = harness();
  await h.settle();
  // Every control the script wires has to exist in the markup it ships with.
  const wired = [...new Set([...source.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]))];
  assert.ok(wired.length > 40, "the script wires the design's controls by id");
  for (const id of wired) {
    assert.ok(h.document.getElementById(id), `the design's markup has #${id}`);
  }
  // And the classes the page and the script paint with are the design's own:
  // a port that invented its own class names would render unstyled.
  const vocabulary = [
    "drift", "top", "brand", "logo", "searchbar", "lens", "mic", "go", "clockbox", "daylight",
    "grid", "left", "hero", "artwrap", "art", "glow", "meta", "eyebrow", "dot", "scrub", "times",
    "controls", "chip", "round", "volumerow", "slider", "vol", "pct",
    "shelves", "shelf", "shelf-head", "row", "tile", "cover", "mark", "name", "sub", "playbadge",
    "side", "side-head", "queue", "qart", "qmeta", "qt", "qa", "qd", "empty", "tiny",
    "sheet", "results", "res", "rart", "rt", "ra", "rtag", "hint",
    "resline", "res-queue", "resgroup", "tilegrid",
    "rail", "railhead", "railnav", "railbtn",
    "overlay", "ask", "ask-card", "ask-eyebrow", "ask-heard", "ask-options", "opt", "oart", "ot",
    "oa", "num", "ask-foot", "mic-hint", "ghost",
    "lyrics", "lyr-bg", "lyr-head", "lyr-close", "lyr-scroller", "lyr-lines", "lyr-line", "pill",
    "lyr-foot", "lyr-times", "lyr-zoom", "lyr-zoom-label", "toast", "playing-ring", "dragging", "listening",
  ];
  const missing = vocabulary.filter((name) => !stylesheet.includes("." + name));
  assert.deepEqual(missing, [], "the design's stylesheet styles the whole page");
  h.unmount();
});

check("a music card is mostly its cover, and is sized to be read across a room", () => {
  /* jsdom lays nothing out, so what there is to read here is the rule the wall is
     painted with. Two things have to hold at once: a music card is its sleeve
     rather than a padded card, and it is big — the shelves, the library page and
     the search rails are the same card, and they were asked for bigger so their
     names can be read from the sofa. */
  const rule = /\.tile \{([^}]*)\}/.exec(stylesheet);
  assert.ok(rule, "the design's stylesheet has the tile rule");
  // The clamp is read as the wall's own rule, so the numbers may be anything a
  // fluid size is: the ceilings were raised with the rest of the page (the wall
  // is read from further back than the design assumed), and a size that has
  // moved up is still the design's clamp.
  const width = /width: clamp\(([\d.]+)px, ([\d.]+)vw, ([\d.]+)px\)/.exec(rule[1]);
  assert.ok(width, "its width is the design's own clamp: " + rule[1].trim());
  assert.ok(Number(width[3]) >= 300, "sized to be read from across the room: " + width[3] + "px");
  const padding = /padding: clamp\(([\d.]+)px/.exec(rule[1]);
  assert.ok(padding, "and it is padded by the design's own clamp");
  assert.ok(Number(padding[1]) <= 5,
    "with the cover taking the tile rather than a card margin: " + padding[1] + "px");
  // The same card, the same size, in the rails of a search or a song list.
  const rail = /\.rail > \.resline \{([^}]*)\}/.exec(stylesheet);
  assert.ok(rail, "a rail has its card rule");
  const railWidth = /width: clamp\(([\d.]+)px, ([\d.]+)vw, ([\d.]+)px\)/.exec(rail[1]);
  assert.ok(railWidth && Number(railWidth[3]) >= 400,
    "and the rail's cards are as big as the shelves': " + JSON.stringify(railWidth));
  // The library page is the same tile, in as many columns as the wall will hold.
  assert.match(stylesheet, /\.tilegrid \{[^}]*grid-template-columns: repeat\(auto-fill/,
    "the library page lays the same tiles out in columns");
});

check("the whole wall came up together, and the player is still the smaller card", () => {
  /* Asked for by name: everything bigger, because the wall is read from further
     back than the design assumed — the player included, which is why its cover
     and its text moved up with the shelves and the sheets rather than staying at
     the design's own numbers. What must not change is the order of the two: a
     shelf card is the card read from the sofa and the now-playing card stays
     narrower than it, so the wall does not become a screen of tiles. */
  const art = /\.art \{([^}]*)\}/.exec(stylesheet);
  assert.ok(art, "the player's cover has its rule");
  const width = /width: clamp\(([\d.]+)px, ([\d.]+)vw, ([\d.]+)px\)/.exec(art[1]);
  assert.ok(width, "its width is still the design's own clamp: " + art[1].trim());
  const tileWidth = /width: clamp\(([\d.]+)px, ([\d.]+)vw, ([\d.]+)px\)/
    .exec(/\.tile \{([^}]*)\}/.exec(stylesheet)[1]);
  assert.ok(Number(width[3]) < Number(tileWidth[3]),
    "and it stayed the smaller card: " + JSON.stringify(width) + " under " + tileWidth[3] + "px");
  // The same for its words: raised with the page, still a caption rather than a
  // headline, so the title of the song is what the card is looked at for.
  const meta = /\.meta \.eyebrow \{[^}]*font-size: clamp\(([\d.]+)px, ([\d.]+)vw, ([\d.]+)px\)/.exec(stylesheet);
  assert.ok(meta && Number(meta[3]) <= 22, "and so is its text: " + JSON.stringify(meta));
  const title = /\.meta h1 \{[^}]*font-size: clamp\(([\d.]+)px, ([\d.]+)vw, ([\d.]+)px\)/.exec(stylesheet);
  assert.ok(title && Number(title[3]) > Number(tileWidth[3]) * 0.2,
    "with the title still the biggest line on the card: " + JSON.stringify(title));
});

check("the theme follows the console's clock, not the browser's", async () => {
  const night = harness({ mode: "dark" });
  await night.settle();
  // The clock is written on the panel's own tick, from the console's answer.
  await night.wait(1100);
  assert.equal(night.document.documentElement.classList.contains("night"), true, "night mode after 10PM");
  assert.equal(night.document.documentElement.classList.contains("day"), false);
  assert.equal(night.text("#clock"), "10:00");
  assert.equal(night.text("#ampm"), "PM");
  assert.equal(night.text("#daylight").trim(), "night");
  assert.equal(night.el("#metaTheme").getAttribute("content"), "#04050a");
  night.unmount();

  const day = harness({ mode: "light", localTime: "06:52" });
  await day.settle();
  await day.wait(1100);
  assert.equal(day.document.documentElement.classList.contains("day"), true, "day mode from 6AM");
  assert.equal(day.text("#clock"), "6:52", "the console's own time, not the browser's");
  assert.equal(day.text("#ampm"), "AM");
  assert.equal(day.el("#metaTheme").getAttribute("content"), "#ffffff");
  day.unmount();
});

check("the lyrics design opens by itself for the track that is playing", async () => {
  const h = harness();
  await h.settle();
  await h.wait(30);
  assert.deepEqual(h.calls.lyrics, ["v1"], "the playing track's lyrics are fetched");
  assert.equal(h.el("#lyricsOverlay").hidden, false, "the lyrics overlay is open");
  assert.equal(h.document.body.classList.contains("lyrics-on"), true);
  assert.equal(h.text("#lyrTitle"), "First Song");
  assert.equal(h.text("#lyrArtist"), "Test Artist");
  const lines = h.els("#lyrLines .lyr-line[data-t]");
  assert.deepEqual(lines.map((line) => line.textContent), ["First line", "Second line"]);
  assert.match(h.el("#lyrLines").innerHTML, /class="pill"/, "the design's title pill heads the words");
  assert.equal(lines[0].classList.contains("cur"), true, "the line being sung is marked");
  assert.equal(lines[1].classList.contains("next"), true);
  h.unmount();
});

check("a track whose words are plain text, or missing, cannot stop the wall", async () => {
  /* The state a wall sat in: `synced: []` is truthy, so reading the last word of
     nothing threw inside the poll's own chain. The panel reported "reconnecting"
     on a console that had answered every request, stopped following the music,
     and never advanced the queue when a song ended — the words are the least
     important thing on the wall and must never be able to stop it. */
  const words = harness({ playing: true, lyrics: [], lyricsPlain: "First line\nSecond line" });
  await words.settle();
  assert.equal(words.window.__puca.idle().connected, true,
    "the console answered, so the wall is live");
  assert.equal(words.window.__puca.connected(), true, "which the console tab can read");
  assert.equal(words.window.__puca.lastError(), null, "and nothing this page drew threw");
  assert.equal(words.el("#lyricsOverlay").hidden, false, "the words are still up");
  assert.match(words.text("#lyrLines"), /First line/, "showing the plain lines the console gave");
  // And the wall keeps following the music rather than dying on a stale state.
  words.state.track = track("v2", "Second Song");
  await words.poll();
  assert.equal(words.text("#npTitle"), "Second Song", "the wall follows the console to the next song");
  assert.equal(words.window.__puca.idle().connected, true, "still live");
  assert.equal(words.window.__puca.lastError(), null, "with no failure recorded");
  words.unmount();

  const none = harness({ playing: true, lyrics: [], lyricsPlain: "" });
  await none.settle();
  assert.equal(none.window.__puca.idle().connected, true, "no words at all is not an error either");
  assert.equal(none.window.__puca.lastError(), null);
  assert.match(none.text("#lyrLines"), /No words are available|Waiting for the words/,
    "and the design says so instead of breaking");
  // The queue still advances when the song ends, which the same crash used to
  // skip: the words failing is never the music failing.
  none.state.position = 200;
  none.state.playing = false;
  none.state.queueActive = false;
  await none.poll();
  assert.deepEqual(plain(none.calls.queue).filter((call) => call.action === "next"), [{ action: "next" }],
    "a song played on its own still hands the queue on");
  none.unmount();
});

check("closing the lyrics keeps them closed for that track, and a new track opens them again", async () => {
  const h = harness();
  await h.settle();
  h.click("#lyrClose");
  assert.equal(h.el("#lyricsOverlay").hidden, true, "closed by the user");
  assert.equal(h.document.body.classList.contains("lyrics-on"), false);

  await h.poll();
  assert.equal(h.el("#lyricsOverlay").hidden, true, "the next poll does not reopen them");
  assert.deepEqual(h.calls.lyrics, ["v1"], "and does not refetch them either");

  h.state.track = track("v2", "Second Song");
  await h.poll();
  await h.wait(30);
  assert.deepEqual(h.calls.lyrics, ["v1", "v2"], "the new track's lyrics are fetched");
  assert.equal(h.el("#lyricsOverlay").hidden, false, "and shown without being asked");

  // The design offers its own toggle as well, and that one reopens them.
  h.click("#btnLyrics");
  assert.equal(h.el("#lyricsOverlay").hidden, true);
  h.click("#btnLyrics");
  assert.equal(h.el("#lyricsOverlay").hidden, false, "the Lyrics chip brings them back");
  h.unmount();
});

check("the words follow the line being sung, and stay put when it does not move", async () => {
  const lyrics = Array.from({ length: 20 }, (_, index) => ({ time_sec: index * 10, text: "Line " + (index + 1) }));
  const h = harness({ lyrics });
  await h.settle();
  const geometry = lyricGeometry(h);
  assert.equal(h.el("#lyricsOverlay").hidden, false, "the words are open");

  // The song reaches the fourth line. The panel glides the block to it, so the
  // check waits for the glide to come to rest and then measures.
  h.state.position = 30;
  await h.poll();
  await h.wait(700);
  assert.equal(
    geometry.offset(),
    transformFor(centredOffset(geometry, 3)),
    "the line being sung is centred in the design's own box",
  );

  // A tick that does not change the line must leave the block alone: rewriting
  // the transform per frame is what makes a follow-along stutter and fight a
  // person who has scrolled the words themselves.
  const resting = geometry.offset();
  h.state.position = 31;
  await h.poll();
  await h.wait(500);
  assert.equal(geometry.offset(), resting, "an unchanged line is not moved again");

  // A new track starts from the top of its own words.
  h.state.track = track("v2", "Second Song");
  h.state.position = 0;
  await h.poll();
  await h.wait(60);
  assert.equal(h.el("#lyricsOverlay").hidden, false, "the new track's words are shown");
  assert.equal(
    geometry.offset(),
    transformFor(centredOffset(geometry, 0)),
    "the block is placed at the first line without waiting for an animation",
  );
  h.unmount();
});

check("words already on screen survive a console that cannot answer", async () => {
  // A visit that has the words for the track it is playing…
  const first = harness();
  await first.settle();
  assert.ok(first.stored().lyrics["v1"], "the words are cached with the rest of the reads");
  first.pagehide();
  const stored = first.stored();
  first.unmount();

  // …and a later boot where the console cannot answer at all.
  const offline = harness({
    stateFail: true,
    lyricsFail: true,
    storage: { "nix.panel.cache.v2": JSON.stringify(stored) },
  });
  await offline.settle();
  await offline.wait(30);
  assert.equal(offline.el("#lyricsOverlay").hidden, false, "the overlay is still open");
  assert.deepEqual(
    offline.els("#lyrLines .lyr-line[data-t]").map((line) => line.textContent),
    ["First line", "Second line"],
    "with the words that were already there",
  );
  assert.equal(offline.window.__puca.connected(), false, "and it reports the console is not back");
  offline.unmount();
});

check("a panel that has run before paints the track, the queue and the library before the console answers", async () => {
  // A visit where the console answers everything…
  const first = harness();
  await first.settle();
  first.pagehide();
  const stored = first.stored();
  assert.ok(stored, "the panel's reads are persisted at all");
  assert.equal(stored.state.nowPlaying.title, "First Song", "the track that was playing is remembered");
  assert.equal(stored.queueTracks.length, 2, "the queue is remembered with its tracks");
  assert.ok(stored.library.playlists.length > 0, "the library tab is remembered");
  assert.ok(!JSON.stringify(stored).includes('"question"') || stored.state.ask === null,
    "a question is never revived from storage");
  first.unmount();

  // Yesterday's copy, held: a later boot paints it at once, before the console
  // has said anything at all.
  const held = harness({ hold: true, storage: { "nix.panel.cache.v2": JSON.stringify(stored) } });
  await held.settle();
  assert.equal(held.text("#npTitle"), "First Song", "the remembered track is on the wall");
  assert.equal(held.el("#heroImg").hidden, false, "with its cover");
  assert.equal(held.els("#queue li").length, 2, "and the queue it had");
  assert.ok(held.el("#shelves .tile"), "and the library it was looking at");
  assert.equal(held.window.__puca.connected(), false, "and does not claim the console is back yet");
  assert.equal(held.calls.state, 1, "the console is asked anyway");

  // When the console answers, the same surfaces are repainted from it.
  held.release();
  await held.settle();
  assert.equal(held.window.__puca.connected(), true, "the console's own answer replaces the remembered one");
  held.unmount();
});

check("the transport and the volume reach the console", async () => {
  const h = harness({ playing: false });
  await h.settle();
  h.click("#btnPlay");
  await h.settle();
  assert.deepEqual(plain(h.calls.control.at(-1)), ["resume"], "play resumes a paused speaker");

  h.state.playing = true;
  await h.poll();
  assert.equal(h.document.body.classList.contains("playing"), true, "and the panel follows what is playing");
  assert.equal(h.el("#npDot").style.background, "var(--accent)");

  // The volume is a slider the panel owns: a nudge of the keyboard settles on a
  // level and sends that level, once.
  const before = h.calls.control.length;
  h.key("#volSlider", "ArrowRight");
  await h.wait(300);
  assert.deepEqual(plain(h.calls.control.at(-1)), ["volume", 0.55]);
  assert.ok(h.calls.control.length - before < 3, "one nudge is not one request per frame");

  h.click("#btnMute");
  await h.settle();
  assert.deepEqual(plain(h.calls.control.at(-1)), ["mute"]);
  h.unmount();
});

check("the library lists the account's playlists and plays the track a tile shows", async () => {
  const h = harness();
  await h.settle();
  const playlists = h.els("#shelves .tile[data-playlist]");
  assert.ok(playlists.length >= 2, "the shelves carry a row of playlists");
  assert.equal(playlists[0].getAttribute("data-playlist"), "surprise", "led by the design's own tile");

  const songs = h.els('#shelves .tile[data-track]');
  assert.ok(songs.length > 0, "and its songs are tiles of their own");
  songs[0].click();
  await h.settle();
  assert.deepEqual(plain(h.calls.play.at(-1)), { video_id: songs[0].getAttribute("data-track") },
    "a tile plays the track it shows");
  assert.deepEqual(
    h.calls.library.filter((entry) => entry[0] === "playlists").length, 1,
    "the playlist list is read once, not once per shelf",
  );
  h.unmount();
});

check("every row the design draws wears the cover the console knows", async () => {
  const h = harness({
    question: { id: "a1", prompt: "Which one did you mean?", heard: "shadow", options: [track("o1", "Shadow")] },
  });
  await h.settle();

  /* Covers reach the panel through the console's own artwork cache, so the src
     the design is handed is that cache's URL with the provider's own behind it. */
  const cover = (root, selector) => {
    const img = root.querySelector(selector);
    if (!img) return null;
    return decodeURIComponent(String(img.getAttribute("src")).replace(/^.*[?&](?:u|src)=/, ""));
  };

  // A playlist's own tile: the console resolves its cover (Liked Music has one,
  // so do shared playlists), so the tile wears it rather than the monogram.
  const focus = h.document.querySelector('.tile[data-playlist="p1"]');
  assert.equal(cover(focus, "img"), "https://example.invalid/p1.jpg", "a playlist tile shows the playlist's cover");
  assert.equal(focus.querySelector(".mark"), null, "and no letter is drawn over the picture");
  assert.ok(h.document.querySelector('.tile[data-playlist="surprise"] .mark svg'),
    "the tile the panel invents for itself keeps the design's own mark");

  // The queue: a queued song with artwork shows it, one without keeps the flat
  // block the design drew (an empty answer is a song with no cover, not a bug).
  const rows = h.els("#queue li");
  assert.equal(cover(rows[0], ".qart img"), "https://example.invalid/q1.jpg", "a queued song shows its cover");
  assert.equal(rows[1].querySelector(".qart img"), null, "a queued song with no cover keeps the design's block");

  // Results and the options of a question are songs too, and they arrive with
  // their artwork already resolved.
  h.el("#searchInput").value = "second";
  h.el("#searchForm").dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
  await h.settle();
  assert.equal(cover(h.els("#results .res")[0], ".rart img"), "https://example.invalid/s1.jpg",
    "a search result shows the song's cover");
  assert.equal(cover(h.els("#askOptions .opt")[0], ".oart img"), "https://example.invalid/o1.jpg",
    "an option of a question shows the song's cover");
  h.unmount();
});

check("a shelf shows a page of the songs and See all for the rest", async () => {
  const h = harness();
  await h.settle();

  // A song's cover is not the only thing the wall was dropping: a shelf read
  // twelve songs and said nothing about the hundreds it did not read.
  const p1 = h.document.querySelector('.tile[data-playlist="p1"]');
  assert.equal(p1.querySelector(".sub").textContent, "3 songs");
  const likedTile = h.el('#shelves .shelf[data-playlist="liked"] .tile[data-playlist-all]');
  assert.ok(likedTile, "the liked songs have more than a row can hold");
  assert.equal(likedTile.getAttribute("data-playlist-all"), "liked");
  assert.equal(likedTile.querySelector(".sub").textContent, "439 songs",
    "See all says how many there are, not how many were read");
  assert.equal(h.els('#shelves .shelf[data-playlist="liked"] .tile').length, 4,
    "three liked songs and the See-all tile");

  h.click(likedTile);
  await h.settle();
  assert.equal(h.el("#resultsSheet").hidden, false, "the list is a page of its own");
  assert.equal(h.text("#resultsTitle"), "Liked Music",
    "the wall calls it what the console calls it");
  assert.equal(h.els("#results .res").length, 3, "every song it could read is listed");
  assert.match(h.text("#resultsHint"), /3 of 439 songs/, "and the page says what it is showing");
  assert.deepEqual(
    h.calls.library.filter((entry) => entry[0] === "likes").map((entry) => entry[2]).at(-1),
    500,
    "opening the rest asks for the whole playlist, not a page of it",
  );

  // The rows are read as pages too: a playlist row is no longer twelve songs.
  const playlistReads = h.calls.library.filter((entry) => entry[0] === "playlist");
  assert.ok(playlistReads.length > 0, "the shelves read their playlists");
  for (const read of playlistReads) assert.equal(read[2], 24, "a shelf row asks for a page of songs");
  h.unmount();
});

check("a playlist longer than a shelf row lists every song by name, on a rail that slides", async () => {
  const h = harness();
  await h.settle();

  const shelf = h.el('#shelves .shelf[data-playlist="p2"]');
  assert.ok(shelf, "the long playlist has a shelf of its own");
  assert.equal(shelf.querySelector(".shelf-head span").textContent, "50 songs",
    "the count is the console's own, not the page that was read");
  assert.equal(shelf.querySelectorAll(".tile").length, 25, "a page of songs and See all for the rest");
  h.click(shelf.querySelector('.tile[data-playlist-all]'));
  await h.settle();

  assert.equal(h.text("#resultsTitle"), "Long Haul");
  const rows = h.els("#results .res");
  assert.equal(rows.length, 50, "every song is on the page");
  // The songs past the first page are ones no shelf read ever carried: a page
  // built out of the ids alone is how the wall showed "h31" where a song's name
  // belonged, and this is the difference the list page exists to fix.
  const names = rows.map((row) => row.querySelector(".rt").textContent);
  assert.deepEqual(names.slice(24, 27), ["Long Haul 25", "Long Haul 26", "Long Haul 27"],
    "each row wears the song's name, not its video id");
  assert.equal(names.filter((name) => /^h\d+$/.test(name)).length, 0, "no row is named by its id");
  assert.match(rows[24].querySelector(".ra").textContent, /^Test Artist/,
    "and the rest of the console's answer comes with it");

  // The page is a rail: one named group, laid out across the wall, slid by the
  // arrows in its heading (or by a swipe) rather than a strip of text per song.
  assert.deepEqual(h.els("#results .resgroup h3").map((el) => el.textContent), ["Songs"],
    "the page names what it is a list of");
  const rail = h.el("#results .resgroup .rail");
  assert.equal(rail.querySelectorAll(".resline").length, 50, "the songs are the rail's cards");
  const arrows = h.els("#results .resgroup .railbtn");
  assert.equal(arrows.length, 2, "with an arrow each way");
  assert.deepEqual(arrows.map((el) => el.getAttribute("data-rail")), ["-1", "1"]);
  const played = h.calls.play.length;
  const queued = h.calls.queue.length;
  arrows[1].click();
  arrows[0].click();
  await h.settle();
  assert.equal(h.calls.play.length, played, "the arrows are controls of the sheet, never a song");
  assert.equal(h.calls.queue.length, queued, "and sliding plays and queues nothing");
  h.unmount();
});

check("a long list is drawn at the wall's size and slides the way a wall is read", () => {
  /* jsdom lays nothing out, so the rule the wall is painted with is what there is
     to read. The sheet was a 1100px box on a 1920px screen — a strip of text per
     song in the middle of the wall, unreadable from the sofa the wall is for. */
  const sheet = /\.sheet \{([^}]*)\}/.exec(stylesheet);
  assert.ok(sheet, "the design's stylesheet has the sheet rule");
  const width = /width: min\((\d+)px, ([\d.]+)vw\)/.exec(sheet[1]);
  assert.ok(width, "its width is the wall's own clamp: " + sheet[1].trim());
  assert.ok(Number(width[1]) >= 1600,
    "so a long list is as wide as the wall: " + width[1] + "px");
  const height = /max-height: min\((\d+)vh/.exec(sheet[1]);
  assert.ok(height, "and it is tall enough for a page of sleeves");
  assert.ok(Number(height[1]) >= 70, "rather than a strip of rows: " + height[1] + "vh");

  const rail = /\.rail \{([^}]*)\}/.exec(stylesheet);
  assert.ok(rail, "the stylesheet lays the list out as a rail");
  assert.match(rail[1], /display:\s*flex/, "its songs are cards in a row");
  assert.match(rail[1], /overflow-x:\s*auto/, "that slides sideways");
  assert.match(rail[1], /scroll-snap-type:\s*x mandatory/, "a card at a time");
  assert.match(rail[1], /scroll-behavior:\s*smooth/, "smoothly, for the arrows and the swipe alike");
  assert.match(stylesheet, /\.resline \.res-queue \{[^}]*position: absolute/,
    "the queue control rides on the card it belongs to");
  assert.match(stylesheet, /@keyframes railIn \{/, "and the cards arrive in a run");
});

check("a list is drawn above the words of the song, and under what is being asked", () => {
  /* The words of the current song are a full-screen overlay and the panel opens
     them by itself for every track, so a list stacked under them is invisible and
     takes no taps — the state a wall with music playing was in, where a search and
     a song list were dead and the first tap on them only closed the words. What a
     person opened belongs above what the panel is showing; Nix's own question and
     the toast stay above both. */
  const z = (selector) => {
    const rule = new RegExp("\\" + selector[0] + selector.slice(1) + " \\{([^}]*)\\}").exec(stylesheet);
    assert.ok(rule, "the stylesheet has the rule for " + selector);
    const match = /z-index:\s*(\d+)/.exec(rule[1]);
    assert.ok(match, selector + " sets a z-index: " + rule[1].trim());
    return Number(match[1]);
  };
  const words = z(".overlay");   // the words (and the scrim under a question)
  const sheet = z(".sheet");     // a search, a playlist, a ranking
  const ask = z(".ask");         // Nix asking which song was meant
  const toast = z(".toast");     // what the wall says it just did
  assert.ok(sheet > words, `the list (${sheet}) is above the words (${words})`);
  assert.ok(sheet < ask, `and under Nix's question (${ask})`);
  assert.ok(sheet < toast, `and under the toast (${toast})`);
  assert.match(stylesheet, /\.sheet \{[^}]*z-index: 65/, "the list's own place in the stack");
});

check("scrolling the music is the column's own scroll, and it is not the music's request", async () => {
  /* The card folding away is a scroll: the column that holds the card and the
     music scrolls, so the card leaves the top of the wall as the music comes up,
     on the compositor, with no height for this machine to lay out per frame. It
     was that animation on a low-powered wall — measured at 74% of it in frames
     over 33ms with the CPU throttled — that made it stutter, so what is checked
     here is that the fold is not an animation any more. */
  const h = harness();
  await h.settle();
  assert.equal(h.el(".left").firstElementChild, h.el(".hero"),
    "the card is the first thing in the music column, so scrolling takes it away");
  assert.match(stylesheet, /\.left \{[^}]*overflow-y: auto/, "and the column is what scrolls");
  assert.match(stylesheet, /\.shelves \{[^}]*overflow: visible/,
    "with the music in that scroll rather than a scroller of its own");
  assert.doesNotMatch(stylesheet, /player-folded/, "there is no fold class to animate");
  assert.doesNotMatch(stylesheet, /\.hero \{[^}]*transition:[^}]*max-height/,
    "and no card height being animated");

  // A scroll on the wall is somebody looking through the music: nothing is
  // played or queued by it, and the idle page is not woken by it.
  const column = h.el(".left");
  column.dispatchEvent(new h.window.Event("scroll"));
  h.window.dispatchEvent(new h.window.Event("wheel"));
  await h.settle();
  assert.deepEqual(plain(h.calls.play), [], "scrolling the music plays nothing");
  assert.deepEqual(plain(h.calls.queue), [], "and queues nothing");
  assert.equal(h.window.__puca.idle().saving, false, "and does not send the wall to its idle page");
  // The console tab can ask where the music is on a wall nobody can stand in front of.
  assert.equal(h.window.__puca.scroll().mode, "column");
  h.unmount();

  // A wall can be told not to: `?fold=0` pins the card and gives the music its
  // own scroller underneath it, which is what the wall did before.
  const off = harness({ url: "http://localhost:49170/?fold=0" });
  await off.settle();
  assert.equal(off.document.body.classList.contains("fold-off"), true,
    "the fold can be switched off from the address bar");
  assert.equal(off.window.__puca.scroll().mode, "pinned");
  off.unmount();
});

check("the fold is the browser's scrolling, not a height this machine lays out", () => {
  /* jsdom lays nothing out, so the rules the wall is painted with are what there
     is to read. The card has to be a normal in-flow child of the scroller — not
     sticky, not fixed, not sized by an animated height — because anything else
     puts the layout back on every frame, which is exactly what a wall panel with
     no headroom to spare cannot do. */
  assert.doesNotMatch(stylesheet, /\.hero \{[^}]*position: (fixed|sticky)/,
    "the card scrolls with the column instead of being pinned to it");
  assert.match(stylesheet, /body\.fold-off \.left \{[^}]*overflow: hidden/,
    "and the switch that pins it takes the column's scrolling away entirely");
  assert.match(stylesheet, /body\.fold-off \.shelves \{[^}]*overflow-y: auto/,
    "giving the music the scroller the card used to give back");
});

check("the wall is told when the console moves, and reconnects when the channel drops", async () => {
  /* Two halves of one box do not need a poll: the console pushes an event and
     the wall reads the state it already renders. What is checked is that the
     channel is opened on the page's own origin, that an event reads the console
     now rather than waiting for the fallback timer, and that a dropped channel
     is reconnected rather than leaving a stale wall. */
  const h = harness({ track: track("v1", "First Song") });
  await h.settle();
  assert.ok(h.socket.count() >= 1, "the panel opens the push channel on boot");
  assert.equal(h.socket.last().url, "ws://localhost:49170/api/panel/socket",
    "and it is on the origin the page was served from");
  assert.equal(plain(h.window.__puca.stream()).up, false, "a socket still connecting is not up");

  h.socket.open();
  assert.equal(plain(h.window.__puca.stream()).up, true, "an opened socket is the channel being up");

  // The console says the track changed: the wall paints it now.
  h.state.track = track("v2", "Second Song");
  const before = h.calls.state;
  h.socket.event("playing");
  await h.until("the event to paint the new track", () => h.text("#npTitle") === "Second Song");
  assert.ok(h.calls.state > before, "the event caused a fresh read, not a cached paint");

  // The channel drops: the page is not left stale, it reconnects.
  h.socket.drop();
  assert.equal(plain(h.window.__puca.stream()).up, false, "a closed socket is not up");
  await h.until("the panel to open the channel again", () => h.socket.count() >= 2, 6000);
});

check("a new panel on the console takes the open wall with it", async () => {
  /* A wall display is never reloaded by hand, so a page left open is the one
     thing that never picks up a new panel: features that are on the served page
     were reported as missing because the page in memory predated them. The
     console's build is what the page compares itself with. */
  const h = harness();
  await h.settle();
  assert.deepEqual(plain(h.window.__puca.builds()),
    { page: "build-1", served: "build-1", reload_asked: false },
    "the first state a page sees is its own build");

  // A poll that says the same thing changes nothing.
  await h.poll();
  assert.deepEqual(plain(h.window.__puca.builds()),
    { page: "build-1", served: "build-1", reload_asked: false },
    "a console that has not moved on leaves the page alone");

  h.state.panel.build = "build-2";
  await h.poll();
  assert.deepEqual(plain(h.window.__puca.builds()),
    { page: "build-1", served: "build-2", reload_asked: true },
    "a console serving a new panel asks this page to refresh");

  // One reload per build: a console whose answer keeps changing, or a reload that
  // does not take, must not turn the wall into a page that reloads in a loop.
  h.state.panel.build = "build-3";
  await h.poll();
  assert.equal(h.window.__puca.builds().reload_asked, true, "and asks for the one it saw first");
  assert.equal(h.window.__puca.builds().served, "build-3", "while still tracking what is served");
  h.unmount();

  // `?refresh=0` pins a page where it is, for a display someone is debugging.
  const pinned = harness({ url: "http://localhost:49170/?refresh=0", build: "build-7" });
  await pinned.settle();
  pinned.state.panel.build = "build-8";
  await pinned.poll();
  assert.deepEqual(plain(pinned.window.__puca.builds()),
    { page: "build-7", served: "build-8", reload_asked: false },
    "a wall can be told not to refresh itself");
  pinned.unmount();
});

check("a search lists the artists and the playlists it matched, not only songs", async () => {
  const h = harness();
  await h.settle();

  // "test" is in the artist every song on the wall is by, and the console's own
  // search answers with a song: the design shows both, under their own headings.
  h.el("#searchInput").value = "test";
  h.el("#searchForm").dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
  await h.settle();
  assert.deepEqual(h.els("#results .resgroup h3").map((el) => el.textContent), ["Songs", "Artists"],
    "the page names the kinds of thing it found");
  const artist = h.el('#results .res[data-artist="Test Artist"]');
  assert.ok(artist, "the artist the matching songs are by is a row of its own");
  const byThatArtist = new Set(
    h.window.__puca.library.tracks.filter((t) => t.artist === "Test Artist").map((t) => t.id),
  ).size;
  assert.equal(artist.querySelector(".ra").textContent, byThatArtist + " songs on the console",
    "and says how many songs the wall holds by them");
  assert.equal(h.calls.play.length, 0,
    "a word that matched an artist as well as a song is not a song to play on its own");

  // An artist row is a doorway, not a track: the console's own search is what has
  // their music, so a tap asks it for their songs and offers no artist again.
  artist.click();
  await h.settle();
  assert.equal(h.calls.search.at(-1), "Test Artist", "tapping the artist searches for them");
  assert.equal(h.text("#resultsTitle"), "Songs by Test Artist");
  assert.deepEqual(h.els("#results .resgroup h3").map((el) => el.textContent), ["Songs"],
    "the page it opens is songs, with no artist under it");

  // A playlist goes by the word too, and its row plays the playlist.
  h.el("#searchInput").value = "focus";
  h.el("#searchForm").dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
  await h.settle();
  assert.deepEqual(h.els("#results .resgroup h3").map((el) => el.textContent), ["Songs", "Playlists"],
    "a word a playlist goes by puts the playlist on the page");
  const row = h.el('#results .res[data-playlist="p1"]');
  assert.ok(row, "the playlist is a row");
  assert.equal(row.querySelector(".ra").textContent, "3 songs");
  row.click();
  await h.settle();
  assert.deepEqual(plain(h.calls.play.at(-1)), { video_id: "t1" },
    "and tapping it plays the playlist, exactly as its tile does");
  h.unmount();
});

check("every song in a list can be queued as well as played now", async () => {
  const h = harness();
  await h.settle();
  h.el("#searchInput").value = "second";
  h.el("#searchForm").dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
  await h.settle();

  const line = h.els("#results .resline")[0];
  const row = line.querySelector('.res[data-track="s1"]');
  assert.ok(row, "the song is the row");
  const control = line.querySelector(".res-queue");
  assert.ok(control, "and the queue control waits beside it");
  // It has to be beside the row rather than inside it: a button inside a button
  // is not something a browser will render, and the design's row is a button.
  assert.equal(row.querySelector(".res-queue"), null, "never nested inside the row's own button");
  assert.equal(control.getAttribute("data-queue-track"), "s1");

  control.click();
  await h.settle();
  assert.deepEqual(plain(h.calls.queue.at(-1)), { action: "add", video_id: "s1" },
    "queueing is the console's own add, not a play");
  assert.match(h.text("#toast"), /Queued “Search Result”/, "and the wall says what it lined up");
  assert.equal(h.el("#resultsSheet").hidden, false, "without taking the list away");

  // A search row is a song with nowhere it was listed, so it carries the one
  // control: add this song.
  assert.equal(line.querySelectorAll(".res-range").length, 0,
    "a song from a search has no list behind it to add the rest of");

  // A whole playlist's page carries both controls on every song it lists: this
  // one, and this one with every song under it.
  h.click('#shelves .shelf[data-playlist="liked"] .tile[data-playlist-all]');
  await h.settle();
  const rows = h.els("#results .res");
  assert.equal(h.els("#results .res-queue:not(.res-range)").length, rows.length,
    "every song on the page can be queued");
  assert.equal(h.els("#results .res-range").length, rows.length,
    "and every one of them offers this song and the rest of the list");
  h.els("#results .res-queue:not(.res-range)")[1].click();
  await h.settle();
  assert.deepEqual(plain(h.calls.queue.at(-1)), { action: "add", video_id: "t10" },
    "and each control queues the song it belongs to");

  // The range control queues the tail of the playlist the row was listed in, and
  // nothing above the chosen song: the console reads the list and appends it.
  const range = h.els("#results .res-range")[1];
  assert.equal(range.getAttribute("data-queue-from"), "t10", "it names the song it was tapped on");
  assert.equal(range.getAttribute("data-queue-playlist"), "liked",
    "and the list that song was listed in");
  range.click();
  await h.settle();
  assert.deepEqual(plain(h.calls.queue.at(-1)),
    { action: "add_range", playlist_id: "liked", video_id: "t10" },
    "queuing the rest is one request, not one per song");
  h.unmount();
});

check("the library page lists every playlist with its cover and opens the whole song list", async () => {
  const h = harness();
  await h.settle();

  const entry = h.el('#shelves .shelf .tile[data-library="all"]');
  assert.ok(entry, "the playlists row ends in the library page");
  assert.equal(entry.querySelector(".sub").textContent, "5 playlists",
    "and says how many playlists there are");
  entry.click();
  await h.settle();

  assert.equal(h.text("#resultsTitle"), "Library");
  const tiles = h.els("#results .tilegrid .tile");
  assert.deepEqual(tiles.map((el) => el.querySelector(".name").textContent),
    ["Liked Music", "Recently played", "Focus", "Long Haul"],
    "every playlist is a tile, and Liked Music is not listed twice");
  for (const tile of tiles) {
    assert.ok(tile.querySelector(".cover img"), "each one wears its own cover");
    assert.ok(tile.hasAttribute("data-playlist-all"),
      "and opens a song list rather than starting the playlist");
  }

  // The point of the page: choosing a playlist opens the songs in it.
  tiles[2].click();
  await h.settle();
  assert.equal(h.text("#resultsTitle"), "Focus");
  assert.equal(h.els("#results .res").length, 3, "its songs are the page");
  assert.equal(
    h.calls.library.filter((call) => call[0] === "playlist" && call[1] === "p1").map((call) => call[2]).at(-1),
    500,
    "and the whole playlist is asked for, not the twelve a search page holds",
  );
  h.unmount();
});

check("the songs this account plays most are a shelf of their own", async () => {
  const h = harness();
  await h.settle();

  const shelf = h.el('#shelves .shelf[data-shelf="frequent"]');
  assert.ok(shelf, "the wall carries a Frequently played shelf");
  assert.equal(shelf.querySelector("h2").textContent, "Frequently played");
  assert.equal(shelf.querySelector(".shelf-head span").textContent, "30 songs", "the console's own ranking");
  assert.equal(shelf.querySelectorAll(".tile").length, 25, "24 tiles and See all for the rest");
  // The count is the point of the row: each tile says how often it was played.
  assert.equal(shelf.querySelector('.tile[data-track="f0"] .sub').textContent, "30 plays");
  assert.equal(shelf.querySelector('.tile[data-track="f23"] .sub').textContent, "7 plays",
    "the row is ordered by how often each song was played");
  assert.equal(
    h.calls.library.filter((entry) => entry[0] === "frequent").map((entry) => entry[2]).at(-1),
    60,
    "the console is asked for the ranking it has",
  );

  h.click(shelf.querySelector(".tile[data-playlist-all]"));
  await h.settle();
  assert.equal(h.text("#resultsTitle"), "Frequently played", "the whole ranking is a page");
  assert.equal(h.els("#results .res").length, 30, "with every song on it");
  assert.match(h.els("#results .res")[0].querySelector(".ra").textContent, /30 plays/,
    "and each row keeps its count");
  assert.match(h.els("#results .res").at(-1).querySelector(".ra").textContent, /1 play\b/,
    "one play is not one plays");
  h.unmount();
});

check("a song that ends hands the words over to the next song in the queue", async () => {
  const h = harness({ playing: true, position: 100, queueActive: true, queue: [
    { video_id: "q1", title: "Queued One", artist: "Someone", duration_sec: 120, artwork_url: "" },
    { video_id: "q2", title: "Queued Two", artist: "Someone", duration_sec: 130, artwork_url: "" },
  ] });
  await h.settle();
  assert.equal(h.el("#lyricsOverlay").hidden, false, "the words are up for the song that is playing");

  // The song ends: the speaker goes idle at the last second. The console follows
  // a track it started from the queue by itself, so the wall must not push a
  // second advance behind it — it would skip the song that just started.
  h.state.position = 200;
  h.state.playing = false;
  await h.poll();
  assert.equal(h.text("#npTitle"), "Queued One", "the wall follows the console to the next song");
  assert.equal(h.el("#lyricsOverlay").hidden, false, "and the words stay up for it");
  assert.deepEqual(plain(h.calls.queue).filter((call) => call.action === "next"), [],
    "the console was allowed to make its own hand-over");
  h.unmount();
});

check("a song played on its own starts the queue when it ends", async () => {
  const h = harness({ playing: true, position: 100, queueActive: false });
  await h.settle();
  h.state.position = 200;
  h.state.playing = false;
  await h.poll();
  // The console never advances a one-off play (a song played on its own is one
  // song), so the queue's next track is started from the wall instead.
  assert.deepEqual(plain(h.calls.queue).filter((call) => call.action === "next"), [{ action: "next" }]);
  await h.poll();
  assert.equal(h.text("#npTitle"), "Queued One", "and the next queued song is what the wall shows");
  assert.equal(h.el("#lyricsOverlay").hidden, false, "with its words up, since nothing was dismissed");
  h.unmount();
});

check("the wall goes back to the home page when the queue has nothing left", async () => {
  const h = harness({ playing: true, position: 100, queueActive: false, queue: [] });
  await h.settle();
  assert.equal(h.el("#lyricsOverlay").hidden, false, "the words were up");

  h.state.position = 200;
  h.state.playing = false;
  await h.poll();
  assert.equal(h.el("#lyricsOverlay").hidden, true, "the last song closes them");
  assert.equal(h.document.body.classList.contains("lyrics-on"), false, "and the home page is back");
  assert.match(h.text("#toast"), /last song in the queue/);
  assert.deepEqual(plain(h.calls.queue).filter((call) => call.action === "next"), [],
    "nothing was queued, so nothing was started");

  // Going home is not a dismissal: the next song the user starts opens the words
  // again, the same way a track the console starts does.
  h.state.track = track("v2", "Another Song");
  h.state.position = 0;
  h.state.playing = true;
  await h.poll();
  assert.equal(h.el("#lyricsOverlay").hidden, false, "the words open again for the next song");
  assert.equal(h.text("#npTitle"), "Another Song");
  h.unmount();
});

check("up next is what is still to come, not the song being played", async () => {
  const h = harness({ playing: true, position: 30, track: track("q1", "Queued One"),
    queueActive: true, queue: [
      { video_id: "q1", title: "Queued One", artist: "Someone", duration_sec: 120, artwork_url: "" },
      { video_id: "q2", title: "Queued Two", artist: "Someone", duration_sec: 130, artwork_url: "" },
    ] });
  await h.settle();
  const rows = h.els("#queue li");
  assert.equal(rows.length, 1, "the queue keeps the track being played out of Up next");
  assert.equal(rows[0].getAttribute("data-id"), "q2");
  // The row still plays the position it holds in the console's queue, not the
  // position it happens to have on screen.
  h.click(rows[0]);
  await h.settle();
  assert.deepEqual(plain(h.calls.queue.at(-1)), { action: "play", index: 1 });
  h.unmount();
});

check("tapping a playlist plays the playlist, not one song out of it", async () => {
  const h = harness();
  await h.settle();
  // A shelf whose songs could not be read still shows the console's own count,
  // so the section never looks like decoration.
  const subs = Object.fromEntries(
    h.els("#shelves .tile[data-playlist]").map((tile) => [
      tile.getAttribute("data-playlist"),
      tile.querySelector(".sub").textContent,
    ]),
  );
  assert.equal(subs.p1, "3 songs", "a playlist says how many songs it has");
  assert.equal(subs.p2, "50 songs", "and keeps saying so when its songs cannot be read");

  const focus = h.els("#shelves .tile[data-playlist]").find((t) => t.getAttribute("data-playlist") === "p1");
  focus.click();
  await h.settle();
  assert.deepEqual(plain(h.calls.play.at(-1)), { video_id: "t1" }, "the playlist starts at its first song");
  assert.deepEqual(
    plain(h.calls.queue),
    [{ action: "clear" }, { action: "add", video_id: "t2" }, { action: "add", video_id: "t3" }],
    "and the rest of the playlist becomes Up next",
  );
  assert.match(h.text("#toast"), /2 more queued/, "the panel says the queue was filled");

  await h.poll();
  assert.equal(h.els("#queue li").length, 2, "the queue on the wall is the rest of the playlist");
  assert.equal(h.text("#queue li:nth-child(1) .qt"), "Second Track");
  h.unmount();
});

check("a playlist the console will not play says so instead of doing nothing", async () => {
  const h = harness();
  await h.settle();
  // The console answers a refused play with a reason; a wall display has only
  // that reason to go on, so it has to reach the screen.
  h.state.failNextPlay = true;
  const focus = h.els("#shelves .tile[data-playlist]").find((t) => t.getAttribute("data-playlist") === "p1");
  focus.click();
  await h.settle();
  assert.match(h.text("#toast"), /speaker is not answering/, "the console's own reason is shown");
  assert.deepEqual(plain(h.calls.queue), [], "and a failed play does not rebuild the queue");
  h.unmount();
});

check("the lyrics text zooms from the small control at the bottom left", async () => {
  const h = harness();
  await h.settle();
  const zoom = h.el("#lyrZoom");
  assert.ok(zoom, "the control lives in the lyrics page");
  assert.equal(h.el(".lyr-foot").firstElementChild, zoom, "and sits first in the footer, at the bottom left");
  const overlay = h.el("#lyricsOverlay");
  assert.equal(overlay.style.getPropertyValue("--lyr-zoom"), "1.00", "the words start at the design's own size");

  h.click("#lyrZoomIn");
  assert.equal(overlay.style.getPropertyValue("--lyr-zoom"), "1.15", "A+ grows the words");
  h.click("#lyrZoomIn");
  assert.equal(overlay.style.getPropertyValue("--lyr-zoom"), "1.30", "tap by tap");
  h.click("#lyrZoomOut");
  assert.equal(overlay.style.getPropertyValue("--lyr-zoom"), "1.15", "A− shrinks them again");
  assert.equal(overlay.hidden, false, "zooming does not close the words");
  assert.equal(h.window.localStorage.getItem("nix.panel.lyrics-zoom"), "1.15", "the size is remembered");
  h.unmount();

  const again = harness({ storage: { "nix.panel.lyrics-zoom": "1.6" } });
  await again.settle();
  assert.equal(again.el("#lyricsOverlay").style.getPropertyValue("--lyr-zoom"), "1.60",
    "the size the user picked comes back on the next boot");
  again.unmount();
});

check("the lyrics size control is always drawn, and never faded away", async () => {
  /* It is a control on a wall, not a hover affordance: reported twice as missing
     while it was on screen, because it was a pair of small circles in the page's
     own low-contrast panel colour that faded to 35% at the ends of their range.
     Nothing about it may be conditional — every track, words or no words. */
  const rule = /\.lyr-zoom button \{([^}]*)\}/.exec(stylesheet);
  assert.ok(rule, "the chips have their own rule");
  const size = /(?:width|height): clamp\((\d+)px/.exec(rule[1]);
  assert.ok(size && Number(size[1]) >= 58,
    "big enough to see from the sofa and tap standing up: " + JSON.stringify(size));
  // Solid, in the theme's own foreground. A translucent circle on a translucent
  // panel is a shape with nothing to see — which is how a control that was on
  // screen the whole time kept being reported as missing.
  assert.match(rule[1], /background: var\(--accent\)/, "a solid chip in the theme's foreground");
  assert.match(rule[1], /color: var\(--accent-ink\)/, "with the ink that reads on it");
  assert.doesNotMatch(stylesheet, /\.lyr-zoom button\[disabled\] \{[^}]*opacity: \.[0-6]/,
    "and a chip at the end of its range is not faded out");
  // And the whole footer is lifted off the bottom edge, where televisions crop.
  const foot = /\.lyr-foot \{([^}]*)\}/.exec(stylesheet);
  const lift = foot && /padding: 0 var\(--pad\) calc\(var\(--pad\) \+ ([\d.]+)vh\)/.exec(foot[1]);
  assert.ok(lift && Number(lift[1]) >= 3,
    "clear of the overscan a television crops: " + JSON.stringify(lift));

  // With no words at all — the state the wall sits in for a track without lyrics
  // — the footer, and so the control, is still there.
  const bare = harness({ lyrics: [], track: track("v1", "No Words") });
  await bare.settle();
  // The panel opens the words for every track, with or without any to show.
  assert.equal(bare.el("#lyricsOverlay").hidden, false, "the words page is open");
  assert.match(bare.text("#lyrLines"), /No words are available/, "and says so");
  assert.ok(bare.el("#lyrZoom"), "and the size control is on it");
  assert.equal(bare.el(".lyr-foot").contains(bare.el("#lyrZoom")), true, "in the footer it belongs to");
  // The word beside the chips, because two letters in the corner of a television
  // do not say what they do.
  const label = bare.el(".lyr-zoom-label");
  assert.ok(label, "the control is labelled");
  assert.equal(label.parentElement, bare.el("#lyrZoom"), "inside the size control itself");
  bare.click("#lyrZoomIn");
  assert.equal(bare.el("#lyricsOverlay").style.getPropertyValue("--lyr-zoom"), "1.15",
    "and it zooms even with nothing to show");
  bare.unmount();

  // Opened by hand rather than by the panel: the same footer, the same control.
  const byHand = harness({ lyrics: [] });
  await byHand.settle();
  byHand.click("#lyrClose");
  assert.equal(byHand.el("#lyricsOverlay").hidden, true, "the words are closed");
  byHand.click("#btnLyrics");
  assert.equal(byHand.el("#lyricsOverlay").hidden, false, "and opened again by the chip");
  assert.ok(byHand.el("#lyrZoom"), "with the size control on them");
  assert.equal(byHand.el(".lyr-foot").firstElementChild, byHand.el("#lyrZoom"),
    "still first in the footer, at the bottom left");
  byHand.unmount();
});

check("the brand is the NIX PUCA logo, and no lettering", async () => {
  /* The display's brand is the mark and nothing else: the PUCA logo on its own
     plate, and the wording that used to sit beside it ("PUCA" and "Nix display
     for OpenDeck") is gone. The panel's note mark stays underneath as the
     fallback, so a missing artwork leaves a brand rather than an empty tile.
     jsdom loads no images, so both paths are driven by the events a browser
     would send. */
  const h = harness();
  await h.settle();
  const plate = h.el("#brandLogo");
  assert.ok(plate, "the brand plate is in the header");
  const art = plate.querySelector("img");
  assert.ok(art, "and holds the logo");
  assert.equal(art.getAttribute("src"), "puca-logo.png", "read from beside the panel page");
  assert.equal(art.getAttribute("alt"), "NIX PUCA", "named for a screen reader");
  assert.ok(plate.querySelector("svg"), "the panel's own note mark stays as the fallback");  assert.match(stylesheet, /\.brand \.logo\.has-logo svg \{ display: none; \}/,
    "and is hidden once the logo is up");
  // Drawn directly: no plate under it, no elevation, no border — the mark sits
  // on the page the same way any other element does.
  const plateRule = /\.brand \.logo \{([^}]*)\}/.exec(stylesheet);
  assert.ok(plateRule, "the brand has its own rule");
  assert.doesNotMatch(plateRule[1], /background/, "with no plate behind the mark");
  assert.doesNotMatch(plateRule[1], /box-shadow/, "and no elevation under it");
  assert.doesNotMatch(plateRule[1], /border/, "and no plate edge either");
  assert.doesNotMatch(plateRule[1], /padding/, "the artwork is the whole of it");
  // The mark is tinted into the theme's own foreground, because the panel is
  // dark at night and near-white in the day.
  const artRule = /\.brand \.logo img \{([^}]*)\}/.exec(stylesheet);
  assert.ok(artRule, "the logo has its own rule");
  assert.match(artRule[1], /filter: brightness\(0\) invert\(1\)/, "white on the night panel");
  assert.match(stylesheet, /:root\.day \.brand \.logo img \{ filter: brightness\(0\); \}/,
    "and near-black on the day one");
  // No lettering in the brand: not the design's own two lines, and nothing the
  // script writes back into it.
  assert.equal(h.text(".brand").trim(), "", "the brand carries no text");
  assert.equal(h.els(".brand .brand-text").length, 0, "and is not a lock-up with a wording block");
  assert.equal(h.el("#sourceTag"), null, "the connection line that lived there is gone");
  assert.doesNotMatch(source, /#sourceTag/, "and nothing in the script still writes to it");

  art.dispatchEvent(new h.window.Event("load"));
  assert.equal(plate.classList.contains("has-logo"), true, "a loaded logo hides the fallback note");
  assert.equal(h.window.__puca.brand(), "puca-logo", "and the wall says which logo it shows");
  h.unmount();

  const missing = harness();
  await missing.settle();
  const broken = missing.el("#brandLogo").querySelector("img");
  broken.dispatchEvent(new missing.window.Event("error"));
  assert.equal(missing.el("#brandLogo").querySelector("img"), null,
    "an unreadable artwork is taken out rather than left as a broken image");
  assert.equal(missing.el("#brandLogo").querySelector("svg") !== null, true,
    "and the note mark is what the brand falls back to");
  assert.equal(missing.window.__puca.brand(), "note", "which the wall reports as well");
  missing.unmount();
});

check("the words stay on the line being sung after a zoom", async () => {
  const lyrics = Array.from({ length: 20 }, (_, index) => ({ time_sec: index * 10, text: "Line " + (index + 1) }));
  const h = harness({ lyrics, position: 30 });
  await h.settle();
  const geometry = lyricGeometry(h);
  await h.wait(60);
  assert.equal(geometry.offset(), transformFor(centredOffset(geometry, 3)), "centred to start with");

  // Bigger words are taller lines: the block has to be measured again, or the
  // line being sung drifts off centre for the rest of the track.
  h.click("#lyrZoomIn");
  await h.wait(60);
  assert.equal(
    geometry.offset(),
    transformFor(centredOffset(geometry, 3, 1.15)),
    "and still centred once the words are larger",
  );
  h.unmount();
});

check("the queue lists what is next, plays a position, and clears", async () => {
  const h = harness();
  await h.settle();
  const rows = h.els("#queue li");
  assert.equal(rows.length, 2, "both queued tracks are shown");
  assert.equal(h.text("#queue li:nth-child(1) .qt"), "Queued One");
  assert.equal(h.el("#queueEmpty").hidden, true);

  rows[1].click();
  await h.settle();
  assert.deepEqual(plain(h.calls.queue.at(-1)), { action: "play", index: 1 }, "a row plays that queue position");

  h.click("#btnClearQueue");
  await h.settle();
  assert.deepEqual(plain(h.calls.queue.at(-1)), { action: "clear" });
  await h.poll();
  assert.equal(h.el("#queueEmpty").hidden, false, "the empty state the design draws comes back");
  assert.equal(h.els("#queue li").length, 0);
  h.unmount();
});

check("a spoken request becomes the same play call the assistant makes", async () => {
  const h = harness({ speech: true });
  await h.settle();
  h.window.__spoken = "bohemian rhapsody";
  h.click("#micBtn");
  await h.settle();
  assert.deepEqual(h.calls.search, ["bohemian rhapsody"], "the words are searched for");
  assert.deepEqual(plain(h.calls.play.at(-1)), { video_id: "s1" }, "and the match is handed to the speaker");
  assert.equal(h.el("#resultsSheet").hidden, false, "the results sheet is the design's own");
  assert.equal(h.text("#resultsTitle"), "Nix heard “bohemian rhapsody”");
  assert.match(h.el("#results").innerHTML, /data-track="s1"/);
  assert.match(h.text("#toast"), /Search Result/, "and the panel says what it is playing");
  h.unmount();
});

check("the console's question is answered by the card the user taps", async () => {
  const h = harness({
    question: {
      id: "q1",
      prompt: "2 tracks match “that song”: which one did you mean?",
      query: "that song",
      options: [track("o1", "Option One"), track("o2", "Option Two")],
    },
  });
  await h.settle();
  assert.equal(h.el("#askOverlay").hidden, false, "the question takes the screen");
  assert.match(h.text("#askPrompt"), /which one did you mean/);
  assert.match(h.text("#askHeard"), /that song/, "the panel shows what it heard");
  const cards = h.els("#askOptions .opt");
  assert.equal(cards.length, 2, "every option the console could not choose between is offered");

  cards[1].click();
  await h.settle();
  assert.deepEqual(plain(h.calls.answer), [1], "the tapped option is answered by its index");
  assert.equal(h.el("#askOverlay").hidden, true, "and the question closes");

  await h.poll();
  assert.equal(h.text("#npTitle"), "Option Two", "the choice is what ends up playing");
  h.unmount();
});

check("the console's question can be answered by saying the number", async () => {
  const h = harness({
    speech: true,
    question: {
      id: "q2",
      prompt: "Which one did you mean?",
      query: "the one from the film",
      options: [track("o1", "Option One"), track("o2", "Option Two")],
    },
  });
  await h.settle();
  assert.equal(h.el("#askOverlay").hidden, false);

  // The microphone is deliberately not open while a question waits — it would
  // hear the song — so the user asks for it from the question itself.
  h.window.__spoken = "two";
  h.click("#askMicHint");
  await h.settle();
  assert.deepEqual(plain(h.calls.answer), [1], "“two” picks the second card");
  assert.equal(h.el("#askOverlay").hidden, true);

  h.state.question = {
    id: "q3",
    prompt: "Which one did you mean?",
    query: "no idea",
    options: [track("o1", "Option One"), track("o2", "Option Two")],
  };
  await h.poll();
  h.window.__spoken = "something entirely different";
  h.click("#askMicHint");
  await h.settle();
  assert.equal(h.el("#askOverlay").hidden, false, "an unclear answer leaves the question up");
  assert.match(h.text("#askMicHintText"), /not sure which/i, "and says so instead of guessing");
  assert.deepEqual(plain(h.calls.answer), [1], "nothing was answered by the guess");
  h.unmount();
});

check("a question nobody answers can be dismissed, and is not asked again", async () => {
  const h = harness({ question: { id: "q4", prompt: "Which one did you mean?", options: [track("o1", "Option One")] } });
  await h.settle();
  assert.equal(h.el("#askOverlay").hidden, false);
  h.click("#askCancel");
  await h.settle();
  assert.equal(h.calls.dismiss, 1, "dismissing tells the console the question is closed");
  assert.equal(h.el("#askOverlay").hidden, true);

  // The console clears a dismissed question, but if one comes back the panel
  // must not put the same question on the wall again.
  await h.poll();
  await h.poll();
  assert.equal(h.el("#askOverlay").hidden, true, "the same question is not reopened by the next poll");
  assert.equal(h.calls.dismiss, 1);
  h.unmount();
});

check("the panel says so when the browser cannot hear", async () => {
  const h = harness();
  await h.settle();
  h.click("#micBtn");
  await h.settle();
  assert.equal(h.el("#toast").hidden, false, "the panel answers the tap");
  assert.match(h.text("#toast"), /type instead/i, "and offers the keyboard instead of pretending to listen");
  assert.deepEqual(h.calls.search, [], "nothing was listened for");
  h.unmount();
});

check("a spoken request is heard on the console itself", async () => {
  const h = harness({ microphone: true });
  await h.settle();
  assert.equal(h.calls.voice.length, 0, "nothing was recognised before the mic was tapped");

  h.click("#micBtn");
  await h.settle();
  assert.equal(h.microphone.processors.length, 1, "the microphone is open");
  assert.equal(h.el("#micBtn").classList.contains("recording"), true, "the wall shows it is listening");

  await h.speak();
  assert.equal(h.calls.clips.length, 1, "the clip goes to the console, not to a speech service");
  const wav = new Uint8Array(h.calls.clips[0].parts[0]);
  const tag = (at) => String.fromCharCode(wav[at], wav[at + 1], wav[at + 2], wav[at + 3]);
  const word = (at) => wav[at] | (wav[at + 1] << 8);
  assert.equal(tag(0), "RIFF");
  assert.equal(tag(8), "WAVE");
  assert.equal(word(20), 1, "uncompressed PCM");
  assert.equal(word(22), 1, "one channel");
  assert.equal(word(34), 16, "16-bit samples, which the console reads with the standard library");
  assert.equal(h.microphone.tracks, 1, "and the microphone is closed again");
  assert.equal(h.el("#micBtn").classList.contains("recording"), false);

  // What was heard goes through the same path the browser's recognition used:
  // a plain phrase is searched for and its match becomes the music.
  assert.deepEqual(h.calls.voice, ["Play Bohemian Rhapsody."]);
  assert.deepEqual(h.calls.search, ["Play Bohemian Rhapsody."]);
  assert.deepEqual(plain(h.calls.play.at(-1)), { video_id: "s1" });
  assert.equal(h.el("#searchInput").value, "Play Bohemian Rhapsody.", "and the words are on screen");
  h.unmount();
});

check("a spoken command drives the transport instead of searching", async () => {
  const paused = harness({ microphone: true, transcript: "pause the music" });
  await paused.settle();
  paused.click("#micBtn");
  await paused.settle();
  await paused.speak();
  assert.deepEqual(plain(paused.calls.control.at(-1)), ["pause"]);
  assert.deepEqual(paused.calls.search, [], "a command is not a song title");
  paused.unmount();

  const quieter = harness({ microphone: true, transcript: "volume down" });
  await quieter.settle();
  quieter.click("#micBtn");
  await quieter.settle();
  await quieter.speak();
  assert.deepEqual(plain(quieter.calls.control.at(-1)), ["volume", 0.4], "the words a person says for the volume");
  assert.deepEqual(quieter.calls.search, []);
  quieter.unmount();
});

check("the mic says so when the browser refuses it", async () => {
  const h = harness({ microphone: { micBlocked: true } });
  await h.settle();
  h.click("#micBtn");
  await h.settle();
  assert.match(h.text("#toast"), /blocked/i, "a refused microphone is reported, not swallowed");
  assert.equal(h.calls.clips.length, 0);
  h.unmount();
});

check("an insecure wall hands itself to the box's secure address to be heard", async () => {
  // The wall display is opened at http://<box-ip>:49170/, where no browser will
  // lend the page a microphone at all. Rather than putting an address on screen
  // for somebody to type into a screen mounted on a wall, the panel takes itself
  // to the box's own TLS listener and opens the microphone on arrival: same
  // display, box's own address, and the certificate the console made for exactly
  // that address.
  const h = harness({ microphone: true, insecure: true, url: BOX_HTTP });
  await h.settle();
  h.click("#micBtn");
  await h.settle();
  assert.equal(h.microphone.processors.length, 0, "nothing was recorded: the browser would refuse it");
  const local = plain(h.window.__puca.local());
  assert.equal(local.moved_to, `${BOX_HTTPS}?listen=1`,
    "the wall is handed to the box's secure address, arriving to listen");
  assert.equal(h.navigations.length, 1, "and the browser was asked to go there");
  assert.equal(h.el("#resultsSheet").hidden, true, "it does not lecture the room instead");
  h.unmount();
});

check("a wall that cannot be moved says where the voice works", async () => {
  // The one case left: a wall the browser (or `?local=0`) will not move. Then the
  // address is said out loud, exactly as it always was.
  const h = harness({ microphone: true, insecure: true, url: `${BOX_HTTP}?local=0` });
  await h.settle();
  h.click("#micBtn");
  await h.settle();
  assert.equal(h.microphone.processors.length, 0, "nothing was recorded: the browser would refuse it");
  assert.equal(h.el("#resultsSheet").hidden, false, "the panel says why instead of doing nothing");
  assert.match(h.text("#resultsTitle"), /secure page/i);
  assert.match(h.text("#results"), /https:\/\/192\.168\.0\.230:49171\//, "and names the address that works");
  h.unmount();
});

check("the wall that was moved to be heard arrives listening", async () => {
  // What the move carries: the tap on the mic that sent the wall to the box's
  // secure address is the tap being listened to, not one that has to be made
  // again in front of the wall.
  const h = harness({ microphone: true, url: "http://localhost:49170/?listen=1" });
  await h.settle();
  await h.until("the microphone to open by itself", () => h.microphone.processors.length === 1);
  assert.equal(h.el("#micBtn").classList.contains("recording"), true,
    "the wall shows it is listening");
  h.unmount();
});

check("a wall opened away from the box moves onto the box's own address", async () => {
  // The display is pointed at a tunnel/tailnet name, so every read it makes —
  // the state, the music, the covers — leaves the LAN and comes back. The console
  // says where it lives on its own network, and the panel takes the wall there:
  // same page, same settings.
  // `insecure` is what a browser reports for a plain-http page, and it is what
  // decides the direction of the move: this page could not hear anyway, so the
  // box's own http listener is the address it belongs on.
  const h = harness({ url: "http://nix.boston-mizar.ts.net:49170/?theme=night", insecure: true });
  await h.settle();
  const local = plain(h.window.__puca.local());
  assert.equal(local.on_the_box, false, "the page knows it was not served by the box");
  assert.equal(local.moved_to, `${BOX_HTTP}?theme=night`,
    "the wall is handed to the box's own address, with the settings it was opened with");
  assert.equal(local.moved, true);
  assert.equal(h.navigations.length, 1, "and the browser was asked to go there");
  h.unmount();
});

check("a secure wall moves to the box's secure address, so the microphone survives", async () => {
  const h = harness({ url: "https://nix.example.com/panel" });
  await h.settle();
  const local = plain(h.window.__puca.local());
  assert.equal(local.box_http, BOX_HTTP, "the console says where the box is");
  assert.equal(local.moved_to, `${BOX_HTTPS}panel`,
    "a page that could hear still can: the move travels in the page's own direction");
  h.unmount();
});

check("a wall already on the box, or a box that does not answer, stays where it is", async () => {
  const at = harness({ url: BOX_HTTP });
  await at.settle();
  const here = plain(at.window.__puca.local());
  assert.equal(here.on_the_box, true);
  assert.equal(here.reason, "already on the box");
  assert.equal(here.moved_to, "", "there is nothing closer to move to");
  assert.equal(at.navigations.length, 0);
  at.unmount();

  // A wall watched from outside the house: the box's own address is not
  // reachable from there, so the display stays on the address that works —
  // showing music beats a blank page every time.
  const away = harness({ url: "https://nix.example.com/panel", boxUnreachable: true });
  await away.settle();
  const local = plain(away.window.__puca.local());
  assert.equal(local.moved_to, "", "no move was made");
  assert.match(local.reason, /did not answer/, "and the wall can say why");
  assert.equal(away.navigations.length, 0);
  away.unmount();

  // ... and a wall deliberately opened somewhere else is pinned there.
  const pinned = harness({ url: "http://nix.boston-mizar.ts.net:49170/?local=0" });
  await pinned.settle();
  const pinnedState = plain(pinned.window.__puca.local());
  assert.equal(pinnedState.auto, false);
  assert.equal(pinnedState.moved_to, "", "?local=0 leaves the wall where it was opened");
  assert.equal(pinned.navigations.length, 0);
  pinned.unmount();
});

check("an idle wall hands itself over to the idle page, and a touch comes back", async () => {
  const h = harness({ track: null, mode: "dark", url: "http://localhost:49170/?saverAfter=1" });
  await h.settle();
  assert.equal(h.el("#saver"), null, "the wall is left alone to start with");
  await h.until("the idle page", () => h.el("#saver"));
  const saver = h.el("#saver");
  assert.equal(saver.tagName, "IFRAME", "the idle page takes the screen");
  assert.match(saver.getAttribute("src"), /screensaver\.html\?theme=night$/,
    "and it is told the console's own daypart, not the screen's clock");
  assert.equal(h.document.body.classList.contains("saving"), true);

  // A tap lands inside the idle page's own document, so the wake listener lives
  // there: without it the wall would never come back.
  const inner = saver.contentDocument;
  assert.ok(inner, "the idle page has a document of its own");
  inner.dispatchEvent(new h.window.Event("pointerdown", { bubbles: true }));
  await h.wait(30);
  assert.equal(h.el("#saver"), null, "a touch brings the panel straight back");
  assert.equal(h.document.body.classList.contains("saving"), false);

  // Still idle again a moment later: the countdown restarts from the touch.
  await h.until("the idle page to come back", () => h.el("#saver"));
  h.unmount();
});

check("a wall in use never goes idle, and one nobody is using does", async () => {
  // Music playing: the whole point of the display.
  const playing = harness({ playing: true, url: "http://localhost:49170/?saverAfter=1" });
  await playing.settle();
  await playing.wait(2600);
  assert.equal(playing.el("#saver"), null, "music on the wall keeps it awake");
  playing.unmount();

  /* The words the panel opens by itself are not somebody reading them. This was
     the state a live wall sat in for days: the music had stopped, the lyrics of
     the last track were up, nobody was in the room, and the idle page could
     never come because "there is something on the screen". */
  const stopped = harness({ url: "http://localhost:49170/?saverAfter=1" });
  await stopped.settle();
  assert.equal(stopped.el("#lyricsOverlay").hidden, false, "the words opened with the track");
  assert.equal(stopped.window.__puca.idle().lyrics_by_user, false, "and the panel opened them");
  assert.equal(stopped.window.__puca.idle().something_to_show, false,
    "a stopped song's words are not somebody reading them");
  await stopped.until("the idle page under the words the panel opened", () => stopped.el("#saver"));
  stopped.unmount();

  // Opened by hand, though, they are being read: the wall stays as it is.
  const reading = harness({ url: "http://localhost:49170/?saverAfter=1" });
  await reading.settle();
  reading.click("#lyrClose");
  await reading.wait(80);
  reading.click("#btnLyrics");
  await reading.settle();
  assert.equal(reading.el("#lyricsOverlay").hidden, false, "the words are open again");
  assert.equal(reading.window.__puca.idle().lyrics_by_user, true, "opened by a person this time");
  await reading.wait(2600);
  assert.equal(reading.el("#saver"), null, "and the idle page keeps out of the way");
  // Closed, and the quiet window starts from there.
  reading.click("#lyrClose");
  await reading.until("the idle page after the words are closed", () => reading.el("#saver"));
  reading.unmount();

  /* The same for a list nobody came back to: it is on the wall, but the wall is
     not being used — and the display behind it is one touch away again. */
  const list = harness({ url: "http://localhost:49170/?saverAfter=1" });
  await list.settle();
  list.el("#searchInput").value = "second";
  list.el("#searchForm").dispatchEvent(new list.window.Event("submit", { bubbles: true, cancelable: true }));
  await list.settle();
  assert.equal(list.el("#resultsSheet").hidden, false, "a list is up");
  await list.until("the idle page under the list", () => list.el("#saver"));
  assert.equal(list.el("#resultsSheet").hidden, false, "with the list still where it was");
  // A touch comes back to the list, not to an empty wall.
  const inner = list.el("#saver").contentDocument;
  assert.ok(inner, "the list's idle page has a document of its own");
  inner.dispatchEvent(new list.window.Event("pointerdown", { bubbles: true }));
  await list.wait(80);
  assert.equal(list.el("#saver"), null, "a touch brings the panel back");
  assert.equal(list.el("#resultsSheet").hidden, false, "to the list it was showing");
  list.unmount();

  // A question on screen is waiting for an answer, not for a screensaver.
  const asking = harness({
    track: null,
    url: "http://localhost:49170/?saverAfter=1",
    question: { id: "q9", prompt: "Which one did you mean?", options: [track("o1", "Option One")] },
  });
  await asking.settle();
  await asking.wait(2600);
  assert.equal(asking.el("#saver"), null, "a question keeps the wall awake");
  asking.unmount();
});

check("the idle page can be switched off", async () => {
  const h = harness({ track: null, url: "http://localhost:49170/?saverAfter=1&saver=off" });
  await h.settle();
  await h.wait(2600);
  assert.equal(h.el("#saver"), null, "saver=off leaves the panel as it is");
  h.unmount();
});

check("a browser that refuses to store anything still paints the panel", async () => {
  const h = harness();
  await h.settle();
  // A private window, a full quota, storage switched off by policy: the cache is
  // an optimisation, so the panel keeps working with none of it.
  h.window.localStorage.setItem = () => { throw new Error("the storage is full"); };
  h.window.localStorage.getItem = () => { throw new Error("the storage is blocked"); };
  h.click("#btnNext");
  await h.poll();
  assert.equal(h.text("#npTitle"), "Queued One", "the panel keeps painting");
  assert.ok(h.el("#shelves .tile"), "and the library it already read is still on the wall");
  h.unmount();
});

check("the idle page is a working page of its own", async () => {
  // The panel shows screensaver.html in an iframe, so that page has to stand on
  // its own two feet: its own script, its own palette, its own clock and eyes.
  const markup = readFileSync(path.join(panelDir, "screensaver.html"), "utf8");
  const script = /<script>([\s\S]*)<\/script>/.exec(markup);
  assert.ok(script, "the idle page carries its script");

  function mountSaver(query) {
    const dom = new JSDOM(markup.replace(/<script>[\s\S]*<\/script>/, ""), {
      runScripts: "outside-only",
      pretendToBeVisual: true,
      url: "http://localhost:49170/screensaver.html" + (query || ""),
    });
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    dom.window.eval(script[1]);
    return dom;
  }

  const night = mountSaver("?theme=night");
  const doc = night.window.document;
  assert.ok(night.window.__display, "its script runs and leaves its own seam behind");
  assert.equal(doc.querySelectorAll(".cateye").length, 2, "two cat eyes");
  assert.equal(doc.documentElement.classList.contains("night"), true, "night is the console's night");
  assert.ok(doc.querySelectorAll("#stars .star").length > 10, "the sky is built at night");
  assert.match(doc.querySelector("#clockTime").textContent, /^\d{1,2}:\d{2}$/, "with a clock of its own");
  assert.match(doc.querySelector("#clockAmPm").textContent, /^(AM|PM)?$/, "and its am/pm beside it");
  assert.equal(night.window.__display.theme(), "night");

  const creature = doc.querySelector(".creature");
  creature.dispatchEvent(new night.window.MouseEvent("pointerdown", { clientX: 100, clientY: 100, bubbles: true }));
  await wait(30);
  assert.ok(doc.querySelectorAll("#fx .bit").length > 0, "a tap lands as a burst of particles");
  assert.equal(doc.querySelector("#face").classList.contains("squish"), true, "and the eyes squish");
  night.window.close();

  const day = mountSaver("?theme=day");
  assert.equal(day.window.document.documentElement.classList.contains("day"), true,
    "and the same page in daylight");
  day.window.close();
});

check("the wall's own page and type come from the box, not from the internet", async () => {
  // The display is a page on a wall in a room: everything it paints with has to
  // answer on the box it was served from. Measured live, the panel and its idle
  // page each asked fonts.googleapis.com for their typography on every boot, so
  // a wall whose internet was down drew in a fallback font and could not even
  // paint until a font CDN answered. The fonts ship in this package now, and the
  // panel listener serves them from its own origin.
  const pages = { "panel.html": design, "screensaver.html": readFileSync(path.join(panelDir, "screensaver.html"), "utf8") };
  for (const [name, markup] of Object.entries(pages)) {
    assert.doesNotMatch(markup, /fonts\.googleapis\.com|fonts\.gstatic\.com/,
      `${name} asks no font CDN for anything`);
    assert.match(markup, /href="fonts\.css"/, `${name} takes its type from the package`);
  }
  assert.ok(existsSync(path.join(panelDir, "fonts.css")), "the type stylesheet ships beside the page");

  // Every file the stylesheet names, and every file the page links, has to be in
  // the package: a face that is declared but missing is a wall drawing in a
  // fallback font with nothing anywhere saying why.
  const fonts = readFileSync(path.join(panelDir, "fonts.css"), "utf8");
  const faces = [...fonts.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((match) => match[1]);
  assert.ok(faces.length >= 4, `the stylesheet declares its faces (${faces.length})`);
  for (const face of faces) {
    assert.match(face, /\.woff2$/, `${face} is a web font`);
    assert.ok(existsSync(path.join(panelDir, face)), `${face} ships in the package`);
  }
  assert.match(fonts, /font-family: "Outfit"/, "the panel's own face is the one it asked for");
  assert.match(fonts, /font-family: "Baloo 2"/, "and the idle page's");

  const linked = [...design.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  const remote = linked.filter((ref) => /^[a-z][a-z0-9+.-]*:\/\//i.test(ref) && !ref.startsWith("data:"));
  assert.deepEqual(remote, [], "the page asks no other host for anything it draws with");
  for (const ref of linked.filter((ref) => ref && !ref.startsWith("data:") && !ref.startsWith("#"))) {
    assert.ok(existsSync(path.join(panelDir, ref)), `${ref} ships in the package`);
  }
});

check("the floating playbar keeps the track on the wall when the card is away", async () => {
  // The card carries the player and the column carries the card away; the
  // results sheet covers the wall outright. What is playing is not part of
  // either, so a strip of its own keeps the name (and three controls) in sight
  // — and stays hidden while the card itself is on screen, because two players
  // showing the same song is one too many.
  // `?lyrics=0` keeps the words from taking the wall by themselves: the strip
  // yields to them, so they are opened by hand further down instead.
  const h = harness({ track: track("v1", "First Song"), playing: true, position: 40,
    url: "http://localhost:49170/?lyrics=0" });
  await h.settle();
  const bar = h.el("#minibar");
  assert.ok(bar, "the strip is part of the page it ships with");
  assert.equal(h.text("#miniTitle"), "First Song", "and it carries the track's name");
  assert.equal(bar.hidden, true, "while the card is on screen the strip stays out of the way");

  const column = h.el(".left");
  column.scrollTop = 200;
  column.dispatchEvent(new h.window.Event("scroll"));
  await h.settle();
  assert.equal(bar.hidden, false, "the card scrolled away, so the strip takes over");
  assert.equal(h.text("#miniTitle"), "First Song");
  assert.equal(h.text("#miniArtist"), "Test Artist");
  assert.equal(bar.classList.contains("playing"), true, "and it knows the speaker is playing");

  // The strip's controls are the card's own commands: one player, two views.
  const queued = h.calls.queue.length;
  h.click("#miniNext");
  await h.settle();
  assert.deepEqual(plain(h.calls.queue.at(-1)), { action: "next" },
    "the strip's next is the queue's own skip");
  assert.ok(h.calls.queue.length > queued);
  const controlled = h.calls.control.length;
  h.click("#miniPlay");
  await h.settle();
  assert.ok(h.calls.control.length > controlled, "and its play button is the card's transport");
  assert.equal(h.calls.failed, 0, "every route the strip asked for is one the console serves");

  // Tapping the strip is a request for the card back, not a play command.
  h.click("#miniStrip");
  await h.settle();
  assert.equal(column.scrollTop, 0, "the strip brings the card back");
  assert.equal(bar.hidden, true, "and steps aside again once it has");

  // The lyrics carry the words and their own transport, so the strip yields to
  // them rather than drawing a second player over the words.
  column.scrollTop = 200;
  column.dispatchEvent(new h.window.Event("scroll"));
  await h.settle();
  assert.equal(bar.hidden, false);
  h.click("#btnLyrics");
  await h.settle();
  assert.equal(bar.hidden, true, "the words take the wall, and the strip yields to them");
  h.unmount();
});

/* ── runner ──────────────────────────────────────────────────────────────── */

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`FAIL ${name}\n     ${error && error.message}\n`);
  }
}
process.stdout.write(
  failed ? `\n${failed} PUCA Panel check(s) failed\n` : `\n${checks.length}/${checks.length} PUCA Panel checks passed\n`,
);
process.exit(failed ? 1 : 0);

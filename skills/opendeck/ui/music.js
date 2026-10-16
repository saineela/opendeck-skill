/* OpenDeck music page — the PUCA Panel's design, in the console's Music tab.
 *
 * This page is the desk-size copy of the wall panel. It is built from the
 * panel's own parts and its own stylesheet language (PUCA-Panel/panel.css):
 * the hero card with the big cover and the soft glow behind it, one control row
 * (shuffle, previous, the big play control, next, repeat), the volume row with
 * the speaker's own mute control and slider, the shelves of sleeves, "Up next"
 * beside them, the results sheet, and the lyrics design that takes over the
 * screen when a track starts. Colors, sizes and the 22:00/06:00 theme flip are
 * the panel's; the type is the panel's own Outfit, served from this package
 * (PUCA-Panel/fonts.css, declared in skill.json) so nothing here reaches for a
 * font CDN. Anything the page cannot do from the console - seeking, which the
 * speaker's stream has no primitive for - is drawn and not offered, rather than
 * offered and broken.
 *
 * It is driven entirely by the shared music API the NIX Home app also calls
 * (window.NixMusicPage.mount(rootElement, api)). Playback happens on the
 * speaker: picking a song hands the resolved OpenDeck stream URL to whichever
 * installed skill owns the player, and this page mirrors what that speaker
 * reports.
 *
 * Two things it is careful about, because both were visibly wrong:
 *
 *   - LYRICS. The page asks for the words of the track it is showing, by id
 *     *and* by name and length, so a lookup can never be answered with another
 *     song's words; it renders plain lyrics when the provider has no timings;
 *     and a lookup that comes back empty is retried once before the page says
 *     there are no words.
 *   - THE QUEUE. What is queued lives in the provider, so the page's copy of it
 *     is kept live: it is re-read when the track changes (a queue moves on by
 *     itself), on a short timer while the page is visible, and after any write.
 *     A reply from an older read can never repaint over a newer one, so a track
 *     that was just added cannot vanish from the list, and Remove/Play/Reorder
 *     never act on a stale position.
 */
(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const SEARCH_DEBOUNCE_MS = 280;
  // The manifest declares the ceiling the provider accepts for one search (12),
  // and the skill runtime refuses an argument above it rather than clamping, so
  // asking for more would come back empty. The sheet lays the answer out as a
  // rail, which is a list to slide through, so a page of results is plenty.
  const SEARCH_LIMIT = 12;
  // One shelf is a row of sleeves (the panel's own shelf size), not a whole
  // library: a wall you can see is browsed, not scrolled through end to end.
  const SHELF_LIMIT = 20;
  // A playlist opened from a shelf is read whole - the Liked Music auto playlist
  // is hundreds of songs. The console and the provider declare the same ceiling.
  const LIBRARY_LIMIT = 500;
  const SEARCH_TTL_MS = 90_000;
  const LIBRARY_TTL_MS = 20_000;
  const CACHE_LIMIT = 40;
  // How long a cached list may still be painted while it is refreshed.
  const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const CACHE_STORE_KEY = "nix.music.cache.v2";
  const CONFIRM_ATTEMPTS = 10;
  const CONFIRM_DELAY_MS = 260;
  const VOLUME_STEP = 0.05;
  // How often the page re-reads the queue while it is on screen. The console
  // polls the snapshot every 1.5s while something plays, and a write paints its
  // own reply, so this only has to catch changes made somewhere else.
  const QUEUE_TTL_MS = 5_000;
  const QUEUE_DRAG_THRESHOLD = 6;
  // A lyrics lookup that comes back empty is tried once more: the provider's
  // request to LRCLIB has a timeout, and a slow answer is not "no words".
  const LYRICS_RETRY_MS = 1_800;
  const NIGHT_FROM = 22;
  const DAY_FROM = 6;
  const ART_TONES = 6;
  const LIKED_PLAYLIST_ID = "LM";
  // The panel's own repeat wording, with its own labels.
  const REPEAT_LABELS = { off: "Repeat", all: "Repeat all", one: "Repeat one" };
  const REPEAT_NEXT = { off: "all", all: "one", one: "off" };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function pathNode(spec) {
    const node = document.createElementNS(SVG_NS, spec.tag || "path");
    Object.keys(spec).forEach(function (name) {
      if (name === "tag") return;
      node.setAttribute(name, spec[name]);
    });
    return node;
  }

  /* The panel's own icons, drawn from the same paths panel.html uses: the page
     and the wall show the same control the same way, so a person who has used
     one already knows the other. */
  const ICONS = {
    shuffle: [{ d: "M16 4h4v4M20 4l-6 6M4 20l6-6M16 20h4v-4M4 4l5 5", fill: "none", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round", "stroke-linejoin": "round" }],
    prev: [{ d: "M18 5v14L7 12zM6 5v14", fill: "none", stroke: "currentColor", "stroke-width": "2.4", "stroke-linecap": "round", "stroke-linejoin": "round" }],
    play: [{ d: "M7 4.5v15l13-7.5z", fill: "currentColor" }],
    pause: [{ d: "M7 4h4v16H7zM13 4h4v16h-4z", fill: "currentColor" }],
    next: [{ d: "M6 5v14l11-7zM18 5v14", fill: "none", stroke: "currentColor", "stroke-width": "2.4", "stroke-linecap": "round", "stroke-linejoin": "round" }],
    repeat: [{ d: "M4 9a5 5 0 0 1 5-5h9l-3-3M20 15a5 5 0 0 1-5 5H6l3 3", fill: "none", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round", "stroke-linejoin": "round" }],
    volume: [
      { d: "M4 9.5h4L13 5v14l-5-4.5H4z", fill: "currentColor" },
      { d: "M16.5 9a4.5 4.5 0 0 1 0 6", fill: "none", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round" },
      { d: "M19 6.5a8 8 0 0 1 0 11", fill: "none", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round" },
    ],
    muted: [
      { d: "M4 9.5h4L13 5v14l-5-4.5H4z", fill: "currentColor" },
      { d: "M17 9.5l4.5 5M21.5 9.5l-4.5 5", fill: "none", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round" },
    ],
    words: [{ d: "M5 6h14M5 11h14M5 16h9", fill: "none", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round" }],
    lens: [
      { tag: "circle", cx: "11", cy: "11", r: "7", fill: "none", stroke: "currentColor", "stroke-width": "2.4" },
      { d: "M16.5 16.5 21 21", stroke: "currentColor", "stroke-width": "2.4", "stroke-linecap": "round" },
    ],
    plus: [{ d: "M12 5v14M5 12h14", fill: "none", stroke: "currentColor", "stroke-width": "2.4", "stroke-linecap": "round" }],
    down: [{ d: "M12 5v13M6 12l6 6 6-6", fill: "none", stroke: "currentColor", "stroke-width": "2.4", "stroke-linecap": "round", "stroke-linejoin": "round" }],
    close: [{ d: "M6 6l12 12M18 6L6 18", fill: "none", stroke: "currentColor", "stroke-width": "2.6", "stroke-linecap": "round" }],
    left: [{ d: "M15 5l-7 7 7 7", fill: "none", stroke: "currentColor", "stroke-width": "2.4", "stroke-linecap": "round", "stroke-linejoin": "round" }],
    right: [{ d: "M9 5l7 7-7 7", fill: "none", stroke: "currentColor", "stroke-width": "2.4", "stroke-linecap": "round", "stroke-linejoin": "round" }],
    heart: [{ d: "M12 20.3S4 15.4 4 10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 8 2.6c0 5.2-8 10.1-8 10.1z", fill: "currentColor" }],
    note: [{ d: "M38 68V38l26-6v30", fill: "none", stroke: "currentColor", "stroke-width": "9", "stroke-linecap": "round", "stroke-linejoin": "round" }, { tag: "circle", cx: "30", cy: "68", r: "9", fill: "currentColor" }, { tag: "circle", cx: "56", cy: "62", r: "9", fill: "currentColor" }],
  };

  function icon(name, viewBox) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", viewBox || "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    (ICONS[name] || []).forEach(function (spec) { svg.appendChild(pathNode(spec)); });
    return svg;
  }

  function iconButton(className, name, label) {
    const button = element("button", className);
    button.type = "button";
    button.appendChild(icon(name));
    if (label) button.setAttribute("aria-label", label);
    return button;
  }

  /* ── covers ────────────────────────────────────────────────────────────────
     A resolved artwork URL is painted as-is (the provider gives absolute
     OpenDeck/YouTube URLs, and the shell rewrites them to the console's own
     cache). A row with no cover gets the panel's own mark on a tinted block,
     and a cover that fails to load degrades to it instead of a broken image. */
  function monogramTone(seed) {
    const text = String(seed || "");
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) % 100000;
    }
    return String(hash % ART_TONES);
  }

  function initials(name) {
    const words = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "♪";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function monogramNode(glyph, seed) {
    const mark = element("span", "mark", glyph || "♪");
    mark.dataset.tone = monogramTone(seed);
    mark.setAttribute("aria-hidden", "true");
    return mark;
  }

  function artNode(url, glyph, seed) {
    if (url) {
      const image = element("img");
      image.alt = "";
      // Attributes as well as properties: every host honours them, including
      // the ones that do not reflect the property back onto the element.
      image.setAttribute("loading", "lazy");
      image.setAttribute("decoding", "async");
      image.addEventListener("error", function () {
        if (image.parentNode) image.parentNode.replaceChild(monogramNode(glyph, seed), image);
      });
      image.src = url;
      return image;
    }
    return monogramNode(glyph, seed);
  }

  function splitPlain(value) {
    return String(value || "").split(/\n+/).map(function (line) { return line.trim(); }).filter(Boolean);
  }

  function mount(root, api) {
    const state = {
      snapshot: null,
      trackVideoId: "",
      lyrics: null,          // timed lines of the track on screen
      lyricsPlain: [],       // words without timings, one entry per line
      lyricsFor: "",
      lyricsSeq: 0,
      lyricsNote: "",
      lyricsOpen: false,
      lyricsDismissedFor: "",  // the one track the user closed the words of
      lyricsZoom: 1,
      lyricsRetried: new Set(),
      lyricsTimer: 0,
      activeLine: null,
      lyricFrame: 0,
      lyricTarget: 0,
      lyricStepAt: 0,
      lyricFrameStalled: false,
      playingVideoId: "",
      clock: { base: null, at: 0, playing: false },
      // One shelf per library group. Each entry is what the shelf is showing.
      shelves: {
        playlists: { payload: null, at: 0, loading: false },
        likes: { payload: null, at: 0, loading: false },
        history: { payload: null, at: 0, loading: false },
      },
      sheet: { open: false, title: "", groups: [], playlistId: "", playlistName: "" },
      cache: new Map(),
      confirmTimers: [],
      playTicker: 0,
      searchTimer: 0,
      searchRequest: null,
      unmounts: [],
      volumeLocal: null,
      volumeMuted: false,
      volumeDragging: false,
      volumeInFlight: false,
      volumePending: false,
      volumeSettleTimer: 0,
      queue: [],
      queueIndex: -1,
      queueAt: 0,
      queueSeq: 0,
      shuffle: false,
      repeat: "off",
      likedSeed: new Set(),
      likedOverrides: new Map(),
      day: false,
    };

    root.innerHTML = "";
    root.classList.add("puca-music");

    /* ── theme ─────────────────────────────────────────────────────────────
       The panel flips itself at 22:00 and 06:00, and the page is the panel's
       design: the same flip, so a screen sitting in a dark room is dark. */
    function applyTheme() {
      const hour = new Date().getHours();
      const day = hour >= DAY_FROM && hour < NIGHT_FROM;
      if (day === state.day && root.classList.contains("day")) return;
      state.day = day;
      root.classList.toggle("day", day);
      root.classList.toggle("night", !day);
    }
    applyTheme();

    /* ── the page's own shape ──────────────────────────────────────────────
       .top (searchbar) / .grid > .left (hero + shelves) + .side (queue), the
       panel's own arrangement. The sheet, the words and Nix's question sit over
       it; the toast is the one place a message appears. */
    const top = element("header", "top music-top");
    const searchForm = element("form", "searchbar music-search");
    searchForm.autocomplete = "off";
    const lens = icon("lens");
    lens.setAttribute("class", "lens");
    const searchInput = element("input");
    searchInput.type = "search";
    searchInput.placeholder = "Search songs, artists, playlists";
    searchInput.setAttribute("aria-label", "Search OpenDeck");
    searchInput.enterKeyHint = "search";
    const searchGo = element("button", "go", "Go");
    searchGo.type = "submit";
    const searchClear = iconButton("music-search-clear", "close", "Clear the search");
    searchClear.hidden = true;
    searchForm.append(lens, searchInput, searchClear, searchGo);
    top.appendChild(searchForm);

    const grid = element("main", "grid");
    const left = element("div", "left");
    const side = element("section", "side music-queue-card");

    // ── hero: what is playing ──────────────────────────────────────────────
    const hero = element("section", "hero music-now-card");
    const artwrap = element("div", "artwrap");
    const art = element("div", "art");
    const artwork = element("img", "music-artwork");
    artwork.alt = "";
    artwork.decoding = "async";
    artwork.setAttribute("fetchpriority", "high");
    artwork.hidden = true;
    const glyph = element("span", "glyph music-art-glyph", "♪");
    art.append(artwork, glyph);
    const glow = element("div", "glow music-glow");
    glow.setAttribute("aria-hidden", "true");
    artwrap.append(art, glow);

    const meta = element("div", "meta");
    const eyebrow = element("p", "eyebrow");
    const dot = element("span", "dot");
    const badge = element("span", "music-badge", "Nothing playing");
    eyebrow.append(dot, badge);
    const title = element("h1", "music-now-title", "Nothing playing");
    const artist = element("p", "artist music-now-artist", "Pick a sleeve below, or search OpenDeck");
    const album = element("p", "album music-now-album");

    const scrub = element("div", "slider scrub music-progress");
    scrub.setAttribute("role", "slider");
    scrub.setAttribute("aria-label", "Progress through the track");
    scrub.setAttribute("aria-valuemin", "0");
    scrub.setAttribute("aria-valuemax", "100");
    scrub.setAttribute("aria-valuenow", "0");
    scrub.setAttribute("aria-readonly", "true");
    scrub.title = "The speaker streams this track, so it cannot be seeked";
    const scrubTrack = element("div", "track");
    const scrubFill = element("div", "fill");
    scrubTrack.appendChild(scrubFill);
    scrub.append(scrubTrack, element("div", "knob"));
    const times = element("div", "times");
    const elapsed = element("span", "music-elapsed", "0:00");
    const total = element("span", "music-total", "--:--");
    times.append(elapsed, total);

    const controls = element("div", "controls music-controls");
    const shuffleButton = element("button", "chip music-extra");
    shuffleButton.type = "button";
    shuffleButton.dataset.control = "shuffle";
    shuffleButton.setAttribute("aria-pressed", "false");
    shuffleButton.title = "Play the rest of the queue in a random order";
    shuffleButton.append(icon("shuffle"), element("span", null, "Shuffle"));
    const prevButton = iconButton("round music-prev", "prev", "Previous track");
    const playButton = element("button", "round play music-play");
    playButton.type = "button";
    playButton.setAttribute("aria-label", "Play or pause");
    playButton.title = "Play or pause";
    const playIcon = icon("play");
    playIcon.setAttribute("class", "ic-play");
    const pauseIcon = icon("pause");
    pauseIcon.setAttribute("class", "ic-pause");
    playButton.append(playIcon, pauseIcon);
    const nextButton = iconButton("round music-next", "next", "Next track");
    const repeatButton = element("button", "chip music-extra");
    repeatButton.type = "button";
    repeatButton.dataset.control = "repeat";
    repeatButton.setAttribute("aria-pressed", "false");
    repeatButton.title = "Repeat: off, the whole queue, or this track";
    const repeatLabel = element("span", null, REPEAT_LABELS.off);
    repeatButton.append(icon("repeat"), repeatLabel);
    controls.append(shuffleButton, prevButton, playButton, nextButton, repeatButton);

    const volumerow = element("div", "volumerow");
    const muteButton = element("button", "vol music-mute");
    muteButton.type = "button";
    muteButton.setAttribute("aria-label", "Mute the speaker");
    muteButton.setAttribute("aria-pressed", "false");
    const volIcon = icon("volume");
    volIcon.setAttribute("class", "ic-vol");
    const mutedIcon = icon("muted");
    mutedIcon.setAttribute("class", "ic-muted");
    muteButton.append(volIcon, mutedIcon);

    const volSlider = element("div", "slider vol music-volwheel");
    volSlider.setAttribute("role", "slider");
    volSlider.setAttribute("tabindex", "0");
    volSlider.setAttribute("aria-label", "Speaker volume");
    volSlider.setAttribute("aria-valuemin", "0");
    volSlider.setAttribute("aria-valuemax", "100");
    volSlider.setAttribute("aria-valuenow", "0");
    const volTrack = element("div", "track");
    const volFill = element("div", "fill");
    volTrack.appendChild(volFill);
    volSlider.append(volTrack, element("div", "knob"));
    const volPct = element("span", "pct music-volnum", "--%");
    volPct.setAttribute("aria-live", "polite");
    const lyricsButton = element("button", "chip music-lyrics-toggle");
    lyricsButton.type = "button";
    lyricsButton.setAttribute("aria-pressed", "false");
    lyricsButton.title = "Show or hide the words";
    lyricsButton.append(icon("words"), element("span", null, "Lyrics"));
    volumerow.append(muteButton, volSlider, volPct, lyricsButton);

    /* Like and Add-to-playlist write to the user's own account, and they act on
       the track that is playing, so they sit with the player as the panel's own
       chips do. */
    const accountRow = element("div", "controls music-account");
    const likeButton = element("button", "chip music-extra");
    likeButton.type = "button";
    likeButton.dataset.control = "like";
    likeButton.setAttribute("aria-pressed", "false");
    likeButton.disabled = true;
    const likeLabel = element("span", null, "Like");
    likeButton.append(icon("heart"), likeLabel);
    const playlistButton = element("button", "chip music-extra");
    playlistButton.type = "button";
    playlistButton.dataset.control = "playlist";
    playlistButton.setAttribute("aria-expanded", "false");
    playlistButton.title = "Add the playing track to one of your playlists";
    playlistButton.append(icon("plus"), element("span", null, "Playlist"));
    accountRow.append(likeButton, playlistButton);

    const stateLine = element("p", "empty music-state");
    stateLine.setAttribute("role", "status");
    meta.append(eyebrow, title, artist, album, scrub, times, controls, volumerow, accountRow, stateLine);
    hero.append(artwrap, meta);

    // ── shelves: the library, as sleeves ───────────────────────────────────
    const shelves = element("section", "shelves music-shelves");
    const shelfNodes = {};
    [
      ["playlists", "Playlists", "Your OpenDeck playlists"],
      ["likes", "Liked songs", "Everything you liked"],
      ["history", "History", "What has been played"],
    ].forEach(function (entry) {
      const shelf = element("section", "shelf");
      shelf.dataset.shelf = entry[0];
      const head = element("div", "shelf-head");
      const heading = element("h2", null, entry[1]);
      const note = element("span", "music-shelf-note", entry[2]);
      head.append(heading, note);
      const row = element("div", "row music-shelf-row");
      row.setAttribute("role", "list");
      shelf.append(head, row);
      shelves.appendChild(shelf);
      shelfNodes[entry[0]] = { shelf: shelf, row: row, note: note };
    });
    const shelfNote = element("p", "empty music-empty music-library-note");
    shelfNote.setAttribute("role", "status");
    shelves.appendChild(shelfNote);

    // ── side: up next ──────────────────────────────────────────────────────
    const sideHead = element("div", "side-head");
    const sideTitle = element("h2", null, "Up next");
    const sideActions = element("div", "music-queue-actions");
    const queueNextButton = element("button", "tiny music-queue-next", "Play next");
    queueNextButton.type = "button";
    const queueClearButton = element("button", "tiny music-queue-clear", "Clear");
    queueClearButton.type = "button";
    sideActions.append(queueNextButton, queueClearButton);
    sideHead.append(sideTitle, sideActions);
    const queueList = element("ol", "queue music-queue-list");
    const queueNote = element("p", "empty music-queue-note", "Queue is empty — use ＋ on a song to add it.");
    queueNote.setAttribute("role", "status");
    side.append(sideHead, queueList, queueNote);

    left.append(hero, shelves);
    grid.append(left, side);

    /* ── the sheet: results and a playlist's songs ─────────────────────────
       The panel draws a list to choose from at the size of the glass it is on,
       over the page, because the person choosing is across the room. */
    const sheet = element("section", "sheet music-sheet");
    sheet.hidden = true;
    const sheetHead = element("header", "music-sheet-head");
    const sheetTitle = element("span", "music-sheet-title", "Results");
    const sheetClose = element("button", "tiny music-sheet-close", "Close");
    sheetClose.type = "button";
    sheetHead.append(sheetTitle, sheetClose);
    const sheetResults = element("div", "results music-sheet-results");
    const sheetHint = element("p", "hint music-sheet-hint");
    sheet.append(sheetHead, sheetResults, sheetHint);

    /* ── the words ─────────────────────────────────────────────────────────
       The panel's lyrics design: the words at the size of the glass, the words
       of what is playing, a hide control, and the text-size pair in the footer.
       The scrub rides along as it does on the panel and is a display, not a
       control: the speaker plays a stream URL and has nothing to seek with. */
    const lyricsOverlay = element("div", "overlay lyrics music-lyrics-overlay");
    lyricsOverlay.hidden = true;
    const lyrBg = element("div", "lyr-bg music-lyr-bg");
    lyrBg.setAttribute("aria-hidden", "true");
    const lyrHead = element("header", "lyr-head");
    const lyrNow = element("div", "lyr-now");
    const lyrTitle = element("span", "np-title music-lyr-title", "Lyrics");
    const lyrArtist = element("span", "np-artist music-lyr-artist");
    lyrNow.append(lyrTitle, lyrArtist);
    const lyrClose = element("button", "lyr-close music-lyr-close");
    lyrClose.type = "button";
    lyrClose.setAttribute("aria-label", "Hide the words");
    lyrClose.append(icon("close"), element("span", null, "Hide"));
    lyrHead.append(lyrNow, lyrClose);
    const lyrScroller = element("div", "lyr-scroller");
    const lyrLines = element("div", "lyr-lines music-lyrics");
    lyrScroller.appendChild(lyrLines);
    const lyrFoot = element("footer", "lyr-foot");
    const lyrZoom = element("div", "lyr-zoom");
    lyrZoom.setAttribute("role", "group");
    lyrZoom.setAttribute("aria-label", "Lyrics text size");
    const zoomOut = element("button", "music-lyr-zoom-out", "A−");
    zoomOut.type = "button";
    zoomOut.setAttribute("aria-label", "Smaller words");
    const zoomIn = element("button", "music-lyr-zoom-in", "A+");
    zoomIn.type = "button";
    zoomIn.setAttribute("aria-label", "Larger words");
    lyrZoom.append(element("span", "lyr-zoom-label", "Text"), zoomOut, zoomIn);
    const lyrScrub = element("div", "slider scrub thin music-lyr-progress");
    lyrScrub.setAttribute("role", "slider");
    lyrScrub.setAttribute("aria-label", "Progress through the track");
    lyrScrub.setAttribute("aria-readonly", "true");
    const lyrTrack = element("div", "track");
    const lyrFill = element("div", "fill");
    lyrTrack.appendChild(lyrFill);
    lyrScrub.append(lyrTrack, element("div", "knob"));
    const lyrTimes = element("div", "lyr-times");
    const lyrElapsed = element("span", "music-lyr-elapsed", "0:00");
    const lyrLeft = element("span", "music-lyr-left", "--:--");
    lyrTimes.append(lyrElapsed, lyrLeft);
    lyrFoot.append(lyrZoom, lyrScrub, lyrTimes);
    lyricsOverlay.append(lyrBg, lyrHead, lyrScroller, lyrFoot);

    /* ── save to a playlist ────────────────────────────────────────────────
       Nix's own question card, because that is what this is: a short list to
       choose one thing from. */
    const picker = element("div", "overlay ask music-picker");
    picker.hidden = true;
    const pickerCard = element("div", "ask-card");
    const pickerHead = element("div", "music-picker-head");
    const pickerCopy = element("div");
    pickerCopy.append(
      element("p", "ask-eyebrow", "Save to"),
      element("h2", null, "Which playlist?")
    );
    const pickerClose = iconButton("music-picker-close", "close", "Close the playlist list");
    pickerHead.append(pickerCopy, pickerClose);
    const pickerList = element("div", "ask-options music-picker-list");
    const pickerForm = element("form", "music-picker-new");
    const pickerInput = element("input");
    pickerInput.type = "text";
    pickerInput.placeholder = "New playlist name…";
    pickerInput.maxLength = 120;
    pickerInput.setAttribute("aria-label", "New playlist name");
    const pickerCreate = element("button", "ghost", "Create");
    pickerCreate.type = "submit";
    pickerForm.append(pickerInput, pickerCreate);
    const pickerNote = element("p", "empty music-picker-note");
    pickerNote.setAttribute("role", "status");
    pickerCard.append(pickerHead, pickerList, pickerForm, pickerNote);
    picker.appendChild(pickerCard);

    const toast = element("div", "toast music-error");
    toast.hidden = true;
    toast.setAttribute("role", "status");

    root.append(top, grid, sheet, lyricsOverlay, picker, toast);

    /* ── messages ─────────────────────────────────────────────────────────
       The panel's toast: one line, over the page, gone by itself. It is also
       the page's own status line for the speaker, where the wording has to
       survive (`.music-state` is rendered in the player). */
    let toastTimer = 0;
    function setNotice(text) {
      const message = String(text || "");
      toast.textContent = message;
      toast.hidden = !message;
      if (toastTimer) window.clearTimeout(toastTimer);
      if (message) {
        toastTimer = window.setTimeout(function () { toast.hidden = true; toast.textContent = ""; }, 9000);
      }
    }

    function formatTime(seconds) { return api.formatTime(seconds); }

    function showArtwork(url, image, fallback) {
      if (url) {
        if (image.getAttribute("src") !== url) image.src = url;
        image.hidden = false;
        fallback.hidden = true;
      } else {
        image.hidden = true;
        image.removeAttribute("src");
        fallback.hidden = false;
      }
    }

    /* ── result cache ─────────────────────────────────────────────────────
       A short-lived cache means a repeat tap (the same shelf, the same search,
       a playlist already opened) paints instantly with no request, while still
       following the library as it changes. It is written through to
       localStorage, so a reload starts from the shelves it already had. */
    function cacheRead(key, ttl) {
      const entry = state.cache.get(key);
      if (!entry || entry.expires < Date.now()) return null;
      return entry.value;
    }

    function cachePeek(key) {
      const entry = state.cache.get(key);
      if (!entry) return null;
      if (entry.expires + CACHE_MAX_AGE_MS < Date.now()) {
        state.cache.delete(key);
        return null;
      }
      return entry.value;
    }

    function cacheWrite(key, value, ttl) {
      if (state.cache.size >= CACHE_LIMIT) {
        const oldest = state.cache.keys().next();
        if (!oldest.done) state.cache.delete(oldest.value);
      }
      state.cache.set(key, { value: value, expires: Date.now() + ttl });
      persistCache();
    }

    function persistCache() {
      try {
        const out = {};
        const now = Date.now();
        state.cache.forEach(function (entry, key) {
          if (entry.expires + CACHE_MAX_AGE_MS > now) {
            out[key] = { value: entry.value, expires: entry.expires };
          }
        });
        window.localStorage.setItem(CACHE_STORE_KEY, JSON.stringify(out));
      } catch (_error) { /* a cache that cannot persist is still a cache */ }
    }

    function hydrateCache() {
      try {
        const raw = window.localStorage.getItem(CACHE_STORE_KEY);
        const saved = raw ? JSON.parse(raw) : null;
        if (!saved || typeof saved !== "object") return;
        const now = Date.now();
        Object.keys(saved).forEach(function (key) {
          const entry = saved[key];
          if (!entry || typeof entry !== "object") return;
          if (!entry.expires || entry.expires + CACHE_MAX_AGE_MS <= now) return;
          if (state.cache.size >= CACHE_LIMIT) return;
          state.cache.set(key, { value: entry.value, expires: entry.expires });
        });
      } catch (_error) { /* an unreadable cache starts the page cold */ }
    }

    /* ── the shelves ──────────────────────────────────────────────────────── */

    function trackTile(track, options) {
      const settings = options || {};
      const tile = element("button", "tile music-tile");
      tile.type = "button";
      if (track.video_id) tile.dataset.videoId = track.video_id;
      const cover = element("div", "cover music-tile-cover");
      cover.appendChild(artNode(track.artwork_url, "♪", track.video_id || track.title));
      const badge = element("span", "playbadge");
      badge.appendChild(icon("play"));
      cover.appendChild(badge);
      tile.append(cover, element("span", "name music-tile-name", track.title || track.video_id || "Unknown track"),
        element("span", "sub music-tile-sub", track.artist || ""));
      tile.title = "Play on " + (state.snapshot && state.snapshot.player && state.snapshot.player.device
        ? state.snapshot.player.device : "the speaker");
      tile.addEventListener("click", function () {
        playTarget({ video_id: track.video_id, title: track.title }, tile);
      });
      if (settings.queue) {
        // The queue control rides the sleeve's corner, where a thumb expects it
        // (the panel's own placement). It is a sibling of the tile, never inside
        // it: one button inside another swallows a tap.
        const wrap = element("div", "resline music-tile-wrap");
        const queueButton = iconButton("res-queue music-queue-add", "plus",
          "Add “" + (track.title || track.video_id || "track") + "” to the play queue");
        queueButton.title = "Add to the play queue";
        queueButton.addEventListener("click", function (event) {
          event.stopPropagation();
          queueAdd(track);
        });
        wrap.append(tile, queueButton);
        // "This song and every song under it": only a song listed in a playlist
        // can offer the rest of one, and nothing above the chosen song travels.
        if (settings.playlistId && track.video_id) {
          const rangeButton = iconButton("res-range music-queue-range", "down",
            "Add “" + (track.title || track.video_id) + "” and every song under it to the play queue");
          rangeButton.title = "Add this song and every song under it";
          rangeButton.addEventListener("click", function (event) {
            event.stopPropagation();
            queueFromHere(track, settings.playlistId);
          });
          wrap.appendChild(rangeButton);
        }
        return wrap;
      }
      return tile;
    }

    function playlistTile(playlist) {
      const tile = element("button", "tile music-tile music-playlist-tile");
      tile.type = "button";
      tile.dataset.playlistId = playlist.playlist_id || "";
      const cover = element("div", "cover music-tile-cover");
      cover.appendChild(artNode(playlist.artwork_url, initials(playlist.name), playlist.playlist_id));
      cover.appendChild(element("span", "playbadge", "›"));
      const count = Number(playlist.track_count || 0);
      tile.append(cover,
        element("span", "name music-tile-name", playlist.name || playlist.playlist_id),
        element("span", "sub music-tile-sub", count ? count + (count === 1 ? " song" : " songs") : "Playlist"));
      tile.addEventListener("click", function () { openPlaylist(playlist); });
      return tile;
    }

    function shelfKey(kind) {
      return "library:" + kind;
    }

    function paintShelf(kind, payload) {
      const node = shelfNodes[kind];
      if (!node) return;
      const items = kind === "playlists" ? (payload.playlists || []) : (payload.tracks || []);
      node.row.innerHTML = "";
      node.note.textContent = items.length ? (items.length === 1 ? "1 item" : items.length + " items") : "";
      if (!items.length) {
        node.note.textContent = kind === "playlists"
          ? "No playlists in this OpenDeck account yet."
          : (kind === "likes" ? "Nothing liked yet." : "Nothing played yet.");
        return;
      }
      const fragment = document.createDocumentFragment();
      items.forEach(function (item) {
        fragment.appendChild(kind === "playlists"
          ? playlistTile(item)
          : trackTile(item, { queue: true }));
      });
      node.row.appendChild(fragment);
      markPlaying(state.playingVideoId);
    }

    async function loadShelf(kind, options) {
      const entry = state.shelves[kind];
      if (!entry) return;
      const force = Boolean(options && options.force);
      const key = shelfKey(kind);
      const fresh = cacheRead(key, LIBRARY_TTL_MS);
      if (fresh && !force) {
        paintShelf(kind, fresh);
        return;
      }
      const held = force ? null : cachePeek(key);
      if (held) paintShelf(kind, held);
      if (entry.loading) return;
      entry.loading = true;
      try {
        const payload = await api.library(kind, { limit: SHELF_LIMIT });
        cacheWrite(key, payload, LIBRARY_TTL_MS);
        entry.payload = payload;
        entry.at = Date.now();
        paintShelf(kind, payload);
        if (kind === "likes") seedLikes(payload);
      } catch (error) {
        if (!held && !fresh) {
          shelfNodes[kind].note.textContent = error.message;
        }
      } finally {
        entry.loading = false;
      }
    }

    function loadShelves(options) {
      Object.keys(state.shelves).forEach(function (kind) { loadShelf(kind, options); });
    }

    function renderSkeletons() {
      Object.keys(shelfNodes).forEach(function (kind) {
        const node = shelfNodes[kind];
        if (node.row.children.length) return;
        const holder = element("div", "music-skeleton");
        for (let index = 0; index < 6; index += 1) holder.appendChild(element("span"));
        node.row.appendChild(holder);
      });
    }

    function markPlaying(videoId) {
      state.playingVideoId = videoId || "";
      root.querySelectorAll(".music-tile").forEach(function (tile) {
        const isPlaying = Boolean(videoId) && tile.dataset.videoId === videoId;
        tile.classList.toggle("playing-ring", isPlaying);
        tile.classList.toggle("is-playing", isPlaying);
        tile.classList.remove("is-pending");
        if (isPlaying) tile.setAttribute("aria-current", "true"); else tile.removeAttribute("aria-current");
      });
    }

    function releasePending() {
      root.querySelectorAll(".is-pending").forEach(function (node) { node.classList.remove("is-pending"); });
    }

    /* ── search, and the sheet ────────────────────────────────────────────── */

    function sheetOpen(open) {
      const next = Boolean(open);
      sheet.hidden = !next;
      root.classList.toggle("sheet-open", next);
      if (!next) {
        state.sheet.open = false;
        state.sheet.playlistId = "";
        return;
      }
      state.sheet.open = true;
      sheet.scrollTop = 0;
    }

    /* One rail of cards per named group, exactly as the panel lays a list out:
       across the sheet, sleeves over names, so a long answer is slid through
       rather than squeezed into a strip of text. */
    function rail(group) {
      const block = element("div", "resgroup");
      const head = element("div", "railhead");
      head.append(element("h3", null, group.title));
      const items = group.items || [];
      (group.actions || []).forEach(function (action) {
        const button = element("button", "tiny music-sheet-action", action.label);
        button.type = "button";
        button.addEventListener("click", action.run);
        head.appendChild(button);
      });
      const railNode = element("div", "rail music-rail");
      items.forEach(function (item) { railNode.appendChild(group.row(item, group)); });
      block.append(head, railNode);
      return block;
    }

    function sheetTrackRow(track, group) {
      const wrap = element("div", "resline music-resline");
      wrap.dataset.videoId = track.video_id || "";
      const card = element("button", "res music-res");
      card.type = "button";
      const cover = element("div", "rart music-res-art");
      cover.appendChild(artNode(track.artwork_url, "♪", track.video_id || track.title));
      card.append(cover,
        element("span", "rt music-res-title", track.title || track.video_id || "Unknown track"),
        element("span", "ra music-res-artist", track.artist || ""));
      if (track.duration_sec) {
        card.appendChild(element("span", "rtag soft music-res-time", formatTime(track.duration_sec)));
      }
      card.addEventListener("click", function () {
        playTarget({ video_id: track.video_id, title: track.title }, card);
      });
      const queueButton = iconButton("res-queue music-queue-add", "plus",
        "Add “" + (track.title || track.video_id || "track") + "” to the play queue");
      queueButton.title = "Add to the play queue";
      queueButton.addEventListener("click", function (event) {
        event.stopPropagation();
        queueAdd(track);
      });
      wrap.append(card, queueButton);
      if (group.playlistId && track.video_id) {
        const rangeButton = iconButton("res-range music-queue-range", "down",
          "Add “" + (track.title || track.video_id) + "” and every song under it to the play queue");
        rangeButton.title = "Add this song and every song under it";
        rangeButton.addEventListener("click", function (event) {
          event.stopPropagation();
          queueFromHere(track, group.playlistId);
        });
        wrap.appendChild(rangeButton);
      }
      return wrap;
    }

    function renderSheet(title, groups, hint) {
      sheetTitle.textContent = title;
      sheetResults.innerHTML = "";
      state.sheet.groups = groups;
      sheetHint.textContent = hint || "";
      if (!groups.length) {
        sheetResults.appendChild(element("p", "empty", "Nothing came back for that."));
        return;
      }
      groups.forEach(function (group) {
        if (!group.items.length) return;
        sheetResults.appendChild(rail(group));
      });
    }

    async function openPlaylist(playlist) {
      state.sheet.playlistId = playlist.playlist_id;
      state.sheet.playlistName = playlist.name || playlist.playlist_id;
      renderSheet(playlist.name || "Playlist", [], "Reading the playlist…");
      sheetOpen(true);
      const key = "library:playlist:" + playlist.playlist_id;
      const cached = cachePeek(key);
      if (cached) paintPlaylist(playlist, cached);
      if (cacheRead(key, LIBRARY_TTL_MS)) return;
      try {
        const payload = await api.library("playlist", { playlist_id: playlist.playlist_id, limit: LIBRARY_LIMIT });
        cacheWrite(key, payload, LIBRARY_TTL_MS);
        if (state.sheet.playlistId === playlist.playlist_id) paintPlaylist(playlist, payload);
      } catch (error) {
        if (cached) return;
        renderSheet(playlist.name || "Playlist", [], error.message);
      }
    }

    function paintPlaylist(playlist, payload) {
      const tracks = (payload.tracks || []).filter(function (track) { return track && track.video_id; });
      if (!tracks.length) {
        renderSheet(playlist.name || "Playlist", [], "That playlist is empty.");
        return;
      }
      const queueAll = {
        label: "Queue all",
        run: function () {
          queueFromHere(tracks[0], playlist.playlist_id);
        },
      };
      renderSheet(playlist.name || "Playlist", [{
        title: tracks.length + (tracks.length === 1 ? " song" : " songs"),
        items: tracks,
        row: sheetTrackRow,
        playlistId: playlist.playlist_id,
        actions: [queueAll],
      }], "Tap a song to send it to the speaker, or ＋ to line it up.");
      markPlaying(state.playingVideoId);
    }

    function runSearch(options) {
      const immediate = Boolean(options && options.immediate);
      window.clearTimeout(state.searchTimer);
      const query = searchInput.value.trim();
      searchClear.hidden = !query;
      if (!query) {
        if (state.sheet.playlistId) return;
        sheetOpen(false);
        return;
      }
      const fire = function () { performSearch(query); };
      if (immediate) fire(); else state.searchTimer = window.setTimeout(fire, SEARCH_DEBOUNCE_MS);
    }

    async function performSearch(query) {
      const key = "search:" + query.toLowerCase() + ":" + SEARCH_LIMIT;
      const cached = cacheRead(key, SEARCH_TTL_MS);
      if (cached) { paintSearch(query, cached); return; }
      if (state.searchRequest) { state.searchRequest.abort(); state.searchRequest = null; }
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      state.searchRequest = controller;
      sheetTitle.textContent = "Searching OpenDeck for “" + query + "”…";
      sheetResults.innerHTML = "";
      sheetHint.textContent = "";
      const holder = element("div", "music-skeleton");
      for (let index = 0; index < 6; index += 1) holder.appendChild(element("span"));
      sheetResults.appendChild(holder);
      sheetOpen(true);
      try {
        const payload = await api.search(query, SEARCH_LIMIT, controller ? { signal: controller.signal } : undefined);
        cacheWrite(key, payload, SEARCH_TTL_MS);
        paintSearch(query, payload);
      } catch (error) {
        if (error && error.name === "AbortError") return;
        renderSheet("Results", [], error.message);
      } finally {
        if (state.searchRequest === controller) state.searchRequest = null;
      }
    }

    function paintSearch(query, payload) {
      const tracks = payload.tracks || [];
      const playlists = payload.playlists || [];
      const groups = [];
      if (tracks.length) {
        groups.push({ title: "Songs", items: tracks, row: sheetTrackRow });
      }
      if (playlists.length) {
        groups.push({
          title: "Playlists",
          items: playlists,
          row: function (playlist) {
            const card = element("button", "res music-res");
            card.type = "button";
            const cover = element("div", "rart music-res-art");
            cover.appendChild(artNode(playlist.artwork_url, initials(playlist.name), playlist.playlist_id));
            card.append(cover,
              element("span", "rt music-res-title", playlist.name || playlist.playlist_id),
              element("span", "ra music-res-artist", (playlist.track_count || 0) + " songs"));
            card.addEventListener("click", function () { openPlaylist(playlist); });
            const wrap = element("div", "resline music-resline");
            wrap.appendChild(card);
            return wrap;
          },
        });
      }
      renderSheet(
        "Results for “" + query + "”",
        groups,
        tracks.length ? "Tap a song to play it on the speaker." : ""
      );
      if (!tracks.length && !playlists.length) {
        renderSheet("Results for “" + query + "”", [], "OpenDeck returned nothing for that.");
      }
      markPlaying(state.playingVideoId);
    }

    /* ── playback ─────────────────────────────────────────────────────────── */

    async function playTarget(target, node) {
      setNotice("");
      if (node) node.classList.add("is-pending");
      const name = target.title || target.video_id || "that track";
      stopPlayTicker();
      const startedAt = Date.now();
      state.playTicker = window.setInterval(function () {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        stateLine.textContent = "Resolving “" + name + "” with OpenDeck… " + seconds + "s";
      }, 500);
      stateLine.textContent = "Sending “" + name + "” to the speaker…";
      try {
        const payload = await api.play(target);
        if (payload.ambiguous) {
          releasePending();
          stateLine.textContent = "";
          const offered = (payload.options || []).map(function (option) { return "“" + (option.title || option.video_id) + "”"; });
          setNotice("That matched " + offered.length + " tracks: " + offered.join(", ") + ". " +
            (payload.panel_available ? "Pick the one you meant on the PUCA Panel." : "Say which one you meant."));
          return;
        }
        applySnapshot(payload);
        const handoff = payload.handoff || {};
        if (!handoff.supported) {
          setNotice("OpenDeck is serving this track, but no installed skill can hand a URL to the speaker yet: " +
            (handoff.reason || "URL playback is unavailable."));
        } else if (handoff.error) {
          setNotice("The speaker skill refused the stream: " + handoff.error);
        }
        stateLine.textContent = "";
        if (payload.track && payload.track.video_id) {
          loadLyrics(payload.track);
          followUp(payload.track.video_id);
          loadQueue({ force: true });
        }
      } catch (error) {
        releasePending();
        setNotice(error.message);
        stateLine.textContent = "";
      } finally {
        stopPlayTicker();
      }
    }

    function stopPlayTicker() {
      if (state.playTicker) { window.clearInterval(state.playTicker); state.playTicker = 0; }
    }

    /* The speaker takes a moment to report that it is really playing. Rather
       than waiting for the shell's background poll, ask the cheap snapshot
       endpoint a few times and stop as soon as the speaker agrees. */
    function followUp(videoId) {
      stopFollowing();
      let attempt = 0;
      const step = async function () {
        attempt += 1;
        try {
          const snapshot = await api.nowPlaying();
          applySnapshot(snapshot);
          if (sessionPlayback(snapshot) || (snapshot.track && snapshot.track.video_id !== videoId)) {
            markPlaying(snapshot.track ? snapshot.track.video_id : "");
            stopFollowing();
            return;
          }
        } catch (_error) { /* transient: the background poll keeps trying */ }
        if (attempt < CONFIRM_ATTEMPTS) {
          state.confirmTimers.push(window.setTimeout(step, CONFIRM_DELAY_MS));
        }
      };
      state.confirmTimers.push(window.setTimeout(step, CONFIRM_DELAY_MS));
    }

    function stopFollowing() {
      state.confirmTimers.forEach(function (timer) { window.clearTimeout(timer); });
      state.confirmTimers = [];
    }

    async function control(action, value) {
      setNotice("");
      try {
        const payload = await api.control(action, value);
        if (payload.player) applyPlayer(payload.player);
        followUp(state.playingVideoId);
      } catch (error) {
        setNotice(error.message);
      }
    }

    function sessionPlayback(snapshot) {
      return Boolean(snapshot && snapshot.playing) ||
        Boolean(snapshot && snapshot.player && snapshot.player.state === "playing");
    }

    function togglePlayback() {
      if (sessionPlayback(state.snapshot)) control("pause"); else control("resume");
    }

    /* ── the clock ─────────────────────────────────────────────────────────
       The speaker reports state and volume but no position, so progress is the
       console's own estimate: elapsed from its hand-off, minus any paused time.
       The page keeps it ticking between polls so the page and the words move. */
    function setClock(snapshot) {
      const position = snapshot && snapshot.position ? snapshot.position : {};
      state.clock.at = typeof position.elapsed_sec === "number" ? position.elapsed_sec : 0;
      state.clock.base = Date.now();
      state.clock.playing = sessionPlayback(snapshot);
      renderClock();
    }

    function currentElapsed() {
      if (!state.clock.playing) return state.clock.at;
      return state.clock.at + (Date.now() - state.clock.base) / 1000;
    }

    function renderClock() {
      const position = state.snapshot && state.snapshot.position ? state.snapshot.position : {};
      const duration = position.duration_sec || null;
      const seconds = currentElapsed();
      elapsed.textContent = formatTime(seconds);
      total.textContent = formatTime(duration);
      const ratio = duration ? Math.min(1, seconds / duration) : 0;
      scrubFill.style.width = (ratio * 100).toFixed(1) + "%";
      scrub.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
      lyrFill.style.width = (ratio * 100).toFixed(1) + "%";
      lyrElapsed.textContent = formatTime(seconds);
      lyrLeft.textContent = duration ? "−" + formatTime(Math.max(0, duration - seconds)) : "--:--";
      highlightLyrics(seconds);
    }

    /* ── the words ─────────────────────────────────────────────────────────
       The page asks for the words of the track it is showing, by id *and* by
       name and length. Naming both is what keeps a lookup from being answered
       with another song's words (the provider matches on names, not on ids),
       and the length is what the provider's exact endpoint needs. */

    function lyricsQuery(track) {
      const query = {};
      if (track.video_id) query.video_id = track.video_id;
      if (track.title) query.title = track.title;
      if (track.artist) query.artist = track.artist;
      if (track.album) query.album = track.album;
      if (typeof track.duration_sec === "number" && track.duration_sec > 0) {
        query.duration_sec = String(Math.round(track.duration_sec));
      }
      return query;
    }

    function lyricsNoteText() {
      if (state.lyricsNote) return state.lyricsNote;
      return "Nothing is playing.";
    }

    async function loadLyrics(track, options) {
      const videoId = track && track.video_id;
      if (!videoId) return;
      const force = Boolean(options && options.force);
      if (!force && state.lyricsFor === videoId && (state.lyrics || state.lyricsPlain.length)) return;
      state.lyricsFor = videoId;
      const seq = ++state.lyricsSeq;
      if (state.lyricsTimer) { window.clearTimeout(state.lyricsTimer); state.lyricsTimer = 0; }
      if (!state.lyrics || force) {
        state.lyricsNote = "Looking for the words of “" + (track.title || videoId) + "”…";
        renderLyrics();
      }
      try {
        const payload = await api.lyrics(lyricsQuery(track));
        if (seq !== state.lyricsSeq) return;   // a newer track's words won the race
        const lines = Array.isArray(payload.lyrics) ? payload.lyrics : [];
        const plain = splitPlain(payload.lyrics_plain);
        if (!lines.length && !plain.length) {
          // The provider's lookup is a timed request to LRCLIB: an empty answer
          // is as likely to be a slow one as a missing song, so it is asked
          // once more before the page says there is nothing.
          if (!state.lyricsRetried.has(videoId)) {
            state.lyricsRetried.add(videoId);
            state.lyricsTimer = window.setTimeout(function () {
              state.lyricsTimer = 0;
              loadLyrics(track, { force: true });
            }, LYRICS_RETRY_MS);
            return;
          }
          state.lyrics = null;
          state.lyricsPlain = [];
          state.lyricsNote = payload.lyrics_timing === "instrumental"
            ? "“" + (track.title || "This track") + "” has no words."
            : "No words for “" + (track.title || videoId) + "” yet. Tap Lyrics to look again.";
          renderLyrics();
          return;
        }
        state.lyrics = lines.length ? lines : null;
        state.lyricsPlain = lines.length ? [] : plain;
        state.lyricsNote = "";
        renderLyrics();
        // A new track opens the words by itself, the way the wall does, unless
        // the person just closed them for this same track.
        if (videoId !== state.lyricsDismissedFor) openLyrics(true);
      } catch (error) {
        if (seq !== state.lyricsSeq) return;
        state.lyricsNote = "The words could not be read: " + error.message;
        renderLyrics();
      }
    }

    function openLyrics(open) {
      const next = Boolean(open);
      lyricsOverlay.hidden = !next;
      state.lyricsOpen = next;
      lyricsButton.classList.toggle("on", next);
      lyricsButton.setAttribute("aria-pressed", next ? "true" : "false");
      if (!next && state.lyricsFor) state.lyricsDismissedFor = state.lyricsFor;
      if (next) {
        state.lyricsDismissedFor = "";
        renderLyrics();
        highlightLyrics(currentElapsed());
      }
    }

    function renderLyrics() {
      const track = state.snapshot && state.snapshot.track ? state.snapshot.track : {};
      lyrTitle.textContent = track.title || "Lyrics";
      lyrArtist.textContent = [track.artist, track.album].filter(Boolean).join(" · ");
      lyrLines.innerHTML = "";
      state.activeLine = null;
      if (state.lyrics && state.lyrics.length) {
        const fragment = document.createDocumentFragment();
        state.lyrics.forEach(function (line) {
          const paragraph = element("p", "lyr-line music-lyr-line", line.text || "♪");
          paragraph.dataset.time = String(line.time_sec);
          fragment.appendChild(paragraph);
        });
        lyrLines.appendChild(fragment);
        // A new track starts from the top of its own words, not from wherever
        // the previous track's follow-along left the box.
        if (state.lyricFrame) { window.cancelAnimationFrame(state.lyricFrame); state.lyricFrame = 0; }
        state.activeLine = null;
        lyrScroller.scrollTop = 0;
        renderClock();
        return;
      }
      if (state.lyricsPlain.length) {
        lyrLines.appendChild(element("p", "lyr-line plain", "Plain lyrics — the provider has no timings for this track."));
        state.lyricsPlain.forEach(function (line) {
          lyrLines.appendChild(element("p", "lyr-line plain music-lyr-line-plain", line));
        });
        lyrScroller.scrollTop = 0;
        return;
      }
      lyrLines.appendChild(element("p", "lyr-line plain", lyricsNoteText()));
    }

    /* Follow-along. `offsetTop` is measured against the nearest *positioned*
       ancestor, which on this page is not the scroller, so the target comes from
       the two rects and is clamped to the box's own scroll range. Lines can
       change faster than a smooth scroll finishes, so one retargeting animation
       holds the box on the line rather than stacking scrolls that fall behind.
       The glide is a nicety, never the mechanism: a kiosk or an embedded WebView
       can have no requestAnimationFrame, or one whose surface is never painted,
       and then the box is placed outright instead of waiting for a frame. */
    function lyricTop(line) {
      const box = lyrScroller.getBoundingClientRect();
      const rect = line.getBoundingClientRect();
      const inside = rect.top - box.top;
      const target = lyrScroller.scrollTop + inside - (lyrScroller.clientHeight - rect.height) / 2;
      return Math.max(0, Math.min(target, lyrScroller.scrollHeight - lyrScroller.clientHeight));
    }

    function lyricRequest(callback) {
      const raf = window.requestAnimationFrame || window.webkitRequestAnimationFrame;
      return typeof raf === "function" ? raf.call(window, callback) : 0;
    }

    function lyricCancel(frame) {
      const cancel = window.cancelAnimationFrame || window.webkitCancelAnimationFrame;
      if (typeof cancel === "function") cancel.call(window, frame);
    }

    function settleLyrics() {
      lyrScroller.scrollTop = state.lyricTarget;
    }

    function glideToLyrics() {
      const raf = window.requestAnimationFrame || window.webkitRequestAnimationFrame;
      if (typeof raf !== "function" || state.lyricFrameStalled) {
        settleLyrics();
        return;
      }
      if (state.lyricFrame) {
        if (Date.now() - state.lyricStepAt < 400) return;
        lyricCancel(state.lyricFrame);
        state.lyricFrame = 0;
        state.lyricFrameStalled = true;
        settleLyrics();
        return;
      }
      const step = function () {
        state.lyricStepAt = Date.now();
        const remaining = state.lyricTarget - lyrScroller.scrollTop;
        if (!isFinite(remaining) || Math.abs(remaining) < 0.5) { settleLyrics(); state.lyricFrame = 0; return; }
        lyrScroller.scrollTop += remaining * 0.28;
        state.lyricFrame = lyricRequest(step);
        if (!state.lyricFrame) settleLyrics();
      };
      state.lyricStepAt = Date.now();
      state.lyricFrame = lyricRequest(step);
      if (!state.lyricFrame) settleLyrics();
    }

    function highlightLyrics(seconds) {
      if (!state.lyrics) return;
      let current = null;
      for (let index = 0; index < state.lyrics.length; index += 1) {
        if (state.lyrics[index].time_sec <= seconds) current = index; else break;
      }
      const node = current === null ? null : lyrLines.children[current];
      if (node === state.activeLine) return;
      if (state.activeLine) state.activeLine.classList.remove("cur");
      state.activeLine = node || null;
      if (!state.activeLine) return;
      state.activeLine.classList.add("cur");
      if (lyrScroller.scrollHeight > lyrScroller.clientHeight) {
        state.lyricTarget = lyricTop(state.activeLine);
        glideToLyrics();
      }
    }

    /* ── the queue ─────────────────────────────────────────────────────────
       The queue lives in the OpenDeck skill (so the assistant can queue tracks
       through its own tool). What this page shows is a *copy*, and a copy that
       is not kept live is the bug that made queued music seem to disappear: the
       console moves the queue on by itself when a song ends and the panel can
       change it from the wall, so a list read once at load drifts, and every
       Remove/Play/Reorder afterwards acts on the wrong position. So the copy is
       re-read when the track changes, on a short timer, and after every write -
       and a reply from an older read can never land on top of a newer one. */
    let queueDrag = null;

    function queueRows() {
      return Array.prototype.slice.call(queueList.querySelectorAll(".music-queue-row"));
    }

    function clearQueueDropMarks() {
      queueRows().forEach(function (row) {
        row.classList.remove("is-drop-before", "is-drop-after");
      });
    }

    function queueSlotAt(clientY) {
      const rows = queueRows();
      for (let index = 0; index < rows.length; index += 1) {
        const box = rows[index].getBoundingClientRect ? rows[index].getBoundingClientRect() : null;
        if (!box || !box.height) continue;
        if (clientY < box.top + box.height / 2) return index;
      }
      return rows.length;
    }

    function paintQueueDrop(slot) {
      clearQueueDropMarks();
      const rows = queueRows();
      if (!rows.length) return;
      if (slot >= rows.length) rows[rows.length - 1].classList.add("is-drop-after");
      else rows[slot].classList.add("is-drop-before");
    }

    // The dragged row leaves the list first, so a slot below its own position is
    // one place earlier by the time the provider inserts it.
    function queueInsertIndex(from, slot) {
      return slot > from ? slot - 1 : slot;
    }

    function queuePointerY(event) {
      return event && typeof event.clientY === "number" ? event.clientY : null;
    }

    function beginQueueDrag(event) {
      if (event.button != null && event.button !== 0) return;
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      if (target.closest("button")) return;    // a press on a control is a tap
      const row = target.closest(".music-queue-row");
      if (!row || !queueList.contains(row)) return;
      const index = Number(row.dataset.index);
      if (!Number.isInteger(index) || index < 0) return;
      queueDrag = {
        from: index,
        row: row,
        pointerId: event.pointerId == null ? 1 : event.pointerId,
        startY: queuePointerY(event) == null ? 0 : queuePointerY(event),
        active: false,
      };
    }

    function moveQueueDrag(event) {
      if (!queueDrag) return;
      const y = queuePointerY(event);
      if (!queueDrag.active) {
        const away = y == null || Math.abs(y - queueDrag.startY) < QUEUE_DRAG_THRESHOLD;
        if (away) return;
        queueDrag.active = true;
        queueDrag.row.classList.add("is-dragging");
        queueList.classList.add("is-reordering");
        if (typeof queueList.setPointerCapture === "function") {
          try { queueList.setPointerCapture(queueDrag.pointerId); } catch (_error) { /* not fatal */ }
        }
      }
      if (typeof event.preventDefault === "function") event.preventDefault();
      paintQueueDrop(queueSlotAt(y == null ? queueDrag.startY : y));
    }

    function finishQueueDrag(event, commit) {
      if (!queueDrag) return;
      const drag = queueDrag;
      queueDrag = null;
      queueList.classList.remove("is-reordering");
      queueRows().forEach(function (row) { row.classList.remove("is-dragging"); });
      clearQueueDropMarks();
      if (!drag.active || !commit) return;
      const y = queuePointerY(event);
      const to = queueInsertIndex(drag.from, queueSlotAt(y == null ? drag.startY : y));
      if (to >= 0 && to !== drag.from) queueMove(drag.from, to);
    }

    function queueRow(item, index) {
      const row = element("li", "music-queue-row");
      row.dataset.index = String(index);
      if (index === state.queueIndex) row.classList.add("is-current");
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      row.setAttribute("aria-label", "Play “" + (item.title || item.video_id || "track") + "”");
      const grip = element("span", "music-queue-grip", "⠿");
      grip.setAttribute("aria-hidden", "true");
      const cover = element("div", "qart music-queue-art");
      cover.appendChild(artNode(item.artwork_url, "♪", item.video_id || item.title));
      const copy = element("div", "qmeta");
      copy.append(element("span", "qt music-queue-title", item.title || item.video_id || "Unknown track"),
        element("span", "qa music-queue-artist", item.artist || ""));
      const end = element("div", "music-queue-end");
      end.appendChild(element("span", "qd music-queue-duration", formatTime(item.duration_sec)));
      const remove = iconButton("tiny music-queue-remove", "close", "Remove from the queue");
      end.appendChild(remove);
      row.append(grip, cover, copy, end);
      row.addEventListener("click", function () { queuePlay(index); });
      row.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); queuePlay(index); }
      });
      remove.addEventListener("click", function (event) {
        event.stopPropagation();
        queueRemove(index);
      });
      return row;
    }

    function renderQueue(payload) {
      const items = payload && Array.isArray(payload.queue) ? payload.queue : [];
      state.queue = items;
      state.queueIndex = payload && typeof payload.index === "number" ? payload.index : -1;
      state.queueAt = Date.now();
      state.shuffle = Boolean(payload && payload.shuffle);
      state.repeat = payload && REPEAT_LABELS[payload.repeat] ? payload.repeat : "off";
      renderMode();
      queueList.innerHTML = "";
      queueNote.hidden = items.length > 0;
      queueNote.textContent = items.length ? "" : "Queue is empty — use ＋ on a song to add it.";
      sideTitle.textContent = items.length ? "Up next · " + items.length : "Up next";
      queueNextButton.disabled = items.length === 0;
      queueClearButton.disabled = items.length === 0;
      const fragment = document.createDocumentFragment();
      items.forEach(function (item, index) { fragment.appendChild(queueRow(item, index)); });
      queueList.appendChild(fragment);
    }

    /* Every write paints its own reply and retires any read that was already on
       the wire, so a slower, older list cannot overwrite it. */
    function applyQueueReply(payload) {
      state.queueSeq += 1;
      renderQueue(payload);
    }

    async function loadQueue(options) {
      const force = Boolean(options && options.force);
      if (!force && Date.now() - state.queueAt < QUEUE_TTL_MS) return;
      const seq = ++state.queueSeq;
      state.queueAt = Date.now();
      try {
        const payload = await api.get("/queue");
        if (seq !== state.queueSeq) return;
        renderQueue(payload);
      } catch (error) {
        if (seq !== state.queueSeq) return;
        if (!state.queue.length) {
          queueNote.hidden = false;
          queueNote.textContent = error.message;
        }
      }
    }

    async function queueAdd(track) {
      if (!track || !track.video_id) return;
      setNotice("");
      try {
        applyQueueReply(await api.post("/queue", { action: "add", video_id: track.video_id }));
        setNotice("Queued “" + (track.title || track.video_id) + "”.");
      } catch (error) {
        setNotice(error.message);
        loadQueue({ force: true });
      }
    }

    async function queueFromHere(track, playlistId) {
      if (!track || !track.video_id || !playlistId) return;
      setNotice("Queuing “" + (track.title || track.video_id) + "” and the rest of the list…");
      try {
        const payload = await api.post("/queue", {
          action: "add_range",
          playlist_id: playlistId,
          video_id: track.video_id,
        });
        applyQueueReply(payload);
        setNotice(payload.message || "Queued the rest of that list.");
      } catch (error) {
        setNotice(error.message);
        loadQueue({ force: true });
      }
    }

    async function queuePlay(index) {
      setNotice("");
      try {
        const payload = await api.post("/queue", { action: "play", index: index });
        applyQueueReply(payload);
        applySnapshot(payload);
      } catch (error) {
        setNotice(error.message);
        loadQueue({ force: true });
      }
    }

    async function queueNext() {
      if (!state.queue.length) { setNotice("Nothing is queued yet."); return; }
      setNotice("");
      try {
        const payload = await api.post("/queue", { action: "next" });
        applyQueueReply(payload);
        applySnapshot(payload);
      } catch (error) {
        setNotice(error.message);
        loadQueue({ force: true });
      }
    }

    async function queueRemove(index) {
      setNotice("");
      try { applyQueueReply(await api.post("/queue", { action: "remove", index: index })); }
      catch (error) {
        setNotice(error.message);
        loadQueue({ force: true });
      }
    }

    async function queueMove(from, to) {
      if (from === to) return;
      setNotice("");
      try { applyQueueReply(await api.post("/queue", { action: "move", index: from, to: to })); }
      catch (error) {
        setNotice(error.message);
        loadQueue({ force: true });
      }
    }

    async function queueClear() {
      setNotice("");
      try { applyQueueReply(await api.post("/queue", { action: "clear" })); }
      catch (error) {
        setNotice(error.message);
        loadQueue({ force: true });
      }
    }

    /* ── shuffle and repeat ────────────────────────────────────────────────
       Both belong to the queue, so every queue reply carries them and the two
       chips are painted from that one answer instead of being tracked here. */
    function renderMode() {
      const mode = REPEAT_LABELS[state.repeat] ? state.repeat : "off";
      shuffleButton.classList.toggle("on", state.shuffle);
      shuffleButton.setAttribute("aria-pressed", state.shuffle ? "true" : "false");
      repeatLabel.textContent = REPEAT_LABELS[mode];
      repeatButton.classList.toggle("on", mode !== "off");
      repeatButton.setAttribute("aria-pressed", mode !== "off" ? "true" : "false");
    }

    async function toggleShuffle() {
      setNotice("");
      shuffleButton.disabled = true;
      try {
        applyQueueReply(await api.post("/queue", { action: "shuffle" }));
      } catch (error) {
        setNotice(error.message);
      } finally {
        shuffleButton.disabled = false;
      }
    }

    async function cycleRepeat() {
      setNotice("");
      repeatButton.disabled = true;
      try {
        const mode = REPEAT_NEXT[state.repeat] || "off";
        applyQueueReply(await api.post("/queue", { action: "repeat", mode: mode }));
      } catch (error) {
        setNotice(error.message);
      } finally {
        repeatButton.disabled = false;
      }
    }

    /* ── like, and save to a playlist ─────────────────────────────────────── */

    function likedTrack(videoId) {
      if (state.likedOverrides.has(videoId)) return state.likedOverrides.get(videoId);
      return state.likedSeed.has(videoId);
    }

    let likeBusy = false;

    function renderLike() {
      const track = state.snapshot && state.snapshot.track;
      const videoId = track && track.video_id ? track.video_id : "";
      const liked = Boolean(videoId) && likedTrack(videoId);
      likeLabel.textContent = liked ? "Liked" : "Like";
      likeButton.classList.toggle("on", liked);
      likeButton.setAttribute("aria-pressed", liked ? "true" : "false");
      likeButton.disabled = likeBusy || !videoId;
      likeButton.setAttribute("aria-label", liked
        ? "Remove the playing track from Liked Music"
        : "Add the playing track to Liked Music");
    }

    function seedLikes(payload) {
      const tracks = payload && Array.isArray(payload.tracks) ? payload.tracks : [];
      state.likedSeed = new Set(tracks.map(function (track) { return track.video_id; }).filter(Boolean));
      renderLike();
    }

    function playingTrack() {
      const track = state.snapshot && state.snapshot.track;
      return track && track.video_id ? track : null;
    }

    async function toggleLike() {
      const track = playingTrack();
      if (!track) { setNotice("Play something first, then like it."); return; }
      const liked = likedTrack(track.video_id);
      const name = track.title || track.video_id;
      setNotice("");
      likeBusy = true;
      renderLike();
      try {
        const payload = await api.post("/save", {
          kind: liked ? "unlike" : "like",
          video_id: track.video_id,
          title: track.title, artist: track.artist, album: track.album,
        });
        state.likedOverrides.set(track.video_id, Boolean(payload.liked));
        state.cache.delete(shelfKey("likes"));
        setNotice(payload.liked
          ? "Added “" + name + "” to Liked Music."
          : "Removed “" + name + "” from Liked Music.");
        if (payload.liked) loadShelf("likes", { force: true });
      } catch (error) {
        setNotice(error.message);
      } finally {
        likeBusy = false;
        renderLike();
      }
    }

    function openPicker(open) {
      const next = Boolean(open);
      picker.hidden = !next;
      playlistButton.classList.toggle("on", next);
      playlistButton.setAttribute("aria-expanded", next ? "true" : "false");
      if (!next) return;
      loadPickerPlaylists();
      pickerInput.focus();
    }

    async function loadPickerPlaylists() {
      const fresh = cacheRead(shelfKey("playlists"), LIBRARY_TTL_MS);
      const held = fresh || cachePeek(shelfKey("playlists"));
      if (held) renderPicker(held.playlists || []);
      if (fresh) return;
      if (!held) {
        pickerNote.hidden = false;
        pickerNote.textContent = "Looking for your OpenDeck playlists…";
      }
      try {
        const payload = await api.library("playlists", { limit: SHELF_LIMIT });
        cacheWrite(shelfKey("playlists"), payload, LIBRARY_TTL_MS);
        renderPicker(payload.playlists || []);
      } catch (error) {
        if (held) return;
        pickerList.innerHTML = "";
        pickerNote.hidden = false;
        pickerNote.textContent = error.message;
      }
    }

    function renderPicker(playlists) {
      const addable = playlists.filter(function (playlist) {
        return Boolean(playlist.playlist_id) && playlist.playlist_id !== LIKED_PLAYLIST_ID;
      });
      pickerList.innerHTML = "";
      pickerNote.hidden = addable.length > 0;
      pickerNote.textContent = addable.length ? "" : "No playlists to add to yet. Name one below.";
      const fragment = document.createDocumentFragment();
      addable.forEach(function (playlist) {
        const row = element("button", "opt music-picker-row");
        row.type = "button";
        const cover = element("div", "oart music-picker-art");
        cover.appendChild(artNode(playlist.artwork_url, initials(playlist.name), playlist.playlist_id));
        const copy = element("div");
        copy.append(element("span", "ot music-picker-name", playlist.name || playlist.playlist_id),
          element("span", "oa music-picker-count", (playlist.track_count || 0) + " songs"));
        row.append(cover, copy);
        row.addEventListener("click", function () { addToPlaylist(playlist.playlist_id, playlist.name); });
        fragment.appendChild(row);
      });
      pickerList.appendChild(fragment);
    }

    async function addToPlaylist(playlistId, playlistName) {
      const track = playingTrack();
      if (!track) { setNotice("Play something first, then add it to a playlist."); return; }
      const name = track.title || track.video_id;
      setNotice("");
      pickerNote.hidden = false;
      pickerNote.textContent = "Adding “" + name + "”…";
      try {
        await api.post("/save", {
          kind: "playlist_add",
          playlist_id: playlistId,
          video_id: track.video_id,
          title: track.title, artist: track.artist, album: track.album,
        });
        state.cache.delete("library:playlist:" + playlistId);
        openPicker(false);
        setNotice("Added “" + name + "” to " + (playlistName || "the playlist") + ".");
        if (state.sheet.playlistId === playlistId && state.sheet.open) {
          const tile = { playlist_id: playlistId, name: playlistName || "Playlist" };
          openPlaylist(tile);
        }
      } catch (error) {
        pickerNote.hidden = false;
        pickerNote.textContent = error.message;
      }
    }

    async function createPlaylistAndAdd() {
      const name = pickerInput.value.trim();
      if (!name) {
        pickerNote.hidden = false;
        pickerNote.textContent = "Name the playlist first.";
        return;
      }
      const track = playingTrack();
      if (!track) { setNotice("Play something first, then add it to a playlist."); return; }
      pickerCreate.disabled = true;
      pickerNote.hidden = false;
      pickerNote.textContent = "Creating “" + name + "”…";
      try {
        const created = await api.post("/save", { kind: "playlist_create", name: name });
        if (!created.playlist_id) throw new Error("OpenDeck created the playlist but did not report its id.");
        await api.post("/save", {
          kind: "playlist_add",
          playlist_id: created.playlist_id,
          video_id: track.video_id,
          title: track.title, artist: track.artist, album: track.album,
        });
        state.cache.delete(shelfKey("playlists"));
        pickerInput.value = "";
        openPicker(false);
        setNotice("Created “" + (created.name || name) + "” and added “" + (track.title || track.video_id) + "” to it.");
        loadShelf("playlists", { force: true });
      } catch (error) {
        pickerNote.hidden = false;
        pickerNote.textContent = error.message;
      } finally {
        pickerCreate.disabled = false;
      }
    }

    /* ── volume ────────────────────────────────────────────────────────────
       The panel's slider: click or drag anywhere along it, scroll for one step,
       arrow keys for a step. A drag previews live and commits when the gesture
       settles; coalescing means a burst of changes sends one request at a time
       and then only the level the user settled on. */
    function percentOf(level) {
      return Math.max(0, Math.min(100, Math.round((Number(level) || 0) * 100)));
    }

    function setVolume(level, muted) {
      const clamped = Math.max(0, Math.min(1, Number(level) || 0));
      state.volumeLocal = clamped;
      const shown = percentOf(clamped);
      volFill.style.width = (clamped * 100).toFixed(1) + "%";
      volPct.textContent = muted ? "Muted" : shown + "%";
      volPct.classList.toggle("is-muted", Boolean(muted));
      volSlider.setAttribute("aria-valuenow", String(shown));
      volSlider.setAttribute("aria-valuetext", (muted ? "muted, " : "") + shown + " percent");
      volumerow.classList.toggle("is-muted", Boolean(muted));
    }

    function applyPlayer(player) {
      if (!player) return;
      const muted = Boolean(player.muted);
      state.volumeMuted = muted;
      const busy = state.volumeDragging || state.volumeInFlight || state.volumePending;
      if (typeof player.volume === "number" && !busy) {
        setVolume(player.volume, muted);
      } else if (state.volumeLocal === null) {
        setVolume(0, muted);
      } else {
        volPct.textContent = muted ? "Muted" : percentOf(state.volumeLocal) + "%";
        volPct.classList.toggle("is-muted", muted);
        volumerow.classList.toggle("is-muted", muted);
      }
      muteButton.classList.toggle("is-muted", muted);
      muteButton.setAttribute("aria-pressed", muted ? "true" : "false");
      muteButton.setAttribute("aria-label", muted ? "Unmute the speaker" : "Mute the speaker");
      muteButton.title = muted ? "Unmute the speaker" : "Mute the speaker";
      stateLine.textContent = player.confirmed
        ? "Speaker " + (player.device ? player.device + " · " : "") + (player.state || "unknown")
        : "The speaker skill is not reporting state.";
    }

    function commitVolume() {
      if (state.volumeInFlight) { state.volumePending = true; return; }
      state.volumeInFlight = true;
      state.volumePending = false;
      const level = Math.max(0, Math.min(1, state.volumeLocal === null ? 0 : state.volumeLocal));
      control("volume", level).finally(function () {
        state.volumeInFlight = false;
        if (state.volumePending) commitVolume();
      });
    }

    function previewVolume(level) { setVolume(level, state.volumeMuted); }

    function nudgeVolume(delta) {
      previewVolume((state.volumeLocal === null ? 0 : state.volumeLocal) + delta);
      commitVolume();
    }

    function settleVolume(ms) {
      if (state.volumeSettleTimer) window.clearTimeout(state.volumeSettleTimer);
      state.volumeSettleTimer = window.setTimeout(function () { state.volumeSettleTimer = 0; commitVolume(); }, ms);
    }

    function volFromPointer(event) {
      const rect = volSlider.getBoundingClientRect();
      if (!rect.width) return;
      previewVolume((event.clientX - rect.left) / rect.width);
    }

    /* ── the snapshot ─────────────────────────────────────────────────────── */

    function applySnapshot(snapshot) {
      if (!snapshot || !snapshot.track) {
        state.snapshot = snapshot || null;
        state.trackVideoId = "";
        setClock(snapshot || {});
        setBadge(null);
        renderLike();
        renderLyrics();
        if (snapshot && snapshot.player) applyPlayer(snapshot.player);
        return;
      }
      const previous = state.trackVideoId;
      state.snapshot = snapshot;
      const track = snapshot.track;
      state.trackVideoId = track.video_id || "";
      title.textContent = track.title || "Untitled";
      artist.textContent = track.artist || "";
      album.textContent = track.album || "";
      showArtwork(track.artwork_url, artwork, glyph);
      const background = track.artwork_url
        ? "radial-gradient(circle at 50% 45%, color-mix(in oklab, var(--accent) 22%, transparent), transparent 70%)"
        : "radial-gradient(circle at 50% 45%, color-mix(in oklab, var(--ink) 16%, transparent), transparent 70%)";
      glow.style.background = background;
      lyrBg.style.background = background;
      if (snapshot.player) applyPlayer(snapshot.player);
      setBadge(snapshot);
      setClock(snapshot);
      if (track.video_id && state.lyricsFor !== track.video_id) loadLyrics(track);
      renderLike();
      markPlaying(track.video_id);
      if (track.video_id !== previous) {
        // A different track is playing, which is what a queue moving on by
        // itself looks like from here: the page's copy of the queue is now a
        // step behind, so it is re-read at once rather than in five seconds.
        loadQueue({ force: true });
      } else {
        loadQueue();
      }
    }

    function setBadge(snapshot) {
      const player = snapshot && snapshot.player;
      const live = sessionPlayback(snapshot || {});
      const device = player && player.device ? player.device : "Speaker";
      const playerState = player && player.state ? player.state : "idle";
      badge.textContent = live ? device + " · playing" : device + " · " + playerState;
      hero.classList.toggle("is-live", live);
      root.classList.toggle("playing", live);
      playButton.setAttribute("aria-label", live ? "Pause" : "Play or resume");
      playButton.title = live ? "Pause" : "Play or resume";
    }

    /* ── wiring ───────────────────────────────────────────────────────────── */

    playButton.addEventListener("click", togglePlayback);
    prevButton.addEventListener("click", function () { control("stop"); });
    nextButton.addEventListener("click", queueNext);
    muteButton.addEventListener("click", function () {
      const muted = state.snapshot && state.snapshot.player && state.snapshot.player.muted;
      control(muted ? "unmute" : "mute");
    });
    shuffleButton.addEventListener("click", toggleShuffle);
    repeatButton.addEventListener("click", cycleRepeat);
    likeButton.addEventListener("click", toggleLike);
    playlistButton.addEventListener("click", function () { openPicker(picker.hidden); });
    pickerClose.addEventListener("click", function () { openPicker(false); });
    pickerForm.addEventListener("submit", function (event) {
      // The page lives inside the dashboard, so the form must never navigate.
      event.preventDefault();
      createPlaylistAndAdd();
    });
    queueNextButton.addEventListener("click", queueNext);
    queueClearButton.addEventListener("click", queueClear);
    lyricsButton.addEventListener("click", function () {
      if (lyricsOverlay.hidden && !state.lyrics && !state.lyricsPlain.length) {
        loadLyrics(state.snapshot && state.snapshot.track, { force: true });
      }
      openLyrics(lyricsOverlay.hidden);
    });
    lyrClose.addEventListener("click", function () { openLyrics(false); });
    zoomOut.addEventListener("click", function () { setLyricsZoom(state.lyricsZoom - 0.15); });
    zoomIn.addEventListener("click", function () { setLyricsZoom(state.lyricsZoom + 0.15); });
    sheetClose.addEventListener("click", function () { sheetOpen(false); });
    searchClear.addEventListener("click", function () {
      searchInput.value = "";
      searchClear.hidden = true;
      sheetOpen(false);
      searchInput.focus();
    });
    searchForm.addEventListener("submit", function (event) {
      event.preventDefault();
      runSearch({ immediate: true });
    });
    searchInput.addEventListener("input", function () { runSearch(); });
    searchInput.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        searchInput.value = "";
        searchClear.hidden = true;
        sheetOpen(false);
      }
    });

    function setLyricsZoom(value) {
      state.lyricsZoom = Math.max(0.75, Math.min(1.75, Number(value) || 1));
      lyrLines.style.setProperty("--lyr-zoom", String(state.lyricsZoom));
      zoomOut.disabled = state.lyricsZoom <= 0.7501;
      zoomIn.disabled = state.lyricsZoom >= 1.7499;
    }

    volSlider.addEventListener("pointerdown", function (event) {
      state.volumeDragging = true;
      volSlider.classList.add("dragging");
      try { volSlider.setPointerCapture(event.pointerId); } catch (_error) { /* ignore */ }
      volFromPointer(event);
    });
    volSlider.addEventListener("pointermove", function (event) { if (state.volumeDragging) volFromPointer(event); });
    volSlider.addEventListener("pointerup", function () {
      if (!state.volumeDragging) return;
      state.volumeDragging = false;
      volSlider.classList.remove("dragging");
      commitVolume();
    });
    volSlider.addEventListener("pointercancel", function () {
      state.volumeDragging = false;
      volSlider.classList.remove("dragging");
    });
    volSlider.addEventListener("wheel", function (event) {
      event.preventDefault();
      previewVolume((state.volumeLocal === null ? 0 : state.volumeLocal) + (event.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP));
      settleVolume(280);
    }, { passive: false });
    volSlider.addEventListener("keydown", function (event) {
      const base = state.volumeLocal === null ? 0 : state.volumeLocal;
      const step = event.key === "PageUp" ? VOLUME_STEP * 2 : event.key === "PageDown" ? -VOLUME_STEP * 2 : 0;
      if (event.key === "ArrowUp" || event.key === "ArrowRight") nudgeVolume(VOLUME_STEP);
      else if (event.key === "ArrowDown" || event.key === "ArrowLeft") nudgeVolume(-VOLUME_STEP);
      else if (step) { previewVolume(base + step); commitVolume(); }
      else if (event.key === "Home") { previewVolume(0); commitVolume(); }
      else if (event.key === "End") { previewVolume(1); commitVolume(); }
      else return;
      event.preventDefault();
      // The page's own shortcuts also answer the arrow keys. Without this the
      // press was handled twice - once by the slider and once by the document -
      // and one tap moved the volume by two steps instead of one.
      event.stopPropagation();
    });

    queueList.addEventListener("pointerdown", beginQueueDrag);
    queueList.addEventListener("pointermove", moveQueueDrag);
    queueList.addEventListener("pointerup", function (event) { finishQueueDrag(event, true); });
    queueList.addEventListener("pointercancel", function (event) { finishQueueDrag(event, false); });
    const onWindowPointerRelease = function (event) { finishQueueDrag(event, true); };
    window.addEventListener("pointerup", onWindowPointerRelease);
    window.addEventListener("pointercancel", onWindowPointerRelease);

    // Shelves fill in when they are scrolled to, so opening the page paints the
    // player at once instead of waiting behind three library reads.
    const shelfObserver = typeof window.IntersectionObserver === "function"
      ? new window.IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          const kind = entry.target.dataset.shelf;
          shelfObserver.unobserve(entry.target);
          loadShelf(kind);
        });
      }, { rootMargin: "300px" })
      : null;

    /* Keyboard shortcuts, ignored while the user is typing anywhere. */
    function onKeydown(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      if (event.key === "Escape") {
        if (!picker.hidden) { openPicker(false); return; }
        if (!lyricsOverlay.hidden) { openLyrics(false); return; }
        if (!sheet.hidden) { sheetOpen(false); return; }
        return;
      }
      if (event.key === "/") { event.preventDefault(); searchInput.focus(); return; }
      if (event.key === " ") { event.preventDefault(); togglePlayback(); return; }
      if (event.key === "m") { muteButton.click(); return; }
      if (event.key === "n") { queueNext(); return; }
      if (event.key === "l") { lyricsButton.click(); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); nudgeVolume(VOLUME_STEP); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); nudgeVolume(-VOLUME_STEP); }
    }
    document.addEventListener("keydown", onKeydown);

    /* ── first paint ──────────────────────────────────────────────────────── */

    state.unmounts.push(api.poll(function (snapshot) { applySnapshot(snapshot); }));
    const ticker = setInterval(function () {
      if (document.hidden) return;
      renderClock();
      applyTheme();
      loadQueue();
    }, 250);

    setLyricsZoom(1);
    renderMode();
    renderLike();
    renderLyrics();
    hydrateCache();
    Object.keys(state.shelves).forEach(function (kind) {
      const held = cachePeek(shelfKey(kind));
      if (held) paintShelf(kind, held);
    });
    renderSkeletons();
    loadShelf("playlists");
    if (shelfObserver) {
      Object.keys(shelfNodes).forEach(function (kind) { shelfObserver.observe(shelfNodes[kind].shelf); });
    } else {
      Object.keys(state.shelves).forEach(function (kind) { loadShelf(kind); });
    }
    loadQueue({ force: true });
    api.nowPlaying().then(function (snapshot) {
      applySnapshot(snapshot);
      if (snapshot.player && snapshot.player.confirmed) setNotice("");
      else setNotice("No installed skill is reporting a speaker; OpenDeck can still serve a stream.");
    }).catch(function (error) {
      stateLine.textContent = error.message;
    });

    return function unmount() {
      clearInterval(ticker);
      window.clearTimeout(state.searchTimer);
      if (state.lyricsTimer) window.clearTimeout(state.lyricsTimer);
      if (toastTimer) window.clearTimeout(toastTimer);
      if (state.volumeSettleTimer) window.clearTimeout(state.volumeSettleTimer);
      stopPlayTicker();
      stopFollowing();
      if (state.searchRequest) { state.searchRequest.abort(); state.searchRequest = null; }
      if (state.lyricFrame) window.cancelAnimationFrame(state.lyricFrame);
      if (shelfObserver) shelfObserver.disconnect();
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerup", onWindowPointerRelease);
      window.removeEventListener("pointercancel", onWindowPointerRelease);
      finishQueueDrag(null, false);
      state.unmounts.forEach(function (off) { try { off(); } catch (_error) { /* ignore */ } });
    };
  }

  window.NixMusicPage = { mount: mount };
})();

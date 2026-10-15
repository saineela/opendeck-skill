/* OpenDeck music page.
 *
 * Fills the console's Music page shell (declared in skill.json as
 * device_ui.page) and is driven entirely by the shared music API that the NIX
 * Home mobile app also calls. Playback happens on the speaker: this page hands
 * the resolved OpenDeck stream URL to whichever installed skill owns the
 * player, then mirrors what that speaker reports.
 *
 * Look: the markup is scoped to .music-app and every surface comes from the
 * console's own tokens (ui/music.css), so the page reads as a NIX page — the
 * same paper cards, sage accent, pill controls and Georgia headings as the
 * dashboard — in light and dark mode, on a phone or on a desktop.
 *
 * Latency: a tap is acknowledged before the network answers (the row is marked
 * pending and the transport updates immediately), results already fetched are
 * served from a short-lived cache with no spinner, typing searches as you type
 * with a debounce, superseded searches and volume levels are dropped rather
 * than queued, and after an action the page polls the cheap snapshot endpoint a
 * few times at 260 ms instead of waiting for the shell's slower background poll.
 *
 * Caching: every library answer (playlists, a playlist's tracks, liked songs,
 * history) and every search result is kept in memory *and* in localStorage, so
 * the page opens on the playlists and covers it already had and then refreshes
 * them from the provider; the worker caches the same reads on disk, so the
 * refresh is cheap instead of another multi-second browse.
 *
 * Contract: window.NixMusicPage = { mount(rootElement, api) }
 */
(function () {
  "use strict";

  const SEARCH_DEBOUNCE_MS = 280;
  const SEARCH_LIMIT = 12;
  // A library read is a list to browse rather than a page of answers: the Liked
  // tab is a real playlist of hundreds, and the page lists what it is given. The
  // console and the provider skill declare the same ceiling.
  const LIBRARY_LIMIT = 500;
  const SEARCH_TTL_MS = 90_000;
  const LIBRARY_TTL_MS = 20_000;
  const CACHE_LIMIT = 40;
  // How long a cached list may still be painted while it is refreshed. Long,
  // because painting the library the user saw last time and then updating it is
  // the whole point: the page has nothing to show until the provider answers,
  // and a linked account's browse takes seconds.
  const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  // Named and versioned: a later release that changes a payload shape reads its
  // own key instead of feeding an old one into the new renderer.
  const CACHE_STORE_KEY = "nix.music.cache.v1";
  // How many tiles a monogram cover can be tinted with (see ui/music.css).
  const ART_TONES = 6;
  const CONFIRM_ATTEMPTS = 10;
  const CONFIRM_DELAY_MS = 260;
  const VOLUME_STEP = 0.05;
  const QUEUE_TTL_MS = 5_000;
  const SVG_NS = "http://www.w3.org/2000/svg";
  // Liked songs are an auto playlist in OpenDeck. The provider refuses writes to
  // it (a like belongs to the Like control), so it is never offered as a target.
  const LIKED_PLAYLIST_ID = "LM";
  const REPEAT_LABELS = { off: "🔁 Repeat off", all: "🔁 Repeat all", one: "🔁 Repeat one" };
  const REPEAT_NEXT = { off: "all", all: "one", one: "off" };
  const VOL_DIAL_R = 56;
  const VOL_DIAL_CIRC = 2 * Math.PI * VOL_DIAL_R;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /* Covers.

     A resolved artwork URL is painted as-is; the provider gives absolute
     OpenDeck/YouTube URLs, so the bytes come from the same caches the rest of
     the account's browsing already fills. A row with no cover — a playlist
     saved without artwork, an auto playlist, a provider that returned none —
     gets a monogram tile instead, tinted from a hash of its own id so it looks
     the same every time. A cover whose URL fails to load degrades to that same
     tile rather than a broken-image icon. */
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
    const tile = element("div", "music-row-art", glyph || "♪");
    tile.dataset.tone = monogramTone(seed);
    tile.setAttribute("aria-hidden", "true");
    return tile;
  }

  function artNode(url, glyph, seed) {
    if (url) {
      const image = element("img");
      image.alt = "";
      // Attributes, not just properties: every host honours them, including the
      // ones that do not reflect the property back onto the element.
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

  /* The mute control's own icon: a speaker that grows waves when it is live and
     carries a slash when it is not, so the button reads at a glance and stays
     legible without colour. */
  function speakerGlyph() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const cone = document.createElementNS(SVG_NS, "path");
    cone.setAttribute("fill", "currentColor");
    cone.setAttribute("d", "M3 9.4h3.7L11.6 5v14L6.7 14.6H3z");
    const waves = document.createElementNS(SVG_NS, "path");
    waves.setAttribute("class", "music-mute-waves");
    waves.setAttribute("fill", "none");
    waves.setAttribute("stroke", "currentColor");
    waves.setAttribute("stroke-width", "1.7");
    waves.setAttribute("stroke-linecap", "round");
    waves.setAttribute("d", "M15 9.4a3.8 3.8 0 0 1 0 5.2M17.7 6.8a7.3 7.3 0 0 1 0 10.4");
    const slash = document.createElementNS(SVG_NS, "path");
    slash.setAttribute("class", "music-mute-slash");
    slash.setAttribute("fill", "none");
    slash.setAttribute("stroke", "currentColor");
    slash.setAttribute("stroke-width", "1.9");
    slash.setAttribute("stroke-linecap", "round");
    slash.setAttribute("d", "M4.6 4.6l14.8 14.8");
    svg.append(cone, waves, slash);
    return svg;
  }

  function barsNode() {
    const bars = element("div", "music-bars");
    bars.hidden = true;
    bars.setAttribute("aria-hidden", "true");
    bars.append(element("span"), element("span"), element("span"));
    return bars;
  }

  function mount(root, api) {
    const state = {
      snapshot: null,
      lyrics: null,
      lyricsFor: "",
      playingVideoId: "",
      clock: { base: null, at: 0, playing: false },
      // `playlistId` is the list the songs on screen were listed in, so a row
      // can offer "this one and the rest" — the Liked tab is the console's LM
      // auto playlist, which is what the console reads the tail of.
      library: { kind: "playlists", playlistId: "" },
      cache: new Map(),
      confirmTimers: [],
      playTicker: 0,
      searchTimer: 0,
      searchRequest: null,
      unmounts: [],
      volumeLocal: null,
      volumeMuted: false,
      queue: [],
      queueIndex: -1,
      queueAt: 0,
      shuffle: false,
      repeat: "off",
      // What the page knows about likes: ids seen in the Liked list, plus the
      // tracks the user liked/unliked here (which outrank the seeded page).
      likedSeed: new Set(),
      likedOverrides: new Map(),
    };

    root.innerHTML = "";

    // ── now playing ──────────────────────────────────────────────────────
    const nowCard = element("section", "music-card music-now-card");
    const hero = element("div", "music-hero");
    const heroArt = element("div", "music-hero-art");
    const artwork = element("img", "music-artwork");
    artwork.alt = "";
    artwork.decoding = "async";
    artwork.fetchPriority = "high";
    artwork.hidden = true;
    const vinyl = element("div", "music-vinyl");
    vinyl.append(element("span", null, "♪"));
    heroArt.append(artwork, vinyl);

    const heroCopy = element("div", "music-hero-copy");
    const badge = element("span", "music-badge", "Speaker idle");
    const title = element("h2", "music-now-title", "Nothing is playing");
    const artist = element("p", "music-now-artist", "Pick something from OpenDeck to send it to the speaker.");
    const progress = element("div", "music-progress");
    const progressFill = element("span");
    progress.appendChild(progressFill);
    const times = element("div", "music-times");
    const elapsed = element("span", null, "--:--");
    const total = element("span", null, "--:--");
    times.append(elapsed, total);

    /* The transport is two round controls and nothing else.

       A separate Pause button repeated the toggle, and a Stop button only ever
       meant "pause a moment", so neither exists: the page carries exactly one
       play/pause control and one mute control, and the phone mini bar is a
       status strip rather than a second set of buttons. Both are circular
       because they sit in the same control hub as the volume wheel, which is
       the Echo Connect speaker panel's composition. */
    const playButton = element("button", "music-round music-play", "▶ Play");
    playButton.type = "button";
    playButton.dataset.primary = "1";
    playButton.setAttribute("aria-label", "Play or resume on the speaker");
    const muteButton = element("button", "music-round music-mute");
    muteButton.type = "button";
    muteButton.setAttribute("aria-label", "Mute the speaker");
    muteButton.setAttribute("aria-pressed", "false");
    muteButton.append(speakerGlyph(), element("span", "music-round-label", "Mute"));

    /* Volume is the Echo Connect speaker panel's control wheel: one soft dial
       with the live level in its centre and a halo behind it, the transport as
       round controls either side of it, and a ▲/▼ stepper under it. Drag,
       scroll or the arrow keys set the level. */
    const volumeRow = element("div", "music-volume");
    const volHead = element("div", "music-volhead");
    const volIcon = document.createElementNS(SVG_NS, "svg");
    volIcon.setAttribute("viewBox", "0 0 24 24");
    volIcon.setAttribute("width", "15");
    volIcon.setAttribute("height", "15");
    volIcon.setAttribute("fill", "currentColor");
    volIcon.setAttribute("aria-hidden", "true");
    const volIconPath = document.createElementNS(SVG_NS, "path");
    volIconPath.setAttribute("d", "M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z");
    volIcon.appendChild(volIconPath);
    const volIconWrap = element("span", "music-spkicon");
    volIconWrap.setAttribute("aria-hidden", "true");
    volIconWrap.appendChild(volIcon);
    volHead.append(volIconWrap, element("span", "music-vollbl", "Volume"));

    const volWheel = element("div", "music-volwheel");
    volWheel.setAttribute("role", "slider");
    volWheel.setAttribute("tabindex", "0");
    volWheel.setAttribute("aria-label", "Speaker volume");
    volWheel.setAttribute("aria-valuemin", "0");
    volWheel.setAttribute("aria-valuemax", "100");
    volWheel.setAttribute("aria-valuenow", "0");
    const volHalo = element("span", "music-volhalo");
    volHalo.setAttribute("aria-hidden", "true");
    const volSvg = document.createElementNS(SVG_NS, "svg");
    volSvg.setAttribute("viewBox", "0 0 150 150");
    volSvg.setAttribute("aria-hidden", "true");
    const volTrackCircle = document.createElementNS(SVG_NS, "circle");
    volTrackCircle.setAttribute("class", "music-voltrack");
    volTrackCircle.setAttribute("cx", "75");
    volTrackCircle.setAttribute("cy", "75");
    volTrackCircle.setAttribute("r", String(VOL_DIAL_R));
    volTrackCircle.setAttribute("fill", "none");
    volTrackCircle.setAttribute("stroke-width", "13");
    const volArc = document.createElementNS(SVG_NS, "circle");
    volArc.setAttribute("class", "music-volarc");
    volArc.setAttribute("cx", "75");
    volArc.setAttribute("cy", "75");
    volArc.setAttribute("r", String(VOL_DIAL_R));
    volArc.setAttribute("fill", "none");
    volArc.setAttribute("stroke-width", "13");
    volArc.setAttribute("stroke-linecap", "round");
    volArc.setAttribute("stroke-dasharray", "0 " + VOL_DIAL_CIRC.toFixed(1));
    volSvg.append(volTrackCircle, volArc);
    const volCtr = element("div", "music-volctr");
    const volNum = element("div", "music-volnum", "--%");
    volNum.setAttribute("aria-live", "polite");
    const volHint = element("div", "music-volhint", "drag · scroll · ↑↓");
    volCtr.append(volNum, volHint);
    volWheel.append(volHalo, volSvg, volCtr);

    const volStep = element("div", "music-volstep");
    const volUp = element("button", "music-volbtn music-volup", "⌃");
    volUp.type = "button";
    volUp.setAttribute("aria-label", "Volume up");
    const volStepDiv = element("span", "music-volstep-div");
    volStepDiv.setAttribute("aria-hidden", "true");
    const volDown = element("button", "music-volbtn music-voldown", "⌄");
    volDown.type = "button";
    volDown.setAttribute("aria-label", "Volume down");
    volStep.append(volUp, volStepDiv, volDown);
    // The hub carries the transport with the wheel, so the whole page has one
    // control cluster instead of a row of buttons plus a dial. It keeps the
    // music-controls name: that is the element the page's own checks read as
    // "the transport".
    const hub = element("div", "music-hub music-controls");
    hub.append(playButton, volWheel, muteButton);
    volumeRow.append(volHead, hub, volStep);

    /* ── queue mode + library actions ──────────────────────────────────────
       Shuffle and Repeat shape the queue; Like and Add-to-playlist write to
       the user's own OpenDeck library. They live on the now-playing card
       because the track playing is what they act on. */
    const extras = element("div", "music-extras");
    const shuffleButton = element("button", "music-extra", "🔀 Shuffle");
    shuffleButton.type = "button";
    shuffleButton.dataset.control = "shuffle";
    shuffleButton.setAttribute("aria-pressed", "false");
    shuffleButton.title = "Play the rest of the queue in a random order";
    const repeatButton = element("button", "music-extra", REPEAT_LABELS.off);
    repeatButton.type = "button";
    repeatButton.dataset.control = "repeat";
    repeatButton.setAttribute("aria-pressed", "false");
    repeatButton.title = "Repeat: off, the whole queue, or this track";
    const likeButton = element("button", "music-extra", "♡ Like");
    likeButton.type = "button";
    likeButton.dataset.control = "like";
    likeButton.setAttribute("aria-pressed", "false");
    likeButton.disabled = true;
    const playlistButton = element("button", "music-extra", "＋ Playlist");
    playlistButton.type = "button";
    playlistButton.dataset.control = "playlist";
    playlistButton.setAttribute("aria-expanded", "false");
    playlistButton.setAttribute("aria-controls", "musicPlaylistPicker");
    playlistButton.title = "Add the playing track to one of your playlists";
    extras.append(shuffleButton, repeatButton, likeButton, playlistButton);

    const picker = element("div", "music-picker");
    picker.id = "musicPlaylistPicker";
    picker.hidden = true;
    const pickerHead = element("div", "music-picker-head");
    const pickerCopy = element("div");
    pickerCopy.append(element("span", "music-eyebrow", "Save to"), element("strong", null, "A playlist"));
    const pickerClose = element("button", "music-picker-close", "✕");
    pickerClose.type = "button";
    pickerClose.setAttribute("aria-label", "Close the playlist list");
    pickerHead.append(pickerCopy, pickerClose);
    const pickerList = element("div", "music-picker-list");
    pickerList.setAttribute("role", "list");
    const pickerForm = element("form", "music-picker-new");
    const pickerInput = element("input");
    pickerInput.type = "text";
    pickerInput.placeholder = "New playlist name…";
    pickerInput.maxLength = 120;
    pickerInput.setAttribute("aria-label", "New playlist name");
    const pickerCreate = element("button", "secondary", "Create");
    pickerCreate.type = "submit";
    pickerForm.append(pickerInput, pickerCreate);
    const pickerNote = element("p", "music-empty");
    pickerNote.setAttribute("role", "status");
    picker.append(pickerHead, pickerList, pickerForm, pickerNote);

    const stateLine = element("p", "music-state", "Waiting for the music API…");
    stateLine.setAttribute("role", "status");
    const notice = element("p", "music-error");
    notice.setAttribute("role", "status");
    heroCopy.append(
      element("span", "music-eyebrow", "Now playing"),
      badge, title, artist, progress, times, volumeRow, extras, picker, stateLine, notice
    );
    hero.append(heroArt, heroCopy);
    nowCard.appendChild(hero);

    // ── library / search ─────────────────────────────────────────────────
    const browseCard = element("section", "music-card music-browse-card");
    const browseHead = element("div", "music-browse-head");
    const browseTitle = element("div");
    browseTitle.append(element("span", "music-eyebrow", "From OpenDeck"), element("h3", null, "Browse"));
    browseHead.appendChild(browseTitle);
    const tabs = element("div", "music-tabs");
    tabs.setAttribute("role", "tablist");
    const searchRow = element("div", "music-search");
    const searchInput = element("input");
    searchInput.type = "search";
    searchInput.placeholder = "Search OpenDeck…  ( / )";
    searchInput.setAttribute("aria-label", "Search OpenDeck");
    searchInput.autocomplete = "off";
    searchInput.enterKeyHint = "search";
    const searchButton = element("button", null, "Search");
    searchButton.type = "button";
    searchButton.className = "secondary";
    searchRow.append(searchInput, searchButton);
    const list = element("div", "music-list");
    list.setAttribute("role", "list");
    const listNote = element("p", "music-empty", "Browse playlists, liked songs or history.");
    listNote.setAttribute("role", "status");
    browseCard.append(browseHead, tabs, searchRow, list, listNote);

    const kinds = [
      ["playlists", "Playlists"],
      ["likes", "Liked"],
      ["history", "History"],
    ];
    kinds.forEach(function (pair) {
      const button = element("button", "active", pair[1]);
      button.type = "button";
      button.dataset.kind = pair[0];
      button.setAttribute("role", "tab");
      button.addEventListener("click", function () {
        state.library = { kind: pair[0], playlistId: "" };
        tabs.querySelectorAll("button").forEach(function (item) {
          item.classList.toggle("active", item === button);
          item.setAttribute("aria-selected", item === button ? "true" : "false");
        });
        loadLibrary();
      });
      tabs.appendChild(button);
    });

    // ── lyrics ───────────────────────────────────────────────────────────
    const lyricsCard = element("section", "music-card music-lyrics-card");
    lyricsCard.append(
      element("span", "music-eyebrow", "Words"),
      element("h3", null, "Lyrics")
    );
    const lyricsBox = element("div", "music-lyrics");
    const lyricsNote = element("p", "music-empty", "Synchronized lyrics appear here while a track plays.");
    lyricsNote.setAttribute("role", "status");
    lyricsCard.append(lyricsBox, lyricsNote);

    // ── queue ────────────────────────────────────────────────────────────
    const queueCard = element("section", "music-card music-queue-card");
    const queueHead = element("div", "music-browse-head");
    const queueTitle = element("div");
    queueTitle.append(
      element("span", "music-eyebrow", "Up next"),
      element("h3", null, "Queue")
    );
    const queueCount = element("span", "music-queue-count", "");
    const queueActions = element("div", "music-queue-actions");
    const queueNextButton = element("button", "secondary", "⏭ Play next");
    queueNextButton.type = "button";
    const queueClearButton = element("button", "secondary", "Clear");
    queueClearButton.type = "button";
    queueActions.append(queueNextButton, queueClearButton);
    queueHead.append(queueTitle, queueCount, queueActions);
    const queueList = element("div", "music-list music-queue-list");
    queueList.setAttribute("role", "list");
    const queueNote = element("p", "music-empty", "Nothing queued. Use ＋ on a track to line it up.");
    queueNote.setAttribute("role", "status");
    queueCard.append(queueHead, queueList, queueNote);

    // ── sticky mini bar (phones) ─────────────────────────────────────────
    const mini = element("button", "music-mini");
    mini.type = "button";
    mini.hidden = true;
    mini.setAttribute("aria-label", "Show the player");
    mini.title = "Show the player";
    const miniArt = element("img");
    miniArt.alt = "";
    miniArt.decoding = "async";
    const miniArtFallback = element("div", "music-mini-art", "♪");
    miniArtFallback.hidden = true;
    const miniCopy = element("div");
    const miniTitle = element("strong", null, "Nothing is playing");
    const miniArtist = element("span", null, "");
    miniCopy.append(miniTitle, miniArtist);
    const miniBars = barsNode();
    // The mini bar reports and leads back to the hub; it deliberately carries no
    // transport of its own, so no control exists twice on the page.
    mini.append(miniArtFallback, miniArt, miniCopy, miniBars);
    mini.addEventListener("click", function () {
      // A plain jump, not a smooth scroll: the lyrics box drives its own
      // animation, and one instant jump to the hub keeps the two apart.
      if (nowCard.scrollIntoView) nowCard.scrollIntoView({ block: "start" });
    });

    root.append(
      (function () {
        const grid = element("div", "music-grid");
        // The wall display's own shape, which this page is the desk-size copy
        // of: the player is the hero, the shelves and the words run under it,
        // and "Up next" is the column beside them — what is queued is read next
        // to what is playing rather than under it. The four cards are the
        // grid's own children and the stylesheet places them by name, so a
        // narrow screen can put the queue directly under the player again.
        grid.append(nowCard, queueCard, browseCard, lyricsCard);
        return grid;
      })(),
      mini
    );

    function setNotice(text) { notice.textContent = text || ""; }

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

    /* ── result cache ───────────────────────────────────────────────────────
       A short-lived cache means a repeat tap (the same tab, the same search, a
       playlist the user already opened) paints instantly with no spinner and no
       request, while still following the library as it changes. */
    function cacheRead(key, ttl) {
      const entry = state.cache.get(key);
      // An entry past its own TTL is not dropped here: the page still paints it
      // once while it refreshes (see cachePeek), which is the only place an
      // entry is ever evicted.
      if (!entry || entry.expires < Date.now()) return null;
      return entry.value;
    }

    /* An entry that has aged past its own TTL is still worth painting once: the
       reloaded page shows the library it had, then replaces it with the provider's
       answer a moment later. Only a copy old enough to mislead is dropped. */
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

    /* The memory cache is written through to localStorage, so a reload, a second
       tab or the NIX Home web view starts from the playlists, liked songs and
       search results it already had — covers included, since the artwork URLs
       travel inside those payloads and the browser's own image cache then serves
       the bytes. Nothing here may throw: a private window or a full quota simply
       means the page starts cold, which is exactly what it did before. */
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

    function renderSkeleton(rows) {
      list.innerHTML = "";
      const holder = element("div", "music-skeleton");
      for (let index = 0; index < rows; index += 1) holder.appendChild(element("span"));
      list.appendChild(holder);
    }

    function renderList(items, emptyText, rowBuilder) {
      list.innerHTML = "";
      listNote.hidden = items.length > 0;
      // Only the visible state carries wording: a hidden note that still says
      // "no tracks" about a list of twelve is a trap for anyone reading the DOM.
      listNote.textContent = items.length ? "" : emptyText;
      const fragment = document.createDocumentFragment();
      items.forEach(function (item) {
        const row = rowBuilder(item);
        if (row) fragment.appendChild(row);
      });
      list.appendChild(fragment);
      markPlaying(state.playingVideoId);
    }

    /* The list a song on screen was listed in: a playlist the user opened, or
       the Liked Music auto playlist. A search result, the history and the
       playlist list itself have none, so those rows carry one control only. */
    function listedPlaylist() {
      const kind = state.library.kind;
      if (kind === "playlist") return state.library.playlistId;
      if (kind === "likes") return LIKED_PLAYLIST_ID;
      return "";
    }

    function trackRow(track) {
      const wrap = element("div", "music-row-wrap");
      const row = element("button", "music-row");
      row.type = "button";
      row.dataset.videoId = track.video_id || "";
      const copy = element("div");
      copy.appendChild(element("strong", null, track.title || track.video_id || "Unknown track"));
      copy.appendChild(element("span", null, track.artist || ""));
      const end = element("div", "music-row-end");
      const bars = barsNode();
      end.append(bars, element("i", null, formatTime(track.duration_sec)));
      row.append(artNode(track.artwork_url, "♪"), copy, end);
      row.title = "Play on " + (state.snapshot && state.snapshot.player && state.snapshot.player.device
        ? state.snapshot.player.device : "the speaker");
      row.addEventListener("click", function () { playTarget({ video_id: track.video_id, title: track.title }, row); });
      // A sibling of the row, never nested inside it: one button inside another
      // is invalid markup and swallows one of the two taps.
      const queueButton = element("button", "music-queue-add", "＋");
      queueButton.type = "button";
      queueButton.title = "Add to the play queue";
      queueButton.setAttribute("aria-label", "Add “" + (track.title || track.video_id || "track") + "” to the play queue");
      queueButton.addEventListener("click", function (event) {
        event.stopPropagation();
        queueAdd(track);
      });
      // "This song and every song under it": only a song that is listed in a
      // playlist can offer the rest of one, and nothing above the chosen song is
      // queued. The console reads the playlist and appends the tail in one call.
      const playlistId = listedPlaylist();
      if (playlistId && track.video_id) {
        const rangeButton = element("button", "music-queue-add music-queue-range");
        rangeButton.type = "button";
        rangeButton.textContent = "↓";
        rangeButton.title = "Add this song and every song under it to the queue";
        rangeButton.setAttribute("aria-label",
          "Add “" + (track.title || track.video_id) + "” and every song under it to the play queue");
        rangeButton.addEventListener("click", function (event) {
          event.stopPropagation();
          queueFromHere(track, playlistId);
        });
        wrap.append(row, queueButton, rangeButton);
        return wrap;
      }
      wrap.append(row, queueButton);
      return wrap;
    }

    function markPlaying(videoId) {
      state.playingVideoId = videoId || "";
      list.querySelectorAll(".music-row").forEach(function (row) {
        const isPlaying = Boolean(videoId) && row.dataset.videoId === videoId;
        row.classList.toggle("is-playing", isPlaying);
        row.classList.remove("is-pending");
        if (isPlaying) row.setAttribute("aria-current", "true"); else row.removeAttribute("aria-current");
        const bars = row.querySelector(".music-bars");
        if (bars) bars.hidden = !isPlaying;
      });
    }

    function releasePending() {
      list.querySelectorAll(".music-row.is-pending").forEach(function (row) { row.classList.remove("is-pending"); });
    }

    async function loadLibrary(options) {
      const force = Boolean(options && options.force);
      const kind = state.library.kind;
      const playlistId = state.library.playlistId;
      const cacheKey = kind === "playlist" ? "library:playlist:" + playlistId : "library:" + kind;
      // Whatever the page had — this session's copy, or the last visit's — so
      // the list is never empty while the provider is asked again.
      const held = force ? null : cachePeek(cacheKey);
      if (held && cacheRead(cacheKey, LIBRARY_TTL_MS)) {
        // A tab the user just visited: already on screen, already up to date.
        paintLibrary(held);
        return;
      }
      const stale = held;
      if (stale) {
        paintLibrary(stale);
      } else {
        listNote.hidden = false;
        listNote.textContent = "Loading " + kind + "…";
        if (!list.children.length) renderSkeleton(3);
      }
      try {
        // A playlist is read whole: the Liked tab is hundreds of songs, and the
        // page lists what the console hands over. The manifest declares the same
        // ceiling, so asking for it is not refused.
        const payload = kind === "playlists"
          ? await api.library("playlists", { limit: SEARCH_LIMIT })
          : kind === "playlist"
            ? await api.library("playlist", { playlist_id: playlistId, limit: LIBRARY_LIMIT })
            : await api.library(kind, { limit: LIBRARY_LIMIT });
        cacheWrite(cacheKey, payload, LIBRARY_TTL_MS);
        // A slow reply must not repaint a tab the user has already left.
        if (state.library.kind === kind && state.library.playlistId === playlistId) {
          paintLibrary(payload);
        }
      } catch (error) {
        // The cached list is still on screen and still usable; a failed refresh
        // is only worth reporting when there is nothing to show at all.
        if (stale) return;
        list.innerHTML = "";
        listNote.hidden = false;
        listNote.textContent = error.message;
      }
    }

    function paintLibrary(payload) {
      if (state.library.kind === "playlists") {
        const playlists = payload.playlists || [];
        renderList(playlists, "This OpenDeck library has no playlists yet.", function (playlist) {
          const row = element("button", "music-row");
          row.type = "button";
          const copy = element("div");
          copy.appendChild(element("strong", null, playlist.name || playlist.playlist_id));
          copy.appendChild(element("span", null, (playlist.track_count || 0) + " track(s)"));
          const end = element("div", "music-row-end");
          end.appendChild(element("i", null, "›"));
          row.append(artNode(playlist.artwork_url, initials(playlist.name), playlist.playlist_id), copy, end);
          row.addEventListener("click", function () {
            state.library = { kind: "playlist", playlistId: playlist.playlist_id };
            tabs.querySelectorAll("button").forEach(function (item) {
              item.classList.remove("active");
              item.setAttribute("aria-selected", "false");
            });
            loadLibrary();
          });
          return row;
        });
      } else {
        if (state.library.kind === "likes") seedLikes(payload);
        renderList(payload.tracks || [], "Nothing here yet.", trackRow);
      }
    }

    /* ── search ─────────────────────────────────────────────────────────────
       Typing searches after a short pause; a superseded request is aborted so a
       slow reply for "d" can never overwrite the results for "daft punk", and
       the answer for a query already asked is served from cache with no spinner. */
    function runSearch(options) {
      const immediate = Boolean(options && options.immediate);
      window.clearTimeout(state.searchTimer);
      const query = searchInput.value.trim();
      if (!query) {
        searchButton.classList.remove("is-busy");
        loadLibrary();
        return;
      }
      const fire = function () { performSearch(query); };
      if (immediate) fire(); else state.searchTimer = window.setTimeout(fire, SEARCH_DEBOUNCE_MS);
    }

    async function performSearch(query) {
      const cacheKey = "search:" + query.toLowerCase() + ":" + SEARCH_LIMIT;
      const cached = cacheRead(cacheKey, SEARCH_TTL_MS);
      if (cached) {
        renderList(cached.tracks || [], "OpenDeck returned no tracks for “" + query + "”.", trackRow);
        searchButton.classList.remove("is-busy");
        return;
      }
      if (state.searchRequest) { state.searchRequest.abort(); state.searchRequest = null; }
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      state.searchRequest = controller;
      searchButton.classList.add("is-busy");
      listNote.hidden = false;
      listNote.textContent = "Searching OpenDeck for “" + query + "”…";
      // A search round trip goes out to the provider, so the list shows its own
      // shape while it waits instead of a jump from nothing to everything.
      renderSkeleton(4);
      try {
        const payload = await api.search(query, SEARCH_LIMIT, controller ? { signal: controller.signal } : undefined);
        cacheWrite(cacheKey, payload, SEARCH_TTL_MS);
        renderList(payload.tracks || [], "OpenDeck returned no tracks for “" + query + "”.", trackRow);
      } catch (error) {
        if (error && error.name === "AbortError") return;
        list.innerHTML = "";
        listNote.hidden = false;
        listNote.textContent = error.message;
      } finally {
        if (state.searchRequest === controller) {
          state.searchRequest = null;
          searchButton.classList.remove("is-busy");
        }
      }
    }

    /* ── playback ───────────────────────────────────────────────────────── */
    async function playTarget(target, row) {
      setNotice("");
      if (row) row.classList.add("is-pending");
      const name = target.title || target.video_id || "that track";
      listNote.hidden = false;
      listNote.textContent = "Sending “" + name + "” to the speaker…";
      // Resolving a stream can take the provider a moment (and can fail on a
      // track it cannot serve), so the wait counts itself out instead of
      // sitting on one frozen sentence.
      stopPlayTicker();
      const startedAt = Date.now();
      state.playTicker = window.setInterval(function () {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        listNote.textContent = "Resolving “" + name + "” with OpenDeck… " + seconds + "s" +
          (seconds >= 8 ? " (this one is slow; long tracks can exceed what the speaker streams)" : "");
      }, 500);
      try {
        const payload = await api.play(target);
        if (payload.ambiguous) {
          // Several tracks answer to the request and the provider refused to
          // guess, so nothing is playing yet: the row is released and the user
          // is told where the choice is waiting rather than left watching a
          // pending row for a track that was never chosen.
          releasePending();
          listNote.textContent = "";
          const offered = (payload.options || []).map(function (option) { return "“" + (option.title || option.video_id) + "”"; });
          setNotice(
            "That matched " + offered.length + " tracks: " + offered.join(", ") + ". " +
            (payload.panel_available
              ? "Pick the one you meant on the PUCA Panel."
              : "Say which one you meant.")
          );
          return;
        }
        applySnapshot(payload);
        const handoff = payload.handoff || {};
        if (!handoff.supported) {
          setNotice("OpenDeck is serving this track, but no installed skill can hand a URL to the speaker yet: " + (handoff.reason || "URL playback is unavailable."));
        } else if (handoff.error) {
          setNotice("The speaker skill refused the stream: " + handoff.error);
        }
        listNote.textContent = "Sent to the speaker.";
        if (payload.track && payload.track.video_id) {
          loadLyrics(payload.track.video_id);
          followUp(payload.track.video_id);
        }
      } catch (error) {
        releasePending();
        setNotice(error.message);
        listNote.textContent = "";
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
          if (sessionPlayback(snapshot) || snapshot.track && snapshot.track.video_id !== videoId) {
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

    /* ── queue ─────────────────────────────────────────────────────────────
       The queue itself lives in the OpenDeck skill (so the assistant can queue
       tracks through its own tool); this page only reads it and asks the
       console to add, drop, reorder, clear, or start the next item. */
    /* Reordering is a pointer drag, not HTML5 drag-and-drop: `dragstart` never
       fires for a finger in the phone webview this page runs in, and a drop
       between rows or below the last one has no row to land on. One pointer
       handler on the list covers mouse, touch and pen: the row is marked as it
       is carried, a line shows the slot it will land in, and the release sends
       one `move`. Dragging only begins after the pointer travels a few pixels,
       so a tap on the row's play/remove buttons still works. */
    const QUEUE_DRAG_THRESHOLD = 6;
    let queueDrag = null; // {from, row, pointerId, startY, active}

    function queueRows() {
      return Array.prototype.slice.call(queueList.querySelectorAll(".music-queue-row"));
    }

    function clearQueueDropMarks() {
      queueRows().forEach(function (row) {
        row.classList.remove("is-drop-before", "is-drop-after");
      });
    }

    // The slot the pointer is over, counted between rows (0 = above the first,
    // rows.length = below the last), so a release in a gap or under the list
    // still lands somewhere instead of doing nothing.
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

    // The dragged row leaves the list first, so a slot below its own position
    // is one place earlier by the time the provider inserts it.
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
      // A press on the row's own controls is a tap, not the start of a drag.
      if (target.closest("button")) return;
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
        // Capture keeps the moves coming once the finger leaves the row; a
        // browser that refuses it still gets the moves while inside the list.
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

    queueList.addEventListener("pointerdown", beginQueueDrag);
    queueList.addEventListener("pointermove", moveQueueDrag);
    queueList.addEventListener("pointerup", function (event) { finishQueueDrag(event, true); });
    queueList.addEventListener("pointercancel", function (event) { finishQueueDrag(event, false); });
    // A release outside the list (no pointer capture, or a finger lifted off the
    // page) still ends the drag rather than leaving the row marked as carried.
    const onWindowPointerRelease = function (event) { finishQueueDrag(event, true); };
    window.addEventListener("pointerup", onWindowPointerRelease);
    window.addEventListener("pointercancel", onWindowPointerRelease);

    function queueRow(item, index) {
      const row = element("div", "music-queue-row");
      row.dataset.index = String(index);
      if (index === state.queueIndex) row.classList.add("is-current");
      // The grip is the grab handle on a touch screen (its own `touch-action:
      // none` keeps the page from scrolling instead), and the whole row is the
      // handle for a mouse.
      const grip = element("span", "music-queue-grip", "⠿");
      grip.setAttribute("aria-hidden", "true");
      row.setAttribute("aria-label", (item.title || item.video_id || "Unknown track") + ", drag to reorder");
      const play = element("button", "music-queue-play", "▶");
      play.type = "button";
      play.setAttribute("aria-label", "Play this queued track");
      const copy = element("div");
      copy.appendChild(element("strong", null, item.title || item.video_id || "Unknown track"));
      copy.appendChild(element("span", null, item.artist || ""));
      const end = element("div", "music-row-end");
      end.appendChild(element("i", null, formatTime(item.duration_sec)));
      const remove = element("button", "music-queue-remove", "✕");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove from the queue");
      end.appendChild(remove);
      row.append(grip, play, artNode(item.artwork_url, "♪"), copy, end);
      play.addEventListener("click", function () { queuePlay(index); });
      remove.addEventListener("click", function () { queueRemove(index); });
      return row;
    }

    function renderQueue(payload) {
      const items = payload && Array.isArray(payload.queue) ? payload.queue : [];
      state.queue = items;
      state.queueIndex = payload && typeof payload.index === "number" ? payload.index : -1;
      state.queueAt = Date.now();
      // Shuffle/repeat arrive with the queue, so the two toggles never guess.
      state.shuffle = Boolean(payload && payload.shuffle);
      state.repeat = payload && REPEAT_LABELS[payload.repeat] ? payload.repeat : "off";
      renderMode();
      queueList.innerHTML = "";
      queueNote.hidden = items.length > 0;
      queueNote.textContent = items.length ? "" : "Nothing queued. Use ＋ on a track to line it up.";
      queueCount.textContent = items.length ? items.length + (items.length === 1 ? " track" : " tracks") : "";
      queueNextButton.disabled = items.length === 0;
      queueClearButton.disabled = items.length === 0;
      const fragment = document.createDocumentFragment();
      items.forEach(function (item, index) { fragment.appendChild(queueRow(item, index)); });
      queueList.appendChild(fragment);
    }

    async function loadQueue(options) {
      const force = Boolean(options && options.force);
      if (!force && Date.now() - state.queueAt < QUEUE_TTL_MS) return;
      try {
        renderQueue(await api.get("/queue"));
      } catch (error) {
        queueNote.hidden = false;
        queueNote.textContent = error.message;
      }
    }

    async function queueAdd(track) {
      if (!track || !track.video_id) return;
      setNotice("");
      try {
        renderQueue(await api.post("/queue", { action: "add", video_id: track.video_id }));
        setNotice("Queued “" + (track.title || track.video_id) + "”.");
      } catch (error) {
        setNotice(error.message);
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
        renderQueue(payload);
        // The console's own sentence knows how many songs fit: the queue has a
        // ceiling, and a playlist longer than it is reported as what landed.
        setNotice(payload.message || "Queued the rest of that list.");
      } catch (error) {
        setNotice(error.message);
      }
    }

    async function queuePlay(index) {
      setNotice("");
      try {
        const payload = await api.post("/queue", { action: "play", index: index });
        renderQueue(payload);
        applySnapshot(payload);
      } catch (error) { setNotice(error.message); }
    }

    async function queueNext() {
      if (!state.queue.length) { setNotice("Nothing is queued yet."); return; }
      setNotice("");
      try {
        const payload = await api.post("/queue", { action: "next" });
        renderQueue(payload);
        applySnapshot(payload);
      } catch (error) { setNotice(error.message); }
    }

    async function queueRemove(index) {
      setNotice("");
      try { renderQueue(await api.post("/queue", { action: "remove", index: index })); }
      catch (error) { setNotice(error.message); }
    }

    /* The whole arrangement is one reorder call: the provider moves the entry
       at `index` to `to`, exactly as the drag was drawn on screen. */
    async function queueMove(from, to) {
      if (from === to) return;
      setNotice("");
      try { renderQueue(await api.post("/queue", { action: "move", index: from, to: to })); }
      catch (error) { setNotice(error.message); }
    }

    async function queueClear() {
      setNotice("");
      try { renderQueue(await api.post("/queue", { action: "clear" })); }
      catch (error) { setNotice(error.message); }
    }

    /* ── shuffle / repeat ──────────────────────────────────────────────────
       Both belong to the queue, so every queue reply carries them and the two
       buttons are painted from that one answer instead of being tracked here. */
    function renderMode() {
      const mode = REPEAT_LABELS[state.repeat] ? state.repeat : "off";
      shuffleButton.textContent = state.shuffle ? "🔀 Shuffling" : "🔀 Shuffle";
      shuffleButton.classList.toggle("is-on", state.shuffle);
      shuffleButton.setAttribute("aria-pressed", state.shuffle ? "true" : "false");
      repeatButton.textContent = REPEAT_LABELS[mode];
      repeatButton.classList.toggle("is-on", mode !== "off");
      repeatButton.setAttribute("aria-pressed", mode !== "off" ? "true" : "false");
    }

    async function toggleShuffle() {
      setNotice("");
      shuffleButton.disabled = true;
      try {
        renderQueue(await api.post("/queue", { action: "shuffle" }));
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
        renderQueue(await api.post("/queue", { action: "repeat", mode: mode }));
      } catch (error) {
        setNotice(error.message);
      } finally {
        repeatButton.disabled = false;
      }
    }

    /* ── like / unlike ────────────────────────────────────────────────────
       The Like button writes to the user's own library through the provider.
       The Liked page is a twelve-row page, so the button is seeded from it when
       the user has looked at it, and from what they did here otherwise. */
    function likedTrack(videoId) {
      if (state.likedOverrides.has(videoId)) return state.likedOverrides.get(videoId);
      return state.likedSeed.has(videoId);
    }

    let likeBusy = false;

    function renderLike() {
      const track = state.snapshot && state.snapshot.track;
      const videoId = track && track.video_id ? track.video_id : "";
      const liked = Boolean(videoId) && likedTrack(videoId);
      likeButton.textContent = liked ? "♥ Liked" : "♡ Like";
      likeButton.classList.toggle("is-on", liked);
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
        // The Liked tab is cached: drop the page this write changed rather than
        // showing the old list until its TTL runs out.
        state.cache.delete("library:likes");
        setNotice(payload.liked
          ? "Added “" + name + "” to Liked Music."
          : "Removed “" + name + "” from Liked Music.");
        if (state.library.kind === "likes") loadLibrary({ force: true });
      } catch (error) {
        setNotice(error.message);
      } finally {
        likeBusy = false;
        renderLike();
      }
    }

    /* ── add to playlist ──────────────────────────────────────────────────
       A disclosure panel rather than a floating menu: it cannot be clipped by
       the card, and it reads the same on a phone as on a desktop. */
    function openPicker(open) {
      const next = Boolean(open);
      picker.hidden = !next;
      playlistButton.classList.toggle("is-on", next);
      playlistButton.setAttribute("aria-expanded", next ? "true" : "false");
      if (!next) return;
      loadPickerPlaylists();
      pickerInput.focus();
    }

    async function loadPickerPlaylists() {
      // Paint the playlists already in hand (this session or the last one) so
      // the picker opens on real rows at once; a copy that is still fresh is
      // the answer, and only an older one is refreshed behind it.
      const fresh = cacheRead("library:playlists", LIBRARY_TTL_MS);
      const held = fresh || cachePeek("library:playlists");
      if (held) renderPicker(held.playlists || []);
      if (fresh) return;
      if (!held) {
        pickerNote.hidden = false;
        pickerNote.textContent = "Looking for your OpenDeck playlists…";
      }
      try {
        // The manifest caps a page at twelve rows, so this is the same window
        // the Playlists tab shows.
        const payload = await api.library("playlists", { limit: SEARCH_LIMIT });
        cacheWrite("library:playlists", payload, LIBRARY_TTL_MS);
        renderPicker(payload.playlists || []);
      } catch (error) {
        if (held) return; // the cached list is still a usable picker
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
        const row = element("button", "music-picker-row");
        row.type = "button";
        const copy = element("div");
        copy.appendChild(element("strong", null, playlist.name || playlist.playlist_id));
        copy.appendChild(element("span", null, (playlist.track_count || 0) + " track(s)"));
        row.append(artNode(playlist.artwork_url, initials(playlist.name), playlist.playlist_id), copy);
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
        // That playlist's cached page is now one track short of the truth.
        state.cache.delete("library:playlist:" + playlistId);
        openPicker(false);
        setNotice("Added “" + name + "” to " + (playlistName || "the playlist") + ".");
        if (state.library.kind === "playlist" && state.library.playlistId === playlistId) loadLibrary({ force: true });
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
        // Both the picker's list and the Playlists tab are cached pages.
        state.cache.delete("library:playlists");
        pickerInput.value = "";
        openPicker(false);
        setNotice("Created “" + (created.name || name) + "” and added “" + (track.title || track.video_id) + "” to it.");
        if (state.library.kind === "playlists") loadLibrary({ force: true });
      } catch (error) {
        pickerNote.hidden = false;
        pickerNote.textContent = error.message;
      } finally {
        pickerCreate.disabled = false;
      }
    }

    function setVolumeDial(level, muted) {
      const clamped = Math.max(0, Math.min(1, Number(level) || 0));
      state.volumeLocal = clamped;
      const shown = Math.round(clamped * 100);
      volArc.setAttribute("stroke-dasharray", (VOL_DIAL_CIRC * clamped).toFixed(1) + " " + VOL_DIAL_CIRC.toFixed(1));
      volNum.textContent = muted ? "Muted" : shown + "%";
      volNum.classList.toggle("is-muted", Boolean(muted));
      volWheel.setAttribute("aria-valuenow", String(shown));
      volWheel.setAttribute("aria-valuetext", (muted ? "muted, " : "") + shown + " percent");
      volUp.disabled = shown >= 100;
      volDown.disabled = shown <= 0;
      volumeRow.classList.toggle("is-muted", Boolean(muted));
    }

    function applyPlayer(player) {
      if (!player) return;
      const muted = Boolean(player.muted);
      state.volumeMuted = muted;
      // A reply about an *older* level must not drag the dial back while the user
      // is still dragging or while a newer level is queued to send; the next
      // idle poll adopts the speaker's value instead.
      const volumeBusy = volumeDragging || volumeInFlight || volumePending;
      if (typeof player.volume === "number" && !volumeBusy) {
        setVolumeDial(player.volume, muted);
      } else if (state.volumeLocal === null) {
        setVolumeDial(0, muted);
      } else {
        volNum.textContent = muted ? "Muted" : Math.round(state.volumeLocal * 100) + "%";
        volNum.classList.toggle("is-muted", muted);
        volumeRow.classList.toggle("is-muted", muted);
      }
      const label = muteButton.querySelector(".music-round-label");
      if (label) label.textContent = muted ? "Unmute" : "Mute";
      muteButton.classList.toggle("is-muted", muted);
      muteButton.setAttribute("aria-pressed", muted ? "true" : "false");
      muteButton.setAttribute("aria-label", muted ? "Unmute the speaker" : "Mute the speaker");
      muteButton.title = muted ? "Unmute the speaker" : "Mute the speaker";
      stateLine.textContent = player.confirmed
        ? "Speaker " + (player.device ? player.device + " · " : "") + (player.state || "unknown")
        : "The speaker skill is not reporting state.";
    }

    /* Volume is coalesced: dragging or tapping the dial previews immediately
       but sends at most one request at a time, then only the value the user
       settled on. A superseded level never floods the API or reports a failure
       for a value that has already been replaced. */
    let volumeInFlight = false;
    let volumePending = false;
    function commitVolume() {
      if (volumeInFlight) { volumePending = true; return; }
      volumeInFlight = true;
      volumePending = false;
      const level = Math.max(0, Math.min(1, state.volumeLocal === null ? 0 : state.volumeLocal));
      control("volume", level).finally(function () {
        volumeInFlight = false;
        if (volumePending) commitVolume();
      });
    }

    function previewVolume(level) { setVolumeDial(level, state.volumeMuted); }

    function setClock(snapshot) {
      const position = snapshot.position || {};
      state.clock.at = typeof position.elapsed_sec === "number" ? position.elapsed_sec : 0;
      state.clock.base = Date.now();
      state.clock.playing = sessionPlayback(snapshot);
      renderClock();
    }

    function sessionPlayback(snapshot) {
      return Boolean(snapshot.playing) || (snapshot.player && snapshot.player.state) === "playing";
    }

    function currentElapsed() {
      if (!state.clock.playing) return state.clock.at;
      return state.clock.at + (Date.now() - state.clock.base) / 1000;
    }

    function renderClock() {
      const duration = state.snapshot && state.snapshot.position ? state.snapshot.position.duration_sec : null;
      const seconds = currentElapsed();
      elapsed.textContent = formatTime(seconds);
      total.textContent = formatTime(duration);
      const ratio = duration ? Math.min(1, seconds / duration) : 0;
      progressFill.style.width = (ratio * 100).toFixed(1) + "%";
      highlightLyrics(seconds);
    }

    function applySnapshot(snapshot) {
      if (!snapshot || !snapshot.track) {
        state.snapshot = snapshot || null;
        setClock(snapshot || {});
        setBadge(null);
        mini.hidden = true;
        renderLike();
        if (state.snapshot && state.snapshot.player) applyPlayer(state.snapshot.player);
        return;
      }
      state.snapshot = snapshot;
      const track = snapshot.track;
      title.textContent = track.title || "Untitled";
      artist.textContent = [track.artist, track.album].filter(Boolean).join(" · ") || "OpenDeck";
      showArtwork(track.artwork_url, artwork, vinyl);
      miniTitle.textContent = track.title || "Untitled";
      miniArtist.textContent = [track.artist, snapshot.player && snapshot.player.device].filter(Boolean).join(" · ");
      showArtwork(track.artwork_url, miniArt, miniArtFallback);
      mini.hidden = false;
      if (snapshot.player) applyPlayer(snapshot.player);
      setBadge(snapshot);
      setClock(snapshot);
      if (track.video_id && state.lyricsFor !== track.video_id) loadLyrics(track.video_id);
      renderLike();
      markPlaying(track.video_id);
    }

    function setBadge(snapshot) {
      const player = snapshot && snapshot.player;
      const live = sessionPlayback(snapshot || {});
      const device = player && player.device ? player.device : "Speaker";
      const playerState = player && player.state ? player.state : "idle";
      badge.textContent = live ? device + " · playing" : device + " · " + playerState;
      badge.classList.toggle("is-live", live);
      nowCard.classList.toggle("is-live", live);
      const miniBars = mini.querySelector(".music-bars");
      if (miniBars) miniBars.hidden = !live;
      playButton.textContent = live ? "❙❙ Pause" : "▶ Play";
      playButton.setAttribute("aria-label", live ? "Pause the speaker" : "Play or resume on the speaker");
    }

    async function loadLyrics(videoId) {
      if (!videoId) return;
      state.lyricsFor = videoId;
      lyricsNote.hidden = false;
      lyricsNote.textContent = "Looking for synchronized lyrics…";
      try {
        const payload = await api.lyrics({ video_id: videoId });
        state.lyrics = (payload.lyrics || []).length ? payload.lyrics : null;
        lyricsBox.innerHTML = "";
        if (!state.lyrics) {
          lyricsNote.textContent = payload.lyrics_timing === "plain"
            ? "No synchronized lyrics for this track; the provider returned plain text only."
            : "No lyrics are available for this track.";
          return;
        }
        lyricsNote.hidden = true;
        const fragment = document.createDocumentFragment();
        state.lyrics.forEach(function (line) {
          const paragraph = element("p", null, line.text || "♪");
          paragraph.dataset.time = String(line.time_sec);
          fragment.appendChild(paragraph);
        });
        lyricsBox.appendChild(fragment);
        // A new track starts from the top of its own lyrics, not from wherever
        // the previous track's follow-along left the box.
        if (lyricFrame) { window.cancelAnimationFrame(lyricFrame); lyricFrame = 0; }
        activeLine = null;
        lyricsBox.scrollTop = 0;
        renderClock();
      } catch (error) {
        lyricsBox.innerHTML = "";
        lyricsNote.hidden = false;
        lyricsNote.textContent = "Lyrics are unavailable: " + error.message;
      }
    }

    /* Lyric follow-along.
       offsetTop is measured against the nearest *positioned* ancestor, which on
       this page is not the lyrics box, so centring with it scrolled to the wrong
       place. The target comes from the two rects instead and is clamped to the
       box's own scroll range. Lines can change faster than a smooth scroll
       finishes, so one retargeting animation holds the box on the current line
       rather than stacking scrolls that fall behind the song.

       The glide is a nicety, never the mechanism. A kiosk or embedded WebView
       can have no requestAnimationFrame, or one whose surface is never painted,
       and then the frame the box waits on never runs while the page's own clock
       ticker keeps moving the highlight: the highlight walks down the page and
       the box stands still. So the box is placed outright when there is no
       frame to wait on, or when one has not arrived for longer than any live
       browser's frame (see glideToLyrics). */
    let activeLine = null;
    let lyricFrame = 0;
    let lyricTarget = 0;
    let lyricStepAt = 0;
    let lyricFrameStalled = false;

    function lyricTop(line) {
      const box = lyricsBox.getBoundingClientRect();
      const rect = line.getBoundingClientRect();
      const inside = rect.top - box.top; // the line's offset inside the visible box
      const target = lyricsBox.scrollTop + inside - (lyricsBox.clientHeight - rect.height) / 2;
      return Math.max(0, Math.min(target, lyricsBox.scrollHeight - lyricsBox.clientHeight));
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
      lyricsBox.scrollTop = lyricTarget;
    }

    function glideToLyrics() {
      const raf = window.requestAnimationFrame || window.webkitRequestAnimationFrame;
      // No frame callback at all, or one this browser has already proved it
      // never runs: place the box on the line now, every time.
      if (typeof raf !== "function" || lyricFrameStalled) {
        settleLyrics();
        return;
      }
      if (lyricFrame) {
        // Already on its way: retarget it, do not stack a second animation. A
        // frame that has not run for far longer than a live browser's is never
        // going to, so place the box and stop waiting on frames for this visit.
        if (Date.now() - lyricStepAt < 400) return;
        lyricCancel(lyricFrame);
        lyricFrame = 0;
        lyricFrameStalled = true;
        settleLyrics();
        return;
      }
      const step = function () {
        lyricStepAt = Date.now();
        const remaining = lyricTarget - lyricsBox.scrollTop;
        if (!isFinite(remaining) || Math.abs(remaining) < 0.5) { settleLyrics(); lyricFrame = 0; return; }
        lyricsBox.scrollTop += remaining * 0.28;
        lyricFrame = lyricRequest(step);
        if (!lyricFrame) settleLyrics();
      };
      lyricStepAt = Date.now();
      lyricFrame = lyricRequest(step);
      if (!lyricFrame) settleLyrics();
    }

    function highlightLyrics(seconds) {
      if (!state.lyrics) return;
      let current = null;
      for (let index = 0; index < state.lyrics.length; index += 1) {
        if (state.lyrics[index].time_sec <= seconds) current = index; else break;
      }
      const node = current === null ? null : lyricsBox.children[current];
      if (node === activeLine) return;
      if (activeLine) activeLine.classList.remove("active");
      activeLine = node || null;
      if (!activeLine) return;
      activeLine.classList.add("active");
      if (lyricsBox.scrollHeight > lyricsBox.clientHeight) {
        lyricTarget = lyricTop(activeLine);
        glideToLyrics();
      }
    }

    function togglePlayback() {
      if (sessionPlayback(state.snapshot || {})) control("pause"); else control("resume");
    }

    function nudgeVolume(delta) {
      const base = state.volumeLocal === null ? 0 : state.volumeLocal;
      previewVolume(base + delta);
      commitVolume();
    }

    /* The dial follows the speaker panel: drag (or tap) anywhere on the ring to
       set a level, scroll for one step, arrow keys for a step. A drag previews
       live and commits when the gesture settles; a step commits at once. */
    let volumeDragging = false;
    let volumeSettleTimer = 0;
    function volFromPointer(event) {
      const rect = volWheel.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      if (Math.hypot(dx, dy) < rect.width * 0.18) return;
      let angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
      if (angle < 0) angle += 360;
      setVolumeDial(angle / 360, state.volumeMuted);
    }
    function settleVolume(ms) {
      if (volumeSettleTimer) window.clearTimeout(volumeSettleTimer);
      volumeSettleTimer = window.setTimeout(function () { volumeSettleTimer = 0; commitVolume(); }, ms);
    }
    volWheel.addEventListener("pointerdown", function (event) {
      volumeDragging = true;
      volWheel.classList.add("is-dragging");
      try { volWheel.setPointerCapture(event.pointerId); } catch (_error) { /* ignore */ }
      volFromPointer(event);
    });
    volWheel.addEventListener("pointermove", function (event) { if (volumeDragging) volFromPointer(event); });
    volWheel.addEventListener("pointerup", function () {
      if (!volumeDragging) return;
      volumeDragging = false;
      volWheel.classList.remove("is-dragging");
      commitVolume();
    });
    volWheel.addEventListener("pointercancel", function () {
      volumeDragging = false;
      volWheel.classList.remove("is-dragging");
    });
    volWheel.addEventListener("wheel", function (event) {
      event.preventDefault();
      previewVolume((state.volumeLocal === null ? 0 : state.volumeLocal) + (event.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP));
      settleVolume(280);
    }, { passive: false });
    volWheel.addEventListener("keydown", function (event) {
      const step = event.key === "PageUp" ? VOLUME_STEP * 2 : event.key === "PageDown" ? -VOLUME_STEP * 2 : 0;
      const base = state.volumeLocal === null ? 0 : state.volumeLocal;
      if (event.key === "ArrowUp" || event.key === "ArrowRight") nudgeVolume(VOLUME_STEP);
      else if (event.key === "ArrowDown" || event.key === "ArrowLeft") nudgeVolume(-VOLUME_STEP);
      else if (step) { previewVolume(base + step); commitVolume(); }
      else if (event.key === "Home") { previewVolume(0); commitVolume(); }
      else if (event.key === "End") { previewVolume(1); commitVolume(); }
      else return;
      event.preventDefault();
    });

    playButton.addEventListener("click", togglePlayback);
    muteButton.addEventListener("click", function () {
      const muted = state.snapshot && state.snapshot.player && state.snapshot.player.muted;
      control(muted ? "unmute" : "mute");
    });
    volUp.addEventListener("click", function () { nudgeVolume(VOLUME_STEP); });
    volDown.addEventListener("click", function () { nudgeVolume(-VOLUME_STEP); });
    queueNextButton.addEventListener("click", queueNext);
    queueClearButton.addEventListener("click", queueClear);
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
    searchButton.addEventListener("click", function () { runSearch({ immediate: true }); });
    searchInput.addEventListener("input", function () { runSearch(); });
    searchInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); runSearch({ immediate: true }); }
      if (event.key === "Escape") { searchInput.value = ""; runSearch({ immediate: true }); }
    });
    tabs.querySelector('button[data-kind="playlists"]').setAttribute("aria-selected", "true");

    /* Keyboard shortcuts, ignored while the user is typing anywhere. */
    function onKeydown(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      if (event.key === "Escape" && !picker.hidden) { openPicker(false); return; }
      if (event.key === "/") { event.preventDefault(); searchInput.focus(); return; }
      if (event.key === " ") { event.preventDefault(); togglePlayback(); return; }
      if (event.key === "m") { muteButton.click(); return; }
      if (event.key === "n") { queueNext(); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); nudgeVolume(VOLUME_STEP); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); nudgeVolume(-VOLUME_STEP); }
    }
    document.addEventListener("keydown", onKeydown);

    state.unmounts.push(api.poll(function (snapshot) { applySnapshot(snapshot); }));
    const ticker = setInterval(function () { if (!document.hidden) renderClock(); }, 250);

    // First paint.
    api.nowPlaying().then(function (snapshot) {
      applySnapshot(snapshot);
      setNotice(snapshot.player && snapshot.player.confirmed ? "" : "No installed skill is reporting a speaker; OpenDeck can still serve a stream.");
    }).catch(function (error) {
      stateLine.textContent = error.message;
    });
    renderMode();
    renderLike();
    hydrateCache();
    loadLibrary();
    loadQueue();

    return function unmount() {
      clearInterval(ticker);
      window.clearTimeout(state.searchTimer);
      stopPlayTicker();
      stopFollowing();
      if (state.searchRequest) { state.searchRequest.abort(); state.searchRequest = null; }
      if (lyricFrame) window.cancelAnimationFrame(lyricFrame);
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerup", onWindowPointerRelease);
      window.removeEventListener("pointercancel", onWindowPointerRelease);
      finishQueueDrag(null, false);
      state.unmounts.forEach(function (off) { try { off(); } catch (_error) { /* ignore */ } });
    };
  }

  window.NixMusicPage = { mount: mount };
})();

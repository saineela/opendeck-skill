/* ==========================================================================
   PUCA Panel — the Nix display for OpenDeck.

   The look is the Nix-Physical-Display-panel "PUCA Panel": one hero card, the
   playlist shelves, the up-next column, the search sheet, the "which one did
   you mean?" overlay and the lyrics design. This script is the OpenDeck side of
   it: it fills that markup from the console's own music API, which the panel
   listener serves on this same origin.

     GET  /api/panel/state            what is playing, the theme, a question
     WS   /api/panel/socket           the console says when to read it again
     GET  /api/music/queue            the queue, shuffle and repeat
     GET  /api/music/library          playlists / liked / history / one playlist
     GET  /api/music/search?q=        matches
     GET  /api/music/lyrics?...       synchronized words
     POST /api/music/control          play · pause · resume · mute · volume
     POST /api/music/queue            next · add · play · shuffle · repeat · clear
     POST /api/music/play             hand a track to the speaker
     POST /api/panel/answer           answer the question on the wall
     POST /api/panel/dismiss          drop it

   Nothing visual is decided here: sizes, colours and layout are panel.css's.
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     CONFIG
     ====================================================================== */
  var CONFIG = {
    theme: 'auto',       // auto | night | day — the console's clock drives auto
    nightFrom: 22,       // replaced by the console's dark_from_hour
    nightTo: 6,          // replaced by the console's dark_until_hour
    voice: true,
    lyricsAuto: true,    // lyrics take over the wall when a track starts
    idleHide: 12000,     // hide the cursor after this many ms of stillness
    // The console pushes an event the moment something moves, over a socket on
    // this same origin (see THE PUSH CHANNEL). The timer is only the fallback
    // for a display whose socket is down, so it is slower than the three
    // seconds the wall used to ask on, and a change is ordinarily not noticed
    // here at all.
    pollMs: 12000,       // the fallback read, when the push channel is not up
    stream: true,        // the console tells the wall, instead of the wall asking
    streamBackoffMs: 1000,    // first wait before reconnecting a dropped socket
    streamBackoffMaxMs: 30000, // and never a longer wait than this
    saver: 'auto',       // auto | off — the idle page takes the wall over
    saverAfter: 60000,   // a minute with nothing happening on the screen
    autoLocal: true,     // the wall moves itself onto the box's own address
    localProbeMs: 1500,  // how long that address has to answer before it stays
    listenOnBoot: false, // set by ?listen=1: the wall arrives and listens
    foldPlayer: true,    // the column scrolls, so the music takes the card away with it
    autoRefresh: true,   // a new panel on the console takes this page with it
    shelfSongs: 24,      // songs read for one shelf row
    // Most songs a "See all" list will ask for. A liked-songs list is a real
    // library — hundreds of songs, not a page of them — so the wall asks for the
    // whole thing and the console answers with as much as it holds.
    listLimit: 500,
    searchLimit: 12,     // one page of catalog matches, the size the console serves
    frequent: 60,        // most played songs asked of the console
    speechStarted: 700,  // a tap on the mic is not an empty recording
    speechSilence: 1400, // this much quiet ends the phrase
    speechMost: 20000,   // and this caps one, however long the room talks
    speechFloor: 0.012   // below this the room is quiet, not somebody talking
  };

  (function applyParams() {
    var q;
    try { q = new URLSearchParams(window.location.search); } catch (e) { return; }
    if (q.has('theme')) {
      var t = (q.get('theme') || '').toLowerCase();
      if (t === 'night' || t === 'day' || t === 'auto') CONFIG.theme = t;
    }
    if (q.has('voice')) CONFIG.voice = q.get('voice') !== '0';
    if (q.has('lyrics')) CONFIG.lyricsAuto = q.get('lyrics') !== '0';
    if (q.has('saver')) CONFIG.saver = q.get('saver') === '0' || q.get('saver') === 'off' ? 'off' : 'auto';
    if (q.has('stream')) CONFIG.stream = q.get('stream') !== '0';
    if (q.has('fold')) CONFIG.foldPlayer = q.get('fold') !== '0';
    // The fold is the column's own scrolling (see the stylesheet): with it off,
    // the card is pinned and the music scrolls underneath it instead.
    if (!CONFIG.foldPlayer) document.body.classList.add('fold-off');
    if (q.has('refresh')) CONFIG.autoRefresh = q.get('refresh') !== '0';
    // `?local=0` pins the wall where it was opened, for a display that is
    // deliberately watched from outside the house, where the box's own address
    // is not reachable at all.
    if (q.has('local')) CONFIG.autoLocal = q.get('local') !== '0';
    // `?listen=1` is the wall arriving where it can hear: the microphone opens
    // by itself, because the tap that brought it here was a tap to speak.
    if (q.has('listen')) CONFIG.listenOnBoot = q.get('listen') !== '0';
    if (q.has('saverAfter')) {
      var secs = parseFloat(q.get('saverAfter'));
      if (isFinite(secs) && secs >= 0) CONFIG.saverAfter = secs * 1000;
    }
  })();

  /* ======================================================================
     SMALL HELPERS
     ====================================================================== */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /*
   * Covers are monochrome — the Nix panel is black and white, so there is no
   * palette of hues to draw from. A track's hue is used purely as a stable
   * seed, so every cover gets its own shade of grey rather than its own colour,
   * and because the gradient mixes against the theme tokens it turns over
   * automatically when the panel flips between night and day.
   */
  function coverGradient(hue, seed) {
    var v = ((((hue == null ? 220 : hue) % 360) + 360) % 360) / 360;   // 0..1
    var a = 4 + v * 22 + ((seed || 0) % 4);
    return 'linear-gradient(150deg,' +
      ' color-mix(in oklab, var(--ink) ' + a.toFixed(1) + '%, var(--bg)) 0%,' +
      ' color-mix(in oklab, var(--ink) ' + (a + 13).toFixed(1) + '%, var(--bg)) 58%,' +
      ' color-mix(in oklab, var(--ink) ' + (a + 26).toFixed(1) + '%, var(--bg)) 100%)';
  }

  /* The soft bloom behind the hero art and the lyrics backdrop. Replaces what
     used to be a CSS blur filter — same look, nothing to rasterise per frame. */
  function coverRadial(hue, strength) {
    var v = ((((hue == null ? 220 : hue) % 360) + 360) % 360) / 360;
    var s = strength == null ? 1 : strength;
    var a = (7 + v * 9) * s;
    return 'radial-gradient(closest-side at 50% 42%,' +
      ' color-mix(in oklab, var(--ink) ' + (a * 0.9).toFixed(1) + '%, transparent) 0%,' +
      ' color-mix(in oklab, var(--ink) ' + (a * 0.5).toFixed(1) + '%, transparent) 48%,' +
      ' transparent 78%)';
  }

  function artMark(t) {
    var title = String((t && t.title) || '').trim();
    if (!title) return '♪';
    var w = title.replace(/[^A-Za-z0-9]/g, ' ');
    var words = w.split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return title[0].toUpperCase();
  }

  function hueOf(obj, fallback) {
    if (!obj) return fallback == null ? 220 : fallback;
    if (obj.hue != null) return obj.hue;
    var s = String(obj.id || obj.title || 'x'), n = 0;
    for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 360;
    return n;
  }

  /* ======================================================================
     THE CONSOLE'S API
     ====================================================================== */
  var PANEL = '/api/panel';
  var MUSIC = '/api/music';
  var VOICE = '/api/voice';
  var ART = MUSIC + '/artwork?src=';

  function parse(text) {
    try { return text ? JSON.parse(text) : {}; } catch (e) { return {}; }
  }
  function get(path) {
    return fetch(path, { cache: 'no-store' }).then(function (r) { return r.text(); }).then(parse);
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.text(); }).then(parse);
  }
  function getPanel(path) { return get(PANEL + path); }
  function postPanel(path, body) { return post(PANEL + path, body); }
  function getMusic(path) { return get(MUSIC + path); }
  function postMusic(path, body) { return post(MUSIC + path, body); }
  function getVoice(path) { return get(VOICE + path); }

  /* A recorded clip is raw WAV, not JSON: it is samples, and base64 would grow it
     by a third to say nothing. It goes to this origin — the panel's own — which
     is what keeps the microphone request on one origin. */
  function transcribe(clip) {
    return fetch(VOICE + '/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: clip
    }).then(function (r) { return r.text(); }).then(parse);
  }

  // Covers arrive as the provider's absolute URL; the console keeps the first
  // copy it fetched and serves it from its own disk, so the wall is not another
  // client of the provider's CDN.
  function localArt(url) {
    if (!url) return '';
    return /^(?:data:|\.?\/)/i.test(url) ? url : ART + encodeURIComponent(url);
  }

  function trackToUi(t) {
    if (!t) return null;
    var id = t.video_id || t.id || '';
    if (!id && !t.title) return null;
    return {
      id: id,
      title: t.title || id || 'Unknown track',
      artist: t.artist || '',
      album: t.album || '',
      duration: Number(t.duration_sec != null ? t.duration_sec : (t.duration || 0)) || 0,
      art: localArt(t.artwork_url || t.art),
      stream: t.stream_url || t.stream || null
    };
  }

  /* ======================================================================
     CLIENT STATE
     ====================================================================== */
  var S = {
    nowPlaying: null, queue: [], history: [],
    volume: 0.6, muted: false, shuffle: false, repeat: 'off',
    panel: null,
    source: 'idle', lyrics: null, ask: null
  };
  var library = { tracks: [], playlists: [] };
  var known = {};                  // every track the panel has seen, by id
  var connected = false;
  var socket = null;               // the push channel to the console, when it is up
  var socketAttempts = 0;          // failed opens in a row, for the backoff
  var socketTimer = null;          // a pending reconnect
  var lastTrackId = null;
  var panelError = null;           // the last failure of this page's own drawing
  var dismissedLyricsFor = null;   // the one track whose lyrics the user closed
  var dismissedAskId = null;       // the one question the user closed
  var lyricsOpen = false;
  var lyricsByUser = false;        // opened by a person, not by the panel
  var lyricIndex = -1;
  var serverSkew = 0;              // serverNow - localNow
  var consoleTheme = null;
  var consoleClock = '';
  var SHELF_LIMIT = 8;             // how many playlists get their songs fetched

  var audio = $('#audio');
  var audioSrc = null;

  function rememberTrack(t) {
    var u = trackToUi(t);
    if (u && u.id && !known[u.id]) known[u.id] = u;
    return u;
  }

  /* ======================================================================
     STORAGE — what the wall was showing when the console goes away

     A panel is reloaded in front of someone (a kiosk restart, a power cut) and
     a linked account's browse takes seconds. Every read this page makes is kept
     in memory and written through to localStorage, painted the moment the panel
     mounts, and replaced by the console's answer a moment later.
     ====================================================================== */
  var STORE_KEY = 'nix.panel.cache.v2';

  function readStore() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      var saved = raw ? JSON.parse(raw) : null;
      if (!saved || typeof saved !== 'object') return null;
      return saved;
    } catch (e) { return null; }
  }

  function writeStore() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({
        saved_at: Date.now(),
        state: S,
        theme: consoleTheme,
        queueTracks: S.queue.map(function (id) { return known[id]; }).filter(Boolean),
        library: library,
        lyrics: lyricsStore
      }));
    } catch (e) { /* a cache that cannot persist is still a cache */ }
  }

  /* The state is polled every few seconds, and a wall display is left on for
     weeks: the memory copy is always current, the stored one settles on a timer
     instead of a localStorage write every poll. */
  var lastWrite = 0;
  function writeStoreSoon() {
    var now = Date.now();
    if (now - lastWrite < 15000) return;
    lastWrite = now;
    writeStore();
  }

  /* ======================================================================
     CLOCK + AUTO THEME (the console's clock, not the browser's)
     ====================================================================== */
  var doc = document.documentElement;
  var metaTheme = $('#metaTheme');
  var themeNow = null;
  var themingTimer = null;
  var clockEl = $('#clock'), ampmEl = $('#ampm'), daylightEl = $('#daylight');

  function isNight(when) {
    var h = (when || new Date()).getHours();
    return h >= CONFIG.nightFrom || h < CONFIG.nightTo;
  }

  function applyTheme() {
    var next = consoleTheme
      ? (consoleTheme.mode === 'dark' ? 'night' : 'day')
      : (CONFIG.theme === 'auto' ? (isNight() ? 'night' : 'day') : CONFIG.theme);
    var flipped = next !== themeNow;
    themeNow = next;
    doc.classList.toggle('night', next === 'night');
    doc.classList.toggle('day', next === 'day');
    metaTheme.setAttribute('content', next === 'night' ? '#04050a' : '#ffffff');
    if (daylightEl) {
      daylightEl.querySelector('em').textContent =
        CONFIG.theme === 'auto' ? (next === 'night' ? 'night' : 'day') : next + ' (forced)';
    }
    if (flipped && !reduce) {
      // Enable the palette cross-fade for the length of the change, then take it
      // off again so nothing else on the panel is animating a beat behind.
      doc.classList.add('theming');
      clearTimeout(themingTimer);
      themingTimer = setTimeout(function () { doc.classList.remove('theming'); }, 1100);
    }
    // Daybreak while the wall is idle: the idle page is a document of its own,
    // so it has to be told. It is the console's clock either way.
    if (flipped && saverOn && saverFrame) setSaverTheme(saverFrame);
  }

  /* The console's own local time, so the clock on the wall and the clock in the
     console never disagree. It arrives as 24-hour "06:52"; the panel shows the
     same 12-hour face with the am/pm beside it. */
  function tickClock() {
    var shown = null, ap = '';
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(consoleClock || ''));
    if (m) {
      var h = Number(m[1]);
      ap = h >= 12 ? 'PM' : 'AM';
      var h12 = h % 12; if (h12 === 0) h12 = 12;
      shown = h12 + ':' + m[2];
    } else {
      var now = new Date();
      var parts = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }).split(' ');
      shown = parts[0];
      ap = (parts[1] || '').toUpperCase();
    }
    if (clockEl.textContent !== shown) clockEl.textContent = shown;
    if (ampmEl.textContent !== ap) ampmEl.textContent = ap;
    applyTheme();
  }

  /* ======================================================================
     SLIDERS — custom, because a wall needs a fat target
     ====================================================================== */
  function makeSlider(root, opts) {
    opts = opts || {};
    var fill = $('.fill', root) || $('.track .fill', root);
    var knob = $('.knob', root);
    var value = opts.value == null ? 0 : opts.value;
    var dragging = false;

    function paint(v) {
      v = clamp(v, 0, 1);
      if (fill) fill.style.width = (v * 100).toFixed(3) + '%';
      if (knob) knob.style.left = (v * 100).toFixed(3) + '%';
      root.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    }
    function ratioOf(clientX) {
      var r = root.getBoundingClientRect();
      return clamp((clientX - r.left) / (r.width || 1), 0, 1);
    }
    function begin(e) {
      dragging = true;
      root.classList.add('dragging');
      if (root.setPointerCapture && e.pointerId != null) {
        try { root.setPointerCapture(e.pointerId); } catch (err) {}
      }
      move(e);
    }
    function move(e) {
      if (!dragging) return;
      value = ratioOf(e.clientX);
      paint(value);
      if (opts.onDrag) opts.onDrag(value);
    }
    function end() {
      if (!dragging) return;
      dragging = false;
      root.classList.remove('dragging');
      if (opts.onCommit) opts.onCommit(value);
    }

    root.addEventListener('pointerdown', function (e) { e.preventDefault(); begin(e); });
    root.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);

    root.addEventListener('keydown', function (e) {
      var step = opts.step || 0.05;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') value = clamp(value + step, 0, 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') value = clamp(value - step, 0, 1);
      else return;
      e.preventDefault();
      paint(value);
      if (opts.onCommit) opts.onCommit(value);
    });

    return {
      set: function (v, silent) { value = clamp(v, 0, 1); paint(value); if (!silent && opts.onCommit) opts.onCommit(value); },
      get: function () { return value; },
      paint: function () { paint(value); },
      isDragging: function () { return dragging; }
    };
  }

  var scrub, volSlider, lyrScrub;
  var updateScrub, updateVol, updateLyrScrub;

  /* ======================================================================
     TRANSPORT — every control becomes one console call
     ====================================================================== */
  function control(body) {
    var action = body && body.action;
    switch (action) {
      case 'toggle':
        return postMusic('/control', { action: S.nowPlaying && S.nowPlaying.playing ? 'pause' : 'resume' });
      case 'play':
      case 'resume':
        return postMusic('/control', { action: 'resume' });
      case 'pause':
        return postMusic('/control', { action: 'pause' });
      case 'stop':
        return postMusic('/control', { action: 'stop' });
      case 'next':
        return postMusic('/queue', { action: 'next' });
      case 'prev':
        // The speaker has no previous: restarting this track is what the button
        // can honestly mean.
        return S.nowPlaying && S.nowPlaying.id
          ? postMusic('/play', { video_id: S.nowPlaying.id })
          : postMusic('/control', { action: 'resume' });
      case 'mute':
        return postMusic('/control', { action: S.muted ? 'unmute' : 'mute' });
      case 'volume':
        return postMusic('/control', { action: 'volume', value: clamp(Number(body.value) || 0, 0, 1) });
      case 'shuffle':
        return postMusic('/queue', { action: 'shuffle' });
      case 'repeat':
        return postMusic('/queue', { action: 'repeat' });
      case 'clearQueue':
        return postMusic('/queue', { action: 'clear' });
      case 'playTrack':
        return postMusic('/play', { video_id: body.id });
      case 'playQueue':
        return postMusic('/queue', { action: 'play', index: body.index });
      case 'enqueue':
        return postMusic('/queue', { action: 'add', video_id: body.id });
      case 'seek':
        // The stream is handed to the speaker, so there is nothing here to seek;
        // the bar follows the console's position clock instead.
        return Promise.resolve({ ok: true });
      default:
        return Promise.resolve({ ok: false, error: 'unknown action' });
    }
  }

  function toggle() { control({ action: 'toggle' }); }

  /* The console answers a play with a reason when it will not play, and a wall
     nobody is standing at has only that reason to go on: a swallowed failure is
     a tap that did nothing. */
  function report(sent, fallback) {
    if (sent && sent.ok === false) toast(sent.error || fallback || 'The console could not play that.');
    return sent;
  }

  function playTrackId(id) {
    if (!id) return Promise.resolve(null);
    toast('Sending it to the speaker…');
    return control({ action: 'playTrack', id: id }).then(function (sent) {
      return report(sent);
    }, function () {
      toast('The console did not answer.');
      return null;
    });
  }

  /* A playlist tile is a playlist, not a song. The design's own behaviour is to
     start its first track and put the rest of it in the queue, and the console's
     queue is that other half — which is also what the "Up next" column is for,
     so a tap on a playlist fills the wall with the playlist instead of quietly
     playing one song out of it. */
  function playlistTrackIds(id, limit) {
    var kind = id === 'liked' ? 'likes'
      : id === 'history' ? 'history'
      : id === 'frequent' ? 'frequent'
      : 'playlist';
    var path = '/library?kind=' + kind + '&limit=' + (limit || CONFIG.shelfSongs) +
      (kind === 'playlist' ? '&playlist_id=' + encodeURIComponent(id) : '');
    return getMusic(path).then(function (payload) {
      return (payload.tracks || []).map(function (t) { return t.video_id || t.id; }).filter(Boolean);
    });
  }

  /* Add every song from one row to the end of the playlist it is listed in — and
     nothing above it. The console's own queue op reads the playlist and appends
     the tail, so a 400-song list is one request rather than one per song, and a
     playlist longer than the queue's ceiling is reported as the part that fit. */
  function queueFromHere(playlistId, videoId, name) {
    if (!playlistId) { toast('That song is not in a playlist.'); return; }
    toast('Queuing “' + (name || 'that song') + '” and the rest of the list…');
    postMusic('/queue', { action: 'add_range', playlist_id: playlistId, video_id: videoId }).then(function (sent) {
      if (!sent || sent.ok === false) {
        toast(sent && sent.error ? String(sent.error) : 'The queue would not take those songs.');
        return;
      }
      // The console's own sentence is the honest one: it knows how many songs it
      // actually queued (the queue has a ceiling) and how many were left out.
      toast(sent.message || 'Queued the rest of that playlist.');
    }, function () { toast('The console did not answer.'); });
  }

  /* One track out of a list the console read — a playlist's songs, the ranking —
     with the fields a row shows and the play count a ranking carries.

     This is the difference between a list and a queue: a queue is ids the console
     resolves, a list is what the provider answered with, and a list read for a
     439-song playlist is mostly songs this panel has never seen. Rendering the
     ids instead of the answer is how the wall ended up showing “dQw4w9WgXcQ”
     where a song's name belonged. */
  function listedTrack(t) {
    var u = rememberTrack(t);
    if (!u) return null;
    var plays = Number(t && t.plays) || 0;
    if (plays) {
      u.plays = plays;
      // The count belongs to the song, not to this row: every row reads the one
      // object per id, so it is put where the others will find it.
      if (known[u.id] !== u) known[u.id] = Object.assign({}, known[u.id], { plays: plays });
    }
    return u;
  }

  /* The same read, as tracks rather than as ids: what a list page draws. */
  function playlistTracks(id, limit) {
    var kind = id === 'liked' ? 'likes'
      : id === 'history' ? 'history'
      : id === 'frequent' ? 'frequent'
      : 'playlist';
    var path = '/library?kind=' + kind + '&limit=' + (limit || CONFIG.shelfSongs) +
      (kind === 'playlist' ? '&playlist_id=' + encodeURIComponent(id) : '');
    return getMusic(path).then(function (payload) {
      return (payload.tracks || []).map(listedTrack).filter(function (t) { return t && t.id; });
    });
  }

  /* The rest of the playlist becomes Up next: the console's queue is cleared and
     refilled one track at a time (that is the only way the queue takes a track),
     so the count that lands is reported rather than assumed. */
  function fillQueue(ids) {
    if (!ids.length) return Promise.resolve(0);
    return postMusic('/queue', { action: 'clear' }).then(function () {
      var chain = Promise.resolve(0);
      ids.forEach(function (videoId) {
        chain = chain.then(function (added) {
          return postMusic('/queue', { action: 'add', video_id: videoId }).then(function (sent) {
            return added + (sent && sent.ok !== false ? 1 : 0);
          }, function () { return added; });
        });
      });
      return chain;
    });
  }

  /* The shelves the page builds itself — liked songs, recently played, most
     played — are not playlists the console lists, so their rows carry the name
     the panel gave them. */
  function shelfEntry(id) {
    if (id === 'frequent') {
      return { id: 'frequent', name: 'Frequently played', total: (library.frequent || []).length };
    }
    return library.playlists.filter(function (p) { return p.id === id; })[0];
  }

  function playPlaylistId(id) {
    if (id === 'surprise') {
      if (!library.tracks.length) { toast('Nothing in the library to surprise you with yet.'); return Promise.resolve(null); }
      var pick = library.tracks[Math.floor(Math.random() * library.tracks.length)];
      return playTrackId(pick.id);
    }
    var entry = shelfEntry(id);
    var label = (entry && entry.name) || 'that playlist';
    if (entry) toast('Playing “' + label + '”…');
    var loaded = entry && entry.tracks && entry.tracks.length ? entry.tracks : null;
    return (loaded ? Promise.resolve(loaded) : playlistTrackIds(id)).then(function (list) {
      if (!list || !list.length) { toast('That playlist has nothing to play.'); return null; }
      // The first track is started first: the tap has to be audible before the
      // queue is rebuilt behind it.
      return playTrackId(list[0]).then(function (sent) {
        if (!sent || sent.ok === false) return sent;
        var rest = list.slice(1);
        if (!rest.length) { toast('Playing “' + label + '”'); return sent; }
        return fillQueue(rest).then(function (added) {
          toast(added
            ? 'Playing “' + label + '” · ' + added + ' more queued'
            : 'Playing “' + label + '” · the queue would not take the rest');
          return sent;
        });
      });
    }, function () {
      toast('The console did not answer.');
      return null;
    });
  }

  /* A shelf shows a page of a playlist; See all opens the rest of it. The list
     is the same result rows a search draws, so a song in it is one tap from the
     speaker, and the count is the console's own total rather than what happened
     to come back. */
  function openPlaylistList(id) {
    var entry = shelfEntry(id);
    var name = (entry && entry.name) || 'Playlist';
    showResults(name, '<p class="hint">Reading the whole playlist…</p>', '');
    // The page is drawn from the console's answer, names and covers included: a
    // playlist is read here for the whole of it, so most of these songs are ones
    // the shelves above never fetched.
    playlistTracks(id, CONFIG.listLimit).then(function (tracks) {
      if (!tracks.length) {
        showResults(name, '<p class="hint">The console has no songs for that playlist.</p>', '');
        return;
      }
      var total = Math.max((entry && entry.total) || 0, tracks.length);
      showResults(name,
        resultGroup('Songs', tracks.map(function (t) {
          // Every row knows the playlist it was listed in, so it can offer "this
          // one and the rest" as well as "just this one".
          return resultRow({ track: t, playlist: id }, 'Song');
        })),
        tracks.length + ' of ' + total + ' songs · tap one to send it to the speaker' +
          (tracks.length > 6 ? ' — slide across for the rest' : '') +
          ' · ↓ queues a song and every song under it');
    }, function () {
      showResults(name, '<p class="hint">The console did not answer.</p>', '');
    });
  }

  /* ======================================================================
     AUDIO — only if the console ever hands the panel a stream URL
     ====================================================================== */
  function syncAudio(np) {
    var url = (np && np.stream) || null;
    if (url !== audioSrc) {
      audioSrc = url;
      if (url) { audio.src = url; } else { audio.removeAttribute('src'); audio.load(); }
    }
    if (!url) return;
    audio.volume = S.muted ? 0 : S.volume;
    var want = livePosition();
    if (Math.abs(audio.currentTime - want) > 2.5) {
      try { audio.currentTime = want; } catch (e) {}
    }
    if (np.playing) audio.play().catch(function () {}); else audio.pause();
  }

  /* ======================================================================
     POSITION CLOCK
     ====================================================================== */
  function livePosition() {
    var np = S.nowPlaying;
    if (!np) return 0;
    if (audioSrc && audio.duration && !audio.paused) return audio.currentTime;
    var elapsed = np.playing ? (Date.now() - np.at) / 1000 : 0;
    return clamp((np.position || 0) + elapsed, 0, np.duration || 0);
  }

  /* ======================================================================
     STATE IN — the console's answer, in the shape this page renders
     ====================================================================== */
  function consoleState() {
    return getPanel('/state').then(function (panel) {
      if (!panel || panel.ok === false || typeof panel.theme === 'undefined') {
        throw new Error(panel && panel.error ? panel.error : 'the console did not answer');
      }
      return getMusic('/queue').catch(function () { return {}; }).then(function (q) {
        var npRaw = panel.now_playing || {};
        var track = npRaw.track || null;
        var player = npRaw.player || {};
        var pos = npRaw.position || {};
        var np = null;
        if (track) {
          var u = trackToUi(track);
          np = {
            id: u.id,
            title: u.title,
            artist: u.artist,
            album: u.album,
            art: u.art,
            stream: u.stream,
            duration: u.duration || Number(pos.duration_sec || 0) || 0,
            position: Number(pos.elapsed_sec || 0) || 0,
            playing: Boolean(npRaw.playing),
            // The console's own answer to "does the queue follow this song?" —
            // a track it started from the queue is followed by the next one, a
            // song played on its own is not.
            queueActive: Boolean(npRaw.queue_active),
            source: 'nix',
            at: Date.now()
          };
        }
        var queue = (q.queue || []).map(rememberTrack).filter(function (t) { return t && t.id; });
        var question = panel.question || null;
        var options = question ? (question.options || []) : [];
        var ask = options.length ? {
          id: question.id || 'ask',
          prompt: question.prompt || 'Which one did you mean?',
          heard: question.heard || question.query || '',
          options: options.map(function (o) { return { type: 'track', track: trackToUi(o) }; })
        } : null;
        return {
          serverNow: Date.now(),
          nowPlaying: np,
          queue: queue.map(function (t) { return t.id; }),
          history: [],
          volume: typeof player.volume === 'number' ? player.volume : S.volume,
          muted: Boolean(player.muted),
          shuffle: Boolean(q.shuffle),
          repeat: q.repeat || 'off',
          source: np ? 'nix' : 'idle',
          lyrics: np ? (lyricsStore[np.id] || null) : null,
          ask: ask,
          theme: panel.theme || null,
          panel: panel.panel || null
        };
      });
    });
  }

  function applyConsoleTheme(theme) {
    if (!theme) return;
    consoleTheme = theme;
    if (typeof theme.dark_from_hour === 'number') CONFIG.nightFrom = theme.dark_from_hour;
    if (typeof theme.dark_until_hour === 'number') CONFIG.nightTo = theme.dark_until_hour;
    if (theme.local_time) consoleClock = theme.local_time;
  }

  function applyState(data, reason) {
    if (typeof data.serverNow === 'number') serverSkew = data.serverNow - Date.now();

    var prevId = S.nowPlaying && S.nowPlaying.id;
    var prevAskId = S.ask && S.ask.id;
    // What the console says about the panel itself: the port its https listener
    // is on is what a display has to be pointed at for the microphone to work.
    if (data.panel) S.panel = data.panel;
    S.queue = data.queue || [];
    S.history = data.history || [];
    S.volume = typeof data.volume === 'number' ? data.volume : S.volume;
    S.muted = !!data.muted;
    S.shuffle = !!data.shuffle;
    S.repeat = data.repeat || 'off';
    S.source = data.source || 'idle';
    S.lyrics = data.lyrics || null;
    S.ask = data.ask || null;

    if (data.nowPlaying) {
      var np = data.nowPlaying;
      np.at = np.at - serverSkew;   // put the anchor on our own clock
      S.nowPlaying = np;
    } else {
      S.nowPlaying = null;
    }

    var id = S.nowPlaying && S.nowPlaying.id;

    // --- a new track started: show the lyrics design over the wall
    if (CONFIG.lyricsAuto && id && id !== lastTrackId && id !== dismissedLyricsFor) {
      lastTrackId = id;
      openLyrics();
    } else if (id) {
      lastTrackId = id;
    }
    if (!id) { lastTrackId = null; }

    if (prevId !== id) lyricsIndexReset();

    // --- the console asking which track was meant
    var askId = S.ask && S.ask.id;
    if (S.ask && askId !== dismissedAskId && (askId !== prevAskId || !askOpen)) {
      openAsk(S.ask);
    } else if (!S.ask && askOpen && !S.localAsk) {
      closeAsk();
    }

    syncAudio(S.nowPlaying);
    renderAll(reason);
    if (lyricsOpen && lyricsSignature() !== lyricSig) renderLyricLines();
    watchTrackEnd();
  }

  /* ------------------------------------------------------------------ ends
     The last second of a song is where a wall display looks most broken: the
     words are on screen, the music has stopped, and the panel sits there on the
     final line. "Finished" is the speaker gone idle at (or past) the length of
     the track — the same signal the console itself advances on, so a track that
     was merely paused, or stopped early, is never mistaken for one that ended.

     What happens next is the queue's: the console hands a queue-sourced track
     over to the next one by itself (and a panel poll is what tells it to — see
     puca_panel.panel_state). A song played on its own is not followed by
     anything on the console's side, so the next song in the queue is started
     from here instead. With nothing queued at all there is nothing to play, and
     the wall goes back to the home page instead of holding the last line of a
     song that finished minutes ago. */
  var endedFor = null;

  function watchTrackEnd() {
    var np = S.nowPlaying;
    if (!np || !np.duration) { endedFor = null; return; }
    if (np.playing || livePosition() < np.duration - 1) {
      if (endedFor && endedFor !== np.id) endedFor = null;
      return;
    }
    if (endedFor === np.id) return;      // already answered for this song
    endedFor = np.id;
    afterTrackEnd(np);
  }

  function afterTrackEnd(np) {
    // The queue holds the track being played as well as what is behind it (the
    // console keeps one list and an index), so "is there a next song" is the
    // queue without the song that just finished.
    var upNext = (S.queue || []).filter(function (id) { return id !== np.id; });
    if (!upNext.length) {
      if (lyricsOpen) {
        // Not a dismissal: the next song the user starts still opens the words.
        closeLyrics(false);
        toast('That was the last song in the queue.');
      }
      return;
    }
    if (!np.queueActive) control({ action: 'next' });
  }

  /* ======================================================================
     THE WALL KEEPS ITSELF CURRENT

     A wall display is never reloaded by hand: the page that is open is the page
     that stays open. Measured live, the glass kept drawing an older panel for
     hours after the console had started serving the next one, and what the
     served page did have — the size chips on the lyrics page, the player folding
     away as the music is scrolled — was reported as missing, because the page in
     memory simply did not have it and nothing was ever going to tell it so.

     So the console reports the build it is serving, and this page compares it
     with the build it booted into: the first state a page ever sees is, by
     definition, its own, and one that differs later means the console has been
     given a new panel since. Then it reloads — once per build per browsing
     session, so a console that keeps changing its answer, or a reload that does
     not take, can never turn into a loop. The music carries on: the panel seeks
     back to the console's position as soon as it is up again.
     ====================================================================== */
  var BUILD_KEY = 'nix.panel.reload-build';
  var pageBuild = null;      // the build this page was served from
  var servedBuild = null;    // what the console last said it is serving
  var reloadAsked = false;

  function checkBuild(build) {
    if (!build) return false;
    if (servedBuild === build) return false;
    servedBuild = build;
    if (pageBuild === null) { pageBuild = build; return false; }
    if (!CONFIG.autoRefresh || reloadAsked) return false;
    try {
      if (window.sessionStorage.getItem(BUILD_KEY) === build) return false;
      window.sessionStorage.setItem(BUILD_KEY, build);
    } catch (e) { /* a wall with no storage still gets the first reload */ }
    reloadAsked = true;
    setTimeout(function () {
      try { window.location.reload(); } catch (e) { /* nothing to reload with */ }
    }, 1500);
    return true;
  }

  /* ======================================================================
     THE PUSH CHANNEL

     The wall used to find out that anything had moved by asking the console
     again every three seconds. Two halves of the same box do not need that: the
     console upgrades this page's own connection at /api/panel/socket and sends
     one small event when a track starts, a question is parked, a queue moves or
     the transport is driven. The page answers an event by reading the state it
     already knows how to render — the HTTP route stays the one implementation —
     so what the socket buys is latency, not a second way to compute anything.

     A dropped socket is survivable: the page reconnects with a growing wait,
     and the fallback poll above still runs, so the wall is never left stale by
     a channel that is down. `?stream=0` turns it off for a check. */
  function streamUrl() {
    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + window.location.host + (S.panel && S.panel.stream ? S.panel.stream : '/api/panel/socket');
  }

  function streamUp() {
    return !!(socket && socket.readyState === 1);   // 1 === WebSocket.OPEN
  }

  function openStream() {
    if (!CONFIG.stream || typeof window.WebSocket !== 'function') return;
    var ws;
    try { ws = new window.WebSocket(streamUrl()); } catch (error) { scheduleStream(); return; }
    socket = ws;
    ws.onopen = function () { socketAttempts = 0; };
    // Any frame is the console saying "something moved": read the state now
    // rather than wait for the fallback poll. A greeting or a pong just proves
    // the channel is live, so it is answered the same way — one cheap read.
    ws.onmessage = function () { poll(); };
    ws.onclose = function () { if (socket === ws) socket = null; scheduleStream(); };
    ws.onerror = function () { /* onclose follows and owns the retry */ };
  }

  function scheduleStream() {
    if (!CONFIG.stream || socketTimer) return;
    var wait = Math.min(CONFIG.streamBackoffMaxMs, CONFIG.streamBackoffMs * Math.pow(2, socketAttempts));
    socketAttempts += 1;
    socketTimer = setTimeout(function () { socketTimer = null; openStream(); }, wait);
  }

  /* The fallback read, and the one an event turns into. */
  function poll() {
    consoleState().then(function (data) {
      connected = true;
      checkBuild(data.panel && data.panel.build);
      applyConsoleTheme(data.theme);
      try {
        applyState(data, 'poll');
        // Now that the console has said where it lives on its own network, the
        // wall can take the one look that decides whether it is talking to the
        // box or to the internet (see THE WALL TALKS TO THE BOX).
        lookForTheBox();
        ensureLyrics(S.nowPlaying);
        writeStoreSoon();
      } catch (error) {
        // The console answered — the wall is live. A mistake this page makes
        // while drawing what it was given must not be reported as a console that
        // is down, and must not stop the next poll: a wall nobody can watch has
        // only this note to go on, so it is kept where the console tab can read
        // it (`window.__puca.lastError`) as well as written out.
        notePanelError(error);
      }
    }).catch(function () {
      // Whether the console is answering is state, not lettering: the brand
      // carries the logo alone, so a wall's connection is read from the console
      // tab (`window.__puca.connected()`) rather than from a line of text.
      connected = false;
    });
  }

  /* The last mistake this page made while drawing, for a display that has no one
     in front of it to open a console on. */
  function notePanelError(error) {
    var note = (error && error.message) ? error.message : String(error);
    panelError = { message: note, at: Date.now() };
    try { console.error('[puca panel]', error); } catch (e) { /* nothing to log to */ }
  }

  /* ======================================================================
     RENDER
     ====================================================================== */
  var npTitle = $('#npTitle'), npArtist = $('#npArtist'), npAlbum = $('#npAlbum'),
      npSource = $('#npSource'), npDot = $('#npDot'), heroArt = $('#heroArt'),
      heroImg = $('#heroImg'), heroGlyph = $('#heroGlyph'), heroGlow = $('#heroGlow'),
      metaEl = $('.meta'), queueEl = $('#queue'), queueEmpty = $('#queueEmpty'),
      shelvesEl = $('#shelves'), volPct = $('#volPct'), repeatLabel = $('#repeatLabel'),
      columnEl = $('.left');

  function sourceLabel(np) {
    if (!np) return 'Nothing playing';
    return 'Playing from Nix PUCA';
  }

  function renderNow() {
    var np = S.nowPlaying;
    document.body.classList.toggle('playing', !!(np && np.playing));
    document.body.classList.toggle('muted', S.muted);

    document.title = np ? (np.title + ' · ' + np.artist + ' — PUCA') : 'PUCA Panel';

    var hue = hueOf(np, 220);
    heroArt.style.background = coverGradient(hue, np ? String(np.id).length : 0);
    heroGlow.style.background = coverRadial(hue, 1);

    if (np && np.art) {
      heroImg.src = np.art;
      heroImg.hidden = false;
      heroGlyph.hidden = true;
    } else {
      heroImg.hidden = true;
      heroImg.removeAttribute('src');
      heroGlyph.hidden = false;
      heroGlyph.textContent = np ? artMark(np) : '♪';
    }

    metaEl.classList.toggle('playing', !!(np && np.playing));
    npTitle.textContent = np ? np.title : 'Nothing playing';
    npArtist.textContent = np ? np.artist : 'Tap a playlist below, or say a song name';
    npAlbum.textContent = np ? (np.album + (np.duration ? (np.album ? ' · ' : '') + fmtTime(np.duration) : '')) : '';
    npSource.textContent = sourceLabel(np);
    npDot.style.background = np && np.playing ? 'var(--accent)' : '';

    $('#btnShuffle').classList.toggle('on', S.shuffle);
    $('#btnRepeat').classList.toggle('on', S.repeat !== 'off');
    repeatLabel.textContent = S.repeat === 'one' ? 'Repeat 1' : S.repeat === 'all' ? 'Repeat all' : 'Repeat';

    if (volSlider && !volSlider.isDragging()) volSlider.set(S.volume, true);
    setVolLabel(S.volume);
    if (audio) audio.volume = S.muted ? 0 : S.volume;

    updateScrub();
    if (lyrScrub) updateLyrScrub();

    // lyrics header
    var lyrTitle = $('#lyrTitle'), lyrArtist = $('#lyrArtist'), lyrBg = $('#lyrBg');
    if (np) {
      lyrTitle.textContent = np.title;
      lyrArtist.textContent = np.artist;
      lyrBg.style.background = coverRadial(hue, .55);
    }
    markPlayingTiles();
  }

  var queueSig = null;
  function renderQueue() {
    // "Up next" means what is still to come: once the console hands a queued
    // track over, that track is both playing and the first item of the queue, and
    // listing it here would say the song you are hearing is the song you are
    // waiting for. The full list is kept for the tap-to-play index below.
    var playingId = S.nowPlaying && S.nowPlaying.id;
    var ids = (S.queue || []).filter(function (id) { return id !== playingId; });
    var sig = ids.join(',');
    if (sig === queueSig) return;      // nothing moved, nothing to rebuild
    queueSig = sig;
    queueEmpty.hidden = ids.length > 0;
    queueEl.innerHTML = ids.slice(0, 40).map(function (id) {
      var t = trackById(id);
      if (!t) return '';
      var h = hueOf(t);
      return '<li data-id="' + esc(t.id) + '">' +
        '<span class="qart" style="background:' + coverGradient(h, 10) + '">' +
          coverFace(t.art, '') +
        '</span>' +
        '<span class="qmeta"><span class="qt">' + esc(t.title) + '</span>' +
        '<span class="qa">' + esc(t.artist) + '</span></span>' +
        '<span class="qd">' + fmtTime(t.duration) + '</span></li>';
    }).join('');
  }

  function renderShelves() {
    var out = [];

    // --- most played, first: what this account actually puts on, straight off
    //     the console's own ranking rather than an invented recommendation
    var frequent = library.frequent || [];
    if (frequent.length) {
      var shown = frequent.map(trackById).filter(Boolean).slice(0, CONFIG.shelfSongs);
      if (shown.length) {
        out.push('<div class="shelf" data-shelf="frequent"><div class="shelf-head"><h2>Frequently played</h2>' +
          '<span>' + frequent.length + (frequent.length === 1 ? ' song' : ' songs') + '</span></div><div class="row">');
        shown.forEach(function (t) { out.push(tileTrack(t)); });
        if (frequent.length > shown.length) out.push(tileSeeAll({ id: 'frequent', total: frequent.length }));
        out.push('</div></div>');
      }
    }

    // --- playlists, big
    out.push('<div class="shelf"><div class="shelf-head"><h2>Your playlists</h2>' +
      '<span>' + library.playlists.length + ' playlists</span></div><div class="row">');
    out.push(tilePlaylist({ id: 'surprise', name: 'Surprise me', subtitle: 'Pick something for me', hue: 268 }, true));
    library.playlists.forEach(function (p) { out.push(tilePlaylist(p, false)); });
    // Every playlist is on the wall's library page, as covers on a page of their
    // own; the row shows the first few and says where the rest are.
    if (library.playlists.length) out.push(tileLibrary(library.playlists.length));
    out.push('</div></div>');

    // --- one row per playlist
    library.playlists.forEach(function (p) {
      var tracks = (p.tracks || []).map(trackById).filter(Boolean).slice(0, CONFIG.shelfSongs);
      if (!tracks.length) return;
      out.push('<div class="shelf" data-playlist="' + esc(p.id) + '">' +
        '<div class="shelf-head"><h2>' + esc(p.name) + '</h2><span>' +
        esc(p.subtitle || (tracks.length + ' songs')) + '</span></div><div class="row">');
      tracks.forEach(function (t) { out.push(tileTrack(t)); });
      // A row shows a page of the playlist; the rest stays one tap away rather
      // than pretending the playlist is twelve songs long.
      if ((p.total || 0) > tracks.length) out.push(tileSeeAll(p));
      out.push('</div></div>');
    });

    shelvesEl.innerHTML = out.join('');
    markPlayingTiles();
  }

  function tileTrack(t) {
    var h = hueOf(t);
    return '<button class="tile" data-track="' + esc(t.id) + '">' +
      '<span class="cover" style="background:' + coverGradient(h, String(t.id).length) + '">' +
        coverFace(t.art, '<span class="mark">' + esc(artMark(t)) + '</span>') +
        '<span class="playbadge"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></span>' +
      '</span>' +
      '<span class="name">' + esc(t.title) + '</span>' +
      // A song the console counted plays for says so, which is the whole point
      // of the frequent row; anywhere else the artist is what belongs there.
      '<span class="sub">' + esc(t.plays ? t.plays + (t.plays === 1 ? ' play' : ' plays') : t.artist) + '</span>' +
    '</button>';
  }

  /* A cover the design already knows how to wear, or the flat block it draws
     when there is none. A cover that will not load takes itself away, so the
     tile falls back to the block instead of a torn-image icon on the wall. */
  function coverFace(art, fallback) {
    return art
      ? '<img src="' + esc(art) + '" alt="" loading="lazy" onerror="this.remove()" />'
      : fallback;
  }

  function tilePlaylist(p, special, opts) {
    var h = hueOf(p);
    var count = (p.tracks || []).length;
    // A tile in the library opens the playlist's whole song list rather than
    // starting it: on a page that exists to choose a playlist, the song is the
    // next choice, not this one.
    var opens = (opts || {}).opens === 'list';
    // The console knows a playlist's own cover — liked songs have one, so do
    // shared playlists — so the tile wears it exactly as a song tile does. The
    // letter is what is left when there is none, and it is all the design has for
    // the one tile the panel invents itself ("Surprise me").
    var mark = '<span class="mark">' + (special
      ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.7 5.7 1.9-5.7 1.9L12 17.2l-1.9-5.7L4.4 9.6l5.7-1.9z"/></svg>'
      : esc((p.name || '?')[0].toUpperCase())) + '</span>';
    return '<button class="tile" ' + (opens
        ? 'data-playlist-all="' + esc(p.id) + '"'
        : 'data-playlist="' + esc(p.id) + '"') + '>' +
      '<span class="cover" style="background:' + coverGradient(h, 8) + '">' +
        coverFace(special ? '' : p.art, mark) +
        (opens ? '' : '<span class="playbadge"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></span>') +
      '</span>' +
      '<span class="name">' + esc(p.name) + '</span>' +
      '<span class="sub">' + esc(p.subtitle || (count + ' songs')) + '</span>' +
    '</button>';
  }

  /* The end of the playlists row: the library page, where every playlist is a
     cover and every cover is a tap from that playlist's whole song list. */
  function tileLibrary(count) {
    return '<button class="tile see-all" data-library="all">' +
      '<span class="cover" style="background:' + coverGradient(288, 6) + '">' +
        '<span class="mark"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
          '<path d="M4 6h4v5H4zM11 6h4v9h-4zM18 6h4v13h-4z"/></svg></span>' +
      '</span>' +
      '<span class="name">Whole library</span>' +
      '<span class="sub">' + count + (count === 1 ? ' playlist' : ' playlists') + '</span>' +
    '</button>';
  }

  /* The library page: every playlist the console lists, wearing its own cover,
     with each one opening into the whole song list. */
  function openLibraryPage() {
    if (!library.playlists.length) { toast('The console has no playlists yet.'); return; }
    // The console lists Liked Music as a playlist of its own, and the liked songs
    // are already a shelf here under the name the wall uses: one tile, not two.
    var hasLikedShelf = library.playlists.some(function (p) { return p.id === 'liked'; });
    var lists = library.playlists.filter(function (p) {
      return !(hasLikedShelf && p.id === 'LM');
    });
    showResults('Library',
      '<div class="tilegrid">' + lists.map(function (p) {
        return tilePlaylist(p, false, { opens: 'list' });
      }).join('') + '</div>',
      lists.length + (lists.length === 1 ? ' playlist' : ' playlists') +
        ' · tap one for its songs');
  }

  /* The end of a shelf: the songs the row is not showing are one tap away. */
  function tileSeeAll(p) {
    var total = p.total || (p.tracks || []).length;
    return '<button class="tile see-all" data-playlist-all="' + esc(p.id) + '">' +
      '<span class="cover" style="background:' + coverGradient(hueOf(p), 6) + '">' +
        '<span class="mark"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
          '<path d="M4 6h16v2H4zM4 11h16v2H4zM4 16h10v2H4z"/></svg></span>' +
      '</span>' +
      '<span class="name">See all</span>' +
      '<span class="sub">' + esc(total + ' songs') + '</span>' +
    '</button>';
  }

  var tilesSig = null;
  function markPlayingTiles() {
    var id = S.nowPlaying && S.nowPlaying.id;
    if (id === tilesSig) return;       // every tile, only worth touching on a change
    tilesSig = id;
    Array.prototype.forEach.call(shelvesEl.querySelectorAll('.tile'), function (el) {
      el.classList.toggle('playing-ring', !!id && el.getAttribute('data-track') === id);
    });
  }

  function trackById(id) {
    if (!id) return null;
    if (known[id]) return known[id];
    for (var i = 0; i < library.tracks.length; i++) if (library.tracks[i].id === id) return library.tracks[i];
    return null;
  }

  function renderAll() {
    renderNow();
    renderQueue();
    if (askOpen && S.ask) renderAsk(S.ask);
  }

  /* ======================================================================
     PROGRESS LOOP — a wall panel should not spin a frame every 16ms
     ====================================================================== */
  var tCurEl = $('#tCur'), tLeftEl = $('#tLeft'),
      lyrCurEl = $('#lyrCur'), lyrLeftEl = $('#lyrLeft');
  var lastCurText = null, lastLeftText = null;

  /* The bar is written in ~1/1000th steps rather than every frame. On a full
     width bar that is a pixel of travel per step — visually smooth, and a
     fraction of the per-frame style work. */
  var BAR_STEPS = 1000;
  var lastBarStep = -1, lastLyrBarStep = -1;

  updateScrub = function () {
    var np = S.nowPlaying;
    var pos = livePosition();
    var dur = np ? np.duration : 0;
    var ratio = dur ? pos / dur : 0;

    if (scrub && !scrub.isDragging()) {
      var step = Math.round(ratio * BAR_STEPS);
      if (step !== lastBarStep) { lastBarStep = step; scrub.set(ratio, true); }
    }
    if (lyrScrub && !lyrScrub.isDragging()) {
      var lstep = Math.round(ratio * BAR_STEPS);
      if (lstep !== lastLyrBarStep) { lastLyrBarStep = lstep; lyrScrub.set(ratio, true); }
    }

    var curText = fmtTime(pos);
    if (curText !== lastCurText) {
      lastCurText = curText;
      if (tCurEl) tCurEl.textContent = curText;
      if (lyrCurEl) lyrCurEl.textContent = curText;
    }
    var leftText = dur ? '-' + fmtTime(Math.max(0, dur - pos)) : '--:--';
    if (leftText !== lastLeftText) {
      lastLeftText = leftText;
      if (tLeftEl) tLeftEl.textContent = leftText;
      if (lyrLeftEl) lyrLeftEl.textContent = leftText;
    }
    if (lyricsOpen) updateLyricHighlight();
  };

  function setVolLabel(v) {
    volPct.textContent = Math.round(v * 100) + '%' + (S.muted ? ' · muted' : '');
  }

  updateVol = function (v) { setVolLabel(v); };
  updateLyrScrub = function () { /* handled inside updateScrub */ };

  function loop() {
    updateScrub();
    requestAnimationFrame(loop);
  }

  /* ======================================================================
     SEARCH + VOICE
     ====================================================================== */
  var searchForm = $('#searchForm'), searchInput = $('#searchInput');
  var resultsSheet = $('#resultsSheet'), resultsEl = $('#results'), resultsHint = $('#resultsHint');
  var micBtn = $('#micBtn');

  var sheetUpAt = 0;          // when a list was put on the wall, for the idle page

  function showResults(title, html, hint) {
    $('#resultsTitle').textContent = title;
    resultsEl.innerHTML = html;
    resultsHint.textContent = hint || '';
    resultsSheet.hidden = false;
    sheetUpAt = Date.now();
  }
  function hideResults() { resultsSheet.hidden = true; sheetUpAt = 0; }

  function keyOf(hit) {
    if (!hit) return null;
    if (hit.track) return 't:' + hit.track.id;
    if (hit.playlist) return 'p:' + hit.playlist.id;
    return null;
  }

  function songCount(n) { return (Number(n) || 0) + ((Number(n) || 0) === 1 ? ' song' : ' songs'); }

  /* The second thing a row can do. The design's own row *is* the button, so this
     sits beside it rather than inside it — a button inside a button is not
     something a browser will render — and playing stays the whole row. */
  function queueControl(id, title) {
    return '<button class="res-queue" data-queue-track="' + esc(id) + '"' +
      ' title="Add to the queue" aria-label="Add ' + esc(title) + ' to the queue">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M4 6h11M4 11h11M4 16h7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
        '<path d="M17.5 12.5v7M14 16h7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
      '</svg></button>';
  }

  /* The same shape, one line deeper: a bar with a downward arrow means "this
     song and everything under it", so the glyph is deliberately not the plus of
     the control above it. It carries the playlist the row came from, because the
     songs to add are the ones the console can read from that list. */
  function rangeControl(id, playlistId, title) {
    return '<button class="res-queue res-range" data-queue-from="' + esc(id) + '"' +
      ' data-queue-playlist="' + esc(playlistId) + '"' +
      ' title="Add this song and the rest of the list to the queue"' +
      ' aria-label="Add ' + esc(title) + ' and every song under it to the queue">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M4 6h11M4 11h11M4 16h7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
        '<path d="M17.5 10.5v7M14.2 14.2l3.3 3.3 3.3-3.3" fill="none" stroke="currentColor" stroke-width="2.2"' +
          ' stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg></button>';
  }

  /* A list that is a playlist — a playlist's songs, the liked songs, a playlist
     opened from the library — draws one more control per row: "this one and the
     rest". `item.playlist` is the playlist the row was listed in, so the console
     can read the tail of it in one request. A search result, an artist's songs
     and the history have no playlist behind them, so they carry only the queue
     control they always had. */
  function resultRow(item, tag, label) {
    if (item.track) {
      var t = item.track, h = hueOf(t);
      return '<div class="resline">' +
        '<button class="res" data-track="' + esc(t.id) + '">' +
          '<span class="rart" style="background:' + coverGradient(h, 10) + '">' +
            coverFace(t.art, '') +
          '</span>' +
          '<span><span class="rt">' + esc(t.title) + '</span>' +
          '<span class="ra">' + esc(t.artist) + ' · ' +
            esc(t.plays ? (t.plays + (t.plays === 1 ? ' play' : ' plays')) : (t.album || '')) + '</span></span>' +
          '<span class="rtag ' + (tag === 'Playing' ? '' : 'soft') + '">' + esc(label || tag) + '</span>' +
        '</button>' +
        // Every song in a list can be lined up as well as played now.
        queueControl(t.id, t.title) +
        (item.playlist
          ? rangeControl(t.id, item.playlist, t.title)
          : '') +
      '</div>';
    }
    if (item.artist) {
      var a = item.artist;
      return '<div class="resline">' +
        '<button class="res" data-artist="' + esc(a.name) + '">' +
          '<span class="rart" style="background:' + coverGradient(hueOf({ id: a.name }), 10) + '">' +
            coverFace(a.art, '') +
          '</span>' +
          '<span><span class="rt">' + esc(a.name) + '</span>' +
          '<span class="ra">' + esc(songCount(a.songs)) + ' on the console</span></span>' +
          '<span class="rtag soft">Artist</span>' +
        '</button>' +
      '</div>';
    }
    var p = item.playlist;
    // A playlist is a list rather than a song, so it has no queue control of its
    // own: what is queued is a track, and opening the playlist is a tap away.
    return '<div class="resline">' +
      '<button class="res" data-playlist="' + esc(p.id) + '">' +
        '<span class="rart" style="background:' + coverGradient(hueOf(p), 10) + '">' +
          coverFace(p.art, '') +
        '</span>' +
        '<span><span class="rt">' + esc(p.name) + '</span>' +
        '<span class="ra">' + esc(p.subtitle || 'Playlist') + '</span></span>' +
        '<span class="rtag soft">Playlist</span>' +
      '</button>' +
    '</div>';
  }

  /* Every list the sheet draws is a stack of named groups: the songs the console
     matched, the artists they are by, and the playlists the panel already holds.

     A group is a rail rather than a column. A 200-song playlist in a column is a
     scroll box the width of the sheet with a strip of text per song — the rows
     shrink to fit and end up unreadable from the sofa the wall is for. Laid out
     across, each song is a card with its sleeve over its name, the sheet is as
     wide as the wall, and the arrows (or a swipe) slide the rail a page at a
     time. The heading stays with its rail. */
  function resultGroup(title, rows) {
    return '<div class="resgroup">' +
      '<div class="railhead"><h3>' + esc(title) + '</h3>' +
        '<span class="railnav">' +
          '<button type="button" class="railbtn" data-rail="-1" aria-label="Slide ' + esc(title) + ' back">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
          '<button type="button" class="railbtn" data-rail="1" aria-label="Slide ' + esc(title) + ' on">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
        '</span>' +
      '</div>' +
      '<div class="rail">' + rows.join('') + '</div>' +
    '</div>';
  }

  /* One press of an arrow: a page of the rail, less a card so nothing is skipped
     past. `scrollBy` with `smooth` is the animation the browser already has, and
     the stylesheet sets `scroll-behavior: smooth` for the swipe path as well. */
  function slideRail(button, direction) {
    var group = button && button.closest ? button.closest('.resgroup') : null;
    var rail = group ? group.querySelector('.rail') : null;
    if (!rail) return;
    var step = Math.max(120, (rail.clientWidth || 0) * 0.8);
    if (typeof rail.scrollBy === 'function') {
      try { rail.scrollBy({ left: direction * step, behavior: 'smooth' }); return; } catch (e) { /* older engines */ }
    }
    rail.scrollLeft = (rail.scrollLeft || 0) + direction * step;
  }

  /* A typed word is not only a song. The console answers with catalog matches,
     and the library the panel already holds answers two more questions: does a
     playlist go by that name, and is one of the songs on the wall by an artist
     of that name. An artist row is a doorway rather than a track — the console's
     own search is what has their music — so tapping one asks for their songs. */
  function libraryHits(q) {
    var needle = q.toLowerCase();
    var playlists = (library.playlists || []).filter(function (p) {
      return String(p.name || '').toLowerCase().indexOf(needle) >= 0;
    }).slice(0, 6);
    var artists = [], seen = {};
    (library.tracks || []).forEach(function (t) {
      var name = String(t.artist || '').trim(), key = name.toLowerCase();
      if (!name || seen[key] || key.indexOf(needle) < 0) return;
      seen[key] = { name: name, art: t.art || '', songs: 0 };
      artists.push(seen[key]);
    });
    (library.tracks || []).forEach(function (t) {
      var hit = seen[String(t.artist || '').trim().toLowerCase()];
      if (hit) hit.songs += 1;
    });
    return { playlists: playlists, artists: artists.slice(0, 6) };
  }

  function runSearch(query, viaVoice, opts) {
    var q = String(query || '').trim();
    if (!q) return;
    // One artist's page is the same search with the local groups left out, so a
    // tap on an artist cannot offer that artist again.
    var songsOnly = !!(opts && opts.songsOnly);
    getMusic('/search?q=' + encodeURIComponent(q) + '&limit=' + CONFIG.searchLimit).then(function (res) {
      if (res && res.ok === false) {
        showResults('Search failed', '<p class="hint">' + esc(res.error || 'The console could not search.') + '</p>', '');
        return;
      }
      var tracks = (res.tracks || []).map(rememberTrack).filter(function (t) { return t && t.id; });
      var local = songsOnly ? { playlists: [], artists: [] } : libraryHits(q);
      if (!tracks.length && !local.playlists.length && !local.artists.length) {
        showResults(
          viaVoice ? 'Nix heard “' + q + '”' : 'No matches',
          '<p class="hint">Nothing in the library matched that. Try another word, or say a song name.</p>',
          'Tip: you can also say part of a title or an artist name.'
        );
        return;
      }
      // The console hands the track to the speaker itself, so a single match is
      // sent and every match is listed — the assistant's own behaviour, on the
      // wall. A word that matched a playlist or an artist as well is not a song
      // on its own, so nothing is played until one is tapped.
      var alone = tracks.length === 1 && !local.playlists.length && !local.artists.length;
      if (alone) {
        playTrackId(tracks[0].id);
        toast('Playing “' + tracks[0].title + '”');
      }
      var groups = [];
      if (tracks.length) {
        groups.push(resultGroup('Songs', tracks.map(function (t) {
          return resultRow({ track: t }, tracks[0].id === t.id ? 'Playing' : 'Track');
        })));
      }
      if (local.artists.length) {
        groups.push(resultGroup('Artists', local.artists.map(function (a) {
          return resultRow({ artist: a }, 'Artist');
        })));
      }
      if (local.playlists.length) {
        groups.push(resultGroup('Playlists', local.playlists.map(function (p) {
          return resultRow({ playlist: p }, 'Playlist');
        })));
      }
      var counts = [];
      if (tracks.length) counts.push(songCount(tracks.length));
      if (local.artists.length) counts.push(local.artists.length + (local.artists.length === 1 ? ' artist' : ' artists'));
      if (local.playlists.length) counts.push(local.playlists.length + (local.playlists.length === 1 ? ' playlist' : ' playlists'));
      showResults(
        songsOnly ? 'Songs by ' + q : (viaVoice ? 'Nix heard “' + q + '”' : 'Matches'),
        groups.join(''),
        counts.join(' · ') + (tracks.length
          ? ' — tap a song to play it, the + on its cover to queue it.'
          : ' — tap one to open it.')
      );
    });
  }

  /* ======================================================================
     THE WALL TALKS TO THE BOX, NOT TO THE INTERNET

     The panel is served by the console, so every read the page makes — state,
     music, artwork, voice — is a relative path on whatever origin the page was
     opened at. Point a display at the box's own address and the whole wall is
     local already; point it at a tunnel or a tailnet name and it is not, and it
     stays that way for as long as the page is open, because nothing here ever
     asks whether there is a closer way to reach the box. A display is never
     reloaded by hand, so "it will be local next time somebody opens the right
     URL" is not a fix for a screen on a wall.

     The console knows where it lives on its own network and reports it with the
     state the wall polls (`panel.url` and `panel.url_https`, both built from the
     box's LAN address). This is what the page does with it:

     * opened anywhere else, it checks whether the box answers at its own address
       and, if it does, hands the wall over to it — same page, same query, once
       per session, and in the page's own direction of travel: a secure page
       moves to the box's secure listener, so the microphone it had is not what
       the move costs;
     * a tap on the microphone on a page the browser will not lend one to does
       the same, always towards the box's TLS listener, and the wall arrives
       listening (`?listen=1`) instead of asking somebody to type an address into
       a screen mounted on a wall.

     Both moves are one per session and are never taken back: a wall that has
     been handed to an address will not bounce, and an address that does not
     answer leaves the display exactly where it is — a wall showing music must
     never be traded for a blank page. `?local=0` pins the wall where it was
     opened.
     ====================================================================== */
  var LOCAL_KEY = 'nix.panel.local-move';   // where this wall has already been handed to
  var localMove = { looked: false, moved: false, to: '', reason: '', from: '' };

  function pageAddress() {
    try { return String(window.location.href); } catch (error) { return ''; }
  }

  function website(address) {
    try { return new URL(address, pageAddress()); } catch (error) { return null; }
  }

  function originOf(address) {
    var target = website(address);
    return target ? target.origin : String(address == null ? '' : address);
  }

  /* The box's own LAN addresses, as the console reports them. The https one falls
     back to this page's own hostname on the TLS port, for a console that says
     nothing — that is the same box, beside the listener that answers here. */
  function boxAddress(secure) {
    var panel = S.panel || {};
    var advertised = secure ? panel.url_https : panel.url;
    if (advertised) return String(advertised);
    return secure ? httpsAddress() : '';
  }

  /* Whether this page was served by the box itself. Nothing else serves the
     panel — the console's two listeners are the only things that do — so the
     hostname is the whole question, and a wall on the box's own screen
     (localhost) is already as local as it gets. */
  function onTheBox() {
    var here = window.location.hostname;
    if (!here) return false;
    if (here === 'localhost' || here === '127.0.0.1' || here === '::1') return true;
    var known = [boxAddress(false), boxAddress(true)].filter(Boolean);
    for (var i = 0; i < known.length; i++) {
      var target = website(known[i]);
      if (target && target.hostname === here) return true;
    }
    return false;
  }

  function movedBefore(origin) {
    try {
      var seen = JSON.parse(window.sessionStorage.getItem(LOCAL_KEY) || '[]');
      if (Object.prototype.toString.call(seen) !== '[object Array]') return false;
      return seen.indexOf(origin) !== -1;
    } catch (error) { return false; }
  }

  function noteMove(origin) {
    try {
      var seen = JSON.parse(window.sessionStorage.getItem(LOCAL_KEY) || '[]');
      if (Object.prototype.toString.call(seen) !== '[object Array]') seen = [];
      if (seen.indexOf(origin) === -1) seen.push(origin);
      window.sessionStorage.setItem(LOCAL_KEY, JSON.stringify(seen));
    } catch (error) { /* a wall with no storage still gets the first move */ }
  }

  /* The address the wall is handed to: the box's own, carrying the page it is
     showing and the settings it was opened with, plus anything the move itself
     needs to say (?listen=1). */
  function handoverTarget(address, extra) {
    var target = website(address);
    if (!target) return '';
    try {
      var here = window.location;
      target.pathname = here.pathname || '/';
      var query = new URLSearchParams(here.search || '');
      if (extra) {
        Object.keys(extra).forEach(function (name) { query.set(name, String(extra[name])); });
      }
      target.search = query.toString();
      target.hash = here.hash || '';
    } catch (error) { return ''; }
    return target.toString();
  }

  function handOver(target, why) {
    if (!target) return false;
    noteMove(originOf(target));
    localMove.to = target;
    localMove.from = pageAddress();
    localMove.reason = why;
    try {
      // `replace`, not a new history entry: a kiosk browser's back button must
      // not be filled with the address the wall was taken away from.
      window.location.replace(target);
      localMove.moved = true;
      return true;
    } catch (error) {
      // A browser that refuses the move still has to leave the wall it is
      // drawing in place, and the reason is readable from the console tab.
      localMove.moved = false;
      return false;
    }
  }

  /* Does the box answer at that address? The probe is a bare reachability check
     — `no-cors`, so the answer is opaque and nothing of the console's is read
     across origins — and it is what keeps the wall from being traded for a blank
     page. A LAN address that does not answer in time leaves the display where it
     is, internet and all. */
  function boxAnswers(address, done) {
    var target = String(address).replace(/\/+$/, '') + '/api/panel/state';
    var settled = false;
    var timer = null;
    var controller = window.AbortController ? new window.AbortController() : null;
    function finish(ok) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      done(ok);
    }
    timer = setTimeout(function () {
      if (controller) { try { controller.abort(); } catch (error) { /* already gone */ } }
      finish(false);
    }, CONFIG.localProbeMs);
    var options = { cache: 'no-store', mode: 'no-cors' };
    if (controller) options.signal = controller.signal;
    var request;
    try {
      request = fetch(target, options);
    } catch (error) { finish(false); return; }
    if (request && typeof request.then === 'function') {
      request.then(function () { finish(true); }, function () { finish(false); });
    } else {
      finish(false);
    }
  }

  /* The one look this page takes at the addresses it was not opened at. */
  function lookForTheBox() {
    if (localMove.looked || !CONFIG.autoLocal || !S.panel) return;
    if (onTheBox()) {
      localMove.looked = true;
      localMove.reason = 'already on the box';
      return;
    }
    localMove.looked = true;
    // The page's own direction of travel first: a secure page moves to the box's
    // secure listener, so what the move costs is not the microphone.
    var order = secureOrigin() ? [true, false] : [false, true];
    var index = 0;
    function next() {
      if (index >= order.length) {
        localMove.reason = 'the box did not answer at its own address';
        return;
      }
      var secure = order[index];
      index += 1;
      var address = boxAddress(secure);
      if (!address) { next(); return; }
      var target = handoverTarget(address);
      if (!target || movedBefore(originOf(target))) { next(); return; }
      boxAnswers(address, function (answered) {
        if (!answered) { next(); return; }
        if (!handOver(target, 'the wall is on the box’s own address')) {
          localMove.reason = 'this browser would not move the wall';
        }
      });
    }
    next();
  }

  /* The microphone on an address no browser will lend one to: hand the wall to
     the box's TLS listener and arrive there listening. There is no reachability
     probe here on purpose — the certificate is self-signed and covers the box's
     own address, so a probe of it fails until the certificate has been accepted
     once, which is the very thing the move exists for. The address is remembered
     instead: if the wall comes back to a page it cannot record on, the notice
     below says what to do by hand rather than navigating again and again. */
  function handOverForVoice() {
    if (!CONFIG.autoLocal) return false;
    var address = boxAddress(true);
    if (!address) return false;
    var target = handoverTarget(address, { listen: 1 });
    if (!target || movedBefore(originOf(target))) return false;
    return handOver(target, 'the microphone needs the box’s secure address');
  }

  /* ---------------------------------------------------------- speech
     Two ways to hear, and the console's own comes first: it recognises speech on
     this machine (nix_core/voice.py), so a spoken request never leaves the house
     and any browser that can record at all can ask for it. The browser's own
     recognition — Chrome's, which needs a speech service reachable — stays as
     the fallback for a console with no recogniser of its own.

     Either way the microphone comes from the browser, and no browser hands out a
     microphone on a page that is not a secure context. The display is normally
     opened at http://<hub-ip>:49170/, where the microphone is refused before
     anything else can happen — so saying that, with the https address that does
     work, is the only honest thing the button can do there. */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recognizer = null;
  var listening = false;
  var capture = null;              // the live recording, while one is running
  var voiceEngine = null;          // what the console says about its own hearing

  function audioCtor() { return window.AudioContext || window.webkitAudioContext || null; }

  function canRecord() {
    return Boolean(audioCtor() && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function secureOrigin() { return window.isSecureContext !== false; }

  /* Unknown counts as yes: the page asks, and the request itself is what says
     there is no recogniser (a console from before this existed answers 404). */
  function consoleCanHear() { return !voiceEngine || voiceEngine.available !== false; }

  function httpsAddress() {
    var port = (S.panel && (S.panel.tls_port || (S.panel.url_https || '').split(':').pop())) || null;
    var host = window.location.hostname;
    if (!host || !port) return '';
    return 'https://' + host + ':' + String(port).replace(/[^0-9].*$/, '') + '/';
  }

  /* The one case worth a page of its own, because the display is on a wall and
     the fix is a URL: a browser only lends a microphone to a secure origin, so
     http://<hub-ip>:49170/ can show everything and hear nothing. A button that
     does nothing when tapped is how this was reported. */
  function micNotice(reason) {
    var address = httpsAddress();
    showResults('The microphone needs a secure page',
      '<p class="hint">' + esc(reason || '') + '</p>' +
      '<p class="hint">This page is ' + esc(window.location.origin) +
        ', and browsers only lend a microphone to https. Open the display at' +
        (address ? ' <b>' + esc(address) + '</b> — accept the certificate once —' : ' the panel\'s https address —') +
        ' and voice works from there, with everything else unchanged.</p>',
      'Nothing is sent anywhere: the console does the listening itself.');
  }

  function probeVoice() {
    return getVoice('').then(function (answer) {
      voiceEngine = (answer && answer.engine) ? answer : { available: false };
      if (voiceEngine.available !== false && micBtn) {
        micBtn.title = 'Tap, then speak — heard on this console (' + (voiceEngine.model || 'local speech') + ')';
      }
      return voiceEngine;
    }, function () {
      voiceEngine = { available: false };
      return voiceEngine;
    });
  }

  /* Returns whether a microphone session was actually opened, so the caller can
     say "Listening…" only when something is listening: a browser without speech
     recognition used to be told to start talking. */
  function listen(opts) {
    opts = opts || {};
    if (!CONFIG.voice) return false;
    if (capture) { stopCapture(); return false; }
    if (listening) { stopListening(); return false; }
    if (!secureOrigin()) {
      // Before saying where the voice works: go there. The console serves this
      // same display over TLS on the box's own address, so the wall hands itself
      // over and opens the microphone on arrival, rather than putting an address
      // on screen for somebody standing in front of a wall to type in.
      if (handOverForVoice()) return false;
      micNotice('This address is not secure.');
      return false;
    }
    if (canRecord() && consoleCanHear()) { startCapture(opts); return true; }
    if (!SR) {
      if (!opts.silent) {
        toast('This browser cannot listen — type instead, or open the panel where it can.');
      }
      return false;
    }
    return startBrowserRecognition(opts);
  }

  /* ------------------------------------------------- the console's own ears
     A few seconds of samples, a WAV the console can read with the standard
     library, and the words back in the reply. The recording ends itself: the
     display is on a wall, so nobody is going to tap a stop button at the exact
     end of a sentence. */
  function startCapture(opts) {
    navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    }).then(function (stream) {
      var ctx = new (audioCtor())();
      var source = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      var levels = new Float32Array(analyser.fftSize);
      var processor = ctx.createScriptProcessor(4096, 1, 1);
      // Analysed, never played: the room is already listening to the music, and
      // a microphone piped to the speakers is how a display feeds back.
      var sink = ctx.createGain();
      sink.gain.value = 0;
      var chunks = [];
      var began = Date.now(), lastHeard = began;
      processor.onaudioprocess = function (event) {
        var samples = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(samples));
        analyser.getFloatTimeDomainData(levels);
        var sum = 0;
        for (var i = 0; i < levels.length; i++) sum += levels[i] * levels[i];
        var rms = Math.sqrt(sum / levels.length);
        micLevel(rms);
        if (rms > CONFIG.speechFloor) lastHeard = Date.now();
        var elapsed = Date.now() - began;
        if (elapsed > CONFIG.speechStarted && Date.now() - lastHeard > CONFIG.speechSilence) stopCapture();
        else if (elapsed > CONFIG.speechMost) stopCapture();
      };
      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(sink);
      sink.connect(ctx.destination);
      capture = {
        ctx: ctx, stream: stream, source: source, processor: processor, sink: sink,
        chunks: chunks, rate: ctx.sampleRate || 48000, opts: opts
      };
      listening = true;
      micBtn.classList.add('listening', 'recording');
      if (askOpen) $('#askMicHint').classList.add('live');
      if (!opts.silent) toast('Listening… say a song, artist or playlist');
    }, function (error) {
      listening = false;
      var blocked = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      if (!opts.silent) {
        toast(blocked
          ? 'Microphone blocked. Allow it for this site, then tap the mic again.'
          : 'Could not start the microphone.');
      }
    });
  }

  function micLevel(rms) {
    var level = clamp(((rms || 0) - 0.004) * 14, 0, 1);
    if (micBtn) micBtn.style.setProperty('--mic-level', level.toFixed(3));
  }

  function stopCapture() {
    var live = capture;
    capture = null;
    listening = false;
    micBtn.classList.remove('listening', 'recording');
    if (askOpen) $('#askMicHint').classList.remove('live');
    micLevel(0);
    if (!live) return;
    var opts = live.opts || {};
    try { live.processor.onaudioprocess = null; } catch (e) {}
    try { live.stream.getTracks().forEach(function (track) { track.stop(); }); } catch (e) {}
    try { live.source.disconnect(); } catch (e) {}
    try { live.processor.disconnect(); } catch (e) {}
    try { live.sink.disconnect(); } catch (e) {}
    try { live.ctx.close(); } catch (e) {}
    var clip = wavOf(live.chunks, live.rate);
    if (clip.seconds < 0.35 || !clip.blob) {
      if (!opts.silent) toast('Heard nothing — tap the mic and speak again.');
      if (opts.onEnd) opts.onEnd();
      return;
    }
    transcribe(clip.blob).then(function (answer) {
      if (answer && answer.ok === false) {
        toast(answer.error || 'The console could not read that clip.');
        if (opts.onEnd) opts.onEnd();
        return;
      }
      var text = String((answer && answer.text) || '').trim();
      if (!text) {
        if (!opts.silent) toast('Heard nothing — tap the mic and speak again.');
        if (opts.onEnd) opts.onEnd();
        return;
      }
      if (opts.onFinal) opts.onFinal(text);
      else { searchInput.value = text; runSpoken(text); searchInput.blur(); }
      if (opts.onEnd) opts.onEnd();
    }, function () {
      toast('The console did not answer.');
      if (opts.onEnd) opts.onEnd();
    });
  }

  /* A WAV the console's own reader understands, built here: 16-bit PCM, and the
     samples the microphone gave (the recogniser resamples what it is handed). No
     encoder, no library, nothing to install. */
  function wavOf(chunks, rate) {
    var total = 0, i, j;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    if (!total) return { blob: null, seconds: 0 };
    var buffer = new ArrayBuffer(44 + total * 2);
    var view = new DataView(buffer);
    function tag(offset, text) {
      for (var k = 0; k < text.length; k++) view.setUint8(offset + k, text.charCodeAt(k));
    }
    tag(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); tag(8, 'WAVE');
    tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    tag(36, 'data'); view.setUint32(40, total * 2, true);
    var offset = 44;
    for (i = 0; i < chunks.length; i++) {
      var chunk = chunks[i];
      for (j = 0; j < chunk.length; j++) {
        var sample = clamp(chunk[j], -1, 1);
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return { blob: new Blob([buffer], { type: 'audio/wav' }), seconds: total / rate };
  }

  /* What a spoken phrase can be besides a search: the transport, in the words a
     person uses for it. Everything else is what they want to hear. */
  var SPOKEN_COMMANDS = [
    [/^(pause|stop)( the (music|song|playback))?$/, 'pause'],
    [/^(play|resume|continue|play the music)$/, 'resume'],
    [/^(next|next (song|track)|skip|skip this( song| track)?)$/, 'next'],
    [/^(previous|prev|last (song|track)|go back|back)$/, 'prev'],
    [/^(shuffle|shuffle (the )?(music|queue))$/, 'shuffle'],
    [/^(repeat|repeat this( song| track)?|repeat (the )?queue)$/, 'repeat'],
    [/^(mute|unmute|mute the (music|speaker))$/, 'toggleMute'],
    [/^(volume up|louder|turn it up|looser)$/, 'louder'],
    [/^(volume down|quieter|turn it down|lower (the )?volume)$/, 'quieter']
  ];

  function runSpoken(text) {
    var said = String(text || '').toLowerCase().replace(/[.!?,]+$/, '').trim();
    for (var i = 0; i < SPOKEN_COMMANDS.length; i++) {
      if (SPOKEN_COMMANDS[i][0].test(said)) { runSpokenCommand(SPOKEN_COMMANDS[i][1], said); return; }
    }
    runSearch(text, true);
  }

  function runSpokenCommand(action, said) {
    if (action === 'louder' || action === 'quieter') {
      var next = clamp(S.volume + (action === 'louder' ? 0.1 : -0.1), 0, 1);
      control({ action: 'volume', value: next });
      toast((action === 'louder' ? 'Louder: ' : 'Quieter: ') + Math.round(next * 100) + '%');
      return;
    }
    if (action === 'toggleMute') { control({ action: 'mute' }); return; }
    control({ action: action });
    toast('“' + said + '”');
  }

  function startBrowserRecognition(opts) {
    try {
      recognizer = new SR();
    } catch (e) { toast('Could not start the microphone.'); return false; }

    recognizer.lang = opts.lang || 'en-US';
    recognizer.continuous = !!opts.continuous;
    recognizer.interimResults = !!opts.interim;
    recognizer.maxAlternatives = 3;

    recognizer.onstart = function () {
      listening = true;
      micBtn.classList.add('listening');
      if (askOpen) $('#askMicHint').classList.add('live');
    };
    recognizer.onend = function () {
      listening = false;
      micBtn.classList.remove('listening');
      $('#askMicHint').classList.remove('live');
      if (opts.onEnd) opts.onEnd();
    };
    recognizer.onerror = function (e) {
      listening = false;
      micBtn.classList.remove('listening');
      $('#askMicHint').classList.remove('live');
      if (e && (e.error === 'not-allowed' || e.error === 'service-not-allowed')) {
        toast('Microphone blocked. Allow it in the browser, then try again.');
      } else if (e && e.error === 'no-speech') {
        toast('Heard nothing — tap the mic and speak again.');
      }
    };
    recognizer.onresult = function (e) {
      var finalText = '', interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim && opts.onInterim) opts.onInterim(interim);
      if (finalText) {
        if (opts.onFinal) opts.onFinal(finalText.trim());
        else {
          searchInput.value = finalText.trim();
          runSpoken(finalText.trim());
          if (opts.continuous) { /* keep going */ } else { searchInput.blur(); }
        }
      }
    };
    try { recognizer.start(); } catch (e) { /* already started */ }
    return true;
  }

  function stopListening() {
    if (capture) { stopCapture(); return; }
    if (recognizer) { try { recognizer.stop(); } catch (e) {} }
    listening = false;
    micBtn.classList.remove('listening', 'recording');
    if (askOpen) $('#askMicHint').classList.remove('live');
  }

  micBtn.addEventListener('click', function () {
    if (askOpen) { listenForChoice(); return; }
    // The console records and answers on its own; a browser with speech
    // recognition of its own only speaks up when the console cannot listen.
    listen({ interim: true });
  });

  /* ======================================================================
     ASK OVERLAY — the console asking the wall which one was meant
     ====================================================================== */
  var askOverlay = $('#askOverlay'), askPrompt = $('#askPrompt'), askHeard = $('#askHeard'),
      askOptions = $('#askOptions'), askEyebrow = $('#askEyebrow');
  var askOpen = false;
  var currentAsk = null;

  function normalizeOption(o) {
    if (!o) return null;
    if (o.track) return { kind: 'track', item: o.track };
    if (o.playlist) return { kind: 'playlist', item: o.playlist };
    if (o.id && o.title) return { kind: 'track', item: o };
    if (o.id && o.name) return { kind: 'playlist', item: o };
    return null;
  }

  function openAsk(ask) {
    currentAsk = ask;
    askOpen = true;
    S.localAsk = !!ask.local;
    askOverlay.hidden = false;
    askPrompt.textContent = ask.prompt || 'Which one did you mean?';
    askEyebrow.textContent = ask.local ? 'Not sure what you meant' : 'Nix PUCA is not sure';
    askHeard.textContent = ask.heard ? 'Nix heard: “' + ask.heard + '”' : 'Nix heard more than one of these — pick one.';
    renderAsk(ask);
    hideResults();
    setAskHint('Tap a card, or tap here and say “two”');
    // Deliberately NOT listening yet. An always-open mic next to a playing song
    // hears the song, and would happily pick an option the user never chose.
  }

  function setAskHint(text) {
    var el = $('#askMicHintText');
    if (el) el.textContent = text;
  }

  function renderAsk(ask) {
    var opts = (ask.options || []).map(normalizeOption).filter(Boolean);
    askOptions.innerHTML = opts.map(function (o, i) {
      var it = o.item, h = hueOf(it);
      return '<button class="opt" data-index="' + i + '" data-kind="' + o.kind + '" data-id="' + esc(it.id) + '">' +
        '<span class="oart" style="background:' + coverGradient(h, 9) + '">' +
          coverFace(it.art, '') +
        '</span>' +
        '<span><span class="ot">' + esc(it.title || it.name) + '</span>' +
        '<span class="oa">' + esc(it.artist || it.subtitle || (o.kind === 'playlist' ? 'Playlist' : '')) + '</span></span>' +
        '<span class="num">' + (i + 1) + '</span></button>';
    }).join('');
    if (!opts.length) askOptions.innerHTML = '<p class="hint">No options came through.</p>';
  }

  function closeAsk() {
    askOpen = false;
    S.localAsk = false;
    currentAsk = null;
    askOverlay.hidden = true;
    stopListening();
  }

  function currentOptions() {
    return (currentAsk && currentAsk.options || []).map(normalizeOption).filter(Boolean);
  }

  function chooseOption(index, spoken) {
    var opts = currentOptions();
    var o = opts[index];
    if (!o) { closeAsk(); return; }
    var label = o.item.title || o.item.name;
    if (S.ask && S.ask.id) {
      // the console's own question: answer it with the option's position
      S.localAsk = false;
      postPanel('/answer', { index: index });
    } else {
      // a locally-raised ambiguity from search: just send the track it matched
      if (o.kind === 'track') playTrackId(o.item.id); else playPlaylistId(o.item.id);
    }
    if (spoken) toast('Heard “' + spoken + '” — playing “' + label + '”');
    else toast('Playing “' + label + '”');
    closeAsk();
  }

  var NUM_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

  /**
   * Turn something spoken into an option index, or -1 when it is not clear.
   * Deliberately conservative: answering the wrong song is worse than asking
   * again.
   */
  function parseChoice(text, opts) {
    var t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ') + ' ';

    var best = -1, bestAt = -1;
    for (var i = 0; i < opts.length && i < 10; i++) {
      var cands = [String(i + 1), NUM_WORDS[i], NUM_WORDS[i + 10]];
      for (var c = 0; c < cands.length; c++) {
        var at = t.lastIndexOf(' ' + cands[c] + ' ');
        if (at >= 0 && at > bestAt) { bestAt = at; best = i; }
      }
    }
    if (best >= 0) return best;

    var scores = opts.map(function (o) {
      var title = String(o.item.title || o.item.name || '').toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      var words = (title + ' ' + String(o.item.artist || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' '))
        .split(/\s+/).filter(function (w) { return w.length > 2; });
      var s = 0;
      words.forEach(function (w) { if (t.indexOf(' ' + w + ' ') >= 0) s += 1; });
      if (title && t.indexOf(' ' + title + ' ') >= 0) s += 3;
      return { i: o, s: s, words: words.length };
    });

    var top = 0, tie = false;
    for (var k = 1; k < scores.length; k++) {
      if (scores[k].s > scores[top].s) { top = k; tie = false; }
      else if (scores[k].s === scores[top].s && scores[k].s > 0) { tie = true; }
    }
    if (scores[top].s < 2 || tie) return -1;
    return top;
  }

  function listenForChoice() {
    if (!CONFIG.voice || !SR || !askOpen) return;
    if (listening) { stopListening(); return; }
    // The session ends right after the phrase it recognized, so "say the number
    // again" is only the right hint when nothing was heard at all: an answer Nix
    // could not place has to stay on screen instead of being wiped a tick later.
    var heard = false;
    listen({
      interim: true,
      onInterim: function (txt) { setAskHint('“' + txt + '”'); },
      onFinal: function (txt) {
        heard = true;
        var idx = parseChoice(txt, currentOptions());
        if (idx >= 0) chooseOption(idx, txt);
        else {
          setAskHint('Heard “' + txt + '” — not sure which. Tap a card, or tap here and say the number.');
          toast('Heard “' + txt + '” — tap the one you meant.');
        }
      },
      onEnd: function () { if (askOpen && !heard) setAskHint('Tap a card, or tap here and say “two”'); }
    });
  }

  /* ======================================================================
     LYRICS DESIGN
     ====================================================================== */
  var lyricsOverlay = $('#lyricsOverlay'), lyrScroller = $('#lyrScroller'), lyrLines = $('#lyrLines');
  var lyricSig = null;
  var lyricsStore = {};            // track id -> { trackId, synced, plain }
  var lyricsPending = {};

  /** Identity of the words on screen, so identical content is never re-rendered.

      An empty list is the case this has to survive: a track whose words came as
      plain text carries `synced: []`, which is *truthy*, and reading the last of
      nothing threw here — inside the poll's own chain, so the wall reported
      "reconnecting" on a console that had answered, stopped following the music,
      and never advanced the queue when the song ended. The words are the least
      important thing on the wall; they must never be able to stop it. */
  function lyricsSignature() {
    var l = S.lyrics, np = S.nowPlaying;
    if (!np) return 'none';
    if (!l) return 'none:' + np.id;
    var body = (l.synced && l.synced.length)
      ? 's' + l.synced.length + ':' + l.synced[l.synced.length - 1].t
      : (l.plain && l.plain.length) ? 'p' + l.plain.length : 'x';
    return (l.trackId || np.id) + ':' + body;
  }

  function lyricsForNow() {
    var np = S.nowPlaying;
    if (!np) return null;
    if (S.lyrics && S.lyrics.trackId === np.id) return S.lyrics;
    if (S.lyrics && !S.lyrics.trackId) return S.lyrics;
    return null;
  }

  /* The console answers with { lyrics:[{time_sec,text}], lyrics_plain, ... };
     this page renders { trackId, synced:[{t,text}], plain:[...] }. */
  function mapLyrics(id, payload) {
    var synced = (payload && payload.lyrics ? payload.lyrics : []).map(function (l) {
      return { t: Number(l.time_sec || 0), text: l.text || '' };
    });
    var plain = [];
    if (!synced.length && payload && payload.lyrics_plain) {
      plain = String(payload.lyrics_plain).split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    }
    return { trackId: id, synced: synced, plain: plain };
  }

  function ensureLyrics(np) {
    if (!np || !np.id || lyricsStore[np.id] || lyricsPending[np.id]) return;
    lyricsPending[np.id] = true;
    var params = new URLSearchParams();
    if (np.id) params.set('video_id', np.id);
    if (np.title) params.set('title', np.title);
    if (np.artist) params.set('artist', np.artist);
    if (np.album) params.set('album', np.album);
    if (np.duration) params.set('duration_sec', String(Math.round(np.duration)));
    getMusic('/lyrics?' + params.toString()).then(function (payload) {
      lyricsPending[np.id] = false;
      lyricsStore[np.id] = mapLyrics(np.id, payload);
      writeStore();
      if (S.nowPlaying && S.nowPlaying.id === np.id) {
        S.lyrics = lyricsStore[np.id];
        if (lyricsOpen) renderLyricLines();
      }
    }).catch(function () { lyricsPending[np.id] = false; });
  }

  function renderLyricLines() {
    var np = S.nowPlaying;
    var lyr = lyricsForNow();
    if (!np) { lyrLines.innerHTML = '<p class="lyr-line plain">Nothing is playing.</p>'; lyricSig = 'none'; return; }
    if (!lyr) {
      lyrLines.innerHTML = '<p class="lyr-line plain">Waiting for the words…</p>';
      lyricIndex = -1;
      lyricSig = lyricsSignature();
      return;
    }
    var html = [];
    if (lyr.synced && lyr.synced.length) {
      html.push('<p class="lyr-line plain"><span class="pill">' + esc(np.title) + ' · ' + esc(np.artist) + '</span></p>');
      lyr.synced.forEach(function (l, i) {
        html.push('<p class="lyr-line" data-i="' + i + '" data-t="' + Number(l.t) + '">' + esc(l.text || '♪') + '</p>');
      });
    } else if (lyr.plain && lyr.plain.length) {
      lyr.plain.forEach(function (l) {
        html.push('<p class="lyr-line plain">' + esc(l) + '</p>');
      });
    } else {
      html.push('<p class="lyr-line plain">No words are available for this track.</p>');
    }
    lyrLines.innerHTML = html.join('');
    lyricSig = lyricsSignature();
    lyricIndex = -1;
    if (lyricsOpen) { measureLyrics(); updateLyricHighlight(true); }
  }

  function lyricsIndexReset() { lyricIndex = -1; lineTimes = null; }

  /*
   * Song words are positioned with a compositor transform, never by scrolling:
   * a `scrollTop` write per frame forces a layout every frame, and the scrolling
   * box also carried a mask that had to be re-rasterised with it. Line offsets
   * are measured once per render and reused, so the animation touches exactly
   * one property on exactly one element.
   */
  var LYR_SEL = '.lyr-line[data-t]';
  var lineOffsets = null;
  var viewportH = 0;
  var lineOffsetY = 0;
  var lyrTween = null;

  var lineTimes = null;
  function measureLyrics() {
    viewportH = lyrScroller.clientHeight;
    var lines = lyrLines.querySelectorAll(LYR_SEL);
    lineOffsets = [];
    lineTimes = [];
    for (var i = 0; i < lines.length; i++) {
      lineOffsets.push({ top: lines[i].offsetTop, h: lines[i].offsetHeight });
      lineTimes.push(Number(lines[i].getAttribute('data-t')));
    }
  }

  function applyLyricTransform() {
    lyrLines.style.transform = 'translate3d(0,' + lineOffsetY.toFixed(2) + 'px,0)';
  }

  /** Unsynchronised lyrics have nothing to follow, so just centre the block. */
  function centerWhole() {
    viewportH = lyrScroller.clientHeight;
    if (!viewportH) return;
    lineOffsetY = Math.max(0, (viewportH - lyrLines.offsetHeight) / 2);
    applyLyricTransform();
  }

  function centerOn(index, animate) {
    if (!lineOffsets || !lineOffsets.length || !viewportH) return;
    var o = lineOffsets[Math.max(0, Math.min(lineOffsets.length - 1, index))];
    if (!o) return;
    var to = viewportH / 2 - (o.top + o.h / 2);
    if (lyrTween !== null) { cancelAnimationFrame(lyrTween); lyrTween = null; }
    if (!animate || reduce) { lineOffsetY = to; applyLyricTransform(); return; }
    var from = lineOffsetY;
    if (Math.abs(to - from) < 2) return;
    var started = performance.now(), ms = 420;
    function step(now) {
      var p = Math.min(1, (now - started) / ms);
      var e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;   // easeInOutQuad
      lineOffsetY = from + (to - from) * e;
      applyLyricTransform();
      if (p < 1) { lyrTween = requestAnimationFrame(step); } else { lyrTween = null; }
    }
    lyrTween = requestAnimationFrame(step);
  }

  function updateLyricHighlight(force) {
    if (!lyricsOpen) return;
    if (!lineTimes || !lineTimes.length) { centerWhole(); return; }
    var pos = livePosition();
    var idx = -1;
    for (var i = 0; i < lineTimes.length; i++) {
      if (lineTimes[i] <= pos) idx = i; else break;
    }
    if (idx === lyricIndex && !force) return;
    lyricIndex = idx;
    var lines = lyrLines.querySelectorAll(LYR_SEL);
    for (var k = 0; k < lines.length; k++) {
      lines[k].classList.toggle('cur', k === idx);
      lines[k].classList.toggle('past', k < idx);
      lines[k].classList.toggle('next', k === idx + 1 || k === idx + 2);
    }
    centerOn(Math.max(0, idx), !force);
  }

  function openLyrics(byUser) {
    if (!S.nowPlaying) return;
    dismissedLyricsFor = null;
    // Who opened them decides whether they count as somebody reading them (see
    // `hasSomethingToShow`): the panel opens the words for every new track, a
    // person opens them when they want them.
    lyricsByUser = !!byUser;
    lyricsOpen = true;
    lyricsOverlay.hidden = false;
    renderLyricLines();
    // Measure once the overlay is laid out, then land on the right line instantly
    // and animate from there. Offsets are only valid while it is visible.
    requestAnimationFrame(function () {
      measureLyrics();
      updateLyricHighlight(true);
    });
    document.body.classList.add('lyrics-on');
  }

  function closeLyrics(userClosed) {
    lyricsOpen = false;
    lyricsByUser = false;
    lyricsOverlay.hidden = true;
    document.body.classList.remove('lyrics-on');
    if (userClosed) dismissedLyricsFor = S.nowPlaying && S.nowPlaying.id;
  }

  function toggleLyrics() {
    if (lyricsOpen) closeLyrics(true);
    else { dismissedLyricsFor = null; if (!S.lyrics) ensureLyrics(S.nowPlaying); openLyrics(true); }
  }

  /* ------------------------------------------------------------------ zoom
     One factor on the design's own line size. The lyric box positions the line
     being sung from measured offsets, so a size change has to be measured
     again in the same breath — otherwise the words stay centred on where the
     line used to be.

     On a wall display the words have to work for the person across the room
     and for the one standing in front of it, which is why the factor is kept
     between two taps of "the size I can read" instead of being a settings
     screen. */
  var LYR_ZOOM_KEY = 'nix.panel.lyrics-zoom';
  var LYR_ZOOM_MIN = 0.7, LYR_ZOOM_MAX = 2, LYR_ZOOM_STEP = 0.15;
  var lyrZoom = 1;

  function readLyricZoom() {
    try {
      var saved = parseFloat(window.localStorage.getItem(LYR_ZOOM_KEY));
      if (isFinite(saved)) lyrZoom = clamp(saved, LYR_ZOOM_MIN, LYR_ZOOM_MAX);
    } catch (e) { /* a display that cannot remember is still a display */ }
  }

  function applyLyricZoom(remember) {
    var out = $('#lyrZoomOut'), into = $('#lyrZoomIn');
    lyricsOverlay.style.setProperty('--lyr-zoom', lyrZoom.toFixed(2));
    if (out) out.disabled = lyrZoom <= LYR_ZOOM_MIN + 1e-6;
    if (into) into.disabled = lyrZoom >= LYR_ZOOM_MAX - 1e-6;
    if (remember) {
      try { window.localStorage.setItem(LYR_ZOOM_KEY, String(lyrZoom)); } catch (e) {}
    }
    if (lyricsOpen) { measureLyrics(); updateLyricHighlight(true); }
  }

  function zoomLyrics(step) {
    lyrZoom = clamp(Math.round((lyrZoom + step) * 100) / 100, LYR_ZOOM_MIN, LYR_ZOOM_MAX);
    applyLyricZoom(true);
  }

  /* ======================================================================
     TOAST
     ====================================================================== */
  var toastEl = $('#toast'), toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 4200);
  }

  /* ======================================================================
     IDLE / WAKE LOCK / THE IDLE PAGE

     A wall display spends most of its life with nobody in front of it, and a
     bright screen showing a paused song for hours is both a waste and a burn-in
     risk. So after a minute of nothing — no touch, no keys, nothing playing, and
     nothing somebody is actually reading or choosing — the wall hands itself
     over to the idle page (screensaver.html, shipped beside this one). Any touch,
     any key, music starting or the lyrics being opened by hand hands it straight
     back.

     "Nothing somebody is reading" is the part that took a live wall to learn:
     the words open by themselves for every track, so on a display whose music had
     stopped they stayed up for days with nobody in the room, and the one state
     the idle page exists for was the one state it could not reach. The words now
     count while a person is reading them (or while there is a song to read them
     for, which is the music check); a list counts for the same minute that would
     have sent the wall to sleep anyway.
     ====================================================================== */
  var lastActivity = Date.now();
  var saverOn = false;
  var saverFrame = null;

  /** Whether the wall currently has something of its own to show.
   *
   * The distinction that matters here is between the wall *showing* something and
   * somebody *using* it. Music playing is the display doing its job; the words or
   * a list are somebody reading or choosing — but only for as long as they are
   * actually there. Words the panel opened by itself for a song that has since
   * stopped, and a list nobody came back to, are leftovers: on a wall that has
   * been left alone, those are exactly the cases the idle page is for. Measured
   * live, music playing with the words open was the state the wall sat in for
   * days — the one state the idle page could never reach. */
  function hasSomethingToShow() {
    if (S.nowPlaying && S.nowPlaying.playing) return true;   // music is playing
    if (lyricsOpen && lyricsByUser) return true;             // somebody is reading
    if (askOpen) return true;                                // a question is waiting
    // A list left open is the wall's own leftovers after the same quiet window
    // that would have sent it to the idle page anyway.
    return !resultsSheet.hidden && (Date.now() - sheetUpAt) < CONFIG.saverAfter;
  }

  /* The idle page is a document of its own, so a tap lands inside it and never
     reaches this window: the wake listeners are bound to it once it has loaded,
     which is what makes "touch the screen and it comes back" true here. */
  function bindSaverWake(frame) {
    var inner = null;
    try { inner = frame.contentDocument; } catch (e) { inner = null; }
    if (!inner) return;
    ['pointerdown', 'pointermove', 'touchstart', 'keydown', 'wheel'].forEach(function (ev) {
      inner.addEventListener(ev, noteActivity, { passive: true });
    });
  }

  function showSaver() {
    if (saverOn || CONFIG.saver !== 'auto') return;
    saverOn = true;
    var frame = document.createElement('iframe');
    frame.id = 'saver';
    frame.title = 'Idle';
    frame.setAttribute('aria-hidden', 'true');
    // The console's own daypart, not the screen's, so the idle page flips with
    // the rest of the wall. Built fresh on every show: a hidden iframe would
    // otherwise keep a sky full of stars animating for days.
    frame.src = 'screensaver.html?theme=' + (themeNow === 'day' ? 'day' : 'night');
    document.body.appendChild(frame);
    saverFrame = frame;
    document.body.classList.add('saving', 'idle');
    // Bound now as well as on load: the tap that brings the wall back must not
    // depend on a load event that a cached document may have delivered already.
    bindSaverWake(frame);
    frame.addEventListener('load', function () {
      bindSaverWake(frame);
      setSaverTheme(frame);
    });
  }

  function setSaverTheme(frame) {
    // The idle page exposes its own theme seam; used so a daybreak while the
    // wall is idle flips both without reloading the page.
    try {
      var display = frame.contentWindow && frame.contentWindow.__display;
      if (!display) return;
      display.CONFIG.theme = themeNow === 'day' ? 'day' : 'night';
      display.applyTheme();
    } catch (e) { /* cross-origin or not loaded yet: the URL said the same thing */ }
  }

  function hideSaver() {
    if (!saverOn) return;
    saverOn = false;
    document.body.classList.remove('saving');
    if (saverFrame) {
      saverFrame.remove();       // removes the document, and its animation with it
      saverFrame = null;
    }
  }

  function noteActivity() {
    lastActivity = Date.now();
    hideSaver();
  }

  function saverTick() {
    if (CONFIG.saver !== 'auto') { hideSaver(); return; }
    if (hasSomethingToShow()) { noteActivity(); return; }
    if (Date.now() - lastActivity >= CONFIG.saverAfter) showSaver();
  }

  function initIdle() {
    var timer = null;
    function wake() {
      document.body.classList.remove('idle');
      noteActivity();
      clearTimeout(timer);
      timer = setTimeout(function () { document.body.classList.add('idle'); }, CONFIG.idleHide);
    }
    ['pointermove', 'pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
      window.addEventListener(ev, wake, { passive: true });
    });
    wake();
    setInterval(saverTick, 1000);
  }

  var sentinel = null;
  function keepAwake() {
    if (!('wakeLock' in navigator) || document.hidden || sentinel) return;
    try {
      navigator.wakeLock.request('screen').then(function (s) {
        sentinel = s;
        s.addEventListener('release', function () { sentinel = null; });
      }).catch(function () {});
    } catch (e) {}
  }

  /* ======================================================================
     EVENT WIRING
     ====================================================================== */
  $('#btnPlay').addEventListener('click', toggle);
  $('#btnNext').addEventListener('click', function () { control({ action: 'next' }); });
  $('#btnPrev').addEventListener('click', function () { control({ action: 'prev' }); });
  $('#btnShuffle').addEventListener('click', function () { control({ action: 'shuffle' }); });
  $('#btnRepeat').addEventListener('click', function () { control({ action: 'repeat' }); });
  $('#btnMute').addEventListener('click', function () { control({ action: 'mute' }); });
  $('#btnLyrics').addEventListener('click', toggleLyrics);
  $('#btnClearQueue').addEventListener('click', function () { control({ action: 'clearQueue' }); });
  $('#lyrClose').addEventListener('click', function () { closeLyrics(true); });
  $('#lyrZoomIn').addEventListener('click', function () { zoomLyrics(LYR_ZOOM_STEP); });
  $('#lyrZoomOut').addEventListener('click', function () { zoomLyrics(-LYR_ZOOM_STEP); });
  $('#askCancel').addEventListener('click', function () {
    dismissedAskId = S.ask && S.ask.id;
    postPanel('/dismiss', {});
    closeAsk();
  });
  $('#resultsClose').addEventListener('click', hideResults);
  $('#askMicHint').addEventListener('click', function () { listenForChoice(); });

  // clicking a shared row for lyrics dismisses it — "unless clicked out by the user"
  lyricsOverlay.addEventListener('click', function (e) {
    if (e.target.closest('.lyr-close') || e.target.closest('.slider') || e.target.closest('.lyr-foot')) return;
    closeLyrics(true);
  });

  askOptions.addEventListener('click', function (e) {
    var b = e.target.closest('.opt');
    if (!b) return;
    chooseOption(Number(b.getAttribute('data-index')));
  });

  function delegatePlays(root) {
    root.addEventListener('click', function (e) {
      // The queue control is a sibling of the row rather than part of it, so it
      // is answered first and never reaches the row's own play.
      // "This song and the rest of the list" is answered before the plain queue
      // control, because it is the more specific of the two.
      var rangeIt = e.target.closest('[data-queue-from]');
      if (rangeIt) {
        var fromId = rangeIt.getAttribute('data-queue-from');
        var fromTrack = trackById(fromId) || known[fromId] || {};
        queueFromHere(rangeIt.getAttribute('data-queue-playlist'), fromId, fromTrack.title);
        return;
      }
      var queueIt = e.target.closest('[data-queue-track]');
      if (queueIt) { queueTrack(queueIt.getAttribute('data-queue-track')); return; }
      // The arrows slide a rail; they are controls of the sheet, never a song.
      var slide = e.target.closest('[data-rail]');
      if (slide) { slideRail(slide, Number(slide.getAttribute('data-rail')) || 1); return; }
      var t = e.target.closest('[data-track]');
      if (t) { playTrackId(t.getAttribute('data-track')); hideResults(); return; }
      // An artist is a doorway: the console's own search is what has their music.
      var a = e.target.closest('[data-artist]');
      if (a) { runSearch(a.getAttribute('data-artist'), false, { songsOnly: true }); return; }
      // A whole library of playlists, opened from the playlists shelf.
      var shelf = e.target.closest('[data-library]');
      if (shelf) { openLibraryPage(); return; }
      // See all sits inside a playlist's shelf, so it is answered before the
      // shelf's own data-playlist would play the first song instead.
      var all = e.target.closest('[data-playlist-all]');
      if (all) { openPlaylistList(all.getAttribute('data-playlist-all')); return; }
      var p = e.target.closest('[data-playlist]');
      if (p) { playPlaylistId(p.getAttribute('data-playlist')); hideResults(); }
    });
  }

  /* Add one song to the queue without disturbing what is playing. The console's
     queue op resolves the video id through the same catalog path a play does. */
  function queueTrack(id) {
    if (!id) return;
    var t = trackById(id) || known[id] || {};
    postMusic('/queue', { action: 'add', video_id: id }).then(function (sent) {
      if (!sent || sent.ok === false) { toast('The queue would not take that.'); return; }
      toast('Queued “' + (t.title || id) + '”');
    }, function () { toast('The console did not answer.'); });
  }
  delegatePlays(shelvesEl);
  delegatePlays(resultsEl);

  // The queue rows carry data-id and the stylesheet gives them a pointer, so a
  // tap plays that position — the console plays the queue by index.
  queueEl.addEventListener('click', function (e) {
    var li = e.target.closest('li[data-id]');
    if (!li) return;
    var id = li.getAttribute('data-id');
    var index = (S.queue || []).indexOf(id);
    if (index >= 0) control({ action: 'playQueue', index: index });
  });

  searchForm.addEventListener('submit', function (e) {
    e.preventDefault();
    runSearch(searchInput.value, false);
    searchInput.blur();
  });
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { searchInput.value = ''; hideResults(); searchInput.blur(); }
  });

  var volPending = null;
  function sendVolume(v) {
    clearTimeout(volPending);
    volPending = setTimeout(function () { control({ action: 'volume', value: v }); }, 180);
  }

  scrub = makeSlider($('#scrub'), {
    step: 0.02,
    value: 0,
    onDrag: function (v) {
      var np = S.nowPlaying;
      $('#tCur').textContent = fmtTime((np ? np.duration : 0) * v);
    },
    onCommit: function (v) {
      var np = S.nowPlaying;
      if (!np) return;
      control({ action: 'seek', seconds: (np.duration || 0) * v });
    }
  });

  volSlider = makeSlider($('#volSlider'), {
    step: 0.05,
    value: 0.6,
    onDrag: function (v) {
      S.volume = v;
      setVolLabel(v);
      if (audio) audio.volume = S.muted ? 0 : v;
    },
    onCommit: function (v) { sendVolume(v); }
  });

  lyrScrub = makeSlider($('#lyrScrub'), {
    step: 0.02,
    value: 0,
    onCommit: function (v) {
      var np = S.nowPlaying;
      if (!np) return;
      control({ action: 'seek', seconds: (np.duration || 0) * v });
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.target === searchInput || e.target.tagName === 'INPUT') {
      if (e.key === 'Escape') searchInput.blur();
      return;
    }
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); toggle(); break;
      case 'ArrowRight': e.preventDefault(); control({ action: 'seek', delta: 10 }); break;
      case 'ArrowLeft': e.preventDefault(); control({ action: 'seek', delta: -10 }); break;
      case 'ArrowUp': e.preventDefault(); volSlider.set(clamp(S.volume + 0.05, 0, 1)); break;
      case 'ArrowDown': e.preventDefault(); volSlider.set(clamp(S.volume - 0.05, 0, 1)); break;
      case 'n': control({ action: 'next' }); break;
      case 'p': control({ action: 'prev' }); break;
      case 'l': toggleLyrics(); break;
      case 'm': control({ action: 'mute' }); break;
      case 's': control({ action: 'shuffle' }); break;
      case 'r': control({ action: 'repeat' }); break;
      case '/': e.preventDefault(); searchInput.focus(); break;
      case 'Escape':
        if (askOpen) { $('#askCancel').click(); }
        else if (lyricsOpen) closeLyrics(true);
        else hideResults();
        break;
      case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
        if (askOpen) chooseOption(Number(e.key) - 1);
        break;
    }
  });

  audio.addEventListener('ended', function () { control({ action: 'next' }); });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { keepAwake(); updateScrub(); if (lyricsOpen) updateLyricHighlight(true); poll(); }
  });
  window.addEventListener('resize', function () {
    if (!lyricsOpen) return;
    measureLyrics();
    updateLyricHighlight(true);
  });

  // Web fonts land after first paint and change line heights; re-measure or the
  // centred line drifts off centre for the rest of the song.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      if (lyricsOpen) { measureLyrics(); updateLyricHighlight(true); }
    });
  }

  /* ======================================================================
     LIBRARY
     ====================================================================== */
  function applyLibrary(out) {
    library.tracks = out.tracks || [];
    library.playlists = out.playlists || [];
    library.frequent = out.frequent || [];
    library.tracks.forEach(function (t) { if (t && t.id) known[t.id] = t; });
    renderShelves();
  }

  function loadLibrary(force) {
    var suffix = force ? '&refresh=1' : '';
    // A shelf is a page of the library, not the whole of it: the count beside
    // the title is the console's own total, so a row of 24 songs under
    // "439 songs" is a page, and the See-all tile is the rest of them.
    return Promise.all([
      getMusic('/library?kind=playlists&limit=50' + suffix),
      // The liked songs are read whole, not as a page: this is the one shelf
      // whose size the user actually checks against the number beside it, and a
      // "439 songs" heading over fifteen tiles is the wall being wrong.
      getMusic('/library?kind=likes&limit=' + CONFIG.listLimit),
      getMusic('/library?kind=history&limit=' + CONFIG.shelfSongs),
      getMusic('/library?kind=frequent&limit=' + CONFIG.frequent).catch(function () { return {}; })
    ]).then(function (res) {
      var playlists = (res[0].playlists || []);
      var likes = (res[1].tracks || []).map(rememberTrack).filter(Boolean);
      var history = (res[2].tracks || []).map(rememberTrack).filter(Boolean);
      // The console ranks these by how often the account played them; the count
      // travels on the track so the row can say it instead of the artist.
      var frequent = ((res[3] || {}).tracks || []).map(function (item) {
        var u = rememberTrack(item);
        if (!u) return null;
        u.plays = Number(item.plays || 0) || 0;
        // The song is often already on the wall from another row (a like, a
        // playlist), and every row reads the one object per id, so the count has
        // to land there and not on this copy.
        if (known[u.id] !== u) known[u.id] = Object.assign({}, known[u.id], { plays: u.plays });
        return u;
      }).filter(Boolean);
      var tracks = [], list = [];
      function collect(items) {
        items.forEach(function (t) {
          if (!known[t.id]) { known[t.id] = t; }
          if (!tracks.some(function (x) { return x.id === t.id; })) tracks.push(t);
        });
      }
      collect(likes); collect(history); collect(frequent);

      // A playlist knows how many songs it holds even when this page has only
      // read the first few of them, so the count the shelf shows is the
      // console's own — a tile that read "0 songs" while the console listed
      // fifty is a section that looks broken.
      function songs(count) { return count + ' songs'; }
      var likedEntry = playlists.filter(function (pl) { return pl.playlist_id === 'LM'; })[0] || {};
      var likedTotal = likedEntry.track_count;
      var shelfPlaylists = [
        // The two shelves the page builds itself wear a cover too: liked songs
        // are LM's own cover (or their first song's, which is what YouTube
        // Music shows), and recently played is the last thing played.
        // "Liked songs" is the same list the console calls Liked Music: one
        // playlist, one count, one name (see the shelf head below).
        { id: 'liked', name: 'Liked Music', total: likedTotal || likes.length, hue: 210,
          art: localArt(likedEntry.artwork_url) || (likes[0] && likes[0].art) || '',
          tracks: likes.map(function (t) { return t.id; }) },
        { id: 'history', name: 'Recently played', total: history.length, hue: 160,
          art: (history[0] && history[0].art) || '',
          tracks: history.map(function (t) { return t.id; }) }
      ];
      playlists.forEach(function (pl) {
        shelfPlaylists.push({
          id: pl.playlist_id,
          name: pl.name || pl.playlist_id,
          total: pl.track_count || 0,
          art: localArt(pl.artwork_url) || '',
          hue: hueOf({ id: pl.playlist_id }),
          tracks: []
        });
      });
      shelfPlaylists.forEach(function (p) {
        p.subtitle = songs(Math.max((p.tracks || []).length, p.total || 0));
      });

      // Fetch the songs of the first few playlists so the shelves have tiles.
      var withSongs = shelfPlaylists.slice(0, SHELF_LIMIT + 2).filter(function (p) {
        return p.id !== 'liked' && p.id !== 'history';
      });
      return Promise.all(withSongs.map(function (p) {
        return getMusic('/library?kind=playlist&playlist_id=' + encodeURIComponent(p.id) +
            '&limit=' + CONFIG.shelfSongs)
          .then(function (payload) {
            var items = (payload.tracks || []).map(rememberTrack).filter(Boolean);
            items.forEach(function (t) {
              if (!tracks.some(function (x) { return x.id === t.id; })) tracks.push(t);
            });
            p.tracks = items.map(function (t) { return t.id; });
            if (!p.art) p.art = (items[0] && items[0].art) || '';
            p.subtitle = songs(Math.max(items.length, p.total || 0));
          }).catch(function () {});
      })).then(function () {
        var out = { tracks: tracks, playlists: shelfPlaylists, frequent: frequent.map(function (t) { return t.id; }) };
        applyLibrary(out);
        writeStore();
        return out;
      });
    }).catch(function () { /* the shelves keep whatever storage painted */ });
  }

  /* ======================================================================
     BOOT
     ====================================================================== */
  var saved = readStore();
  if (saved) {
    if (saved.lyrics) lyricsStore = saved.lyrics;
    if (Array.isArray(saved.queueTracks)) saved.queueTracks.forEach(function (t) { if (t && t.id) known[t.id] = t; });
    if (saved.library) applyLibrary(saved.library);
    if (saved.theme) applyConsoleTheme(saved.theme);
    if (saved.state) {
      var boot = saved.state;
      // A remembered snapshot is only worth painting until the console answers:
      // its position is frozen (no fake progress between boots) and any question
      // it carried is dropped rather than revived for a room that is not being
      // offered anything any more.
      boot.ask = null;
      if (boot.nowPlaying) {
        boot.nowPlaying = Object.assign({}, boot.nowPlaying, { playing: false, at: Date.now() });
      }
      applyState(boot, 'boot');
    }
  }

  window.addEventListener('pagehide', writeStore);

  /* ------------------------------------------------------------------ brand
     The plate in the top-left is the NIX PUCA logo (puca-logo.png, shipped
     beside this page, declared in the manifest) and nothing else — the wording
     that used to sit next to it is gone, so this is the only thing in the
     brand. The artwork is dark ink drawn for a light background, so the plate
     is light while it is up; the panel's own note mark stays in the markup
     underneath it, so a file that cannot be read leaves a brand rather than an
     empty tile. Which of the two a wall is showing is answerable from the
     console tab.
     ====================================================================== */
  function brandLogo() {
    var plate = $('#brandLogo');
    if (!plate) return;
    var art = plate.querySelector('img');
    if (!art) { plate.classList.remove('has-logo'); return; }
    function keep() { plate.classList.add('has-logo'); }
    function drop() {
      plate.classList.remove('has-logo');
      if (art.parentNode) art.parentNode.removeChild(art);
    }
    if (art.complete) {
      if (art.naturalWidth) keep(); else drop();
      return;
    }
    art.addEventListener('load', keep);
    art.addEventListener('error', drop);
  }

  readLyricZoom();
  applyLyricZoom(false);
  brandLogo();
  probeVoice();
  loadLibrary();
  poll();
  openStream();
  setInterval(poll, CONFIG.pollMs);
  tickClock();
  setInterval(tickClock, 1000);
  applyTheme();
  initIdle();
  keepAwake();
  requestAnimationFrame(loop);

  // A wall handed to the box's own secure address to be spoken to arrives with
  // `?listen=1`: the microphone opens here, so the tap that moved it is the tap
  // that is being listened to rather than one that has to be made again.
  if (CONFIG.listenOnBoot && secureOrigin()) {
    setTimeout(function () { listen({ silent: true }); }, 1200);
  }

  // seam for tinkering from the console
  window.__puca = {
    CONFIG: CONFIG, state: S, library: library, openLyrics: openLyrics, closeLyrics: closeLyrics,
    search: runSearch, control: control, poll: poll, isNight: isNight, theme: function () { return themeNow; },
    // What the wall thinks about being left alone: a display on a wall is the one
    // thing here nobody can watch, so "why is the idle page not up?" has to be
    // answerable from the console tab rather than by waiting another minute.
    lastError: function () { return panelError; },
    idle: function () {
      return {
        saving: saverOn,
        idle_ms: Date.now() - lastActivity,
        idle_after_ms: CONFIG.saverAfter,
        something_to_show: hasSomethingToShow(),
        lyrics_open: lyricsOpen,
        lyrics_by_user: lyricsByUser,
        sheet_open: !resultsSheet.hidden,
        connected: connected,
        panel_error: panelError
      };
    },
    // Which address the wall is talking to, and what this page did about it.
    // The console tab asks this instead of reading a URL bar on a wall, and a
    // display that was expected to be local but is not — the box unreachable,
    // `?local=0`, a move this browser refused — says so here.
    local: function () {
      return {
        auto: CONFIG.autoLocal,
        here: pageAddress(),
        box_http: boxAddress(false),
        box_https: boxAddress(true),
        on_the_box: onTheBox(),
        looked: localMove.looked,
        moved: localMove.moved,
        moved_from: localMove.from,
        moved_to: localMove.to,
        reason: localMove.reason
      };
    },
    // Which panel this page thinks it is: the one it was served from, what the
    // console says it is serving now, and whether it has asked to be refreshed.
    builds: function () {
      return { page: pageBuild, served: servedBuild, reload_asked: reloadAsked };
    },
    // Which logo the plate in the top-left is showing: the NIX PUCA logo, or
    // the panel's own note because the artwork could not be read.
    brand: function () {
      var plate = $('#brandLogo');
      return plate && plate.classList.contains('has-logo') ? 'puca-logo' : 'note';
    },
    // Whether the console is answering. The brand is a mark and no lettering,
    // so this — not text on the page — is where "is the wall live?" is read.
    connected: function () { return connected; },
    // The push channel, for a display nobody can watch: whether it is up, where
    // it points, and how many times it has had to reconnect.
    stream: function () {
      return { enabled: CONFIG.stream, up: streamUp(), url: streamUrl(), attempts: socketAttempts };
    },
    // How far the music has been scrolled on a wall nobody can stand in front of.
    // The card folding away is this number and nothing else, so it is also how
    // "why is the card still there?" is answered from the console tab.
    scroll: function () {
      return columnEl
        ? {
            mode: CONFIG.foldPlayer ? 'column' : 'pinned',
            top: Math.round(columnEl.scrollTop),
            height: columnEl.scrollHeight,
            window: columnEl.clientHeight
          }
        : null;
    }
  };
})();

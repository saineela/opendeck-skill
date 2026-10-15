<p align="center"><a href="https://github.com/saineela/puca"><img src="https://res.cloudinary.com/dh5uxc6ql/image/upload/v1790917615/93d18a47-5f3a-46e1-ad71-705b2680442f_anp8f1.png" alt="NIX PUCA" width="320"></a></p>

# OpenDeck skill for NIX PUCA

[☆ Star NIX PUCA on GitHub](https://github.com/saineela/puca/stargazers)

Play the music that lives in **your own** [OpenDeck](https://github.com/saineela/opendeck) server on your NIX device. Setup collects the instance's **server address** and an **API key** (`odk_…`) in the NIX Skills page; both are stored in the skill's private configuration file (mode 0600) and passed only to the worker. Never ask the conversational model to expose or repeat the key.

> NIX's `secret` setup type is reserved for 32-byte base64 device keys (like the Echo Dot's ESPHome PSK), so the OpenDeck key is a normal setup value: it is stored in the private config file and only ever sent to your own OpenDeck server, but it is visible in the Skills setup form — keep dashboard access to people you trust.

## What you can do

Users can ask naturally, for example:

- “Play Bohemian Rhapsody.” / “Put on some lo-fi jazz.”
- “What does my OpenDeck library have?” (playlists, liked songs, recent plays)
- “Search OpenDeck for Fleetwood Mac.”
- “Like this song.” / “Unsave that one.”
- “Make me a playlist called Late Night.” / “Add that track to Late Night.”
- “Queue Bohemian Rhapsody.” / “Add this to the queue.”
- “What's in my queue?” / “Skip to the next queued track.” / “Clear the queue.”
- “Show me the lyrics for this song.” (synchronized lyrics from LRCLIB, through OpenDeck's proxy)

### When the request is unclear

A `play` with a `query` is decided by the catalog, not by a guess. The worker scores the search
results against the request: a title the request names (or nearly names) is played; when two or more
**different** titles fit it about equally well (“play that song from the film”, “play midnight”), the
result comes back as a **refusal to choose** — `ambiguous: true` with up to four `options` — and
**nothing is played**. Two uploads of the *same* title are not a choice: the catalog's own ranking
decides those.

Core turns that into the question the **PUCA Panel** puts on screen (and says out loud in the reply), so
the user picks the one they meant. Answering it plays exactly that track.

## The PUCA Panel

This package also ships the wall display, in `PUCA-Panel/` (`panel.html`, `panel.css`, `panel.js`): the
**Nix-Physical-Display "PUCA Panel"** design, whose markup and stylesheet ship unchanged, filled from the
console's music API by `panel.js`. The console serves that folder from its own listener on port **49170**
(`NIX_PANEL_PORT`), and the same page over TLS on **49171** (`NIX_PANEL_TLS_PORT`) — the address to use
when the microphone matters, because a browser only lends a page a microphone on a secure origin. The
display **finds the box for itself**: every read the page makes (state, music, covers, the recogniser)
is a relative path on the origin it was opened at, so `panel_info()` reports where the box lives on its
own network and a wall opened at a tunnel or tailnet name hands itself over to that address once the
box answers there, keeping the page and the settings it was opened with (`?local=0` pins a display that
is deliberately watched from outside the house, and `window.__puca.local()` reports which address the
wall is talking to and what it did about it). A tap on the microphone on a page the browser will not
lend one to moves the wall to the box's own TLS address and arrives listening, rather than putting an
address on screen to be typed into a screen on a wall. Nothing on the wall needs the internet to paint
itself either: the page's typography ships in this package (`PUCA-Panel/fonts.css` and `fonts/`, both
declared) and the panel listener serves it from its own origin. Scrolling into the music folds the now-playing card away: the card and the shelves are one
column and the column scrolls, so the card goes up and out of the way as the music comes up — the
browser's own scrolling on the compositor, not an animated height, because a wall panel has no
headroom to lay the column out again on every frame of one (measured at 74% of such an animation in
frames over 33ms with the CPU throttled). Scrolling back to the top brings the card down again, and
`?fold=0` pins the card with the music in its own scroller underneath it. It is read from across a room (large type, large tiles that are mostly their covers, large
volume) and spoken to, with the **console's own recogniser** (`nix_core/voice.py`, served at
`/api/voice`): the page records a phrase, posts the clip to its own origin and the box transcribes it,
so say “play Bohemian Rhapsody”, “pause”, “next”, “volume up” or “shuffle”, or say what you are looking
for and choose from the results. What a word matched is more than songs: the panel lists the artists
and the playlists it holds by that word too, a playlist can be opened into its whole song list from the
**Library page**, and every song can be queued with the `+` on its cover. A long list is drawn the way
the shelves are — a card per song, its sleeve over its name, on a sheet as wide as the wall and slid a
page at a time by the arrows in its heading (or by a swipe) — and every name it shows is the console's
own answer rather than the video id of a song the panel had not read yet. The music cards (shelf tiles,
library tiles, the cards in a search rail and the queue rows) are sized to be read across a room, and
the now-playing card is not changed with them. The lyrics of whatever is playing
open by themselves and stay until closed, with an **A− / A+ size control at the bottom left of the words
page that is always drawn** — every track, with words or without — a little above the bottom edge of the
screen, since that is where a TV overscans and where a device puts a bar of its own; the theme is dark from 10PM and light from 6AM in the console's
timezone. After a minute with nothing happening — no touch, nothing playing, the words closed — the
wall shows `PUCA-Panel/screensaver.html`, its own idle page, and any touch brings the panel back to
what it was showing (`?saver=off` disables it, `?saverAfter=<seconds>` changes the minute). "Nothing
being read" means a person: the words open by themselves for every track, so lyrics the panel opened
for a song that has since stopped, and a list nobody came back to, no longer keep the wall awake —
music playing, a question waiting for an answer, and words opened by hand all do. The panel also keeps
itself current: the state it polls carries the build of the panel the console is serving, and a page
whose own build no longer matches reloads itself once (one reload per build per session, `?refresh=0`
to pin a page) rather than sitting on an old panel for as long as the wall is switched on.

## The Music page

Installing this skill also adds a **Music** page to the NIX console. The console owns the route, the
navigation entry and the layout shell; this package ships the page itself (`ui/music.js`, `ui/music.css`,
declared as `device_ui.page` in `skill.json`), so the page appears when the skill is installed and
disappears when it is removed. The same JSON API backs the NIX Home app's music screen
(`/api/music` and `/api/mobile/v1/music…`, documented in `nix_core/MUSIC_API.md`):

- **Now playing** — artwork, title, artist, elapsed/total time and a progress bar, from the track the
  console recorded plus the speaker's reported state. The console estimates position from when it handed
  the track over (the speaker's media player reports no position), and the page keeps its own clock
  between polls so lyrics stay in step.
- **Transport** — one large play/pause button, Mute/Unmute, and a graphical volume dial that is
  dragged, scrolled or nudged with the arrow keys — the same controller the Echo Connect speaker panel
  uses, so the two pages read as one product. There is no separate Pause and no Stop: the big toggle is
  the whole transport (a second Pause button repeated it, and a Stop button the speaker treats as
  “pause a moment” only invited mistakes). The controls are routed to whichever installed skill
  declares those device controls (today that is Echo Connect: volume and mute are available
  immediately, and URL playback/play/pause light up as soon as that skill declares them). If no
  installed skill can be handed a URL, the page still resolves and shows the track and says so.
- **Queue** — a play queue the assistant and the page share. Every track row carries an add control
  (＋) that lines the track up without interrupting what is playing, and the queue card lists what is
  waiting, marks the entry that is playing, and offers play-next, per-row play and remove, and clear.
  **Shuffle** and **Repeat** sit with the transport: shuffle reorders what is waiting behind the
  playing track and turns back off to the queued order, and repeat cycles off → repeat-all →
  repeat-one, shown from the provider's own reply rather than guessed.
- **Like and playlist** — the playing track can be liked or unliked, and added to one of your
  playlists or to a new one named on the spot. Both write to your OpenDeck account through the
  provider's `save` action (`POST /api/music/save`), never to a store of this skill's own; the console
  fills in the track, so the page never has to know a video id it does not display.
- **Said out loud** — “like this song”, “add this to my Liked Music”, “add this to my Late Night
  playlist”, “make a playlist called Focus”. A spoken request names no video id and no playlist id, so
  the worker resolves both: “this song” is the track it last handed to the speaker, a playlist is found
  by name (case-insensitively, against the linked account and this instance's own store) and created
  when the name is new — “my Late Night playlist” becomes a playlist called `Late Night`. Liked Music
  is the like list, so adding to it is answered as a like rather than refused. “add Bohemian Rhapsody
  to Focus” names a track to look up first, which is the assistant's call to make: search, then save.
- **Browse** — search, playlists, liked songs, history and what the account plays most (`frequent`,
  the play log ranked by play count with that count on each track), straight from your OpenDeck library; a row is
  played by handing its resolved stream to the speaker. Playlists are the linked account's own (read
  through `GET /api/youtube/library`, which is what OpenDeck's UI shows), plus its **Liked Music** auto
  playlist — offered first as `playlist_id` `LM`, because liked songs are a playlist in YouTube Music
  too — and then the playlists created through OpenDeck itself. **Every playlist carries its cover**
  (`artwork_url`): the thumbnail the linked library resolves, or the artwork a stored playlist was saved
  with. Liked Music borrows the first liked song's cover when its own is missing. A playlist with no
  cover at all is drawn as a monogram tile by the page, never a broken image.
- **Cached reads** — a playlist list, a playlist's tracks, liked songs and history are cached on disk
  for ten minutes (`/root/data/opendeck-cache.json`). The page paints its own copy at once and asks
  again behind it, so a tab switch or a reload is instant instead of another multi-second browse; a
  read whose copy has expired is refreshed, and if OpenDeck cannot be reached the older copy is
  served rather than an error. Any write — like, unlike, playlist create or add — drops the cache,
  so the next read is the truth.
- **Lyrics** — the synchronized lines for the current track, highlighted against the shared clock.

### On a phone, and on a slow provider

The page is laid out in CSS alone (no JavaScript measures the viewport), so resizing a window or
rotating a phone never needs a reload: two columns at 1080px and wider, one column below that,
edge-to-edge cards and 44px tap targets under 520px, and a sticky status bar on phones that keeps the
current track (and its live meter) visible while the list scrolls — it carries no transport of its
own, and a tap brings the control hub back into view. The stylesheet is scoped to
`.music-app` and is built from the console's own design tokens — paper surfaces, sage accent, pill
controls, Georgia headings — so it reads as a NIX page in light and dark mode and renders the same way
in the NIX Home app.

Taps answer before the network does: the tapped row is marked pending immediately, controls flip as
they are pressed, already-fetched search and library answers are served from a short-lived cache with
no spinner, typing searches after a short pause, a superseded search is aborted rather than raced, and
rapid volume taps collapse into the one level the user settled on. After an action the page asks the
cheap snapshot endpoint a few times instead of waiting for the background poll, which itself runs
faster while something is playing and stops while another page or a hidden tab is in front.

Resolving a stream is the provider's job. It normally finishes in a fraction of a second, the speaker
has the audio about a second later, and on a track OpenDeck cannot serve it fails and says why. The
page counts a long wait out loud, and a refusal is shown as a stated failure with the track still
recorded, never as a row that stays pending or a silence.

This package is the music **provider** only: it holds no audio and controls no speaker. It is the player
skill (Echo Connect) that owns transport and the actual playback.

## How playback works

The worker is a **client of OpenDeck**, never a music service: it stores no library and no audio.

1. `play` searches the catalog through `POST /api/yt/proxy` (the service's own allowlisted proxy).
2. It resolves a **progressive** (`formats`) rendition through the same proxy's player endpoint —
   not the DASH audio one — and builds an absolute `GET /api/media/stream?url=…&videoId=…` URL
   **on your OpenDeck instance**. A DASH audio URL only answers for the opening of the file, so a
   device streaming it would stop after the first ~256 KiB; the progressive rendition is what makes a
   whole song playable. The result says which one it used.
3. That URL is returned as `play_url`. The device plays it by fetching it from OpenDeck,
   which streams the bytes. That fetch is unauthenticated, so the play is **not** added to the
   account's OpenDeck history — only browser/app plays inside the OpenDeck UI are. Report playback
   from the returned URL, never as a new history entry.

Catalog calls go through the proxy **without** the API key on purpose: OpenDeck attaches the
linked YouTube account's OAuth token to InnerTube calls made with a key, and the app-style
player clients reject that token. This mirrors exactly what OpenDeck's own browser client does —
the key is used for every account-scoped endpoint (library, likes, playlists, history).

Playlists and liked songs that belong to the **linked account** are read from
`GET /api/youtube/library`, and one of them is opened by browsing `VL<playlistId>` through that same
anonymous proxy. The API-key store (`PUT/DELETE /api/library/likes/…`, `POST /api/library/playlists…`)
stays the fallback used when no account is linked, and it is where `save like/unlike/playlist…` writes.

## The play queue

The queue belongs to this skill, not to the page. The worker keeps it in a small JSON state file
(`/root/data/opendeck-queue.json`, override with `NIX_OPENDECK_QUEUE_FILE`, rewritten atomically and
capped at 100 tracks) so the assistant can fill it with its own `opendeck_music` call and the Music
page reads and drives the same list through the console's declared provider action. Queueing is a
catalog read plus a stored entry: nothing is sent to OpenDeck, nothing is written to the account, and
the speaker is left alone until a queued track is actually played.

| `op` | What it does |
|---|---|
| `list` | The queued tracks and which one is playing (`queue_index`, `-1` when none). |
| `add` | `query` or `video_id` — resolves the track through the same catalog path `search`/`play` use and appends it. |
| `remove` | `index`, or a `query`/`video_id` naming the track to drop — “remove Believer from the queue” finds that entry rather than guessing a position, and says so when the track is not queued. The playing marker follows the removal. |
| `clear` | Empties the queue. |
| `play` | `index` — resolves that entry and returns its `play_url` so it can be handed to the speaker. |
| `next` | The entry after the playing one, resolved the same way; an exhausted queue carries no `play_url` and says so. With `auto` (a track that ended by itself) repeat-one restarts the current track, while a plain `next` is a skip and moves on. |
| `move` | `index` → `to` — reorder a track already in the queue (“move track 3 to position 1”). |
| `front` / `next_up` | `index`/`query`/`video_id` — put a track at the front of the queue or right after the playing one, inserting it when it was not queued yet (“play Believer first” / “play Believer next”). |
| `shuffle` | `on` (true/false; omitted toggles) — shuffles the tracks waiting behind the playing one, keeping every track and leaving the playing one where it is. Turning it off restores the queued order. |
| `repeat` | `mode` `off`/`all`/`one` (omitted cycles off → all → one) — what happens when a track ends: stop, wrap to the start of the queue, or repeat the track. |

`play` and `next` return the same track fields as the `play` action, so the caller hands the URL over
exactly as it does for a single play. Entries are stored as video id plus title/artist/album/duration/
artwork — never as a resolved URL — so a queue that outlives a restart is resolved again instead of
replaying a stale `play_url`, and a corrupt or hand-edited state file degrades to an empty queue rather
than an error. A track OpenDeck cannot serve is reported as a failure and stays in the list; the queue
never invents a track. Shuffle and repeat are listening preferences rather than contents: they are
saved with the queue, survive clearing it, and are reported by every queue reply (and by
`now_playing`) as `shuffle` and `repeat`, so a page or the app can paint its toggles from one answer.

## The lyrics action

`lyrics` fetches synchronized lyrics (LRC) from **LRCLIB** through the same OpenDeck proxy, using the
track's title, artist and duration; it retries the provider's search endpoint when the exact lookup
misses, keeps the closest duration match (within two seconds) and rejects mismatched songs rather than
showing the wrong lyrics. A track the provider does not have returns `lyrics_timing: "none"` with an
empty list — that is a normal answer, not an error. Plain-text-only matches return
`lyrics_timing: "plain"`. Nothing is written to OpenDeck or the account by this action.

## Operational contract

1. The selected NIX conversation model may propose one natural-language-matched `opendeck_music`
   call using the declared schema. Core checks the installed digest, explicit trust, configured
   state, and argument/result schema; only then may the worker execute it. The model never
   receives credentials and sends no raw network requests itself.
2. One action at a time. `play` reports the track OpenDeck actually resolved — never a guessed
   title, artist or duration. If OpenDeck returns no playable format, report that; do not retry in a loop.
3. `play_url` is short-lived (it points at a resolved media URL) and bound to the OpenDeck server's
   network location. Resolve again for a later request instead of replaying a stale URL.
4. The device status is what the OpenDeck response reports. A returned stream URL confirms
   OpenDeck is ready to serve the audio; it does not by itself confirm sound left the speaker.
   Do not claim physical playback without the device's own confirmation.
5. Writes (`save`) are the same calls the web UI makes, so they change the user's real library.
   Ask before destructive edits, and never guess a `playlist_id`.
6. Searching and playing are read-mostly and safe to repeat; a failed catalog call is reported,
   not worked around by inventing data.

## Trust and network security

Trust is explicit and separate from package installation. The dashboard warns that trusted skill
code runs in a subprocess **without an OS sandbox**, with NIX's user permissions; read the
repository and license before trusting. A changed package digest invalidates trust and requires
review again. Untrusting stops the worker.

The worker talks only to the configured OpenDeck origin over the user's own network, using the
stored API key. It does not contact YouTube, Google or any third party directly, and it keeps
no audio, library or database of its own. Use a dedicated OpenDeck API key and revoke it from
Settings → API if it is ever leaked. Do not expose the OpenDeck instance to the public internet
without TLS and its own access controls.

## Setup and testing

- Install the skill package from a public NIX skills repository (or upload the packaged ZIP
  during development); installation downloads only declared files.
- Set the OpenDeck address (e.g. `http://192.168.0.152:4100`) and API key under Skills → OpenDeck setup.
- Review and explicitly trust the package; NIX starts the worker and verifies it can authenticate
  (`GET /api/auth/whoami`) against the configured instance.
- The worker declares no Python dependencies, so NIX provisions a bare private `.venv` and runs it on the standard library alone.
- The Music page script and stylesheet are part of the installed package and are served to the console
  from it; they are reviewed with the rest of the source and covered by the same explicit digest trust as
  the worker.
- Unit tests use a fake OpenDeck server; live checks against a real instance are opt-in through
  `NIX_OPENDECK_SERVER_URL` and `NIX_OPENDECK_API_KEY` (see `tests/`).

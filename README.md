<p align="center">
  <a href="https://github.com/saineela/puca">
    <img src="https://res.cloudinary.com/dh5uxc6ql/image/upload/v1790917615/93d18a47-5f3a-46e1-ad71-705b2680442f_anp8f1.png" alt="NIX PUCA" width="360">
  </a>
</p>

<h1 align="center">OpenDeck — NIX&nbsp;PUCA skill</h1>

<p align="center">
  Play the music in <b>your own</b>
  <a href="https://github.com/saineela/opendeck">OpenDeck</a> server from your NIX&nbsp;PUCA
  assistant — search, playlists, likes, history, lyrics, and a play queue.
</p>

<p align="center">
  <a href="https://github.com/saineela/puca">
    <img alt="Requires NIX PUCA" src="https://img.shields.io/badge/requires-NIX%20PUCA-2f6f4e?style=for-the-badge">
  </a>
  <a href="https://github.com/saineela/puca/stargazers">
    <img alt="Star NIX PUCA on GitHub" src="https://img.shields.io/github/stars/saineela/puca?style=for-the-badge&label=%E2%98%86%20star">
  </a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge">
</p>

---

> [!IMPORTANT]
> **This package does nothing on its own.** OpenDeck is a skill that runs **inside
> [NIX PUCA](https://github.com/saineela/puca)** — a self-hosted personal companion that turns a
> small always-on machine into a voice-and-device assistant. NIX owns the conversation, the skill
> marketplace, the explicit trust step and the worker runtime; this repository only ships the skill.
>
> ### 👉 [Explore NIX PUCA](https://github.com/saineela/puca) · [☆ Star it on GitHub](https://github.com/saineela/puca/stargazers)
>
> If this skill is useful to you, a ⭐ on the NIX PUCA repository helps other people find the
> project. Thank you!

---

OpenDeck stays the music service; this package is a thin, bounded client of its HTTP API. You
configure the server address and an `odk_…` API key, and NIX can search the catalog, browse
playlists, likes and history, resolve the requested track to a stream URL **on your OpenDeck
instance**, and play it on the device.

```
user request → NIX skill planner → opendeck_music (this worker)
                                        │  POST /api/yt/proxy      (catalog: search, player)
                                        │  GET  /api/library|history|likes
                                        │  POST /api/media/stream  ← returned as play_url
                                        ▼
                            your OpenDeck instance  →  audio bytes  →  the device
```

## Requirements

- **[NIX PUCA](https://github.com/saineela/puca)** with the Skills marketplace. *(Required — the
  skill runs in NIX's worker runtime.)*
- A reachable **OpenDeck** instance (v1.0.0 API) with the YouTube Music account that owns your
  library linked.
- Python 3.11+ on the NIX host (the worker is standard-library only).

## Install

**From the NIX Skills page (recommended)**

1. Skills → *Add repository* → `https://github.com/saineela/opendeck-skill`
2. Install **OpenDeck**, enter your server address and API key, then trust the package digest.

**From the packaged ZIP (development)**

```bash
python3 scripts/package_skill.py --validate      # build dist/opendeck-<version>.zip
python3 scripts/upload_skill.py --force-replace  # build + upload to a local NIX console
```

## Configuration

| Field | Example | Notes |
|---|---|---|
| `server_url` | `http://192.168.0.152:4100` | Include the port when it is not 80/443 |
| `api_key` | `odk_…` | Create one in OpenDeck under Settings → API |

NIX's masked `secret` setup type only accepts 32-byte base64 device keys (such as the Echo Dot's
ESPHome PSK), so the OpenDeck key is stored as a normal setup value in the skill's private `0600`
configuration file. Keep dashboard access itself access-controlled.

## What you can ask

- “Play Bohemian Rhapsody.” / “Put on some lo-fi jazz.”
- “Search OpenDeck for Miles Davis.” *(a search, not a play)*
- “What's playing?” / “What song is playing?” *(reads the current track)*
- “What's in my OpenDeck library?” / “What have I been listening to?”
- “Like this song.” / “Make a playlist called Focus.”
- “Queue Bohemian Rhapsody.” / “What's in my queue?”
- “Play Bohemian Rhapsody next.” / “Move track 3 to position 1.” *(reorder the queue)*
- “Play the next queued track.” *(advance; the queue keeps playing automatically)*
- “Shuffle the queue.” / “Repeat this song.” *(queue ops `shuffle` and `repeat`)*
- “Show me the lyrics.”

When a request fits several songs equally well (“play that song from the film”), the skill answers with
the candidates instead of playing the first search hit: the assistant says so, and the **PUCA Panel**
puts them on screen to pick from.

## The Music page

Installing the skill adds a **Music** page to the NIX console (and the same screen to the NIX Home
app): now-playing with artwork and progress, **one circular control hub** — the Echo Connect speaker
panel's volume wheel with the transport either side of it (a single play/pause, a round Mute, and a
stepper; no second pause and no Stop) — the play queue with Shuffle and Repeat, OpenDeck search,
library and history browsing with **playlist covers**, a Like button and Add to playlist for the
playing track, and synchronized lyrics. Reads are cached (in the page and on the worker's disk), so
the page opens on the playlists, covers and likes it already had and then refreshes them. The console
owns the page route and layout shell; this package ships the page itself (`ui/music.js`,
`ui/music.css`) and acts as the music provider, while the skill that owns the speaker (Echo Connect)
performs transport. The API is documented in `nix_core/MUSIC_API.md` and served at `/api/music`
plus `/api/mobile/v1/music…`.

## The PUCA Panel

The package also ships **`PUCA-Panel/`**: the wall display for whatever NIX is playing, for a screen
mounted somewhere everyone can see it. The console serves that folder on its own fixed port,
**`49170`** by default (`NIX_PANEL_PORT`), so you point the display at
`http://<hub>:49170/` once and leave it there. Nothing has to be installed twice — the panel's files
ship in this package and update with it, while the API underneath is the console's own music API.

It is designed to be read from across a room and spoken to:

- one large now-playing card (cover, title, artist, progress), the transport and a large volume
  control, the library as large tiles, and the queue under the player;
- the **lyrics of whatever is playing**, which open by themselves and stay open until you close them
  (the next track opens them again — no matter whether the track was started by you or by Nix);
- **speech**: the mic button uses the browser's own recognition, so you can say “play Bohemian
  Rhapsody”, “pause”, “next”, “volume up” or “shuffle”, or just say what you are looking for and pick
  from the results. A browser without speech recognition says so and offers the search box instead;
- **dark mode from 10PM and light from 6AM**, following the console's timezone rather than the
  screen's clock;
- when Nix cannot tell which song was meant, the whole screen becomes the question: every candidate
  is shown large, and tapping one plays it.

## Repository layout

```
nix-skills.json                      catalog entry for the NIX marketplace
skills/opendeck/skill.json           manifest: setup fields, one opendeck_music tool, schemas
skills/opendeck/opendeck_worker.py   the JSONL worker (Python stdlib only)
skills/opendeck/SKILL.md             operational contract for the assistant
skills/opendeck/ui/                  the Music page script and stylesheet
skills/opendeck/PUCA-Panel/          the wall display: panel.html, panel.css, panel.js
tests/                               unit tests (fake OpenDeck) + NIX-core contract tests
scripts/                             package / upload / live-check helpers
```

## What the worker calls

| Action | OpenDeck endpoint |
|---|---|
| search | `POST /api/yt/proxy` (InnerTube search through the service) |
| play | `POST /api/yt/proxy` (player) → `GET /api/media/stream?url=…` |
| now_playing | the worker's own hand-off + queue state (no OpenDeck write) |
| library: playlists | `GET /api/youtube/library` (linked account) + `GET /api/library/playlists` |
| library: likes / history / stats | `GET /api/youtube/library`, `GET /api/history[/stats]` |
| save: like / unlike | `PUT` / `DELETE /api/library/likes/<videoId>` |
| save: playlist_create / playlist_add | `POST /api/library/playlists[/<id>/tracks]` |
| lyrics | `POST /api/yt/proxy` → LRCLIB `api/get` then `api/search` |
| queue: add / play / next / move / front / next_up | the same catalog search + player proxy |
| queue: list / remove / clear / shuffle / repeat | none — the queue lives in the worker's state file |

`play` returns `play_url`: an absolute `…/api/media/stream?…` URL on **your** OpenDeck instance. The
device plays the track by fetching that URL. That fetch carries no credentials, so it is not added to
your OpenDeck play history (which only browser/app plays populate) — the resolve call is what uses
your API key.

## The play queue

The queue belongs to this skill, not to the page. The worker keeps it in a small JSON state file
(`/root/data/opendeck-queue.json`, override with `NIX_OPENDECK_QUEUE_FILE`) so the assistant can fill
it and the Music page reads and drives the same list.

| `op` | What it does |
|---|---|
| `list` | The queued tracks and which one is playing. |
| `add` | `query` or `video_id` — resolves the track and appends it. |
| `remove` | `index` — drops one entry; the playing marker follows it. |
| `clear` | Empties the queue. |
| `play` | `index` — resolves that entry and returns its `play_url`. |
| `next` | The entry after the playing one. |
| `move` | `index` → `to` — reorder a queued track. |
| `front` | `index`/`query`/`video_id` — move a track to the front (insert it if it is not queued). |
| `next_up` | `index`/`query`/`video_id` — put a track right after the one playing. |
| `shuffle` | `on` true/false (omitted toggles) — shuffle the tracks waiting behind the playing one; turning it off restores the queued order. |
| `repeat` | `mode` `off`/`all`/`one` (omitted cycles) — stop at the end, wrap the whole queue, or repeat the one track. |
| `remove` | `index`, or a `query`/`video_id` naming the entry to drop (“remove Believer from the queue”). |

Said out loud, the queue phrasings map onto those ops: “queue Believer” and “add the song Believer to
my queue” are `add`; “play Believer next” is `next_up` and “play Believer first” is `front`; “play the
next queued track” is `next`; “what's in my queue” is `list`; “remove Believer from the queue” is
`remove`; “clear the queue” is `clear`. Saving is spoken the same way: “like this song” and “add this
to my Liked Music” are `save kind like`; “add this to my Late Night playlist” is `save kind
playlist_add` with `name` — the playlist is found by name (case-insensitively) or created for you,
and “this song” is the track that is playing, so no id is needed. A phrase that names a *different*
track (“add Bohemian Rhapsody to Focus”) is a search first and a save second, which is the
assistant's job, not a guess this skill makes.

Each playlist in `library kind playlists` carries its `artwork_url` — the thumbnail the linked library
resolves, or the artwork a stored playlist was saved with, and the first liked song's cover for Liked
Music when its own is missing. The page draws its own tinted monogram tile for a playlist that has no
cover at all.

Library reads are cached on disk for ten minutes (`/root/data/opendeck-cache.json`) and dropped by
any write, so a repeat read is instant (measured about 5.7s → 0.0s against a real linked account), and a read
whose copy has expired is refreshed — serving the older copy only when OpenDeck cannot be reached.

Entries are stored as video id plus title/artist/album/duration/artwork — never as a resolved URL —
so a queue that outlives a restart is resolved again instead of replaying a stale `play_url`. A
track OpenDeck cannot serve is reported as a failure and stays in the list; the queue never invents
a track. When a queued track finishes, the console's now-playing poll advances to the next one
automatically — under repeat-one it restarts the track, and under a skip it moves on.

Shuffle and repeat are listening preferences, not queue contents: they are saved with the queue,
survive clearing it, and come back on every queue reply (and on `now_playing`) as `shuffle` and
`repeat`, so the page and the NIX Home app paint their toggles from one answer.

## Tests

```bash
python3 -m unittest discover -s tests -v
```

- `tests/test_opendeck_worker.py` — a fake OpenDeck instance, the full JSONL protocol
  (`initialize`/`match`/`execute`), argument bounds, queue reordering, now-playing, and an actual
  audio fetch from the `play_url` the worker returns.
- `tests/test_puca_contract.py` — runs the real NIX core's manifest, ZIP and JSON-schema validators
  over this package (skipped when a core checkout is absent; set `NIX_CORE_PATH`).

Live checks (read from the environment, never printed):

```bash
NIX_OPENDECK_SERVER_URL=http://192.168.0.152:4100 NIX_OPENDECK_API_KEY=odk_… \
  python3 scripts/live_check.py "bohemian rhapsody"     # direct worker, read-only
NIX_OPENDECK_SERVER_URL=… NIX_OPENDECK_API_KEY=… \
  python3 scripts/instance_check.py "bohemian rhapsody" # installed skill through NIX's runtime
```

## Notes and limits

- Catalog calls go through OpenDeck's proxy **without** the API key on purpose: OpenDeck attaches the
  linked YouTube account's OAuth token to InnerTube requests, and the app-style player clients reject
  that token. Account-scoped endpoints always use the key.
- `play_url` is short-lived (it embeds a resolved media URL), so resolve again for a later request
  instead of replaying a stale URL.
- ZIP uploads reserve their skill id in the local marketplace; `upload_skill.py --force-replace`
  clears that reservation (with a state-file backup) so the same id can be re-uploaded.
- The worker plays nothing itself. It returns the URL the device plays; sound leaving the speaker is
  confirmed by the device, not by this skill.

## Licence

MIT — see [LICENSE](skills/opendeck/LICENSE).

---

<p align="center">
  Built for <a href="https://github.com/saineela/puca"><b>NIX PUCA</b></a> —
  <a href="https://github.com/saineela/puca/stargazers">☆ star the project</a> if you build with it.
</p>

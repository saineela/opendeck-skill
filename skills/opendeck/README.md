# OpenDeck — NIX PUCA skill

Play the music in your own self-hosted **[OpenDeck](https://github.com/saineela/opendeck)**
music server from NIX.

OpenDeck is the music service. This skill is only a client: it calls OpenDeck's HTTP API with the
server address and API key you configure, so your library, playlists, likes and play history stay
in OpenDeck — the skill keeps no music store and no database of its own.

## Setup

1. In OpenDeck, open **Settings → API** and create an API key (`odk_…`).
2. In NIX, open the **Skills** page, add the OpenDeck repository (or upload the packaged ZIP) and install it.
3. Fill in the two setup fields:
   - **Server address** — e.g. `http://192.168.0.152:4100` (include the port).
   - **API key** — the `odk_…` key from step 1.
4. Review and **trust** the package. NIX then starts the worker and checks it can authenticate
   against your instance.

Both values live in the skill's private configuration file (`~/.config`-style path, mode `0600`) and are
passed only to the worker. NIX's masked `secret` field only accepts 32-byte base64 device keys, so the
OpenDeck key is stored as a normal setup value — it is visible in the Skills setup form, so keep the
dashboard itself access-controlled.

## What you can ask

- “Play Bohemian Rhapsody.”
- “Put on my Late Night playlist.”
- “What's in my OpenDeck library?”
- “What have I been listening to?” / “What do I play the most?”
- “Search OpenDeck for Miles Davis.”
- “Like this song.” / “Add this to my Liked Music.” / “Make a playlist called Focus.”
- “Add this to my Late Night playlist.” *(found by name, or created for you)*
- “Queue Bohemian Rhapsody.” / “What's in my queue?” / “Play the next one.”
- “Add the song Believer to my queue.” / “Play Believer next.” / “Remove Believer from the queue.”
- “Show me the lyrics.”

## The Music page

Installing the skill adds a **Music** page to the NIX console (and the same screen to the NIX Home app):
now-playing with artwork and progress, **one circular control hub** — the Echo Connect speaker panel's
volume wheel with the transport either side of it (one play/pause, one round Mute, a stepper; no second
pause and no Stop) — and, **directly under the player**, the play queue with **Shuffle**, **Repeat** and
**drag-to-reorder** (grab a row by its grip and drop it where it belongs; one `move` call reaches the
provider), OpenDeck search, library and history
browsing with **playlist covers**, a **Like** button and **Add to playlist** for the playing track, and
synchronized lyrics. Playlists are the linked account's, each with its cover, with its **Liked
Music** auto playlist (`playlist_id` `LM`) offered first, exactly as OpenDeck's own client lists it. The console owns the page route and layout shell; this
package ships the page itself (`ui/music.js`, `ui/music.css`) and acts as the music provider, while the
skill that owns the speaker (Echo Connect) performs transport. The API is documented in
`nix_core/MUSIC_API.md` and served at `/api/music` plus `/api/mobile/v1/music…`.

Library reads are cached twice over — the worker keeps each one on disk for ten minutes, and the page
keeps its own copy (with the covers) in local storage — so the page opens on the playlists, liked songs
and their artwork it already had and then refreshes them from the provider. Any write to the account
drops the worker's cache.

The page adapts in CSS alone — two columns on a desktop, one column and a sticky status bar with 44px
tap targets on a phone — and answers a tap before the network does: the row is marked pending at once,
results already fetched come from a short-lived cache, typing searches after a short pause, a
superseded search is aborted, and rapid volume taps collapse into one request. Resolving a stream is
still the provider's job: the page counts that wait out loud and reports a refused stream as a failure
instead of leaving the row pending.

## What the worker calls

| Action | OpenDeck endpoint |
|---|---|
| search | `POST /api/yt/proxy` (InnerTube search through the service) |
| play | `POST /api/yt/proxy` (player) → `GET /api/media/stream?url=…` |
| library: playlists | `GET /api/youtube/library` (linked account) + `GET /api/library/playlists` (this instance's own store) |
| library: playlist | `GET /api/library/playlists/<id>`, or `POST /api/yt/proxy` (InnerTube browse) for a playlist of the linked account |
| library: likes | `GET /api/youtube/library` (linked account), else `GET /api/library/likes` |
| library: Liked Music (`playlist_id` `LM`) | the same liked songs: liked songs are a playlist in YouTube Music too, so the page lists them beside your playlists |
| library: history / stats / frequent | `GET /api/history`, `GET /api/history/stats` — `frequent` ranks the log's last 200 plays by how many times each song was played and returns that count on each track |
| save: like / unlike | `PUT` / `DELETE /api/library/likes/<videoId>` |
| save: playlist_create / playlist_add | `POST /api/library/playlists[/<id>/tracks]` |
| lyrics | `POST /api/yt/proxy` → LRCLIB `api/get` then `api/search` |
| queue: add / play / next | `POST /api/yt/proxy` (the same catalog search and player proxy) — the queue itself is the worker's own state, never an OpenDeck write |
| queue: list / remove / clear / shuffle / repeat / move / front / next_up | none — the queue lives in the worker's state file (`/root/data/opendeck-queue.json`), and shuffle/repeat are saved with it |

`play` returns `play_url`: an absolute `…/api/media/stream?…` URL on **your** OpenDeck instance.
The device plays the track by fetching that URL. The fetch carries no credentials, so it is not added
to your OpenDeck play history (which only browser/app plays populate) — the resolve call is what
uses your API key.

## Requirements

- NIX PUCA with the Skills marketplace.
- A reachable OpenDeck instance (v1.0.0 API) with the YouTube Music account that owns the library linked.
- Python 3.11+ (standard library only — no third-party packages).

## Licence

MIT — see [LICENSE](LICENSE).

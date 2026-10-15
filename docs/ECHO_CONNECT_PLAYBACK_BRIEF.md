# Brief — add URL playback to the Echo Connect service (ring-light)

**You are the agent working on the service behind Echo Connect:** repo
`https://github.com/saineela/ring-light` (branch `main`, tip `5f157c2` when this was written) — the
bridge service `ring_bridge.py`, plus `ring_client.py`, `PROTOCOL.md`, `SKILL.md`, `README.md` and the
`*_probe.py` hardware tools that ship with it.

The NIX skill published as **Echo Connect** is built *on* that service: its worker
(`nix_core/ring_light_package/skills/echo-connect/ring_light_worker.py`) is a fresh ESPHome-native port
of the same command set, and its own docstring says real speech work "belongs to the separate
**ring-bridge** deployment". The service is the source of truth for what the Dot can be told to do;
the skill mirrors it. **So this change lands in the service first** — §7 covers the mirror step and who
owns it. Do not edit the NIX skill package under `nix_core/ring_light_package/`: that clone lives inside
the PUCA checkout and is not yours.

## 1. Why

The **OpenDeck** skill (`saineela/opendeck-skill`, tool `opendeck_music`) plays music from a user's
self-hosted [OpenDeck](https://github.com/saineela/opendeck) server. Its `play` action returns:

```json
{
  "ok": true, "action": "play", "video_id": "BSTsnWoslP4",
  "title": "Bohemian Rhapsody", "artist": "Queen", "duration_sec": 354,
  "mime_type": "audio/mp4",
  "play_url": "http://192.168.0.152:4100/api/media/stream?url=https%3A%2F%2F…&videoId=BSTsnWoslP4&title=…",
  "message": "OpenDeck is serving “Bohemian Rhapsody” by Queen at 192.168.0.152:4100 …"
}
```

That `play_url` is an HTTP audio resource **served by the OpenDeck instance on the same LAN** — verified
from a second machine: `HTTP 206`, `Content-Type: audio/mp4`, `Accept-Ranges: bytes`, `Access-Control-Allow-Origin: *`,
no auth, ~300 req/min. It is the exact thing the Dot's speaker needs to consume.

Nothing can play it today, on either side:

- The **service** knows the media player only as a volume/mute/STOP target: `media_command()` sends
  `volume=`, and `stop_speaking` sends `MediaPlayerCommand.STOP`. Its one URL path, `say`/`say_from_url`,
  is the **assist announcement** channel (`send_voice_assistant_announcement_await_response`, WAV only,
  one-shot, ducks other audio, displaces the wake-word turn). That is speech, not music.
- The **skill** mirrors exactly those commands (`volume`, `mute`, `unmute`, `say`, `stop_speaking`) and
  has no URL-playback action either.

## 2. Definition of done

All three must work against the real Dot, and the audio must be **audible from the speaker**:

1. **Capabilities are visible** — `GET http://<bridge-host>:8766/status` reports the speaker's own
   media capabilities (the device's `supported_formats`), so a caller can pick a playable format:

   ```json
   "speaker": {"volume": 0.5333, "muted": false, "state": "idle"},
   "media": {"supported_formats": [{"format": "mp3", "sample_rate": 44100, "num_channels": 2,
              "purpose": "default", "sample_bytes": 2}],
             "supports_pause": true, "playing_url": null}
   ```

2. **The WebSocket command plays a URL:**

   ```json
   → {"cmd":"play_url","url":"http://192.168.0.152:4100/api/media/stream?url=…&videoId=BSTsnWoslP4","title":"Bohemian Rhapsody","id":"m1"}
   ← {"type":"ok","cmd":"play_url","playing":{"url":"http://192.168.0.152:4100/api/media/stream?…",
      "title":"Bohemian Rhapsody","state":"playing","state_confirmed":true}}
   ```

   Queen comes out of the Dot. `pause` / `resume` / `stop_speaking` then act on that playback, and the
   existing unsolicited `{"type":"speaker","speaker":{…,"state":"playing|paused|idle"}}` push carries the
   transitions.

3. **The Python client exposes it** — `ring.play_url(url, title=None)`, `ring.pause()`, `ring.resume()`,
   and `ring.stop_speaking()` documented as "stops speech *and* music" in `SKILL.md`.

## 3. Exact changes (`saineela/ring-light`)

### 3.1 `ring_bridge.py` — capture what the media player can do

In `_connect()`, the discovery loop already does
`if isinstance(e, MediaPlayerInfo) and obj == MP_OBJ: mp_key = e.key`. Capture the capability fields
right there (the sibling tool `volume_probe.py` already reads them, so the device does advertise them):

```python
mp_formats: list[dict] = []
mp_supports_pause = False
…
if isinstance(e, MediaPlayerInfo) and obj == MP_OBJ:
    mp_key = e.key
    mp_formats = [
        {"format": f.format, "sample_rate": f.sample_rate, "num_channels": f.num_channels,
         "purpose": getattr(f.purpose, "name", str(f.purpose)).lower(), "sample_bytes": f.sample_bytes}
        for f in (e.supported_formats or [])
    ]
    mp_supports_pause = bool(getattr(e, "supports_pause", False))
    continue
```

Store both on the bridge (`self.mp_formats`, `self.mp_supports_pause`, reset to defaults in the
disconnect path like `self.mp_state`), and add them to `status()` and to the `catalog` message next to
`speaker`. Log the observed list at connect so it lands in `%LOCALAPPDATA%\ring_bridge.log`.

`MediaPlayerInfo.supported_formats` is a list of `MediaPlayerSupportedFormat(format, sample_rate,
num_channels, purpose, sample_bytes)`; `purpose` is `default` / `announcement` (`media` on newer
firmware). **Music uses `default`/`media` entries** — an `announcement`-only entry means the format is
usable for `say` but not for streaming playback. This list is the answer to "what can the Dot decode",
and it is required evidence in §4.

### 3.2 `ring_bridge.py` — `play_url` / `pause` / `resume`

`media_command()` currently passes only `command` and `volume`. Extend it to pass the URL through
(aioesphomeapi 46.x signature, verified against the installed client):

```python
async def media_command(self, command=None, volume=None, media_url=None, announcement=None):
    if not self.connected.is_set() or self.cli is None or self.mp_key is None:
        raise RuntimeError("device offline (no media player)")
    async with self.api_lock:
        self.cli.media_player_command(self.mp_key, command=command, volume=volume,
                                      media_url=media_url, announcement=announcement)
```

Then add the handlers next to `stop_speaking` (same guards, same one-reply-per-command contract):

```python
if cmd == "play_url":
    url = str(payload.get("url") or "").strip()
    title = " ".join(str(payload.get("title") or "").split())[:200]
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("url must be an http(s) URL")
    if not self.mp_formats:
        log.warning("device reported no supported_formats; attempting playback anyway")
    playable_url = await self.ensure_playable(url)      # §3.3
    self.playing_url, self.playing_title = playable_url, title
    await self.media_command(command=aioesphomeapi.MediaPlayerCommand.PLAY, media_url=playable_url)
    confirmed = await self._wait_for_speaker(
        lambda s: s.get("state") in ("playing", "announcing"), 5.0)   # bounded, optional
    reply = {"type": "ok", "cmd": "play_url",
             "playing": {"url": playable_url, "title": title,
                         "state": (self.mp_state or {}).get("state"),
                         "state_confirmed": confirmed}}
```

(`_wait_for_speaker(pred, timeout)` is new — the bridge has no shared waiter today; the client's
`_await_speaker(pred)` in `ring_client.py` is the existing bounded-best-effort pattern to mirror.)

- `pause` → `MediaPlayerCommand.PAUSE`, `resume` → `PLAY` with `media_url=None`, `stop_speaking` stays
  `STOP` and its doc/reply text should say it stops speech and music.
- **Never use `announcement=True`, and never route music through `say`/`say_from_url`.** The assist
  announcement path is one-shot, WAV-only, ducked audio, and it displaces the wake-word turn — that is
  precisely why the OpenDeck stream must go through `media_player_command(media_url=…)`.
- Match the bridge's existing reply convention: `volume`/`mute`/`color`/`effect` all send the ESPHome
  call and reply `ok` immediately, with confirmation arriving later as an unsolicited state push. Do the
  same, but include the last pushed speaker state in the reply. URL playback may not push a `playing`
  transition on every firmware (some report `idle` throughout) — so **report what the device actually
  reported**, set `state_confirmed=false` when nothing was observed, and never claim audible playback
  from the command result alone.
- Clear `playing_url` when the state returns to `idle`/`off`, and include it in `status()`.

### 3.3 Serving or converting the stream

Two cases, decided by `mp_formats` and the upstream response:

- **Passthrough** — if the upstream `Content-Type` maps to a supported `default`/`media` format
  (e.g. `audio/mpeg` → `mp3`), hand the device the upstream URL unchanged.
- **Bridge-served** — otherwise the bridge must hand the Dot something it can decode. Add an HTTP route
  beside the existing `/tts/<sha256[:32]>.wav` handler in `_start_http`:

  `GET /media/<sha256[:32]>.<ext>` → fetch the upstream URL and stream it to the Dot with
  `Content-Type` matching `ext` and **HTTP Range support** (`206` + `Accept-Ranges: bytes`, honouring
  `Range:` on re-requests so the device can seek/reconnect). When the device's decodable formats are
  narrower than the upstream (the OpenDeck stream is `audio/mp4`/AAC), transcode with ffmpeg, matching
  an advertised entry — e.g. MP3, or raw PCM in a WAV container:

  ```bash
  ffmpeg -loglevel error -i <upstream> -f mp3 -                                  # if mp3 is supported
  ffmpeg -loglevel error -i <upstream> -f wav -ac <num_channels> -ar <sample_rate> -acodec pcm_s16le -
  ```

  Stream it (do not buffer a whole song), cache by URL hash only if you also add an eviction policy, and
  document the ffmpeg dependency next to the existing piper requirement. If ffmpeg is not available the
  command must fail with a clear error, not silently play nothing.

Note the Dot must be able to **reach** the URL it is given. `/tts/` already relies on this (the bridge
advertises its LAN IP when bound to `0.0.0.0`); reuse that host-selection logic for bridge-served media,
and if the Dot cannot fetch the URL, say so in the error rather than reporting success.

### 3.4 `ring_client.py`, `PROTOCOL.md`, `SKILL.md`, `README.md`

- `ring_client.py`: add `play_url(url, title=None)`, `pause()`, `resume()` following the existing
  request/reply helpers; make `stop_speaking()`'s docstring cover music. Mention playback in the module
  docstring's example block.
- `PROTOCOL.md`: add the command rows (`play_url`, `pause`, `resume`, and STOP's new meaning), the
  `{"type":"ok","cmd":"play_url","playing":{…}}` reply shape, the `media.supported_formats` field in the
  catalog/status, and the semantics section: formats the device decodes, URL reachability, that an
  announcement is not music, and that the `speaker` push reports the transitions. Bump `protocol`.
- `SKILL.md`: document it for AI agents — how to discover playable formats, the `play_url` payload, and
  that playback is confirmed only by the reported state. Same for `README.md`'s "From Python" block.
- Bump whatever version/changelog convention the repo uses and note the ffmpeg dependency if §3.3 needs it.

## 4. Tests and evidence you must return

1. `play_probe.py` (sibling of `volume_probe.py`, same style): connect, print
   `media_player 'speaker' supported_formats=… supports_pause=…`, serve a known-good file from the
   bridge's own HTTP port, send PLAY with that URL, and log every `speaker` state transition with
   timestamps until `idle`. Its output is the primary evidence.
2. Live OpenDeck playback: from a machine on the same LAN as the Dot, hit the OpenDeck skill's URL and
   then `play_url` with it. Report what you heard, from which URL, and the state sequence.
3. Rejection cases: `ftp://`, `file://`, `javascript:`, missing `url`, and an unreachable URL each get a
   `{"type":"error",…}` reply within the timeout, and leave `playing_url` null. `stop_speaking` during
   playback stops it.
4. Regression: `python volume_probe.py` and `python ws_test.py` still pass (the media player restructuring
   must not break volume/mute/STOP or the ring commands).
5. The pushed commit SHA on `saineela/ring-light`, and the **final command/reply JSON plus the client
   method signature** — §7 mirrors them verbatim, so freeze the names: `play_url` with `url` + `title`.

## 5. If the device firmware must change instead

`media_player_command(media_url=…)` is the standard ESPHome media-player path, but if the probe shows
the Dot's media player rejects it (some TECHO5/echolocal builds only implement the announcement side),
the capability has to be added in the **device-side service** (the `echod`/echolocal ESPHome media
player implementation). In that case the daemon must: accept `MediaPlayerCommandRequest` with
`media_url` + `command=PLAY`/`PAUSE`/`STOP`, fetch and decode the formats it advertises via
`MediaPlayerInfo.supported_formats` (including `purpose`), report `MediaPlayerEntityState`
`PLAYING`/`PAUSED`/`IDLE` back, and support `supports_pause`. Report that finding with the firmware
version and the failing call; do not paper over it by announcing a long WAV — announcements are
one-shot and duck the room.

## 6. What NIX does after that

Once the service exposes and documents this, the NIX **Echo Connect** skill gets the matching action,
and the chain works end to end:

1. `opendeck_music` → `play_url` + `mime_type` + `title`.
2. Echo Connect `control_ring` with `{"action":"play_url","url":…,"title":…}` → the Dot plays it.

No OpenDeck change is needed **unless** the device cannot decode the stream in §3.3 — if so, tell us the
mime/format you settled on and OpenDeck gets pointed at it. Two caveats to state in your report: the
device's fetch of the stream is unauthenticated, so such a play is **not** attributed to the OpenDeck
account's play history; and a changed service/skill digest means NIX users must repair/reinstall and
re-trust.

Raw GitHub content is CDN-cached for minutes after a push, so verify by commit SHA rather than trusting
the branch URL immediately.

## 7. The NIX-side mirror (only if your remit includes it)

If you also own the NIX skill package, mirror the same wire shape there: `control_ring` gains
`play_url` (`url` ≤2048 chars, http/https only; optional report-only `title` ≤200) sending
`media_player_command(media_key, media_url=…, command=PLAY)`, plus `pause`/`resume`, `supported_formats`
in the state/catalog result, the manifest `oneOf` branch and declared device control, and the unit +
JSONL tests in `nix_core/test_ring_light_worker.py`. Otherwise leave it to the NIX side and only deliver
the service change, the frozen command shape, and the evidence above.

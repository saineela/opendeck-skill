#!/usr/bin/env python3
"""NIX OpenDeck worker: a bounded client of the user's OpenDeck music service.

This worker never becomes a music service. It holds no library, no database
and no audio: every read, write, search and stream URL comes from the OpenDeck
instance the user configured (server address + ``odk_…`` API key). Playback is
resolved through OpenDeck's own endpoints, so the device only ever fetches a
URL that OpenDeck serves.

Request flow through OpenDeck:

  search     POST /api/yt/proxy   (InnerTube search, anonymous — see below)
  play       POST /api/yt/proxy   (InnerTube player) -> progressive format
  stream     GET  /api/media/stream?url=…  (the device fetches this itself;
             unauthenticated, so it is not attributed to the account)
  library    GET  /api/youtube/library  (the linked account: playlists and likes)
             GET  /api/library/playlists, GET /api/history[/stats]
  playlist   POST /api/yt/proxy  (InnerTube browse of a VL<playlistId>)
  likes      PUT/DELETE /api/library/likes/<videoId>
  playlists  POST /api/library/playlists[/<id>/tracks]

Why the catalog calls are anonymous: OpenDeck's proxy attaches the linked
YouTube account's OAuth token to ``/youtubei/`` requests unless the InnerTube
client is one of the WEB-family clients its own browser client uses. YouTube
answers 400 to an OAuth-authenticated ANDROID/IOS player call, so the worker
calls the proxy the same way OpenDeck's browser client does — without the key —
and uses the configured API key for the account-scoped endpoints. Both paths
are documented OpenDeck endpoints; nothing here talks to YouTube directly.

The worker speaks the NIX JSONL contract on stdin/stdout; diagnostics go to
stderr. Only calls returned by its fixed ``opendeck_music`` tool can reach the
service.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

PROTOCOL = "nix-skill-jsonl-v1"

MAX_QUERY_CHARS = 200
MAX_RESULTS = 12
# What a *page* may ask for in one read. The assistant is answered with a page
# (MAX_RESULTS); a wall display listing a playlist is not, because a playlist is
# not twelve songs long — and the console's own read caps what it hands over.
# How many songs one library read may hand over. A real library is bigger than a
# page of results — a Liked Music playlist can hold hundreds — and the page and
# the wall both list what they are given, so the ceiling is a memory bound on one
# reply, not a page size. (The skill manifest declares the same ceiling in the
# result schema; the two must agree or the reply is rejected as too large.)
MAX_LIBRARY_RESULTS = 500
MAX_PLAY_OPTIONS = 4
# How sure a play request has to be before it plays without asking. A title the
# request names outright scores 1.0 and a containment scores 0.8; a mere word
# overlap is capped at 0.7, so "play the one from that film" reaches the user as
# a question rather than as whichever search hit happened to come first.
CONFIDENT_MATCH_SCORE = 0.8
CONFIDENT_MATCH_MARGIN = 0.15
# Below the confident bar, any second *different* title that plausibly fits the
# request at all makes it unclear: a word overlap of one word in three scores
# 0.23, and "play the song about rain" is exactly the request that should be
# checked with the user rather than answered with the top search hit.
AMBIGUOUS_MIN_SCORE = 0.2

# The play queue is the worker's own small state: the tracks a user or the
# assistant lined up, in order, plus which one is current. It is persisted next
# to the other NIX data so restarting the worker does not lose the line-up. The
# worker owns it because the assistant reaches the queue through this skill; the
# console reads and drives it through the declared provider action.
QUEUE_FILE = os.environ.get("NIX_OPENDECK_QUEUE_FILE", "/root/data/opendeck-queue.json")
MAX_QUEUE = 100
# When the independent queue service is running, the queue belongs to it, and
# this worker forwards every queue request there: one queue, whether the request
# came from the console's page or from the assistant's own tool. Setting
# NIX_MUSIC_QUEUE_URL is what turns that on; with it unset the queue stays here,
# exactly as it has always been.
QUEUE_SERVICE_URL = os.environ.get("NIX_MUSIC_QUEUE_URL", "").strip()
QUEUE_SERVICE_TIMEOUT = float(os.environ.get("NIX_MUSIC_QUEUE_TIMEOUT", "20"))
# Where the queue service publishes its own address. NIX starts a skill worker
# with almost no environment on purpose, so this file — not an inherited
# variable — is how a worker finds the queue running beside it.
QUEUE_SERVICE_FILE = os.environ.get("NIX_MUSIC_QUEUE_FILE", "/root/data/music-queue.json")


def _queue_service_address() -> tuple[str, str]:
    """The queue service's address and token: as configured, or as published."""
    if QUEUE_SERVICE_URL:
        return (QUEUE_SERVICE_URL.rstrip("/"),
                os.environ.get("NIX_MUSIC_QUEUE_TOKEN", "").strip())
    try:
        with open(QUEUE_SERVICE_FILE, "r", encoding="utf-8") as handle:
            published = json.load(handle)
    except (OSError, ValueError, TypeError):
        return "", ""
    if not isinstance(published, dict):
        return "", ""
    url = str(published.get("url") or "").strip().rstrip("/")
    if not url.startswith("http"):
        return "", ""
    return url, str(published.get("token") or "").strip()
# The window this worker asks the service for. The service holds thousands; a
# closed result schema caps the reply at MAX_QUEUE, so the window is what fits
# and the page reads further windows over its own route.
QUEUE_SERVICE_WINDOW = 100


def _queue_service_request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """One call to the independent queue service.

    Configured but unreachable is an error, not a silent fall back: answering
    from this worker's own queue while another queue is playing would report a
    line-up that is not what the speaker is following.
    """
    address, token = _queue_service_address()
    if not address:
        raise RuntimeError("The music queue service has not published an address.")
    url = address + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"accept": "application/json", "accept-encoding": "identity"}
    if data is not None:
        headers["content-type"] = "application/json"
    if token:
        headers["x-nix-token"] = token
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=QUEUE_SERVICE_TIMEOUT) as response:
            payload = json.loads(response.read(MAX_BODY_BYTES) or b"{}")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = str(json.loads(exc.read(4096) or b"{}").get("error") or "")
        except Exception:
            detail = ""
        raise RuntimeError(detail or "The music queue service refused that request.") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"The music queue service is not reachable: {exc.reason}") from exc
    except ValueError as exc:
        raise RuntimeError("The music queue service sent an unreadable reply.") from exc
    return payload if isinstance(payload, dict) else {}
# How the queue behaves when a track ends: off stops at the last one, all wraps
# back to the first, one repeats the track that just finished. Turned into a
# message rather than interpolated, so the wording stays in one place.
REPEAT_MODES = ("off", "all", "one")
REPEAT_MESSAGES = {
    "off": "Repeat is off.",
    "all": "Repeating the whole queue.",
    "one": "Repeating the current track.",
}

# The track this worker last handed over, kept so a follow-up request that names
# no track at all ("show me the lyrics", "who sings this") still resolves to
# what is actually playing. The console records the same hand-off for the Music
# page, but it never sends the track down with an assistant request, so the
# worker remembers its own last resolution instead of depending on it.
NOW_PLAYING_FILE = os.environ.get("NIX_OPENDECK_NOW_PLAYING_FILE", "/root/data/opendeck-now-playing.json")

# Library reads are cached here: a playlist list, a playlist's tracks, liked
# songs, history. Each one is a round trip to the provider (a linked account's
# browse takes seconds, and OpenDeck's own library store is a second call), so
# the console's Music page would otherwise re-pay for the same list every time it
# opens a tab or is reloaded. A fresh entry is answered from the file; a stale
# one is refreshed on the next read and only returned if the provider cannot be
# reached, so a page degrades to slightly old data instead of an error. Writes
# (like, unlike, playlist create/add) drop the whole file: the account changed.
# The three layers of the same cache are deliberately different lengths of
# memory: the Music page and the panel hold a list for 20s (they refresh on top
# of what they painted), the console's catalog cache for 300s, and this worker —
# the last stop before a linked account is browsed — for 600s.
LIBRARY_CACHE_FILE = os.environ.get("NIX_OPENDECK_CACHE_FILE", "/root/data/opendeck-cache.json")
LIBRARY_TTL_SECONDS = 600
# How long a copy whose refresh just failed is served before the provider is
# tried again. Measured live: the console's own cache serves the list it holds and
# refreshes it in the background, so a provider that is down used to be browsed
# again on every poll of every open screen — the same failing multi-second
# request, repeatedly, for as long as the music page or the panel was open. After
# one failure the copy is served as-is instead, and the failure is recorded in the
# entry (attempts, last_attempt, last_error) for anyone reading the file.
CACHE_RETRY_AFTER = 30.0
CACHE_MAX_ENTRIES = 24

# Playback resolves to a *progressive* rendition when the catalog offers one.
# The adaptive (DASH) audio URLs answer only for the opening of the file: the CDN
# refuses a request past roughly its first 256 KiB, so a device that streams the
# whole track could never hear past the first minute. The muxed `formats`
# renditions serve the complete file, so the returned stream URL comes from one
# of those and the audio-only format is the fallback.
PROGRESSIVE_MIME_PREFIX = "video/"
# Both match the declared result schema: a value or list longer than this is
# truncated (never rejected) so one huge upstream number cannot fail the call.
MAX_COUNT = 100_000
HTTP_TIMEOUT_SECONDS = 25
PROXY_TIMEOUT_MS = 20000
MAX_BODY_BYTES = 4 * 1024 * 1024

# Liked songs are an auto playlist in a YouTube Music library. OpenDeck's own
# client lifts it out of the playlist list and offers it as "Liked Music", and
# this worker does the same so both surfaces agree on what a playlist is.
LIKED_PLAYLIST_ID = "LM"
LIKED_PLAYLIST_NAME = "Liked Music"

# Synced lyrics come from LRCLIB through OpenDeck's allowlisted proxy, the same
# provider OpenDeck's own client uses (lrclib.net is in the server allowlist).
LYRICS_TIMEOUT_MS = 9000
LYRICS_MAX_LINES = 400
LYRICS_PLAIN_CHARS = 8000
# How far a provider's own track length may be from the playing one and still be
# the same recording. LRCLIB's entries differ by a second or two on the same
# pressing; a different rendition (a live take, a lyric video) differs by far
# more, and its words are not the words of what is playing.
LYRICS_DURATION_TOLERANCE = 4
_LRC_STAMP_PATTERN = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")

BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# InnerTube clients. WEB-family clients need a browser po-token that only a
# browser can mint, so the worker uses the app clients OpenDeck's own client
# keeps as fallbacks: they return plain (unciphered) audio URLs.
PLAYER_CLIENTS: tuple[tuple[str, str, str], ...] = (
    (
        "ANDROID",
        "3",
        json.dumps(
            {
                "clientName": "ANDROID",
                "clientVersion": "20.10.38",
                "androidSdkVersion": 30,
                "androidPackageName": "com.google.android.youtube",
                "osName": "Android",
                "osVersion": "11",
            }
        ),
    ),
    (
        "IOS",
        "5",
        json.dumps(
            {
                "clientName": "IOS",
                "clientVersion": "20.10.4",
                "deviceMake": "Apple",
                "deviceModel": "iPhone16,2",
                "osName": "iPhone",
                "osVersion": "18.1.0.22B83",
            }
        ),
    ),
)

# InnerTube search filter for songs (what a "play <song>" request wants).
SONGS_PARAMS = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D"

AUDIO_MIME_PREFERENCE = (
    "audio/mp4",
    "audio/mpeg",
    "audio/webm",
)

_VIDEO_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{6,32}\Z")
# "play this song next": a self-reference names the track already playing, not
# a song whose title is "this song".
_SELF_TRACK_PATTERN = re.compile(
    r"^(?:this|that|it|the\s+one|(?:this|that|the|a|my)?\s*(?:current\s+)?"
    r"(?:song|track|tune|one|music))$",
    re.IGNORECASE,
)


def _result(action: str, message: str, **fields: Any) -> dict[str, Any]:
    """Build a result with every declared field present (the schema is closed)."""
    result: dict[str, Any] = {
        "ok": True,
        "action": action,
        "message": message,
        "connected": bool(fields.get("connected", False)),
        "instance": str(fields.get("instance", ""))[:120],
        "user": str(fields.get("user", ""))[:80],
        "video_id": str(fields.get("video_id", ""))[:64],
        "title": str(fields.get("title", ""))[:300],
        "artist": str(fields.get("artist", ""))[:200],
        "album": str(fields.get("album", ""))[:300],
        "duration_sec": int(fields.get("duration_sec", 0) or 0),
        "artwork_url": str(fields.get("artwork_url", ""))[:600],
        "mime_type": str(fields.get("mime_type", ""))[:80],
        "play_url": str(fields.get("play_url", ""))[:2000],
        "tracks": list(fields.get("tracks") or [])[:MAX_LIBRARY_RESULTS],
        "playlists": list(fields.get("playlists") or [])[:MAX_LIBRARY_RESULTS],
        "queue": [
            item for item in (fields.get("queue") or [])[:MAX_QUEUE]
            if isinstance(item, dict)
        ],
        "queue_index": int(fields.get("queue_index", -1) if fields.get("queue_index") is not None else -1),
        # Shuffle/repeat belong to the queue, but every result carries them (the
        # result schema is closed) so a reply about the queue never has to be
        # read twice to know how it will play.
        "shuffle": bool(fields.get("shuffle", False)),
        "repeat": str(fields.get("repeat") or "off")[:8],
        "count": int(fields.get("count", 0) or 0),
        "lyrics": list(fields.get("lyrics") or [])[:LYRICS_MAX_LINES],
        "lyrics_plain": str(fields.get("lyrics_plain") or "")[:LYRICS_PLAIN_CHARS],
        "lyrics_timing": str(fields.get("lyrics_timing") or "")[:16],
        "lyrics_source": str(fields.get("lyrics_source") or "")[:40],
        # An unclear play request never starts a guess: the tracks Nix could not
        # choose between travel back instead, and the console asks the user
        # (the PUCA Panel shows them large enough to pick from across a room).
        "ambiguous": bool(fields.get("ambiguous", False)),
        "query": str(fields.get("query") or "")[:200],
        "options": [
            item for item in (fields.get("options") or [])[:MAX_PLAY_OPTIONS]
            if isinstance(item, dict)
        ],
    }
    return result


def _text(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _lyrics_text(value: Any, limit: int) -> str:
    """Lyrics with their own line breaks kept.

    ``_text`` folds every run of whitespace into one space, which is right for a
    title and wrong for a body of words: a song that arrived as forty lines came
    back as one paragraph, and the wall display - which draws one line per line -
    showed the whole thing on a single row.
    """
    lines = [re.sub(r"[^\S\n]+", " ", line).strip() for line in str(value or "").splitlines()]
    return "\n".join(line for line in lines if line)[:limit]


def _normalized_words(text: str) -> list[str]:
    """The comparable words of a title, so punctuation and case stop mattering."""
    return [word for word in re.split(r"[^0-9a-z]+", str(text or "").casefold()) if word]


def _play_option(track: dict[str, Any]) -> dict[str, Any]:
    """One candidate for the user to choose between, in the schema's own fields."""
    return {
        "video_id": _text(track.get("video_id"), 64),
        "title": _text(track.get("title"), 300),
        "artist": _text(track.get("artist"), 200),
        "album": _text(track.get("album"), 300),
        "duration_sec": _count(track.get("duration_sec")),
        "artwork_url": _text(track.get("artwork_url"), 600),
    }


def _match_score(query: str, track: dict[str, Any]) -> float:
    """How well one catalog track answers a play request, in [0, 1].

    A whole-title match wins outright and a prefix/near match is close behind.
    A token overlap is deliberately capped below the confident bar: a request
    whose words are merely scattered across a title ("the song from that film")
    is not a decision this code should make on the user's behalf.
    """
    wanted = _text(query, 200).casefold()
    title = _text(track.get("title"), 300).casefold()
    if not wanted or not title:
        return 0.0
    if wanted == title:
        return 1.0
    if len(wanted) >= 4 and (title.startswith(wanted) or wanted.startswith(title)):
        return 0.85
    if len(wanted) >= 4 and wanted in title:
        return 0.8
    wanted_words = set(_normalized_words(wanted))
    if not wanted_words:
        return 0.0
    overlap = len(wanted_words & set(_normalized_words(title))) / len(wanted_words)
    # Naming the artist is part of naming a track, so it counts as a match too.
    if wanted_words & set(_normalized_words(track.get("artist"))):
        overlap = min(1.0, overlap + 0.15)
    return round(overlap * 0.7, 3)


def _title_key(title: Any) -> str:
    """A title with its bracketed asides stripped, for comparing two tracks.

    "Never Gonna Give You Up", "… (Official Video)" and "… [8-bit]" are the same
    song as far as a spoken request is concerned, so the catalog's own ranking
    decides between them. Two *different* titles are what makes a request unclear.
    """
    text = _text(title, 300).casefold()
    text = re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", text)
    text = re.sub(r"\b(feat|ft|featuring|official|video|audio|lyrics|remaster(ed)?|version)\b.*$", " ", text)
    return " ".join(_normalized_words(text))


def _play_choice(
    query: str, tracks: list[dict[str, Any]]
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """The one track to play, or the candidates the user has to choose between.

    ``(track, [])`` means one answer is far enough ahead of every *other* title to
    play it; ``(None, candidates)`` means several different songs answer the
    request about equally well — exactly the case where playing the first search
    hit would be a guess rather than a decision the panel should have made.
    """
    ranked = sorted(
        ((_match_score(query, track), track) for track in tracks),
        key=lambda pair: pair[0],
        reverse=True,
    )
    if not ranked:
        return None, []
    best_score, best = ranked[0]
    best_key = _title_key(best.get("title"))
    # A second copy of the *same* title is not a choice the user has to make;
    # the provider's own ranking already ordered those.
    distinct_runner_up = next(
        (score for score, track in ranked[1:] if _title_key(track.get("title")) != best_key),
        0.0,
    )
    if best_score >= CONFIDENT_MATCH_SCORE and best_score - distinct_runner_up >= CONFIDENT_MATCH_MARGIN:
        return best, []
    contenders = [track for score, track in ranked if score >= AMBIGUOUS_MIN_SCORE]
    distinct_titles = {_title_key(track.get("title")) for track in contenders}
    distinct_titles.discard("")
    # More than one *different* title fits the request: the choice belongs to the
    # user, who is the only one who knows which song they meant.
    if len(distinct_titles) >= 2:
        return None, contenders[:MAX_PLAY_OPTIONS]
    return best, []


def _count(value: Any) -> int:
    """A whole number inside the schema's bound, whatever the upstream sent."""
    try:
        return max(0, min(MAX_COUNT, int(value)))
    except (TypeError, ValueError):
        return 0


def _invalidated_reads(kind: str) -> tuple[str, ...] | None:
    """Which cached library reads one write just made wrong.

    ``None`` means every read, for a write this build does not recognise — which
    is what every write used to do. The prefixes are the cache keys' own shape
    (``kind:playlist_id:limit``), so what survives is genuinely unaffected:

    * liking or unliking a song changes the liked songs, the auto playlist they
      live in, and the track counts on the playlist list;
    * adding a track changes the playlist it was added to and those counts (a
      track added to Liked Music arrives through the like path, so the liked
      songs are dropped with it);
    * creating a playlist changes the list of playlists;
    * history and stats are not changed by any of these, so they stay cached.
    """
    if kind in {"like", "unlike"}:
        return ("likes", f"playlist:{LIKED_PLAYLIST_ID}", "playlists")
    if kind == "playlist_add":
        return ("playlist:", "playlists", "likes")
    if kind == "playlist_create":
        return ("playlists",)
    return None


class OpenDeckService:
    """One configured OpenDeck instance: session, tool validation, execution."""

    def __init__(self) -> None:
        self.base_url = ""
        self.api_key = ""
        self.host_label = ""
        self.user_name = ""
        self.youtube_linked = False
        self.connected = False
        # Set by `_linked_library` when a linked account's read failed, so a
        # store-only answer is never cached as the whole library.
        self.linked_library_degraded = False
        self._music_client: dict[str, str] | None = None

    # ── HTTP ──────────────────────────────────────────────────────────────
    def _request(
        self,
        method: str,
        url: str,
        *,
        body: dict[str, Any] | None = None,
        bearer: bool = True,
        timeout: int = HTTP_TIMEOUT_SECONDS,
    ) -> tuple[int, bytes]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"accept": "application/json", "accept-encoding": "identity"}
        if data is not None:
            headers["content-type"] = "application/json"
        if bearer:
            headers["authorization"] = f"Bearer {self.api_key}"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, response.read(MAX_BODY_BYTES)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(4096)
        except urllib.error.URLError as exc:
            raise RuntimeError(
                f"Could not reach the OpenDeck server at {self.host_label}: {exc.reason}"
            ) from exc

    def _api(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _json(self, method: str, path: str, *, body: dict[str, Any] | None = None) -> dict[str, Any]:
        status, payload = self._request(method, self._api(path), body=body)
        if status < 200 or status >= 300:
            detail = ""
            try:
                detail = str(json.loads(payload.decode("utf-8", "replace")).get("error") or "")
            except Exception:
                detail = payload.decode("utf-8", "replace")[:120]
            raise RuntimeError(
                f"OpenDeck answered HTTP {status} for {path}{f': {detail}' if detail else ''}"
            )
        try:
            return json.loads(payload.decode("utf-8", "replace"))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"OpenDeck returned a non-JSON response for {path}.") from exc

    def _proxy(self, url: str, *, method: str = "POST", body: Any = None, timeout_ms: int = PROXY_TIMEOUT_MS) -> bytes:
        """Call OpenDeck's allowlisted proxy. Anonymous: see the module docstring."""
        envelope: dict[str, Any] = {
            "url": url,
            "method": method,
            "headers": {
                "content-type": "application/json",
                "accept-encoding": "identity",
                "user-agent": BROWSER_USER_AGENT,
            },
            "timeout_ms": timeout_ms,
        }
        if body is not None:
            import base64

            raw = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
            envelope["body_base64"] = base64.b64encode(raw).decode("ascii")
        status, payload = self._request("POST", self._api("/api/yt/proxy"), body=envelope, bearer=False)
        if status == 429:
            raise RuntimeError("OpenDeck is rate limiting catalog requests; try again shortly.")
        if status < 200 or status >= 300:
            detail = payload.decode("utf-8", "replace")[:160]
            raise RuntimeError(f"OpenDeck's proxy refused the request (HTTP {status}): {detail}")
        try:
            parsed = json.loads(payload.decode("utf-8", "replace"))
        except json.JSONDecodeError as exc:
            raise RuntimeError("OpenDeck's proxy returned a non-JSON envelope.") from exc
        inner_status = parsed.get("status")
        import base64 as _b64

        inner = _b64.b64decode(parsed.get("body_base64") or "")
        if not isinstance(inner_status, int) or inner_status < 200 or inner_status >= 300:
            raise RuntimeError(
                f"OpenDeck's proxy forwarded HTTP {inner_status} from the music catalog."
            )
        return inner

    # ── Session ───────────────────────────────────────────────────────────
    def initialize(self, config: Any) -> None:
        if not isinstance(config, dict):
            raise ValueError("OpenDeck setup must be an object.")
        raw_url = _text(config.get("server_url"), 300)
        api_key = str(config.get("api_key") or "").strip()
        if not raw_url:
            raise ValueError("Set the OpenDeck server address in Skills setup first.")
        parsed = urllib.parse.urlsplit(raw_url if "//" in raw_url else f"http://{raw_url}")
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("OpenDeck server address must be an http(s) URL or host:port.")
        if parsed.query or parsed.fragment:
            raise ValueError("OpenDeck server address cannot contain a query or fragment.")
        base_path = parsed.path.rstrip("/")
        if base_path and not base_path.startswith("/"):
            raise ValueError("OpenDeck server address path must start with '/'.")
        self.base_url = urllib.parse.urlunsplit(
            (parsed.scheme, parsed.netloc, base_path, "", "")
        )
        self.host_label = parsed.netloc or parsed.hostname or raw_url
        if not api_key:
            raise ValueError("Set the OpenDeck API key in Skills setup first.")
        if len(api_key) > 200 or any(char.isspace() for char in api_key):
            raise ValueError("OpenDeck API key must not contain spaces.")
        self.api_key = api_key

        session = self._json("GET", "/api/auth/whoami")
        if session.get("authenticated") is not True:
            raise RuntimeError("OpenDeck rejected the configured API key.")
        user = session.get("user") if isinstance(session.get("user"), dict) else {}
        self.user_name = _text(user.get("name") or user.get("email"), 80)
        self.youtube_linked = bool(session.get("youtubeLinked"))
        self.connected = True

    # ── Catalog (search / resolve) ────────────────────────────────────────
    def _music_client_config(self) -> dict[str, str]:
        """Real WEB_REMIX client version/API key, read once from the instance."""
        if self._music_client is not None:
            return self._music_client
        html = self._proxy("https://music.youtube.com/", method="GET", timeout_ms=15000).decode(
            "utf-8", "replace"
        )
        version = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', html)
        api_key = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)
        if version is None:
            raise RuntimeError(
                "OpenDeck's catalog bootstrap did not return an InnerTube client version."
            )
        self._music_client = {
            "version": version.group(1),
            "key": api_key.group(1) if api_key else "",
        }
        return self._music_client

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        client = self._music_client_config()
        url = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false"
        if client["key"]:
            url += f"&key={client['key']}"
        body = {
            "context": {
                "client": {
                    "clientName": "WEB_REMIX",
                    "clientVersion": client["version"],
                    "hl": "en",
                    "gl": "US",
                }
            },
            "query": query,
            "params": SONGS_PARAMS,
        }
        payload = self._proxy(url, body=body)
        try:
            data = json.loads(payload.decode("utf-8", "replace"))
        except json.JSONDecodeError as exc:
            raise RuntimeError("OpenDeck's catalog returned an unreadable search response.") from exc
        tracks = _parse_search_tracks(data)
        return tracks[:limit]

    def resolve(self, video_id: str) -> dict[str, Any]:
        last_error = ""
        for client_name, client_number, client_config in PLAYER_CLIENTS:
            body = {
                "context": {"client": json.loads(client_config) | {"hl": "en", "gl": "US"}},
                "videoId": video_id,
                "contentCheckOk": True,
                "racyCheckOk": True,
            }
            try:
                payload = self._proxy(
                    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
                    body=body,
                    timeout_ms=PROXY_TIMEOUT_MS,
                )
            except RuntimeError as exc:
                last_error = str(exc)
                continue
            try:
                data = json.loads(payload.decode("utf-8", "replace"))
            except json.JSONDecodeError:
                last_error = "the player response was unreadable"
                continue
            status = ((data.get("playabilityStatus") or {}).get("status") or "").upper()
            if status != "OK":
                reason = _text((data.get("playabilityStatus") or {}).get("reason"), 120)
                last_error = reason or f"the {client_name} player answered {status or 'no status'}"
                continue
            streaming = data.get("streamingData") or {}
            format_data = _select_audio_format(streaming)
            if format_data is None:
                last_error = f"the {client_name} player returned no playable audio format"
                continue
            playback = _select_playback_format(streaming, format_data)
            details = data.get("videoDetails") or {}
            thumbnails = ((details.get("thumbnail") or {}).get("thumbnails") or [])
            artwork = ""
            if isinstance(thumbnails, list) and thumbnails:
                artwork = str((thumbnails[-1] or {}).get("url") or "")
            return {
                "stream_url": str(playback.get("url") or ""),
                "mime_type": str(format_data.get("mimeType") or "").split(";")[0].strip(),
                "progressive": playback is not format_data,
                "title": _text(details.get("title"), 300),
                "artist": _text(details.get("author"), 200),
                "duration_sec": int(details.get("lengthSeconds") or 0),
                "artwork_url": artwork,
                "video_id": _text(details.get("videoId") or video_id, 64),
            }
        raise RuntimeError(
            "OpenDeck could not resolve a playable stream for that track"
            + (f": {last_error}" if last_error else ".")
        )

    def play_url(self, stream_url: str, track: dict[str, Any]) -> str:
        """Absolute OpenDeck stream URL the device fetches for the audio.

        The URL handed over is the progressive rendition resolved above, so a
        device that downloads it gets the whole track rather than the opening
        the CDN allows an adaptive audio URL to serve. The device's request is
        unauthenticated (this endpoint needs no key), so OpenDeck cannot
        attribute the play to the account: the play does not appear in the
        user's OpenDeck history. Pass the metadata anyway — the web player uses
        it when a signed-in browser fetches the same URL.
        """
        params = {"url": stream_url}
        if track.get("video_id"):
            params["videoId"] = track["video_id"]
        if track.get("title"):
            params["title"] = track["title"]
        if track.get("artist"):
            params["artist"] = track["artist"]
        if track.get("artwork_url"):
            params["artwork"] = track["artwork_url"]
        if track.get("duration_sec"):
            params["durationSec"] = str(int(track["duration_sec"]))
        return self._api("/api/media/stream?" + urllib.parse.urlencode(params))

    # ── Play queue ────────────────────────────────────────────────────────
    @staticmethod
    def _queue_item(track: dict[str, Any]) -> dict[str, Any]:
        """One playlist track, reduced to exactly what the queue stores."""
        return {
            "video_id": _text(track.get("video_id"), 64),
            "title": _text(track.get("title"), 300),
            "artist": _text(track.get("artist"), 200),
            "album": _text(track.get("album"), 300),
            "duration_sec": _count(track.get("duration_sec")),
            "artwork_url": _text(track.get("artwork_url"), 600),
        }

    def _queue_load(self) -> dict[str, Any]:
        empty = {"items": [], "current_index": -1, "repeat": "off", "shuffle": False, "shuffle_base": []}
        try:
            with open(QUEUE_FILE, "r", encoding="utf-8") as handle:
                saved = json.load(handle)
        except (OSError, json.JSONDecodeError):
            return dict(empty)
        raw_items = saved.get("items") if isinstance(saved, dict) else None
        if not isinstance(raw_items, list):
            return dict(empty)
        items = [
            {
                "video_id": _text(item.get("video_id"), 64),
                "title": _text(item.get("title"), 300),
                "artist": _text(item.get("artist"), 200),
                "album": _text(item.get("album"), 300),
                "duration_sec": _count(item.get("duration_sec")),
                "artwork_url": _text(item.get("artwork_url"), 600),
            }
            for item in raw_items[:MAX_QUEUE]
            if isinstance(item, dict) and _VIDEO_ID_PATTERN.fullmatch(_text(item.get("video_id"), 64))
        ]
        index = saved.get("current_index") if isinstance(saved, dict) else -1
        if not isinstance(index, int) or index < -1 or index >= len(items):
            index = -1
        repeat = saved.get("repeat") if isinstance(saved, dict) else None
        if repeat not in REPEAT_MODES:
            repeat = "off"
        base = saved.get("shuffle_base") if isinstance(saved, dict) else None
        shuffle_base = [
            video_id
            for video_id in (_text(item, 64) for item in (base if isinstance(base, list) else []))
            if _VIDEO_ID_PATTERN.fullmatch(video_id)
        ][:MAX_QUEUE]
        return {
            "items": items,
            "current_index": index,
            "repeat": repeat,
            "shuffle": bool(saved.get("shuffle")) if isinstance(saved, dict) else False,
            "shuffle_base": shuffle_base,
        }

    def _queue_save(self, queue: dict[str, Any]) -> None:
        directory = os.path.dirname(QUEUE_FILE)
        if directory:
            os.makedirs(directory, exist_ok=True)
        # Shuffle and repeat are listening preferences, not queue contents: they
        # are written back on every save so clearing the queue does not silently
        # turn them off.
        saved = {
            "items": queue["items"],
            "current_index": queue["current_index"],
            "repeat": queue.get("repeat") if queue.get("repeat") in REPEAT_MODES else "off",
            "shuffle": bool(queue.get("shuffle")),
            "shuffle_base": list(queue.get("shuffle_base") or [])[:MAX_QUEUE],
        }
        temporary = f"{QUEUE_FILE}.{os.getpid()}.tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(saved, handle, ensure_ascii=False)
        os.replace(temporary, QUEUE_FILE)

    def _queue_lookup(self, arguments: dict[str, Any]) -> dict[str, Any]:
        """Turn a queue request into a track record (metadata, no stream)."""
        query = arguments.get("query") or ""
        if query:
            tracks = self.search(query, 1)
            if not tracks:
                raise RuntimeError(f"OpenDeck found no track matching “{query}”.")
            return dict(tracks[0])
        video_id = arguments["video_id"]
        resolved = self.resolve(video_id)
        return {
            "video_id": resolved["video_id"] or video_id,
            "title": resolved["title"],
            "artist": _clean_artist(resolved["artist"]),
            "album": "",
            "duration_sec": resolved["duration_sec"],
            "artwork_url": resolved["artwork_url"],
        }

    def _remember_track(self, track: dict[str, Any]) -> None:
        """Persist the track that is now playing, for follow-up requests."""
        saved = {
            key: track.get(key)
            for key in ("video_id", "title", "artist", "album", "duration_sec", "artwork_url")
        }
        directory = os.path.dirname(NOW_PLAYING_FILE)
        try:
            if directory:
                os.makedirs(directory, exist_ok=True)
            temporary = f"{NOW_PLAYING_FILE}.{os.getpid()}.tmp"
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(saved, handle, ensure_ascii=False)
            os.replace(temporary, NOW_PLAYING_FILE)
        except OSError:
            # Remembering the track is a convenience: never fail a play because
            # the data directory is not writable.
            pass

    def _remembered_track(self) -> dict[str, Any]:
        try:
            with open(NOW_PLAYING_FILE, "r", encoding="utf-8") as handle:
                saved = json.load(handle)
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(saved, dict):
            return {}
        video_id = _text(saved.get("video_id"), 64)
        title = _text(saved.get("title"), 300)
        if not _VIDEO_ID_PATTERN.fullmatch(video_id) and not title:
            return {}
        return {
            "video_id": video_id,
            "title": title,
            "artist": _text(saved.get("artist"), 200),
            "album": _text(saved.get("album"), 300),
            "duration_sec": _count(saved.get("duration_sec")),
        }

    def _queue_start(self, queue: dict[str, Any], index: int) -> dict[str, Any]:
        """Resolve the queue's ``index`` track into playable fields."""
        track = queue["items"][index]
        resolved = self.resolve(track["video_id"])
        title = track["title"] or resolved["title"]
        artist = track["artist"] or _clean_artist(resolved["artist"])
        meta = {
            "video_id": resolved["video_id"] or track["video_id"],
            "title": title,
            "artist": artist,
            "album": track["album"],
            "duration_sec": resolved["duration_sec"] or track["duration_sec"],
            "artwork_url": track["artwork_url"] or resolved["artwork_url"],
        }
        queue["current_index"] = index
        self._queue_save(queue)
        play_url = self.play_url(resolved["stream_url"], meta)
        self._remember_track(meta)
        return {
            **meta,
            "mime_type": resolved["mime_type"],
            "play_url": play_url,
        }

    def _queue_target_index(self, queue: dict[str, Any], arguments: dict[str, Any]) -> int:
        """The queue slot a reorder names, or -1 when the track is not queued.

        A request can name a track by ``index`` ("move track 3"), by ``query``
        ("play Hotel California next") or by ``video_id``; a named track that is
        not in the queue returns -1 so the caller can insert it.
        """
        if arguments.get("index") is not None:
            index = arguments["index"]
            if index >= len(queue["items"]):
                raise RuntimeError("That queue position does not exist.")
            return index
        if not arguments.get("query") and not arguments.get("video_id"):
            # Nothing named ("play this next"): the track already playing.
            current = queue["current_index"]
            return current if 0 <= current < len(queue["items"]) else -1
        track = self._queue_lookup(arguments)
        for position, item in enumerate(queue["items"]):
            if item["video_id"] == track["video_id"]:
                return position
        return -1

    @staticmethod
    def _queue_keep_current(queue: dict[str, Any], current_video_id: str) -> None:
        """Re-point ``current_index`` at the same track after a reorder."""
        if not current_video_id:
            queue["current_index"] = -1
            return
        for position, item in enumerate(queue["items"]):
            if item["video_id"] == current_video_id:
                queue["current_index"] = position
                return
        queue["current_index"] = -1

    @staticmethod
    def _queue_state(queue: dict[str, Any]) -> dict[str, Any]:
        """The shuffle/repeat flags, for every reply about the queue."""
        return {"shuffle": bool(queue.get("shuffle")), "repeat": queue.get("repeat") or "off"}

    def _queue_shuffle(self, queue: dict[str, Any], on: bool) -> None:
        """Shuffle what is waiting after the current track, or put it back.

        Turning it on keeps every track and leaves the one playing exactly where
        it is, then randomly reorders the queue behind it. Turning it off puts
        the waiting tracks back in the order they were queued (a track added
        while shuffled keeps its place at the end), so the toggle is reversible
        instead of one-way.
        """
        items = queue["items"]
        if on and not queue.get("shuffle"):
            queue["shuffle_base"] = [item["video_id"] for item in items]
        queue["shuffle"] = bool(on)
        if on:
            index = queue["current_index"]
            head = items[: index + 1] if 0 <= index < len(items) else []
            waiting = list(items[len(head):])
            random.shuffle(waiting)
            queue["items"] = head + waiting
            return
        if queue.get("shuffle_base"):
            self._queue_restore_order(queue)
        queue["shuffle_base"] = []

    def _queue_restore_order(self, queue: dict[str, Any]) -> None:
        """Re-order the waiting tracks to the queue's pre-shuffle order.

        The playing track stays where it is (only its slot number can change),
        the already-played part is left alone, and anything that was queued or
        reordered while shuffled — so it no longer appears in the base order —
        keeps its current relative position after the restored ones.
        """
        items = queue["items"]
        index = queue["current_index"]
        playing = items[index] if 0 <= index < len(items) else None
        played = items[:index] if playing is not None else []
        waiting = list(items[index + 1:]) if playing is not None else list(items)
        buckets: dict[str, list[dict[str, Any]]] = {}
        for item in waiting:
            buckets.setdefault(item["video_id"], []).append(item)
        ordered: list[dict[str, Any]] = []
        for video_id in queue["shuffle_base"]:
            bucket = buckets.get(video_id)
            if bucket:
                ordered.append(bucket.pop(0))
        for item in waiting:
            bucket = buckets.get(item["video_id"])
            if bucket and item in bucket:
                ordered.append(bucket.pop(0))
        queue["items"] = played + ([playing] if playing is not None else []) + ordered
        queue["current_index"] = len(played) if playing is not None else -1

    # ── the independent queue service ─────────────────────────────────────
    def _service_state(self, window: int = QUEUE_SERVICE_WINDOW) -> dict[str, Any]:
        return _queue_service_request("GET", f"/state?from=0&limit={window}")

    def _service_index_of(self, arguments: dict[str, Any]) -> int:
        """The position the service holds a named track at.

        The assistant names tracks ("move Bohemian Rhapsody to the front"); the
        service works in positions, because that is what a queue is. The name is
        resolved here, against the queue the service actually holds.
        """
        state = self._service_state(2000)
        items = state.get("queue") if isinstance(state.get("queue"), list) else []
        wanted = self._queue_lookup(arguments)
        needle = _text(wanted.get("title"), 300).casefold()
        for position, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            if item.get("video_id") == wanted["video_id"]:
                return position
            if needle and needle in _text(item.get("title"), 300).casefold():
                return position
        raise RuntimeError(f"“{wanted['title'] or wanted['video_id']}” is not in the queue.")

    def _service_playable(self, track: dict[str, Any]) -> dict[str, Any]:
        """Resolve a track the service handed over into playable fields."""
        resolved = self.resolve(track["video_id"])
        meta = {
            "video_id": resolved["video_id"] or track["video_id"],
            "title": track.get("title") or resolved["title"],
            "artist": track.get("artist") or _clean_artist(resolved["artist"]),
            "album": track.get("album") or "",
            "duration_sec": resolved["duration_sec"] or track.get("duration_sec") or 0,
            "artwork_url": track.get("artwork_url") or resolved["artwork_url"],
        }
        play_url = self.play_url(resolved["stream_url"], meta)
        self._remember_track(meta)
        return {**meta, "mime_type": resolved["mime_type"], "play_url": play_url}

    def _service_result(self, reply: dict[str, Any], message: str, *,
                        playable: dict[str, Any] | None = None) -> dict[str, Any]:
        """The service's reply in this worker's own result shape."""
        items = reply.get("queue") if isinstance(reply.get("queue"), list) else []
        index = reply.get("index")
        return {
            **(playable or {}),
            "queue": items[:MAX_QUEUE],
            "queue_index": index if isinstance(index, int) else -1,
            "count": int(reply.get("total") if reply.get("total") is not None else len(items)),
            "shuffle": bool(reply.get("shuffle")),
            "repeat": reply.get("repeat") if reply.get("repeat") in REPEAT_MODES else "off",
            "message": message,
        }

    def _queue_through_service(self, arguments: dict[str, Any]) -> dict[str, Any]:
        """Forward one queue request to the independent queue service."""
        op = arguments["op"]
        if op == "list":
            reply = self._service_state()
            total = int(reply.get("total") or 0)
            message = f"{total} track(s) queued." if total else "The queue is empty."
            return self._service_result(reply, message)
        if op in {"remove", "front", "next_up"} and arguments.get("index") is None:
            arguments = {**arguments, "index": self._service_index_of(arguments)}
        if op == "add":
            track = self._queue_lookup(arguments)
            reply = _queue_service_request("POST", "/add", {"tracks": [track]})
            position = int(reply.get("total") or 0)
            # The track that was queued travels back (the result schema carries
            # its fields), so a reply about an add names what was added.
            return self._service_result(
                reply, f"Queued “{track['title'] or track['video_id']}” at position {position}.",
                playable={key: track[key] for key in (
                    "video_id", "title", "artist", "album", "duration_sec", "artwork_url")
                    if track.get(key) is not None})
        if op in {"play", "next"}:
            if op == "play":
                state = self._service_state(2000)
                items = state.get("queue") if isinstance(state.get("queue"), list) else []
                index = int(arguments["index"])
                if index >= len(items):
                    raise RuntimeError("That queue position does not exist.")
                reply = _queue_service_request("POST", "/ops", {"op": "set_index", "index": index})
                reply = {**reply, "queue": items, "index": index, "total": state.get("total")}
                track = items[index]
            else:
                reply = _queue_service_request("POST", "/ops", {"op": "next",
                                                              "auto": bool(arguments.get("auto"))})
                track = reply.get("track") if isinstance(reply.get("track"), dict) else None
                if not reply.get("ok") or not track:
                    return self._service_result(reply, reply.get("message") or "The queue has no next track to play.")
            playable = self._service_playable(track)
            total = int(reply.get("total") or 0)
            index = int(reply.get("index") or 0)
            return self._service_result(
                reply,
                f"Playing queued track {index + 1} of {total}: "
                f"“{playable['title'] or playable['video_id']}”.",
                playable=playable)
        body = {"op": op}
        for key in ("index", "to", "on", "mode"):
            if key in arguments and arguments[key] is not None:
                body[key] = arguments[key]
        if op == "clear":
            state = self._service_state(2000)
            removed = int(state.get("total") or 0)
            reply = _queue_service_request("POST", "/ops", body)
            return self._service_result(
                reply, f"Cleared {removed} track(s) from the queue." if removed else "The queue was already empty.")
        reply = _queue_service_request("POST", "/ops", body)
        message = {
            "remove": "Removed from the queue.",
            "move": "Queue reordered.",
            "front": "Moved to the front of the queue.",
            "next_up": "Playing next.",
            "shuffle": "Shuffling the queue." if reply.get("shuffle") else "Playing the queue in order.",
            "repeat": REPEAT_MESSAGES.get(reply.get("repeat"), "Repeat updated."),
        }.get(op, "Queue updated.")
        return self._service_result(reply, message)

    def queue(self, arguments: dict[str, Any]) -> dict[str, Any]:
        op = arguments["op"]
        if _queue_service_address()[0]:
            # The service owns the queue: this worker's own file is left
            # untouched, so there is never a second line-up to disagree with it.
            return self._queue_through_service(arguments)
        queue = self._queue_load()
        items = queue["items"]
        if op == "resolve":
            # Read-only: turn a bare video id (or a name) into a track record
            # without queueing or playing it. The independent queue service asks
            # this for each track whose metadata never arrived, one at a time and
            # at whatever rate it decides — the queue itself is not touched here,
            # so resolving can never reorder or start anything.
            track = self._queue_lookup(arguments)
            return {"queue": items, "queue_index": queue["current_index"], "count": len(items),
                    "video_id": track["video_id"], "title": track["title"],
                    "artist": track["artist"], "album": track["album"],
                    "duration_sec": track["duration_sec"], "artwork_url": track["artwork_url"],
                    **self._queue_state(queue),
                    "message": f"Resolved “{track['title'] or track['video_id']}”."}
        if op == "list":
            return {"queue": items, "queue_index": queue["current_index"], "count": len(items),
                    **self._queue_state(queue),
                    "message": f"{len(items)} track(s) queued." if items else "The queue is empty."}
        if op == "clear":
            removed = len(items)
            # Mutated rather than replaced: the shuffle/repeat preferences belong
            # to the player, not to the tracks being dropped.
            items.clear()
            queue["current_index"] = -1
            queue["shuffle_base"] = []
            self._queue_save(queue)
            return {"queue": [], "queue_index": -1, "count": 0,
                    **self._queue_state(queue),
                    "message": f"Cleared {removed} track(s) from the queue." if removed else "The queue was already empty."}
        if op == "shuffle":
            wanted = arguments.get("on")
            on = (not queue["shuffle"]) if wanted is None else bool(wanted)
            self._queue_shuffle(queue, on)
            items = queue["items"]
            self._queue_save(queue)
            return {"queue": items, "queue_index": queue["current_index"], "count": len(items),
                    **self._queue_state(queue),
                    "message": "Shuffling the queue." if on else "Playing the queue in order."}
        if op == "repeat":
            mode = arguments.get("mode")
            if mode not in REPEAT_MODES:
                if mode:
                    raise ValueError("repeat mode must be off, all, or one")
                # No mode given: cycle, so a single "repeat" request is still
                # useful ("repeat this" while it is off turns it on).
                mode = {"off": "all", "all": "one", "one": "off"}[queue["repeat"]]
            queue["repeat"] = mode
            self._queue_save(queue)
            return {"queue": items, "queue_index": queue["current_index"], "count": len(items),
                    **self._queue_state(queue),
                    "message": REPEAT_MESSAGES[mode]}
        if op == "add":
            if len(items) >= MAX_QUEUE:
                raise RuntimeError(f"The queue is full ({MAX_QUEUE} tracks). Remove something first.")
            track = self._queue_lookup(arguments)
            items.append(track)
            if queue["shuffle"]:
                # Shuffled: remember where it belongs once shuffle is turned off.
                queue["shuffle_base"].append(track["video_id"])
            self._queue_save(queue)
            position = len(items)
            return {"queue": items, "queue_index": queue["current_index"], "count": len(items),
                    "video_id": track["video_id"], "title": track["title"], "artist": track["artist"],
                    "album": track["album"], "duration_sec": track["duration_sec"],
                    "artwork_url": track["artwork_url"],
                    **self._queue_state(queue),
                    "message": f"Queued “{track['title'] or track['video_id']}” at position {position}."}
        if op == "remove":
            index = arguments.get("index")
            if index is None:
                # Named, not numbered: find the entry the name resolves to. A
                # title match is accepted too, so "remove Bohemian Rhapsody from
                # the queue" works even when the search picks a different
                # rendition of the same song than the one queued.
                wanted = self._queue_lookup(arguments)
                index = next(
                    (
                        position
                        for position, item in enumerate(items)
                        if item["video_id"] == wanted["video_id"]
                    ),
                    None,
                )
                if index is None:
                    needle = _text(wanted.get("title"), 300).casefold()
                    index = next(
                        (
                            position
                            for position, item in enumerate(items)
                            if needle and needle in _text(item.get("title"), 300).casefold()
                        ),
                        None,
                    )
                if index is None:
                    raise RuntimeError(
                        f"“{wanted['title'] or wanted['video_id']}” is not in the queue."
                    )
            if index >= len(items):
                raise RuntimeError("That queue position does not exist.")
            removed = items.pop(index)
            if queue["shuffle"] and removed["video_id"] in queue["shuffle_base"]:
                queue["shuffle_base"].remove(removed["video_id"])
            if queue["current_index"] == index:
                queue["current_index"] = -1
            elif queue["current_index"] > index:
                queue["current_index"] -= 1
            self._queue_save(queue)
            return {"queue": items, "queue_index": queue["current_index"], "count": len(items),
                    **self._queue_state(queue),
                    "message": f"Removed “{removed['title'] or removed['video_id']}” from the queue."}
        if op == "play":
            index = arguments["index"]
            if index >= len(items):
                raise RuntimeError("That queue position does not exist.")
            data = self._queue_start(queue, index)
            return {**data, "queue": items, "queue_index": index, "count": len(items),
                    **self._queue_state(queue),
                    "message": f"Playing queued track {index + 1} of {len(items)}: “{data['title']}”."}
        if op == "next":
            current = queue["current_index"]
            repeating = queue["repeat"] == "one" and arguments.get("auto") and 0 <= current < len(items)
            if repeating:
                # The track that just finished repeats itself. An explicit "next"
                # from the page still moves on, which is what a skip means.
                next_index = current
            else:
                next_index = current + 1
                while next_index < len(items) and not items[next_index].get("video_id"):
                    next_index += 1
                if next_index >= len(items) and queue["repeat"] == "all" and items:
                    # Repeat-all wraps at the end instead of stopping.
                    next_index = 0
            if next_index >= len(items):
                return {"queue": items, "queue_index": queue["current_index"], "count": len(items),
                        **self._queue_state(queue),
                        "message": "The queue has no next track to play."}
            # The track being left has had its turn, so it stops being shown in
            # the queue. Repeat modes are the exception on purpose: repeat-all
            # has to be able to wrap back to it, and repeat-one has to be able
            # to play it again.
            if not repeating and queue["repeat"] == "off" and 0 <= current < len(items):
                left = items.pop(current)
                if queue["shuffle"]:
                    try:
                        queue["shuffle_base"].remove(left["video_id"])
                    except ValueError:  # queued while shuffled, so never in the base order
                        pass
                if next_index > current:
                    next_index -= 1
            data = self._queue_start(queue, next_index)
            return {**data, "queue": items, "queue_index": next_index, "count": len(items),
                    **self._queue_state(queue),
                    "message": f"Playing queued track {next_index + 1} of {len(items)}: “{data['title']}” "
                               f"({len(items) - next_index - 1} left after this)."}
        if op == "add_range":
            # "Add this song and everything under it": the songs from the chosen
            # row to the end of the playlist it was listed in. Nothing above the
            # chosen row is queued, which is the point of the button.
            playlist_id = _text(arguments.get("playlist_id"), 100)
            anchor_id = _text(arguments.get("video_id"), 64)
            if not playlist_id:
                raise ValueError("add_range needs the playlist_id the song came from.")
            tracks = self._playlist_tracks(playlist_id)
            if not tracks:
                raise RuntimeError("That playlist has no songs to queue.")
            start = 0
            if _VIDEO_ID_PATTERN.fullmatch(anchor_id):
                found = next(
                    (position for position, item in enumerate(tracks) if item.get("video_id") == anchor_id),
                    None,
                )
                if found is None:
                    raise RuntimeError("That song is not in this playlist any more.")
                start = found
            waiting = [
                self._queue_item(item)
                for item in tracks[start:]
                if _VIDEO_ID_PATTERN.fullmatch(_text(item.get("video_id"), 64))
            ]
            if not waiting:
                raise RuntimeError("There are no songs from that one to the end of the playlist.")
            room = MAX_QUEUE - len(items)
            if room <= 0:
                raise RuntimeError(f"The queue is full ({MAX_QUEUE} tracks). Remove something first.")
            added = waiting[:room]
            for item in added:
                items.append(item)
                if queue["shuffle"]:
                    queue["shuffle_base"].append(item["video_id"])
            self._queue_save(queue)
            name = _text((added[0].get("title") or added[0].get("video_id")), 300)
            tail = " the rest of the playlist" if len(added) < len(waiting) else ""
            return {"queue": items, "queue_index": queue["current_index"], "count": len(items),
                    "video_id": added[0]["video_id"], "title": added[0]["title"],
                    "artist": added[0]["artist"], "album": added[0]["album"],
                    "duration_sec": added[0]["duration_sec"], "artwork_url": added[0]["artwork_url"],
                    **self._queue_state(queue),
                    "message": f"Queued {len(added)} song(s) from “{name}” to the end of the playlist{tail}."}
        current_id = (
            items[queue["current_index"]]["video_id"]
            if 0 <= queue["current_index"] < len(items)
            else ""
        )
        if op == "move":
            # Explicit reorder: "move track 3 to position 1".
            from_index = arguments["index"]
            to_index = arguments["to"]
            if from_index >= len(items):
                raise RuntimeError("That queue position does not exist.")
            to_index = min(to_index, len(items) - 1)
            track = items.pop(from_index)
            items.insert(to_index, track)
            self._queue_keep_current(queue, current_id)
            self._queue_save(queue)
            return {"queue": items, "queue_index": queue["current_index"], "count": len(items),
                    "video_id": track["video_id"], "title": track["title"], "artist": track["artist"],
                    **self._queue_state(queue),
                    "message": f"Moved “{track['title'] or track['video_id']}” to position {to_index + 1}."}
        if op in {"front", "next_up"}:
            # "Play <song> next / first": move the named track so it is the very
            # next one (right after the current track) or the front of the queue.
            # A track that is not queued yet is inserted at that spot instead,
            # so the user can prioritise something they had not added.
            index = self._queue_target_index(queue, arguments)
            if op == "front":
                target = 0
            else:
                target = (queue["current_index"] + 1) if queue["current_index"] >= 0 else 0
                target = min(target, len(items))
            if index == -1:
                if not arguments.get("query") and not arguments.get("video_id"):
                    raise RuntimeError("Name a track to prioritise in the queue (nothing is playing yet).")
                track = self._queue_lookup(arguments)
                items.insert(min(target, len(items)), track)
                self._queue_keep_current(queue, current_id)
                self._queue_save(queue)
                where = "the front of the queue" if op == "front" else "next up"
                return {"queue": items, "queue_index": queue["current_index"], "count": len(items),
                        "video_id": track["video_id"], "title": track["title"], "artist": track["artist"],
                        **self._queue_state(queue),
                        "message": f"Queued “{track['title'] or track['video_id']}” at {where}."}
            track = items.pop(index)
            if index < target:
                target -= 1
            items.insert(min(target, len(items)), track)
            self._queue_keep_current(queue, current_id)
            self._queue_save(queue)
            where = "the front of the queue" if op == "front" else f"position {target + 1} (next up)"
            return {"queue": items, "queue_index": queue["current_index"], "count": len(items),
                    "video_id": track["video_id"], "title": track["title"], "artist": track["artist"],
                    **self._queue_state(queue),
                    "message": f"Moved “{track['title'] or track['video_id']}” to {where}."}
        raise ValueError(f"Unsupported queue op '{op}'.")

    # ── Library ───────────────────────────────────────────────────────────
    def _linked_library(self) -> dict[str, Any]:
        """The linked account's YouTube Music library — what OpenDeck itself shows.

        OpenDeck's own ``/api/library`` store is a smaller, separate set (the
        playlists and likes created through OpenDeck and its API), so it is
        merged *after* the linked library instead of replacing it. An unlinked
        or unreachable account leaves the store as the only source — but a read
        that *failed* is remembered (``linked_library_degraded``), because an
        answer built from the store alone is missing the user's own playlists
        and must not be cached as if it were the whole library.
        """
        if not self.youtube_linked:
            return {}
        try:
            data = self._json("GET", "/api/youtube/library")
        except RuntimeError:
            self.linked_library_degraded = True
            return {}
        return data if isinstance(data, dict) else {}

    # ── Library cache ─────────────────────────────────────────────────────
    # The store is one JSON file under the worker's data directory, read and
    # rewritten whole. The worker serves one request at a time on one event loop,
    # so no lock is needed here; the rewrite is atomic (temp file + os.replace) so
    # a console restarting mid-write cannot leave a half-written cache behind.
    def _cache_entries(self) -> dict[str, Any]:
        try:
            with open(LIBRARY_CACHE_FILE, "r", encoding="utf-8") as handle:
                saved = json.load(handle)
        except (OSError, json.JSONDecodeError):
            return {}
        entries = saved.get("entries") if isinstance(saved, dict) else None
        return entries if isinstance(entries, dict) else {}

    def _cache_entry(self, key: str) -> dict[str, Any] | None:
        entry = self._cache_entries().get(key)
        return entry if isinstance(entry, dict) else None

    def _cache_read(self, key: str) -> tuple[dict[str, Any] | None, str, float | None]:
        """One library read through the cache: ``(payload, status, age)``.

        ``status`` is ``hit`` for a copy younger than the TTL, ``stale`` for one
        that may be served while it is refreshed, and ``miss`` when there is
        nothing on disk for this read.
        """
        entry = self._cache_entry(key)
        payload = entry.get("payload") if entry else None
        saved_at = entry.get("saved_at") if entry else None
        if not isinstance(payload, dict) or not isinstance(saved_at, (int, float)):
            return None, "miss", None
        age = max(0.0, time.time() - float(saved_at))
        return payload, ("hit" if age < LIBRARY_TTL_SECONDS else "stale"), age

    def _cache_backing_off(self, key: str) -> bool:
        """Whether this read's refresh just failed and should not be retried yet."""
        entry = self._cache_entry(key)
        if not entry or not entry.get("last_error"):
            return False
        last_attempt = entry.get("last_attempt")
        if not isinstance(last_attempt, (int, float)):
            return False
        return (time.time() - float(last_attempt)) < CACHE_RETRY_AFTER

    def _cache_failed(self, key: str, error: Exception) -> None:
        """Note a failed refresh so the next read leaves the provider alone."""
        entries = self._cache_entries()
        entry = entries.get(key)
        if not isinstance(entry, dict):
            return
        entry["attempts"] = int(entry.get("attempts") or 0) + 1
        entry["last_attempt"] = time.time()
        entry["last_error"] = f"{type(error).__name__}: {str(error)[:160]}"
        self._cache_store(entries)

    def _cache_write(self, key: str, payload: dict[str, Any]) -> None:
        entries = self._cache_entries()
        # A fresh answer clears the failure that was recorded for this read.
        entries[key] = {"saved_at": time.time(), "payload": payload, "attempts": 0, "last_attempt": 0.0, "last_error": ""}
        if len(entries) > CACHE_MAX_ENTRIES:
            # Drop the oldest reads first: a browsing session touches a handful
            # of kinds, and the playlist opened once an hour ago is the one to
            # give up before the list the page is actually showing.
            order = sorted(entries, key=lambda name: (entries[name] or {}).get("saved_at") or 0)
            for stale_key in order[: len(entries) - CACHE_MAX_ENTRIES]:
                entries.pop(stale_key, None)
        self._cache_store(entries)

    def _cache_store(self, entries: dict[str, Any]) -> None:
        directory = os.path.dirname(LIBRARY_CACHE_FILE)
        if directory:
            os.makedirs(directory, exist_ok=True)
        temporary = f"{LIBRARY_CACHE_FILE}.{os.getpid()}.tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump({"entries": entries}, handle, ensure_ascii=False)
        os.replace(temporary, LIBRARY_CACHE_FILE)

    def _cache_forget(self, prefixes: tuple[str, ...] | None = None) -> None:
        """Drop cached reads; every one of them when no prefix is given.

        A write changes one part of the library, so only the reads that answer
        with that part are dropped: liking a song does not invalidate the
        playlists the panel is looking at. A kind this build does not recognise
        still drops the lot, which is what every write used to do.
        """
        if not prefixes:
            try:
                os.remove(LIBRARY_CACHE_FILE)
            except OSError:
                pass
            return
        entries = self._cache_entries()
        keep = {
            key: value
            for key, value in entries.items()
            if not any(key.startswith(prefix) for prefix in prefixes)
        }
        if len(keep) == len(entries):
            return
        self._cache_store(keep)

    def _linked_playlist_ids(self) -> set[str]:
        return {
            item["playlist_id"]
            for item in (
                _playlist_summary(entry)
                for entry in (self._linked_library().get("playlists") or [])
            )
            if item
        }

    def _store_playlists(self) -> list[dict[str, Any]]:
        """Playlists in this instance's own store (created through OpenDeck)."""
        try:
            data = self._json("GET", "/api/library/playlists")
        except RuntimeError:
            return []
        return [
            item
            for item in (_playlist_summary(entry) for entry in (data.get("playlists") or []))
            if item
        ]

    def _liked_tracks(self, library: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """The account's liked songs, as the linked library lists them.

        Falling back to the API-key store keeps liked songs (and like/unlike)
        working on an instance whose YouTube account is not linked.
        """
        linked = self._linked_library() if library is None else library
        if linked:
            return [
                item
                for item in (_linked_track(entry) for entry in (linked.get("likedSongs") or []))
                if item
            ]
        data = self._json("GET", "/api/library/likes")
        return [
            item
            for item in (_library_track(entry) for entry in (data.get("likedSongs") or []))
            if item
        ]

    def _playlists(self) -> list[dict[str, Any]]:
        """Playlists to browse: the linked library's, then this instance's own.

        Liked songs are an auto playlist in a YouTube Music library (id LM). It
        is offered once, first and under its own name, exactly as OpenDeck's
        client offers it, and opening it returns the liked songs.
        """
        library = self._linked_library()
        entries = [
            item
            for item in (_playlist_summary(entry) for entry in (library.get("playlists") or []))
            if item
        ]
        liked_count = next(
            (item["track_count"] for item in entries if item["playlist_id"] == LIKED_PLAYLIST_ID),
            0,
        )
        liked_entry = next(
            (item for item in entries if item["playlist_id"] == LIKED_PLAYLIST_ID), None
        )
        linked = [item for item in entries if item["playlist_id"] != LIKED_PLAYLIST_ID]
        seen = {item["playlist_id"] for item in linked}
        stored = [item for item in self._store_playlists() if item["playlist_id"] not in seen]
        if not liked_count:
            liked = self._liked_tracks(library)
            liked_count = len(liked)
            # Liked Music is an auto playlist with no artwork of its own on some
            # accounts; the first liked song's cover is what its own client uses
            # as the tile, and it is already in hand. No extra request.
            liked_art = next((item["artwork_url"] for item in liked if item["artwork_url"]), "")
        else:
            liked_art = ""
        return [
            {
                "playlist_id": LIKED_PLAYLIST_ID,
                "name": LIKED_PLAYLIST_NAME,
                "track_count": liked_count,
                "artwork_url": (liked_entry or {}).get("artwork_url") or liked_art,
            },
            *linked,
            *stored,
        ]

    def browse_playlist(self, playlist_id: str) -> list[dict[str, Any]]:
        """Tracks of one YouTube Music playlist, through the catalog proxy.

        Playlists that belong to the linked account live in YouTube, not in the
        OpenDeck store, so they are read the same way search is: an anonymous
        WEB_REMIX browse of ``VL<playlistId>``, whose rows are the same
        musicResponsiveListItemRenderer shape search returns.
        """
        client = self._music_client_config()
        url = "https://music.youtube.com/youtubei/v1/browse?prettyPrint=false"
        if client["key"]:
            url += f"&key={client['key']}"
        body = {
            "context": {
                "client": {
                    "clientName": "WEB_REMIX",
                    "clientVersion": client["version"],
                    "hl": "en",
                    "gl": "US",
                }
            },
            "browseId": playlist_id if playlist_id.startswith("VL") else f"VL{playlist_id}",
        }
        payload = self._proxy(url, body=body)
        try:
            data = json.loads(payload.decode("utf-8", "replace"))
        except json.JSONDecodeError as exc:
            raise RuntimeError("OpenDeck's catalog returned an unreadable playlist response.") from exc
        shelf = _find_renderer(data, "musicPlaylistShelfRenderer")
        return _parse_search_tracks(shelf if shelf is not None else data)

    def _stored_playlist_tracks(self, playlist_id: str) -> list[dict[str, Any]]:
        """Tracks of one playlist from this instance's own store."""
        data = self._json(
            "GET", f"/api/library/playlists/{urllib.parse.quote(playlist_id, safe='')}"
        )
        return [
            item for item in (_library_track(entry) for entry in (data.get("tracks") or [])) if item
        ]

    def _playlist_tracks(self, playlist_id: str) -> list[dict[str, Any]]:
        """Tracks of one playlist: the liked list, a linked playlist, or a stored one."""
        if playlist_id == LIKED_PLAYLIST_ID:
            return self._liked_tracks()
        if playlist_id in self._linked_playlist_ids():
            tracks = self.browse_playlist(playlist_id)
            if tracks:
                return tracks
            # The catalog served nothing for a playlist of the linked account:
            # some of those it will not hand over anonymously at all (a private
            # list, a listening recap). The instance's own store may still hold
            # it, and a row of songs is better than an empty shelf.
            try:
                return self._stored_playlist_tracks(playlist_id)
            except RuntimeError:
                return []
        try:
            return self._stored_playlist_tracks(playlist_id)
        except RuntimeError as exc:
            # Not in this instance's own store: it may still be a playlist of the
            # linked library that the snapshot did not list (a read that failed,
            # a playlist shared with the account), so browse it before giving up.
            if "HTTP 404" not in str(exc):
                raise
            tracks = self.browse_playlist(playlist_id)
            if tracks:
                return tracks
            raise

    def library(self, kind: str, playlist_id: str, limit: int) -> dict[str, Any]:
        """A library read, answered from this worker's cache when it is warm.

        The page (and the panel) paint a cached list instantly and ask again in
        the background, so this handler only has to be fast on the repeat and
        honest on the failure:

        * a fresh copy is returned as-is, with no provider call at all;
        * a stale copy is refreshed — unless the last refresh failed, in which
          case the copy is served as-is until the backing-off window has passed,
          so a provider that is down is not browsed again on every poll;
        * a copy is only kept when that refresh fails, so an offline instance
          degrades to slightly old data instead of an error, and its failure is
          recorded for the next reader to back off from; and
        * an answer missing the linked account (a failed browse, not an empty
          library) never becomes the cached copy.
        """
        self.linked_library_degraded = False
        key = f"{kind}:{playlist_id}:{limit}"
        cached, status, _age = self._cache_read(key)
        if status == "hit":
            return cached
        if status == "stale" and self._cache_backing_off(key):
            return cached
        try:
            payload = self._library_read(kind, playlist_id, limit)
        except RuntimeError as exc:
            if cached is not None:
                self._cache_failed(key, exc)
                return cached
            raise
        if self.linked_library_degraded:
            # Store-only because the account's own music library did not answer:
            # keep it out of the cache and prefer the older, complete copy.
            return cached if cached is not None else payload
        self._cache_write(key, payload)
        return payload

    def _library_read(self, kind: str, playlist_id: str, limit: int) -> dict[str, Any]:
        if kind == "playlists":
            playlists = self._playlists()
            return {"playlists": playlists[:limit], "count": len(playlists)}
        if kind == "playlist":
            if not playlist_id:
                raise ValueError("library kind 'playlist' needs a playlist_id from a previous call.")
            tracks = self._playlist_tracks(playlist_id)
            return {"tracks": tracks[:limit], "count": len(tracks)}
        if kind == "likes":
            tracks = self._liked_tracks()
            return {"tracks": tracks[:limit], "count": len(tracks)}
        if kind == "history":
            data = self._json("GET", f"/api/history?limit={max(1, min(limit, 50))}")
            tracks = [_history_track(item) for item in (data.get("plays") or [])]
            tracks = [item for item in tracks if item]
            return {"tracks": tracks[:limit], "count": len(tracks)}
        if kind == "frequent":
            # Most played, ranked from the account's own play log. The instance's
            # stats endpoint ranks ten of them; the log itself holds the whole
            # picture (up to 200 plays), so the ranking is built here — how many
            # times each song was played — with the newest play breaking a tie.
            data = self._json("GET", f"/api/history?limit={max(1, min(limit, 200))}")
            ranked: list[dict[str, Any]] = []
            seen: dict[str, dict[str, Any]] = {}
            for item in (data.get("plays") or []):
                track = _history_track(item)
                if not track:
                    continue
                counted = seen.get(track["video_id"])
                if counted is None:
                    counted = {**track, "plays": 0}
                    seen[track["video_id"]] = counted
                    ranked.append(counted)
                counted["plays"] += 1
            ranked.sort(key=lambda track: track["plays"], reverse=True)
            return {"tracks": ranked[:limit], "count": len(ranked)}
        if kind == "stats":
            data = self._json("GET", "/api/history/stats")
            top = ((data.get("topTracks") or [None])[0]) or {}
            return {
                "count": int(data.get("totalPlays") or 0),
                "title": _text(top.get("title"), 300),
                "artist": _text(top.get("artist"), 200),
            }
        raise ValueError(f"Unsupported library kind '{kind}'.")

    # ── Lyrics ────────────────────────────────────────────────────────────
    @staticmethod
    def parse_synced_lyrics(lrc: str) -> list[dict[str, Any]]:
        """Parse an LRC body into timed lines (multiple stamps per line allowed)."""
        lines: list[dict[str, Any]] = []
        for raw in str(lrc or "").splitlines():
            stamps = list(_LRC_STAMP_PATTERN.finditer(raw))
            if not stamps:
                continue
            # One source line can carry several stamps ("[00:08.00][00:12.00] words");
            # the words belong to every stamp, and metadata tags such as
            # "[ar:Queen]" are not stamps at all.
            text = _text(raw[stamps[-1].end():], 400)
            for stamp in stamps:
                minutes, seconds, fraction = stamp.groups()
                hundredths = int((fraction or "0").ljust(2, "0")[:2])
                time_sec = int(minutes) * 60 + int(seconds) + hundredths / 100.0
                lines.append({"time_sec": round(time_sec, 2), "text": text})
        lines.sort(key=lambda item: item["time_sec"])
        return lines[:LYRICS_MAX_LINES]

    def lyrics(self, arguments: dict[str, Any]) -> dict[str, Any]:
        """Lyrics for a track, fetched through OpenDeck's proxy.

        LRCLIB matches on names and lengths, never on a video id, so the track is
        established first: the caller's own title/artist/album/duration when it
        named a track, and the id resolved through the player when the name and
        length are missing (an id-only request, or the console passing one on).

        The provider is then asked for an exact match (title + artist + length,
        which is what its /api/get needs), and its search endpoint is used as the
        fallback. Every candidate has to be *this* track before its words are
        returned — the name has to be the one asked for and the length has to be
        within ``LYRICS_DURATION_TOLERANCE`` — because a near-miss here is not a
        missing answer, it is another song's words shown as this one's.

        A track the provider only has words (not timings) for answers with
        ``lyrics_timing: "plain"`` and the text in ``lyrics_plain``: the page and
        the wall display both render that, and telling a person "no lyrics" about
        a song whose words are sitting right there is not an answer.
        """
        video_id = _text(arguments.get("video_id"), 64)
        title = _text(arguments.get("title"), 300)
        artist = _text(arguments.get("artist"), 200)
        album = _text(arguments.get("album"), 300)
        try:
            duration = int(arguments.get("duration_sec") or 0)
        except (TypeError, ValueError):
            duration = 0
        if not title and not video_id:
            # No track was named: answer for the track this worker last handed
            # over, which is what "show me the lyrics" means while music plays.
            remembered = self._remembered_track()
            video_id = remembered.get("video_id", "")
            title = remembered.get("title", "")
            artist = artist or remembered.get("artist", "")
            album = album or remembered.get("album", "")
            duration = duration or remembered.get("duration_sec") or 0
            if not title and not video_id:
                raise ValueError(
                    "lyrics needs a track title or a video_id: nothing has been played yet."
                )
        if video_id and (not title or not duration):
            # The provider is queried by name and matches on length, so a request
            # that arrives with only an id (or without a length) is resolved here
            # rather than guessed at.
            resolved = self.resolve(video_id)
            title = title or resolved["title"]
            artist = artist or _clean_artist(resolved["artist"])
            duration = duration or resolved["duration_sec"]
        queries = [{"track_name": title, "artist_name": artist}] if artist else []
        queries.append({"track_name": title})
        candidates: list[dict[str, Any]] = []
        for query in queries:
            params = dict(query)
            if album and "artist_name" in query:
                params["album_name"] = album
            if duration:
                params["duration"] = str(duration)
            match = None
            try:
                payload = self._proxy(
                    "https://lrclib.net/api/get?" + urllib.parse.urlencode(params),
                    method="GET",
                    timeout_ms=LYRICS_TIMEOUT_MS,
                )
            except RuntimeError:
                payload = b"{}"
            try:
                loaded = json.loads(payload.decode("utf-8", "replace"))
            except json.JSONDecodeError:
                loaded = None
            if isinstance(loaded, dict) and (loaded.get("syncedLyrics") or loaded.get("plainLyrics")):
                match = loaded
                candidates.append(loaded)
            if match is not None and match.get("syncedLyrics"):
                # An exact match with timings is the best this provider offers: no
                # search can improve on it, and each one costs a round trip.
                break
            try:
                listing = self._proxy(
                    "https://lrclib.net/api/search?" + urllib.parse.urlencode(query),
                    method="GET",
                    timeout_ms=LYRICS_TIMEOUT_MS,
                )
            except RuntimeError:
                continue
            try:
                found = json.loads(listing.decode("utf-8", "replace"))
            except json.JSONDecodeError:
                continue
            if isinstance(found, list):
                candidates.extend(item for item in found if isinstance(item, dict))
        best: dict[str, Any] | None = None
        best_key: tuple[int, float, int] | None = None
        for candidate in candidates:
            synced = bool(candidate.get("syncedLyrics"))
            if not synced and not candidate.get("plainLyrics"):
                continue
            if not _lyrics_name_matches(title, candidate.get("trackName") or candidate.get("name")):
                continue
            delta: float | None = None
            if isinstance(candidate.get("duration"), (int, float)):
                if not duration:
                    delta = 0.0
                else:
                    delta = abs(float(candidate["duration"]) - duration)
                    if delta > LYRICS_DURATION_TOLERANCE:
                        continue
            # Timed words first, then the closest length (a candidate with no
            # length at all is the last resort), then the likelier artist. The
            # order the provider returned is what settles the rest.
            key = (
                0 if synced else 1,
                delta if delta is not None else float("inf"),
                0 if _lyrics_name_matches(artist, candidate.get("artistName")) else 1,
            )
            if best_key is None or key < best_key:
                best, best_key = candidate, key
        if best is None:
            return {"lyrics": [], "lyrics_plain": "", "lyrics_timing": "none", "lyrics_source": "LRCLIB",
                    "count": 0}
        lines = self.parse_synced_lyrics(best.get("syncedLyrics") or "")
        if not lines:
            plain = _lyrics_text(best.get("plainLyrics"), LYRICS_PLAIN_CHARS)
            return {"lyrics": [], "lyrics_plain": plain,
                    "lyrics_timing": "plain" if plain else "none",
                    "lyrics_source": "LRCLIB", "count": 0}
        return {
            "lyrics": lines,
            "lyrics_plain": _lyrics_text(best.get("plainLyrics"), LYRICS_PLAIN_CHARS),
            "lyrics_timing": "synced",
            "lyrics_source": "LRCLIB",
            "count": len(lines),
        }

    def save(self, kind: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Write to the user's OpenDeck library, then drop the cached reads.

        Everything here is phrased for a person asking out loud — "like this
        song", "add this to my Late Night playlist" — so the track can be the one
        that is playing (named by no argument at all), and the playlist can be a
        name rather than an id the caller would have to look up first.
        """
        result = self._save(kind, arguments)
        self._cache_forget(_invalidated_reads(kind))
        return result

    def _save(self, kind: str, arguments: dict[str, Any]) -> dict[str, Any]:
        video_id = _text(arguments.get("video_id"), 64)
        if kind in {"like", "unlike", "playlist_add"} and not _VIDEO_ID_PATTERN.fullmatch(video_id):
            # "this song" is the one this worker last handed to the speaker. The
            # console fills the id in for the page, but a spoken request names no
            # id at all, and asking the user for one would be absurd.
            remembered = self._remembered_track()
            video_id = _text(remembered.get("video_id"), 64)
            for key in ("title", "artist", "album"):
                if not arguments.get(key) and remembered.get(key):
                    arguments = {**arguments, key: remembered.get(key)}
            if not _VIDEO_ID_PATTERN.fullmatch(video_id):
                if kind == "playlist_add":
                    raise ValueError(
                        "Nothing is playing and no video_id was given, so there is no track to add."
                    )
                raise ValueError("save needs a video_id from a search result.")
        if kind in {"like", "unlike"}:
            if kind == "like":
                body = {
                    "id": video_id,
                    "title": _text(arguments.get("title"), 300) or video_id,
                    "artist": _text(arguments.get("artist"), 200),
                }
                data = self._json("PUT", f"/api/library/likes/{urllib.parse.quote(video_id, safe='')}", body=body)
            else:
                data = self._json("DELETE", f"/api/library/likes/{urllib.parse.quote(video_id, safe='')}")
            return {"count": int(data.get("total") or 0)}
        if kind == "playlist_create":
            name = _text(arguments.get("name"), 120)
            if not name:
                raise ValueError("save kind 'playlist_create' needs a name.")
            data = self._json("POST", "/api/library/playlists", body={"name": name})
            playlist = data.get("playlist") if isinstance(data.get("playlist"), dict) else {}
            return {
                "playlists": [_playlist_summary(playlist)] if playlist else [],
                "count": 1,
                "title": _text(playlist.get("name") or name, 300),
            }
        if kind == "playlist_add":
            playlist_id = _text(arguments.get("playlist_id"), 100)
            name = _text(arguments.get("name"), 120)
            created = ""
            if not playlist_id:
                resolved = self._playlist_named(name)
                if resolved is None:
                    raise ValueError(
                        "save kind 'playlist_add' needs a playlist_id, or the name of one to add to."
                    )
                playlist_id, created = resolved
            if playlist_id == LIKED_PLAYLIST_ID:
                # "add this to my Liked Music" is a like: liked songs are filled
                # by the like control, and the provider refuses a write to LM.
                return {**self._save("like", {**arguments, "video_id": video_id}),
                        "title": LIKED_PLAYLIST_NAME}
            track = {
                "id": video_id,
                "source": "youtube",
                "title": _text(arguments.get("title"), 300) or video_id,
                "artist": _text(arguments.get("artist"), 200),
            }
            if arguments.get("album"):
                track["album"] = _text(arguments.get("album"), 300)
            data = self._json(
                "POST",
                f"/api/library/playlists/{urllib.parse.quote(playlist_id, safe='')}/tracks",
                body={"tracks": [track]},
            )
            count = int(data.get("trackCount") or 0)
            return {
                "count": count,
                "title": created or self._playlist_name_for(playlist_id) or _text(arguments.get("name"), 300),
                # Only a playlist this call created is reported back as a row: it
                # is what the assistant says out loud ("saved it in the Focus
                # playlist I made for you"), and an existing one needs no
                # announcement.
                "playlists": (
                    [{"playlist_id": playlist_id, "name": created, "track_count": count, "artwork_url": ""}]
                    if created else []
                ),
            }
        raise ValueError(f"Unsupported save kind '{kind}'.")

    def _playlist_named(self, name: str) -> tuple[str, str] | None:
        """The id of the playlist a spoken name means, creating it if it is new.

        Returns `(playlist_id, created_name)`, where `created_name` is non-empty
        only when this call made the playlist, so the reply can say so instead of
        pretending the user already had one. Names are matched case-insensitively
        against the linked account's playlists and this instance's own store, so
        "add this to my late night" finds "Late Night".
        """
        wanted = _playlist_reference(name)
        if not wanted:
            return None
        if _LIKED_REFERENCE_PATTERN.fullmatch(wanted.casefold()):
            return LIKED_PLAYLIST_ID, ""
        try:
            playlists = self._playlists()
        except RuntimeError:
            playlists = []
        for playlist in playlists:
            existing = _text(playlist.get("name"), 300)
            if existing.casefold() == wanted.casefold():
                return playlist["playlist_id"], ""
        data = self._json("POST", "/api/library/playlists", body={"name": wanted})
        playlist = data.get("playlist") if isinstance(data.get("playlist"), dict) else {}
        new_id = _text(playlist.get("id") or data.get("id"), 100)
        if not new_id:
            raise RuntimeError(
                f"OpenDeck could not create a playlist called “{wanted}”, so the track was not added."
            )
        return new_id, _text(playlist.get("name") or wanted, 300)

    def _playlist_name_for(self, playlist_id: str) -> str:
        """The name of one playlist, when a reply wants to say where a track went."""
        if playlist_id == LIKED_PLAYLIST_ID:
            return LIKED_PLAYLIST_NAME
        try:
            playlists = self._playlists()
        except RuntimeError:
            return ""
        for playlist in playlists:
            if playlist.get("playlist_id") == playlist_id:
                return _text(playlist.get("name"), 300)
        return ""

    # ── Tool surface ──────────────────────────────────────────────────────
    @staticmethod
    def _validate_tool_arguments(arguments: Any) -> dict[str, Any]:
        if not isinstance(arguments, dict) or not isinstance(arguments.get("action"), str):
            raise ValueError("opendeck_music arguments must be an object with a string action")
        action = arguments["action"]
        allowed = {
            "search": {"action", "query", "limit"},
            "library": {"action", "kind", "playlist_id", "limit"},
            "play": {"action", "query", "video_id"},
            "save": {"action", "kind", "video_id", "title", "artist", "album", "playlist_id", "name"},
            "lyrics": {"action", "video_id", "title", "artist", "album", "duration_sec"},
            "queue": {"action", "op", "query", "video_id", "playlist_id", "index", "to", "on", "mode", "auto"},
            "now_playing": {"action"},
        }
        if action not in allowed:
            raise ValueError(f"Unsupported OpenDeck action '{action}'")
        extra = set(arguments) - allowed[action]
        if extra:
            raise ValueError(f"Unsupported {action} arguments: {', '.join(sorted(extra))}")
        checked = dict(arguments)
        if action == "search":
            query = _text(checked.get("query"), MAX_QUERY_CHARS)
            if not query:
                raise ValueError("search needs a query.")
            checked["query"] = query
            checked["limit"] = _clamp_limit(checked.get("limit"))
        elif action == "library":
            # A library read is a list to browse, not a page of answers, so it
            # may ask for far more than a search may.
            kind = checked.get("kind")
            if kind not in {"playlists", "playlist", "likes", "history", "frequent", "stats"}:
                raise ValueError("library kind must be playlists, playlist, likes, history, frequent, or stats")
            checked["kind"] = kind
            checked["limit"] = _clamp_limit(checked.get("limit"), MAX_LIBRARY_RESULTS)
            if "playlist_id" in checked:
                checked["playlist_id"] = _text(checked["playlist_id"], 100)
        elif action == "play":
            query = _text(checked.get("query"), MAX_QUERY_CHARS)
            video_id = _text(checked.get("video_id"), 64)
            if not query and not _VIDEO_ID_PATTERN.fullmatch(video_id):
                raise ValueError("play needs a query or a video_id from a search result.")
            checked["query"] = query
            checked["video_id"] = video_id
        elif action == "lyrics":
            for key, limit in (("title", 300), ("artist", 200), ("album", 300)):
                if key in checked:
                    checked[key] = _text(checked[key], limit)
            checked["video_id"] = _text(checked.get("video_id"), 64)
            if "duration_sec" in checked:
                try:
                    checked["duration_sec"] = max(0, min(100000, int(checked["duration_sec"])))
                except (TypeError, ValueError) as exc:
                    raise ValueError("lyrics duration_sec must be a whole number of seconds.") from exc
            # No target is not a validation error: with nothing named, the
            # handler answers for the track this worker last handed over, and
            # reports plainly when nothing has played yet.
        elif action == "queue":
            op = checked.get("op")
            if op not in {
                "list", "clear", "add", "remove", "play", "next", "move", "front", "next_up", "shuffle", "repeat",
                "add_range",
            }:
                raise ValueError(
                    "queue op must be list, clear, add, remove, play, next, move, front, next_up, shuffle, repeat, "
                    "or add_range"
                )
            checked["op"] = op
            if "playlist_id" in checked:
                checked["playlist_id"] = _text(checked["playlist_id"], 100)
            if op == "add_range" and not checked.get("playlist_id"):
                # The songs to queue come from the playlist the button sat in, so
                # the playlist is the one thing this op cannot do without.
                raise ValueError("add_range needs the playlist_id the song came from.")
            if "on" in checked and not isinstance(checked["on"], bool):
                # Refused rather than coerced: "on": "off" is a caller bug, not
                # a request to shuffle.
                raise ValueError("queue shuffle 'on' must be true or false")
            if "mode" in checked and checked["mode"] is not None and checked["mode"] not in REPEAT_MODES:
                raise ValueError("queue repeat mode must be off, all, or one")
            if "auto" in checked and not isinstance(checked["auto"], bool):
                raise ValueError("queue 'auto' must be true or false")
            if op == "add":
                query = _text(checked.get("query"), MAX_QUERY_CHARS)
                video_id = _text(checked.get("video_id"), 64)
                if not query and not _VIDEO_ID_PATTERN.fullmatch(video_id):
                    raise ValueError("queue add needs a query or a video_id from a search result.")
                checked["query"] = query
                checked["video_id"] = video_id
            if op in {"remove", "play", "move"}:
                if op == "remove" and checked.get("index") is None:
                    # "remove Believer from the queue": the track is named, not
                    # numbered, and it is resolved against the queue when the
                    # op runs (exactly like "move <song> to the front").
                    query = _text(checked.get("query"), MAX_QUERY_CHARS)
                    video_id = _text(checked.get("video_id"), 64)
                    if not query and not _VIDEO_ID_PATTERN.fullmatch(video_id):
                        raise ValueError("queue remove needs an index, a query, or a video_id")
                    checked["query"] = query
                    checked["video_id"] = video_id
                else:
                    try:
                        index = int(checked.get("index"))
                    except (TypeError, ValueError) as exc:
                        raise ValueError(f"queue {op} needs an integer index") from exc
                    if not 0 <= index < MAX_QUEUE:
                        raise ValueError(f"queue {op} index must be from 0 to {MAX_QUEUE - 1}")
                    checked["index"] = index
            if op == "move":
                try:
                    to = int(checked.get("to"))
                except (TypeError, ValueError) as exc:
                    raise ValueError("queue move needs an integer 'to' position") from exc
                if not 0 <= to < MAX_QUEUE:
                    raise ValueError(f"queue move 'to' must be from 0 to {MAX_QUEUE - 1}")
                checked["to"] = to
            if op in {"front", "next_up"}:
                # A track to prioritise: named by index, or by query/video_id.
                # Naming nothing ("play this next") prioritises the current track.
                if checked.get("index") is not None:
                    try:
                        checked["index"] = max(0, min(MAX_QUEUE - 1, int(checked["index"])))
                    except (TypeError, ValueError) as exc:
                        raise ValueError(f"queue {op} index must be a whole number") from exc
                else:
                    checked["query"] = _text(checked.get("query"), MAX_QUERY_CHARS)
                    checked["video_id"] = _text(checked.get("video_id"), 64)
                    if _SELF_TRACK_PATTERN.fullmatch(checked["query"].strip()):
                        # "play this song next" names the track already playing.
                        checked["query"] = ""
                    if not checked["query"] and not _VIDEO_ID_PATTERN.fullmatch(checked["video_id"]):
                        checked["video_id"] = ""
        elif action == "save":
            kind = checked.get("kind")
            if kind not in {"like", "unlike", "playlist_create", "playlist_add"}:
                raise ValueError("save kind must be like, unlike, playlist_create, or playlist_add")
            checked["kind"] = kind
            for key, limit in (("title", 300), ("artist", 200), ("album", 300), ("playlist_id", 100), ("name", 120)):
                if key in checked:
                    checked[key] = _text(checked[key], limit)
            video_id = _text(checked.get("video_id"), 64)
            checked["video_id"] = video_id
            # A like or a playlist add may name no track at all ("like this
            # song"): the handler falls back to the track that is playing. Only
            # a playlist add with no destination is unanswerable, and a
            # destination of Liked Music is a like, which the handler resolves.
            if kind == "playlist_add" and not (checked.get("playlist_id") or checked.get("name")):
                raise ValueError("save kind 'playlist_add' needs a playlist_id or a name")
            if kind == "playlist_create" and not checked.get("name"):
                raise ValueError("save kind 'playlist_create' needs a name")
        return checked

    async def handle(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
        if operation == "match":
            return {"match": self._arguments(str(payload.get("text") or ""))}
        if operation == "execute":
            if payload.get("tool") != "opendeck_music" or not isinstance(payload.get("arguments"), dict):
                raise ValueError("Only the declared opendeck_music tool is available.")
            arguments = self._validate_tool_arguments(payload["arguments"])
            return {"result": await self._execute(arguments)}
        raise ValueError("Unsupported operation.")

    def _arguments(self, text: str) -> dict[str, Any]:
        """Deterministic fallback matcher for a single free-text request."""
        cleaned = _text(text, 400)
        lowered = cleaned.casefold()
        if "playlist" in lowered and ("create" in lowered or "make" in lowered):
            name = _PLAYLIST_NAME_PATTERN.search(cleaned)
            return {
                "action": "save",
                "kind": "playlist_create",
                "name": (_request_subject(name.group(1)) if name else cleaned)[:120],
            }
        # "add Believer to my queue", "queue up Believer": a track lined up to
        # play after this one, which is the queue's add operation — not a search
        # and not a save into a playlist. Bare "add this to the queue" means the
        # track that is playing.
        queued = _queue_add_query(cleaned)
        if queued is not None:
            return {"action": "queue", "op": "add", "query": queued}
        # "shuffle the queue", "repeat this song": the queue's own listening
        # preferences, which the page drives by op. Checked before the queue verb
        # below, so "shuffle the queue now" is a shuffle and not an add of
        # "shuffle".
        preference = _queue_preference(cleaned)
        if preference is not None:
            return preference
        # "queue Believer": the verb is the queue, not a play. It is answered as
        # an add, which is what the documented phrase has always meant.
        if lowered.startswith("queue ") or re.search(r"\bqueue\s+(?:up\s+)?[^\s]", lowered):
            subject = _request_subject(cleaned)
            if subject and not _names_nothing(subject):
                return {"action": "queue", "op": "add", "query": subject[:MAX_QUERY_CHARS]}
        destination = _save_destination(cleaned)
        if destination is not None:
            return destination
        if lowered.startswith("unlike ") or " unlike " in lowered:
            return {"action": "save", "kind": "unlike", "title": cleaned}
        if lowered.startswith("like ") or " like " in lowered:
            return {"action": "save", "kind": "like", "title": cleaned}
        # "add this to my likes", "save it in my favourites": the destination is
        # the like list, said without the word "add … to a playlist".
        if re.search(r"\b(?:add|save|put|drop)\b", lowered) and _LIKED_REFERENCE_PATTERN.search(lowered):
            return {"action": "save", "kind": "like"}
        if any(needle in lowered for needle in ("lyrics", "song words", "the words to", "sing along")):
            # "show me the lyrics" names no track: leave the title empty so the
            # handler answers for the track that is playing (or last played).
            subject = _lyrics_subject(cleaned)
            return {"action": "lyrics", "title": subject} if subject else {"action": "lyrics"}
        if any(needle in lowered for needle in (
            "what's playing", "what is playing", "what song is playing", "whats playing",
            "now playing", "currently playing", "what am i listening to",
            "what song is this", "what tune is this",
        )):
            return {"action": "now_playing"}
        # "play <song> next / first" prioritises that track in the queue rather
        # than starting it immediately. A bare "play next" advances the queue.
        priority = re.search(r"\bplay\s+(?:the\s+)?(.+?)\s+(?:next|first)\b", cleaned, re.IGNORECASE)
        if priority is not None:
            subject = _request_subject(priority.group(1)) or priority.group(1).strip()
            op = "next_up" if re.search(r"\bnext\b", priority.group(0), re.IGNORECASE) else "front"
            if subject and not _names_nothing(subject):
                return {"action": "queue", "op": op, "query": subject[:MAX_QUERY_CHARS]}
            # Nothing was named: "play this next" prioritises whatever is
            # playing, while "play the next song" asks for the queue's own next
            # entry, which is an advance.
            if op == "next_up" and subject.strip() and not _SELF_TRACK_PATTERN.fullmatch(subject.strip()):
                return {"action": "queue", "op": "next"}
            return {"action": "queue", "op": op}
        if re.search(
            r"\b(?:play\s+next|next\s+track|next\s+queued|up\s+next|"
            r"play\s+the\s+next\s+(?:queued\s+)?(?:song|track|one)|"
            r"skip\s+(?:this\s+)?(?:track|song|one))\b",
            lowered,
        ):
            return {"action": "queue", "op": "next"}
        # The queue as a topic, once every request that names a track to add,
        # prioritise or play has had its turn above.
        if _QUEUE_TOPIC_PATTERN.search(lowered):
            removed = _QUEUE_REMOVE_PATTERN.search(cleaned)
            if removed is not None:
                subject = removed.group("subject").strip(" .,:;!?-\"'")
                numbered = re.fullmatch(r"(?:track|song|item|number)?\s*(\d+)", subject, re.IGNORECASE)
                if numbered is not None:
                    return {"action": "queue", "op": "remove", "index": max(0, int(numbered.group(1)) - 1)}
                if subject and not _SELF_TRACK_PATTERN.fullmatch(subject):
                    return {"action": "queue", "op": "remove", "query": subject[:MAX_QUERY_CHARS]}
            if _QUEUE_CLEAR_PATTERN.search(lowered):
                return {"action": "queue", "op": "clear"}
            return {"action": "queue", "op": "list"}
        move = re.search(
            r"\bmove\s+(?:track\s+)?(\d+)\s+(?:to\s+)?(?:position\s+)?(\d+)\b", cleaned, re.IGNORECASE
        )
        if move is not None:
            return {"action": "queue", "op": "move", "index": max(0, int(move.group(1)) - 1), "to": max(0, int(move.group(2)) - 1)}
        for kind, needles in (
            ("playlists", ("playlists", "playlist list", "playlist library")),
            ("likes", ("liked", "likes", "loved songs", "favourites", "favorites")),
            (
                "history",
                (
                    "history",
                    "recently played",
                    "last played",
                    "been listening",
                    "did i listen",
                    "what did i listen",
                    "recent plays",
                    "what did i play",
                    "listening log",
                ),
            ),
            (
                "frequent",
                (
                    "most played",
                    "frequently played",
                    "played the most",
                    "play the most",
                    "top songs",
                    "top tracks",
                    "on repeat",
                    "my heavy rotation",
                ),
            ),
            ("stats", ("listening stats", "music stats", "how much music", "listening totals")),
        ):
            if any(needle in lowered for needle in needles):
                return {"action": "library", "kind": kind}
        query = _request_subject(cleaned)
        if query:
            if _PLAY_VERB_PATTERN.search(lowered):
                return {"action": "play", "query": query}
            return {"action": "search", "query": query}
        # Nothing but service words were left ("put on some music"): search the
        # original phrase rather than guessing a song.
        if _PLAY_VERB_PATTERN.search(lowered):
            return {"action": "play", "query": cleaned}
        return {"action": "search", "query": cleaned or "music"}

    async def _execute(self, arguments: dict[str, Any]) -> dict[str, Any]:
        action = arguments["action"]
        base = {
            "connected": self.connected,
            "instance": self.host_label,
            "user": self.user_name,
        }
        if not self.connected:
            raise RuntimeError("OpenDeck is not connected. Check the server address and API key, then retry once.")
        if action == "search":
            tracks = self.search(arguments["query"], arguments["limit"])
            return _result(
                action,
                f"OpenDeck returned {len(tracks)} track(s) for “{arguments['query']}”.",
                count=len(tracks),
                tracks=tracks,
                **base,
            )
        if action == "library":
            data = self.library(arguments["kind"], arguments.get("playlist_id", ""), arguments["limit"])
            message = {
                "playlists": f"{data['count']} playlist(s) in this OpenDeck library.",
                "playlist": f"{data['count']} track(s) in that playlist.",
                "likes": f"{data['count']} liked song(s) in this OpenDeck library.",
                "history": f"{data['count']} recent play(s) in this OpenDeck library.",
                "frequent": f"{data['count']} song(s) this account plays most.",
                "stats": f"{data['count']} play(s) recorded by OpenDeck.",
            }[arguments["kind"]]
            return _result(action, message, **data, **base)
        if action == "play":
            query = arguments.get("query") or ""
            if not query:
                video_id = arguments["video_id"]
                title = artist = album = ""
                duration = 0
                artwork = ""
            else:
                tracks = self.search(query, 5)
                if not tracks:
                    raise RuntimeError(f"OpenDeck found no track matching “{query}”.")
                best, contenders = _play_choice(query, tracks)
                if best is None:
                    # Several tracks answer to the request and none answers
                    # clearly. The choice is the user's, so the candidates go
                    # back to the console instead of the top hit being played.
                    return _result(
                        action,
                        f"{len(contenders)} tracks match “{query}”: which one did you mean?",
                        ambiguous=True,
                        query=query,
                        options=[_play_option(track) for track in contenders],
                        count=len(contenders),
                        **base,
                    )
                video_id = best["video_id"]
                title = best["title"]
                artist = best["artist"]
                album = best["album"]
                duration = best["duration_sec"]
                artwork = best["artwork_url"]
            resolved = self.resolve(video_id)
            title = title or resolved["title"]
            # Prefer the catalog's artist name; the player reports the
            # auto-generated "Artist - Topic" channel for many uploads.
            artist = artist or _clean_artist(resolved["artist"])
            duration = resolved["duration_sec"] or duration
            artwork = resolved["artwork_url"] or artwork
            track = {
                "video_id": resolved["video_id"] or video_id,
                "title": title,
                "artist": artist,
                "duration_sec": duration,
                "artwork_url": artwork,
            }
            play_url = self.play_url(resolved["stream_url"], track)
            self._remember_track(track)
            return _result(
                action,
                f"Playing “{title or video_id}” by {artist or 'an unknown artist'} on OpenDeck.",
                video_id=track["video_id"],
                title=title,
                artist=artist,
                album=album,
                duration_sec=duration,
                artwork_url=artwork,
                mime_type=resolved["mime_type"],
                play_url=play_url,
                count=1,
                **base,
            )
        if action == "lyrics":
            data = self.lyrics(arguments)
            label = (
                _text(arguments.get("title"), 300)
                or _text(arguments.get("video_id"), 64)
                or self._remembered_track().get("title")
                or "the current track"
            )
            if data["lyrics_timing"] == "synced":
                message = f"{data['count']} synchronized lyric line(s) for “{label}” ({data['lyrics_source']})."
            elif data["lyrics_timing"] == "plain":
                message = f"No synchronized lyrics are available for “{label}”; plain lyrics were returned."
            else:
                message = f"No lyrics are available for “{label}”."
            return _result(
                action, message,
                video_id=_text(arguments.get("video_id"), 64),
                title=_text(arguments.get("title"), 300),
                artist=_text(arguments.get("artist"), 200),
                **data, **base,
            )
        if action == "now_playing":
            queue = self._queue_load()
            index = queue["current_index"]
            current = queue["items"][index] if 0 <= index < len(queue["items"]) else {}
            track = current or self._remembered_track()
            title = _text(track.get("title"), 300)
            artist = _text(track.get("artist"), 200)
            video_id = _text(track.get("video_id"), 64)
            if not title and not video_id:
                return _result(
                    action, "Nothing is playing on OpenDeck right now.",
                    queue=queue["items"], queue_index=index, count=len(queue["items"]),
                    **self._queue_state(queue), **base,
                )
            next_title = (
                _text(queue["items"][index + 1].get("title"), 300)
                if 0 <= index and index + 1 < len(queue["items"]) else ""
            )
            suffix = f" Next up: “{next_title}”." if next_title else ""
            return _result(
                action,
                f"“{title or video_id}” by {artist or 'an unknown artist'} is playing on OpenDeck.{suffix}",
                video_id=video_id, title=title, artist=artist,
                album=_text(track.get("album"), 300),
                duration_sec=_count(track.get("duration_sec")),
                artwork_url=_text(track.get("artwork_url"), 600),
                queue=queue["items"], queue_index=index, count=len(queue["items"]),
                **self._queue_state(queue), **base,
            )
        if action == "queue":
            data = self.queue(arguments)
            return _result(action, data.pop("message"), **data, **base)
        if action == "save":
            data = self.save(arguments["kind"], arguments)
            return _result(action, _save_message(arguments["kind"], data), **data, **base)
        raise ValueError(f"Unsupported OpenDeck action '{action}'.")


# ── free-text request normalisation (deterministic match fallback) ─────────
# "play music: Bohemian Rhapsody, on OpenDeck please" -> "Bohemian Rhapsody".
_SERVICE_REFERENCE_PATTERN = re.compile(
    r"\b(?:on|from|via|using|in|with|through)\s+(?:my\s+|the\s+)?opendeck\b",
    re.IGNORECASE,
)
_COMMAND_PREFIX_PATTERN = re.compile(
    r"^(?:(?:please|hey\s+nix|nix)[,\s]+)*"
    r"(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?"
    r"(?:play|put\s+on|start\s+playing|start|queue|shuffle|show\s+me|show|list|find|search\s+for|search|look\s+for|get\s+me|display|tell\s+me)\s+",
    re.IGNORECASE,
)
_GENERIC_SUBJECT_PATTERN = re.compile(
    r"^(?:the\s+|some\s+|my\s+)?(?:songs?|tracks?|music|tunes?)\s*[:,\-]?\s*",
    re.IGNORECASE,
)
_RESULT_WORDS_PATTERN = re.compile(
    r"^(?:search\s+results?\s+for|results?\s+for|search\s+for|search)\s+",
    re.IGNORECASE,
)
_TRAILING_POLITE_PATTERN = re.compile(
    r"(?:\s+(?:please|thanks|thank\s+you|for\s+me))+\s*$", re.IGNORECASE
)
_PLAY_VERB_PATTERN = re.compile(r"\b(?:play|playing|put\s+on|queue|shuffle)\b", re.IGNORECASE)
_PLAYLIST_NAME_PATTERN = re.compile(
    r"(?:called|named|titled|name(?:d)?\s+it)\s+[\"'\u201c]?([^\"'\u201d]{1,120})[\"'\u201d]?",
    re.IGNORECASE,
)
# "add Believer to my queue", "queue up Believer", "put this on the queue".
_QUEUE_ADD_PATTERN = re.compile(
    r"("
    r"\b(?:add|put|throw|drop|queue)\s+(?P<subject>[^,]{0,80}?)\s*(?:to|into|on|in)\s+"
    r"(?:my\s+|the\s+|our\s+)?queue\b"
    r"|"
    r"\bqueue\s+up\s+(?P<target>[^,]{1,80})"
    r")",
    re.IGNORECASE,
)
# Words that fill a request without naming anything: "play the next queued
# track" names the queue's own next entry, not a song whose title is "the".
_FILLER_SUBJECT_PATTERN = re.compile(
    r"(?:(?:the|a|an|this|that|it|one|next|queued|current|song|track|tune)\s*)+",
    re.IGNORECASE,
)
# "shuffle the queue", "turn shuffle off", "repeat this song": shuffle and
# repeat are the queue's own listening preferences, and the page drives them by
# op. Said out loud, the phrase has to be about the preference itself - a request
# that names a track ("search for shuffle") is a search, so the words left after
# the service words are checked against a small vocabulary.
_SHUFFLE_PATTERN = re.compile(r"\b(?:shuffl(?:e|es|ed|ing)|randomi[sz]e[ds]?)\b", re.IGNORECASE)
_REPEAT_PATTERN = re.compile(r"\b(?:repeat(?:ing|s)?|loop(?:ing)?)\b", re.IGNORECASE)
# Words that may surround a shuffle/repeat request without naming a track.
_PREFERENCE_WORDS = frozenset(
    "shuffle shuffles shuffled shuffling randomize randomizes randomise randomises random randomly"
    " repeat repeating repeats loop loops looping"
    " on off stop start begin end cancel no more turn turning toggle switch"
    " it this that these those them one all everything whole rest same current"
    " queue list playlist music song songs track tracks tune tunes"
    " and then also now again please for me my our the a an of in to up back".split()
)
# "can you shuffle the queue", "shuffle the queue please": the same request with
# manners on it, so a polite frame comes off before the words are checked.
_PREFERENCE_LEAD_PATTERN = re.compile(
    r"^(?:(?:please|hey\s+nix|nix|ok|okay)[,\s]+)*"
    r"(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?",
    re.IGNORECASE,
)
_PREFERENCE_OFF_PATTERN = re.compile(
    r"\b(?:off|stop|no|cancel|end|un|without)\b", re.IGNORECASE
)
# "repeat this song" repeats the track, "repeat the queue" wraps the whole list.
_PREFERENCE_ONE_PATTERN = re.compile(
    r"\b(?:one|single|same|current|this|that|it|song|track|tune)\b", re.IGNORECASE
)
_PREFERENCE_ALL_PATTERN = re.compile(
    r"\b(?:all|everything|whole|entire|queue|list|playlist|music|songs|tracks|tunes|rest)\b",
    re.IGNORECASE,
)
# The queue itself, said in plain English: "what's in my queue", "empty the
# queue", "remove Believer from the queue", "play the next queued track".
_QUEUE_TOPIC_PATTERN = re.compile(r"\bqueue\b", re.IGNORECASE)
_QUEUE_LIST_PATTERN = re.compile(
    r"\b(?:what|whats|what's|show|list|see|view|check|tell|read)\b", re.IGNORECASE
)
_QUEUE_CLEAR_PATTERN = re.compile(
    r"\b(?:clear|empty|wipe|flush|delete|drop)\b", re.IGNORECASE
)
_QUEUE_REMOVE_PATTERN = re.compile(
    r"\b(?:remove|delete|take\s+out|drop|get\s+rid\s+of)\s+(?P<subject>[^,]{1,80}?)\s*"
    r"(?:from|out\s+of|off)\s+(?:my\s+|the\s+)?queue\b",
    re.IGNORECASE,
)
# "add this song to my Late Night playlist" — a save whose destination is named.
_SAVE_TO_PATTERN = re.compile(
    r"\b(?:add|save|put|drop|throw)\s+(?P<subject>[^,]{0,60}?)\s*(?:to|into)\s+"
    r"(?:my\s+|the\s+|a\s+|one\s+of\s+my\s+)?(?P<target>[^,.!?]{1,120})",
    re.IGNORECASE,
)
# The like list, however a person refers to it: it is a playlist in YouTube
# Music (id LM) but writing to it is a like, not a playlist append.
_LIKED_REFERENCE_PATTERN = re.compile(
    r"(?:liked?|loved?|favorites?|favourites?|likes?)"
    r"(?:\s*(?:music|songs?|tracks?|list|playlist))?",
    re.IGNORECASE,
)
# "show me the lyrics", "what are the lyrics to Bohemian Rhapsody" -> "Bohemian
# Rhapsody". No track named means the current track, so the subject is empty.
_LYRICS_LEAD_PATTERN = re.compile(
    r"^(?:(?:please|hey\s+nix|nix)[,\s]+)*"
    r"(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?"
    r"(?:what\s+(?:are|is)|what's|which\s+(?:are|is)|show\s+me|show|tell\s+me|tell|"
    r"give\s+me|get\s+me|display|i\s+(?:want|need)|let\s+me\s+(?:see|hear))\s+",
    re.IGNORECASE,
)
_LYRICS_TOPIC_PATTERN = re.compile(
    r"\b(?:the\s+)?(?:lyrics?|song\s+words|words\s+to|sing\s+along)\b",
    re.IGNORECASE,
)
_LYRICS_SELF_PATTERN = re.compile(
    r"^(?:this|that|the|a)?\s*(?:current\s+)?(?:song|track|one|tune)$", re.IGNORECASE
)


def _request_subject(text: str) -> str:
    """Strip command words and service references, leaving the subject."""
    value = _SERVICE_REFERENCE_PATTERN.sub(" ", text)
    value = re.sub(r"\bopendeck\b", " ", value, flags=re.IGNORECASE)
    value = _COMMAND_PREFIX_PATTERN.sub("", value.strip())
    value = _RESULT_WORDS_PATTERN.sub("", value.strip())
    value = _GENERIC_SUBJECT_PATTERN.sub("", value.strip())
    value = _TRAILING_POLITE_PATTERN.sub("", value.strip())
    return " ".join(value.split()).strip(" .,:;!?-")


def _playlist_reference(text: str) -> str:
    """A spoken playlist name, as the playlist itself is named.

    "my Late Night playlist" is the playlist called "Late Night", so the
    possessive and the word "playlist" come off before the name is matched —
    and before a new playlist is created, so naming one out loud does not make
    a playlist called "my Late Night playlist".
    """
    value = _text(text, 120)
    value = value.strip(" \"'\u201c\u201d\u2018\u2019.,:;!?-")
    value = re.sub(r"^(?:my|our|the|a)\s+", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\s*\b(?:playlist|list|songs?|tracks?)\s*$", "", value, flags=re.IGNORECASE)
    value = value.strip(" \"'\u201c\u201d\u2018\u2019.,:;!?-")
    return " ".join(value.split())[:120]


def _names_nothing(subject: str) -> bool:
    """True when a phrase's subject is filler ("this", "the next track")."""
    stripped = subject.strip()
    if not stripped:
        return True
    return bool(
        _SELF_TRACK_PATTERN.fullmatch(stripped)
        or _FILLER_SUBJECT_PATTERN.fullmatch(stripped)
    )


def _queue_add_query(text: str) -> str | None:
    """The track a spoken "add … to the queue" request names, or None.

    The subject is a song title ("add Believer to my queue", "queue up
    Believer"), or a self-reference ("add this to the queue"), which becomes an
    empty query so the queue handler lines up what is playing. A phrase with no
    queue in it at all is left to the other matchers.
    """
    match = _QUEUE_ADD_PATTERN.search(text)
    if match is None:
        return None
    subject = (match.group("subject") or "").strip(" .,:;!?-\"'")
    if not subject:
        # "queue up <something>": everything after the verb is the track.
        subject = (match.group("target") or "").strip(" .,:;!?-\"'")
    # "add the song Believer to the queue" names the track after the noun.
    subject = re.sub(r"^(?:the\s+)?(?:song|track|tune|one)\s+", "", subject, flags=re.IGNORECASE)
    subject = re.sub(r"^(?:song|track)\s+(?:called|named)\s+", "", subject, flags=re.IGNORECASE)
    if _names_nothing(subject):
        return ""
    if _LIKED_REFERENCE_PATTERN.fullmatch(subject.casefold()):
        return ""
    return subject[:MAX_QUERY_CHARS]


def _queue_preference(text: str) -> dict[str, Any] | None:
    """A spoken shuffle/repeat request, as queue arguments, or None.

    "shuffle the queue" and "turn shuffle off" set the queue's flag; "repeat this
    song", "repeat the queue" and "stop repeating" set its mode. A request that
    names a track ("search for shuffle", "repeat Believer") is left to the other
    matchers, because the words it is built from are not all preference words.
    Shuffle is switched on rather than toggled - the page's button is the toggle -
    and a bare "repeat" cycles, which is what the handler does with no mode.
    """
    lowered = _TRAILING_POLITE_PATTERN.sub(
        "", _PREFERENCE_LEAD_PATTERN.sub("", text.casefold()).strip()
    ).strip()
    shuffles = _SHUFFLE_PATTERN.search(lowered)
    repeats = _REPEAT_PATTERN.search(lowered)
    if shuffles is None and repeats is None:
        return None
    words = re.findall(r"[a-z']+", lowered)
    if not words or any(word not in _PREFERENCE_WORDS for word in words):
        return None
    if repeats is None or (shuffles is not None and shuffles.start() < repeats.start()):
        return {"action": "queue", "op": "shuffle",
                "on": not _PREFERENCE_OFF_PATTERN.search(lowered)}
    if _PREFERENCE_OFF_PATTERN.search(lowered):
        return {"action": "queue", "op": "repeat", "mode": "off"}
    if _PREFERENCE_ONE_PATTERN.search(lowered):
        return {"action": "queue", "op": "repeat", "mode": "one"}
    if _PREFERENCE_ALL_PATTERN.search(lowered):
        return {"action": "queue", "op": "repeat", "mode": "all"}
    return {"action": "queue", "op": "repeat"}


def _save_destination(text: str) -> dict[str, Any] | None:
    """A spoken "add this to <playlist>" request, as save arguments.

    Only a self-reference is accepted as the subject: "add this song to Focus"
    is about the track that is playing, while "add Bohemian Rhapsody to Focus"
    names a track that has to be found first, so it is left to the caller rather
    than guessed at here. A destination of the like list becomes a like, because
    that is what filling it means.
    """
    match = _SAVE_TO_PATTERN.search(text)
    if match is None:
        return None
    subject = match.group("subject").strip(" .,:;!?-\"'")
    if subject and not _SELF_TRACK_PATTERN.fullmatch(subject):
        return None
    target = _playlist_reference(match.group("target"))
    if not target:
        return None
    if _LIKED_REFERENCE_PATTERN.fullmatch(target.casefold()):
        return {"action": "save", "kind": "like"}
    return {"action": "save", "kind": "playlist_add", "name": target}


def _lyrics_subject(text: str) -> str:
    """The track a lyrics request names, or "" when it names none.

    "" means "the current track" (the handler falls back to the last played
    track), so a bare "show me the lyrics" must not look up a song called
    "show me the lyrics".
    """
    value = _SERVICE_REFERENCE_PATTERN.sub(" ", text)
    value = re.sub(r"\bopendeck\b", " ", value, flags=re.IGNORECASE)
    value = _LYRICS_LEAD_PATTERN.sub("", value.strip())
    value = _LYRICS_TOPIC_PATTERN.sub(" ", value)
    value = re.sub(r"^\s*(?:to|for|of|from|about)\s+", "", value.strip(), flags=re.IGNORECASE)
    value = _TRAILING_POLITE_PATTERN.sub("", value.strip())
    value = " ".join(value.split()).strip(" .,:;!?-\"'")
    if not value or _LYRICS_SELF_PATTERN.fullmatch(value):
        return ""
    return value


def _lyrics_name_key(value: Any) -> str:
    """A track name folded to compare: case, punctuation and accents of spacing."""
    return " ".join(re.sub(r"[^\w\s]+", " ", str(value or "").casefold()).split())


def _lyrics_name_matches(title: Any, candidate: Any) -> bool:
    """Whether a provider's track name is the one that was asked for.

    The catalog titles a track the way YouTube does — "Post Malone - Better Now",
    "Bohemian Rhapsody (Official Video)" — while LRCLIB titles it the way the
    release does. So the two are compared as folded words: equal, one inside the
    other, or sharing most of the shorter one. Anything less is a different song,
    and its words must never be shown for this one.
    """
    wanted = _lyrics_name_key(title)
    found = _lyrics_name_key(candidate)
    if not wanted or not found:
        return False
    if wanted == found:
        return True
    if wanted in found or found in wanted:
        return True
    wanted_words = set(wanted.split())
    found_words = set(found.split())
    shorter = wanted_words if len(wanted_words) <= len(found_words) else found_words
    if not shorter:
        return False
    return len(wanted_words & found_words) / len(shorter) >= 0.75


def _clean_artist(value: Any) -> str:
    artist = _text(value, 200)
    for suffix in (" - Topic", " – Topic"):
        if artist.endswith(suffix):
            artist = artist[: -len(suffix)].strip()
    return artist


def _clock_seconds(value: str) -> int:
    """Seconds in a "3:53" or "1:02:03" clock label, or 0 when it is not one."""
    match = re.fullmatch(r"(\d{1,3}):(\d{2})(?::(\d{2}))?", str(value or "").strip())
    if not match:
        return 0
    if match.group(3):
        return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + int(match.group(3))
    return int(match.group(1)) * 60 + int(match.group(2))


def _find_renderer(node: Any, key: str) -> dict[str, Any] | None:
    """First nested renderer stored under ``key`` (InnerTube answers are deeply wrapped)."""
    if isinstance(node, dict):
        if isinstance(node.get(key), dict):
            return node[key]
        for value in node.values():
            found = _find_renderer(value, key)
            if found is not None:
                return found
    elif isinstance(node, list):
        for value in node:
            found = _find_renderer(value, key)
            if found is not None:
                return found
    return None


def _save_message(kind: str, data: dict[str, Any]) -> str:
    if kind == "like":
        return f"OpenDeck saved the like ({data.get('count', 0)} liked song(s) now)."
    if kind == "unlike":
        return f"OpenDeck removed the like ({data.get('count', 0)} liked song(s) now)."
    if kind == "playlist_create":
        return f"OpenDeck created the playlist “{data.get('title', '')}”."
    where = data.get("title") or "the playlist"
    if data.get("playlists"):
        return (
            f"OpenDeck created the playlist “{where}” and added the track to it "
            f"({data.get('count', 0)} track(s) now)."
        )
    return f"OpenDeck added the track to “{where}” ({data.get('count', 0)} track(s) now)."


def _clamp_limit(value: Any, ceiling: int = MAX_RESULTS) -> int:
    if value is None:
        return 5
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"limit must be a number between 1 and {ceiling}.")
    limit = int(value)
    if not 1 <= limit <= ceiling:
        raise ValueError(f"limit must be between 1 and {ceiling}.")
    return limit


def _parse_search_tracks(root: Any) -> list[dict[str, Any]]:
    """Pull song rows out of an InnerTube music search response."""
    tracks: list[dict[str, Any]] = []
    seen: set[str] = set()

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            item = node.get("musicResponsiveListItemRenderer")
            if isinstance(item, dict):
                track = _parse_search_item(item)
                if track and track["video_id"] not in seen:
                    seen.add(track["video_id"])
                    tracks.append(track)
            for value in node.values():
                visit(value)
        elif isinstance(node, list):
            for value in node:
                visit(value)

    visit(root)
    return tracks


def _parse_search_item(item: dict[str, Any]) -> dict[str, Any] | None:
    video_id = _find_video_id(item)
    if not video_id:
        return None
    # One text per flex column: [title, "Artist • Album • 3:33", ...]. The
    # metadata column carries artist, album and duration separated by " • ".
    columns: list[str] = []
    for column in item.get("flexColumns") or []:
        renderer = ((column or {}).get("musicResponsiveListItemFlexColumnRenderer") or {})
        runs = ((renderer.get("text") or {}).get("runs") or [])
        joined = "".join(
            str(run.get("text") or "") for run in runs if isinstance(run, dict)
        ).strip()
        if joined:
            columns.append(joined)
    title = columns[0] if columns else ""
    artist = album = ""
    duration = 0
    for column in columns[1:]:
        for part in (piece.strip() for piece in column.split("\u2022")):
            if not part:
                continue
            seconds = _clock_seconds(part)
            if seconds:
                duration = seconds
            elif re.search(r"\b(views?|plays?|subscribers?|likes?)\b", part, re.IGNORECASE):
                continue
            elif not artist:
                artist = part
            elif not album:
                album = part
    # A playlist row keeps its duration in a fixed column of its own ("3:53"),
    # where a search row carries it in the metadata line.
    for column in item.get("fixedColumns") or []:
        renderer = ((column or {}).get("musicResponsiveListItemFixedColumnRenderer") or {})
        runs = ((renderer.get("text") or {}).get("runs") or [])
        joined = "".join(
            str(run.get("text") or "") for run in runs if isinstance(run, dict)
        ).strip()
        if not duration:
            duration = _clock_seconds(joined)
    artwork = ""
    thumbnails = (((item.get("thumbnail") or {}).get("musicThumbnailRenderer") or {}).get("thumbnail") or {})
    candidates = thumbnails.get("thumbnails") or []
    if isinstance(candidates, list) and candidates:
        artwork = str((candidates[-1] or {}).get("url") or "")
    return {
        "video_id": video_id,
        "title": _text(title, 300),
        "artist": _text(artist, 200),
        "album": _text(album, 300),
        "duration_sec": duration,
        "artwork_url": artwork,
    }


def _find_video_id(node: Any) -> str:
    if isinstance(node, dict):
        candidate = node.get("videoId")
        if isinstance(candidate, str) and _VIDEO_ID_PATTERN.fullmatch(candidate):
            return candidate
        for key in ("playlistItemData", "navigationEndpoint", "watchEndpoint", "endpoint", "overlay"):
            found = _find_video_id(node.get(key))
            if found:
                return found
        for value in node.values():
            found = _find_video_id(value)
            if found:
                return found
    elif isinstance(node, list):
        for value in node:
            found = _find_video_id(value)
            if found:
                return found
    return ""


def _select_audio_format(streaming_data: dict[str, Any]) -> dict[str, Any] | None:
    formats = (streaming_data.get("adaptiveFormats") or []) + (streaming_data.get("formats") or [])
    audio = [
        item
        for item in formats
        if isinstance(item, dict)
        and str(item.get("mimeType") or "").startswith("audio")
        and isinstance(item.get("url"), str)
    ]
    if not audio:
        return None
    for preferred in AUDIO_MIME_PREFERENCE:
        for item in audio:
            if str(item.get("mimeType") or "").startswith(preferred):
                return item
    return audio[0]


def _select_playback_format(
    streaming_data: dict[str, Any], audio_format: dict[str, Any]
) -> dict[str, Any]:
    """The format whose URL can be fetched in full by whoever plays the track.

    A DASH (``adaptiveFormats``) audio URL is only served up to the opening of
    the file, so on its own it can never carry a whole song. A progressive
    (``formats``) rendition that carries an audio codec streams end to end, so
    it is preferred and the audio-only format is the fallback for a catalog
    response that offers no progressive track at all.
    """
    for item in streaming_data.get("formats") or []:
        if not isinstance(item, dict) or not isinstance(item.get("url"), str):
            continue
        mime = str(item.get("mimeType") or "")
        if mime.startswith(PROGRESSIVE_MIME_PREFIX) and "mp4a" in mime:
            return item
    return audio_format


def _playlist_summary(item: Any) -> dict[str, Any]:
    """One playlist, from either the linked YouTube library or the OpenDeck store.

    The cover is carried through: the linked library resolves each playlist's
    thumbnail, and the store keeps the artwork URL a synced playlist was saved
    with, so the page shows the same picture OpenDeck's own client does instead
    of a placeholder. A playlist with no cover at all stays empty here and the
    page draws its own tile.
    """
    if not isinstance(item, dict):
        return {}
    playlist_id = _text(item.get("id") or item.get("playlist_id"), 100)
    if not playlist_id:
        return {}
    return {
        "playlist_id": playlist_id,
        "name": _text(item.get("name") or item.get("title"), 300),
        "track_count": _count(item.get("trackCount") or item.get("track_count")),
        "artwork_url": _text(item.get("artworkUrl") or item.get("artwork_url"), 600),
    }


def _linked_track(item: Any) -> dict[str, Any]:
    """One row of the linked YouTube library (id/title/artist/artworkUrl/durationSec)."""
    if not isinstance(item, dict):
        return {}
    video_id = _text(item.get("id"), 64)
    if not video_id:
        return {}
    return {
        "video_id": video_id,
        "title": _text(item.get("title"), 300),
        "artist": _text(item.get("artist"), 200),
        "album": _text(item.get("album"), 300),
        "duration_sec": _count(item.get("durationSec")),
        "artwork_url": _text(item.get("artworkUrl"), 600),
    }


def _library_track(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        return {}
    video_id = _text(item.get("id"), 64)
    if not video_id:
        return {}
    return {
        "video_id": video_id,
        "title": _text(item.get("title"), 300),
        "artist": _text(item.get("artist"), 200),
        "album": _text(item.get("album"), 300),
        "duration_sec": _count(item.get("durationSeconds")),
        "artwork_url": _text(item.get("artworkUrl"), 600),
    }


def _history_track(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        return {}
    video_id = _text(item.get("videoId"), 64)
    if not video_id:
        return {}
    return {
        "video_id": video_id,
        "title": _text(item.get("title"), 300),
        "artist": _text(item.get("artist"), 200),
        "album": _text(item.get("album"), 300),
        "duration_sec": _count(item.get("durationSeconds")),
        "artwork_url": _text(item.get("artworkUrl"), 600),
    }


async def _run_worker() -> int:
    service: OpenDeckService | None = None
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        request: dict[str, Any] = {}
        try:
            if len(line.encode("utf-8")) > 256 * 1024:
                raise ValueError("Request exceeds size limit.")
            request = json.loads(line)
            if not isinstance(request, dict) or not isinstance(request.get("id"), str):
                raise ValueError("Request requires a string correlation id.")
            operation = request.get("op")
            if operation == "initialize":
                service = OpenDeckService()
                await asyncio.to_thread(service.initialize, request.get("config") or {})
                response = {"id": request["id"], "ok": True, "ready": True}
            elif service is None:
                raise ValueError("Worker is not initialized.")
            else:
                response = {"id": request["id"], "ok": True, **await service.handle(str(operation), request)}
        except Exception as exc:
            response = {
                "id": request.get("id", "invalid"),
                "ok": False,
                "error": f"{type(exc).__name__}: {str(exc)}"[:240],
            }
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    return 0


def main() -> int:
    if "--nix-skill-worker" not in sys.argv[1:]:
        print(
            "This module is a NIX skill worker; use the NIX Skills dashboard to configure, trust, and run it.",
            file=sys.stderr,
        )
        return 2
    try:
        return asyncio.run(_run_worker())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

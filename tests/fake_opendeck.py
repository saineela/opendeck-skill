"""A faithful-enough fake of the OpenDeck HTTP API for OpenDeck skill tests.

It answers the endpoints the worker uses — whoami, the allowlisted proxy
(InnerTube bootstrap/search/player), library, likes, history and the media
stream — so the worker can be exercised end to end without a real instance.
"""
from __future__ import annotations

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

API_KEY = "odk_test_key_0123456789"

HOME_HTML = (
    "<!DOCTYPE html><html><head><script>var ytcfg = {"
    '"INNERTUBE_CLIENT_VERSION":"1.20261006.10.00",'
    '"INNERTUBE_API_KEY":"fake-innertube-key"'
    "};</script></head><body>music</body></html>"
)

AUDIO_BYTES = b"\x00\x00\x00\x18ftypM4A " + bytes(4096)

# LRCLIB payloads the worker reaches through the proxy for the lyrics action.
LRCLIB_MATCH = {
    "id": 3396226,
    "trackName": "Bohemian Rhapsody",
    "artistName": "Queen",
    "albumName": "A Night At The Opera",
    "duration": 354,
    "instrumental": False,
    "plainLyrics": "Is this the real life?\nIs this just fantasy?",
    "syncedLyrics": (
        "[00:00.50] Is this the real life?\n"
        "[00:04.25] Is this just fantasy?\n"
        "[00:08.00][00:12.00] Caught in a landslide\n"
        "[ar:Queen]\n"
    ),
}


# A track LRCLIB only has words (not timings) for, plus the two wrong answers a
# search for it returns ahead of the right one: a same-length entry with another
# name (whose timings must never be shown for it) and a live take whose length
# gives it away. The right entry is last, so a worker that simply takes the first
# candidate it can use fails this fixture instead of passing it.
LRCLIB_WORDS_ONLY = {
    "id": 4211,
    "trackName": "Words Alone",
    "artistName": "The Testers",
    "albumName": "Plainly",
    "duration": 200,
    "instrumental": False,
    "plainLyrics": "These are the words\nof a plain song",
}
LRCLIB_DECOY_NAME = {
    "id": 4212,
    "trackName": "Some Other Song",
    "artistName": "The Testers",
    "albumName": "Plainly",
    "duration": 200,
    "instrumental": False,
    "plainLyrics": "",
    "syncedLyrics": "[00:01.00] a different song's words\n[00:05.00] with timings\n",
}
LRCLIB_DECOY_LIVE = {
    "id": 4213,
    "trackName": "Words Alone (Live)",
    "artistName": "The Testers",
    "albumName": "Plainly live",
    "duration": 260,
    "instrumental": False,
    "plainLyrics": "",
    "syncedLyrics": "[00:01.00] the live take's words\n",
}


def _lrclib_response(inner_url: str):
    """The provider's answer for one proxy URL, or None when it is a 404 fixture."""
    lowered = inner_url.casefold()
    if "nothing" in lowered:
        return 404, b"{}"
    if "words+alone" in lowered:
        if "/api/search" in inner_url:
            return 200, json.dumps([LRCLIB_DECOY_NAME, LRCLIB_DECOY_LIVE, LRCLIB_WORDS_ONLY]).encode("utf-8")
        return 200, json.dumps(LRCLIB_WORDS_ONLY).encode("utf-8")
    if "/api/search" in inner_url:
        return 200, json.dumps([LRCLIB_MATCH]).encode("utf-8")
    return 200, json.dumps(LRCLIB_MATCH).encode("utf-8")


# ── the account's play log ────────────────────────────────────────────────
# What `/api/history` lists, newest first. It is deliberately longer than one page
# of search results: a log that held three plays could not show that a twelve-item
# cut had come back, and two songs are played more than once because "what do I
# play the most" is a count rather than an order. These are the songs the wall
# display's "Frequently played" shelf is ranked from.
PLAY_LOG_SONGS: list[tuple[str, str, str, str, str, int, int]] = [
    # video id, title, artist, album, artwork, seconds, how many times played
    ("lYBUbBu4W08", "Never Gonna Give You Up", "Rick Astley", "Whenever You Need Somebody", "http://art.example/hq.jpg", 214, 3),
    ("cTHakk3Lnjk", "Take On Me", "a-ha", "Hunting High and Low", "http://art.example/take.jpg", 225, 2),
    ("kXYiU_JCYtU", "Numb", "Linkin Park", "Meteora", "http://art.example/numb.jpg", 185, 1),
    ("fJ9rUzIMcZQ", "Bohemian Rhapsody", "Queen", "A Night At The Opera", "http://art.example/bohemian.jpg", 354, 1),
    ("60ItHLz5WEA", "Faded", "Alan Walker", "Different World", "http://art.example/faded.jpg", 212, 1),
    ("JGwWNGJdvx8", "Shape of You", "Ed Sheeran", "Divide", "http://art.example/shape.jpg", 233, 1),
    ("RgKAFK5djSk", "See You Again", "Wiz Khalifa", "Furious 7", "http://art.example/seeyou.jpg", 229, 1),
    ("OPf0YbXqDm0", "Uptown Funk", "Mark Ronson", "Uptown Special", "http://art.example/uptown.jpg", 269, 1),
    ("09R8_2nJtjg", "Sugar", "Maroon 5", "V", "http://art.example/sugar.jpg", 235, 1),
    ("CevxZvSJLk8", "Roar", "Katy Perry", "Prism", "http://art.example/roar.jpg", 223, 1),
    ("hT_nvWreIhg", "Counting Stars", "OneRepublic", "Native", "http://art.example/stars.jpg", 257, 1),
    ("YQHsXMglC9A", "Hello", "Adele", "25", "http://art.example/hello.jpg", 295, 1),
    ("QcIy9NiNbmo", "Bad Blood", "Taylor Swift", "1989", "http://art.example/badblood.jpg", 211, 1),
    ("djV11Xbc914", "Take On Me", "a-ha", "Hunting High and Low", "http://art.example/take-alt.jpg", 225, 1),
]


def _history_plays() -> list[dict[str, Any]]:
    """The whole log, newest first: every song once, then the plays it repeats.

    A song's first play is what a reader's tie-break sees — a song played once is
    ordered by its newest play, which is the order of `PLAY_LOG_SONGS` here — and
    the repeats behind it are what make the counts differ.
    """
    order = list(PLAY_LOG_SONGS)
    for song in PLAY_LOG_SONGS:
        order.extend([song] * (song[6] - 1))
    return [
        {
            "id": f"play-{index + 1}",
            "videoId": video_id,
            "title": title,
            "artist": artist,
            "album": album,
            "artworkUrl": artwork,
            "durationSeconds": seconds,
            "source": "app" if index % 2 else "api",
            "playedAt": 1770500000000 - index * 60000,
        }
        for index, (video_id, title, artist, album, artwork, seconds, _count) in enumerate(order)
    ]


HISTORY_PLAYS: list[dict[str, Any]] = _history_plays()


def _shelf_row(
    video_id: str, title: str, meta: str, album: str, duration: str = ""
) -> dict[str, Any]:
    """One musicResponsiveListItemRenderer row, as search and playlist pages send it.

    A playlist row carries its duration in a fixed column of its own while a
    search row keeps it in the metadata line, which is why the worker reads both.
    """
    item: dict[str, Any] = {
        "playlistItemData": {"videoId": video_id},
        "flexColumns": [
            {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": title}]}}},
            {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": meta}]}}},
            {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": album}]}}},
        ],
        "thumbnail": {
            "musicThumbnailRenderer": {
                "thumbnail": {
                    "thumbnails": [
                        {"url": "http://art.example/60.jpg", "width": 60, "height": 60},
                        {"url": "http://art.example/120.jpg", "width": 120, "height": 120},
                    ]
                }
            }
        },
    }
    if duration:
        item["fixedColumns"] = [
            {
                "musicResponsiveListItemFixedColumnRenderer": {
                    "text": {"runs": [{"text": duration}]},
                    "size": "MUSIC_RESPONSIVE_LIST_ITEM_FIXED_COLUMN_SIZE_SMALL",
                }
            }
        ]
    return {"musicResponsiveListItemRenderer": item}


def _search_response() -> dict[str, Any]:
    def row(video_id: str, title: str, meta: str, album: str) -> dict[str, Any]:
        return _shelf_row(video_id, title, meta, album)

    return {
        "contents": {
            "tabbedSearchResultsRenderer": {
                "tabs": [
                    {
                        "tabRenderer": {
                            "content": {
                                "sectionListRenderer": {
                                    "contents": [
                                        {
                                            "musicShelfRenderer": {
                                                "contents": [
                                                    row(
                                                        "lYBUbBu4W08",
                                                        "Never Gonna Give You Up",
                                                        "Rick Astley • Whenever You Need Somebody • 3:33",
                                                        "Whenever You Need Somebody",
                                                    ),
                                                    row(
                                                        "cTHakk3Lnjk",
                                                        "Never Gonna Give You Up",
                                                        "TheRealSullyG • Otama-Tunes, Vol. 1 • 3:35",
                                                        "Otama-Tunes, Vol. 1",
                                                    ),
                                                ]
                                            }
                                        }
                                    ]
                                }
                            }
                        }
                    }
                ]
            }
        }
    }


def _player_response(video_id: str) -> dict[str, Any]:
    return {
        "playabilityStatus": {"status": "OK"},
        "streamingData": {
            "adaptiveFormats": [
                {
                    "itag": 251,
                    "mimeType": 'audio/webm; codecs="opus"',
                    "url": f"https://rr1---fake.googlevideo.com/videoplayback?itag=251&id={video_id}",
                },
                {
                    "itag": 139,
                    "mimeType": 'audio/mp4; codecs="mp4a.40.5"',
                    "url": f"https://rr1---fake.googlevideo.com/videoplayback?itag=139&id={video_id}",
                },
            ]
        },
        "videoDetails": {
            "videoId": video_id,
            "title": "Never Gonna Give You Up",
            "author": "Rick Astley - Topic",
            "lengthSeconds": "214",
            "thumbnail": {"thumbnails": [{"url": "http://art.example/hq.jpg", "width": 480, "height": 360}]},
        },
    }


LIBRARY_TRACK = {
    "id": "lYBUbBu4W08",
    "source": "youtube",
    "title": "Never Gonna Give You Up",
    "artist": "Rick Astley",
    "album": "Whenever You Need Somebody",
    "artworkUrl": "http://art.example/hq.jpg",
    "durationSeconds": 214,
}

# The linked-account shapes: /api/youtube/library speaks id/title/artist/
# artworkUrl/durationSec, and a playlist's title instead of a name.
LINKED_SONGS = [
    {
        "id": "lYBUbBu4W08",
        "title": "Never Gonna Give You Up",
        "artist": "Rick Astley",
        "artworkUrl": "http://art.example/hq.jpg",
        "durationSec": 214,
    },
    {
        "id": "cTHakk3Lnjk",
        "title": "Never Gonna Give You Up",
        "artist": "TheRealSullyG",
        "artworkUrl": "http://art.example/120.jpg",
        "durationSec": 215,
    },
]


def _youtube_library() -> dict[str, Any]:
    """The linked account's library, as OpenDeck's /api/youtube/library sends it.

    Liked songs ride along as an auto playlist (LM, "Liked Music") the way
    YouTube Music itself lists them — they are not a stored playlist.
    """
    return {
        "account": {"name": "Ada Lovelace"},
        "playlists": [
            {
                "id": "LM",
                "title": "Liked Music",
                "owner": "You",
                "artworkUrl": "http://art.example/hq.jpg",
                "trackCount": len(LINKED_SONGS),
            },
            {
                "id": "PL-fake-ultimate",
                "title": "Ultimate",
                "owner": "You",
                "artworkUrl": "http://art.example/120.jpg",
                "trackCount": 2,
            },
        ],
        "likedSongs": [dict(song) for song in LINKED_SONGS],
        "albums": [],
        "recentlyPlayed": [],
    }


def _playlist_response() -> dict[str, Any]:
    """A WEB_REMIX browse of one playlist: its rows live in a playlist shelf."""
    return {
        "contents": {
            "twoColumnBrowseResultsRenderer": {
                "secondaryContents": {
                    "sectionListRenderer": {
                        "contents": [
                            {
                                "musicPlaylistShelfRenderer": {
                                    "playlistId": "PL-fake-ultimate",
                                    "contents": [
                                        _shelf_row(
                                            "lYBUbBu4W08",
                                            "Never Gonna Give You Up",
                                            "Rick Astley • Whenever You Need Somebody",
                                            "Whenever You Need Somebody",
                                            "3:33",
                                        ),
                                        _shelf_row(
                                            "cTHakk3Lnjk",
                                            "Never Gonna Give You Up",
                                            "TheRealSullyG • Otama-Tunes, Vol. 1",
                                            "Otama-Tunes, Vol. 1",
                                            "3:35",
                                        ),
                                    ],
                                }
                            }
                        ]
                    }
                }
            }
        }
    }


def _query_int(path: str, name: str, default: int) -> int:
    """One numeric query parameter, as the instance reads its own URLs."""
    query = path.split("?", 1)[1] if "?" in path else ""
    for part in query.split("&"):
        key, _, value = part.partition("=")
        if key == name and value.isdigit():
            return int(value)
    return default


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args: Any) -> None:  # keep test output clean
        return

    # ── plumbing ──────────────────────────────────────────────────────────
    def _record(self, body: bytes) -> dict[str, Any]:
        entry = {
            "method": self.command,
            "path": self.path,
            "headers": {key.lower(): value for key, value in self.headers.items()},
            "body": body,
        }
        entry["authorized"] = entry["headers"].get("authorization") == f"Bearer {API_KEY}"
        self.server.requests.append(entry)  # type: ignore[attr-defined]
        return entry

    def _send(self, status: int, payload: Any, content_type: str = "application/json") -> None:
        if isinstance(payload, (dict, list)):
            body = json.dumps(payload).encode("utf-8")
        else:
            body = payload
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.send_header("accept-ranges", "bytes")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        length = int(self.headers.get("content-length") or 0)
        return self.rfile.read(length) if length else b""

    def _proxy_envelope(self, inner_status: int, inner_body: bytes) -> None:
        self._send(
            200,
            {
                "status": inner_status,
                "headers": {"content-type": "application/json"},
                "body_base64": base64.b64encode(inner_body).decode("ascii"),
            },
        )

    # ── routes ────────────────────────────────────────────────────────────
    def do_GET(self) -> None:  # noqa: N802
        entry = self._record(b"")
        path = self.path.split("?")[0]
        if path == "/api/auth/whoami":
            if not entry["authorized"]:
                self._send(401, {"error": "Sign in is required."})
                return
            self._send(
                200,
                {
                    "authenticated": True,
                    "user": {"name": "Ada Lovelace", "email": "ada@example.com", "picture": None},
                    "youtubeLinked": bool(getattr(self.server, "youtube_linked", True)),
                    "totpEnabled": False,
                    "authProvider": "password",
                },
            )
            return
        if path == "/api/youtube/library":
            if not self._require_auth(entry):
                return
            if not getattr(self.server, "youtube_linked", True):
                self._send(409, {"error": "No YouTube Music account is linked yet."})
                return
            self._send(200, _youtube_library())
            return
        if path == "/api/library/playlists":
            self._require_auth(entry) and self._send(
                200,
                {
                    "playlists": [
                        {
                            "id": "pl-road",
                            "name": "Road Trip",
                            "description": None,
                            "artworkUrl": None,
                            "trackCount": 2,
                            "createdAt": 1,
                            "updatedAt": 2,
                        }
                    ]
                },
            )
            return
        if path == "/api/library/playlists/pl-road":
            self._require_auth(entry) and self._send(
                200,
                {
                    "playlist": {"id": "pl-road", "name": "Road Trip", "trackCount": 2},
                    "tracks": [dict(LIBRARY_TRACK, position=0, addedAt=3)],
                },
            )
            return
        if path == "/api/library/likes":
            self._require_auth(entry) and self._send(200, {"likedSongs": [LIBRARY_TRACK]})
            return
        if path == "/api/history":
            # Newest first, as the instance lists plays, and as long as the reader
            # asked for: this is the endpoint both "what did I listen to" and
            # "what do I play the most" are read from.
            limit = _query_int(self.path, "limit", 50)
            self._require_auth(entry) and self._send(
                200,
                {
                    "plays": HISTORY_PLAYS[:limit],
                    "hasMore": len(HISTORY_PLAYS) > limit,
                    "nextCursor": None,
                },
            )
            return
        if path == "/api/history/stats":
            self._require_auth(entry) and self._send(
                200,
                {
                    "totalPlays": 13,
                    "totalListeningSeconds": 2782,
                    "playsToday": 1,
                    "plays7d": 4,
                    "bySource": {"app": 10, "api": 3},
                    "topTracks": [{"videoId": "lYBUbBu4W08", "title": "Never Gonna Give You Up", "artist": "Rick Astley", "plays": 5}],
                    "topArtists": [{"artist": "Rick Astley", "plays": 5}],
                },
            )
            return
        if path == "/api/media/stream":
            self.send_response(206)
            self.send_header("content-type", "audio/mp4")
            self.send_header("content-length", str(len(AUDIO_BYTES)))
            self.send_header("content-range", f"bytes 0-{len(AUDIO_BYTES) - 1}/{len(AUDIO_BYTES)}")
            self.end_headers()
            self.wfile.write(AUDIO_BYTES)
            return
        self._send(404, {"error": "Not found."})

    def _require_auth(self, entry: dict[str, Any]) -> bool:
        if not entry["authorized"]:
            self._send(401, {"error": "Sign in is required."})
            return False
        return True

    def do_POST(self) -> None:  # noqa: N802
        body = self._body()
        entry = self._record(body)
        path = self.path.split("?")[0]
        if path == "/api/yt/proxy":
            payload = json.loads(body.decode("utf-8"))
            inner_url = str(payload.get("url") or "")
            raw = base64.b64decode(payload.get("body_base64") or b"") if payload.get("body_base64") else b""
            entry["inner_url"] = inner_url
            entry["inner_body"] = raw
            if inner_url.rstrip("/") == "https://music.youtube.com":
                self._proxy_envelope(200, HOME_HTML.encode("utf-8"))
                return
            if "/youtubei/v1/search" in inner_url:
                self._proxy_envelope(200, json.dumps(_search_response()).encode("utf-8"))
                return
            if "/youtubei/v1/browse" in inner_url:
                self._proxy_envelope(200, json.dumps(_playlist_response()).encode("utf-8"))
                return
            if "lrclib.net/api/" in inner_url:
                # 404 is the fixture for "the provider has nothing", which the
                # worker has to report as no lyrics rather than as a failure.
                status, body = _lrclib_response(inner_url)
                self._proxy_envelope(status, body)
                return
            if "/youtubei/v1/player" in inner_url:
                request_body = json.loads(raw.decode("utf-8"))
                self._proxy_envelope(200, json.dumps(_player_response(str(request_body.get("videoId")))).encode("utf-8"))
                return
            self._send(403, {"error": f"Host not allowed: {inner_url}"})
            return
        if path == "/api/library/playlists":
            if not self._require_auth(entry):
                return
            name = str(json.loads(body.decode("utf-8")).get("name") or "")
            self._send(201, {"playlist": {"id": "pl-new", "name": name, "trackCount": 0}})
            return
        if path.startswith("/api/library/playlists/") and path.endswith("/tracks"):
            self._require_auth(entry) and self._send(
                200, {"added": 1, "replaced": 0, "trackCount": 3, "trackIds": ["lYBUbBu4W08"]}
            )
            return
        self._send(404, {"error": "Not found."})

    def do_PUT(self) -> None:  # noqa: N802
        body = self._body()
        entry = self._record(body)
        if self.path.startswith("/api/library/likes/"):
            self._require_auth(entry) and self._send(200, {"liked": True, "total": 3})
            return
        self._send(404, {"error": "Not found."})

    def do_DELETE(self) -> None:  # noqa: N802
        entry = self._record(b"")
        if self.path.startswith("/api/library/likes/"):
            self._require_auth(entry) and self._send(200, {"liked": False, "total": 2})
            return
        self._send(404, {"error": "Not found."})


class FakeOpenDeck:
    """Threaded fake instance; use as a context manager."""

    def __init__(self, api_key: str = API_KEY, youtube_linked: bool = True) -> None:
        self.api_key = api_key
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.requests = []  # type: ignore[attr-defined]
        self.server.youtube_linked = youtube_linked  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def requests(self) -> list[dict[str, Any]]:
        return self.server.requests  # type: ignore[attr-defined]

    def catalog_requests(self) -> list[dict[str, Any]]:
        return [item for item in self.requests if item["path"] == "/api/yt/proxy"]

    def __enter__(self) -> "FakeOpenDeck":
        self.thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

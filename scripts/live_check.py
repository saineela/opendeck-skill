#!/usr/bin/env python3
"""Live smoke check of the OpenDeck skill worker against a real OpenDeck server.

Read-only: it searches, resolves a stream and reads the library. It never
writes to the account. Credentials come from the environment so nothing
sensitive lives in the repository:

    NIX_OPENDECK_SERVER_URL=http://192.168.0.152:4100 \
    NIX_OPENDECK_API_KEY=odk_… \
    python3 scripts/live_check.py ["a song to try"]

Exit status is 0 only when every step succeeded.
"""
from __future__ import annotations

import os
import sys
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", "opendeck"))

from opendeck_worker import OpenDeckService  # noqa: E402


def main() -> int:
    server_url = os.environ.get("NIX_OPENDECK_SERVER_URL", "").strip()
    api_key = os.environ.get("NIX_OPENDECK_API_KEY", "").strip()
    if not server_url or not api_key:
        print("Set NIX_OPENDECK_SERVER_URL and NIX_OPENDECK_API_KEY first.", file=sys.stderr)
        return 2
    query = " ".join(sys.argv[1:]).strip() or "never gonna give you up"

    service = OpenDeckService()
    service.initialize({"server_url": server_url, "api_key": api_key})
    print(f"[connect] {service.host_label} as {service.user_name!r} (youtube linked: {service.youtube_linked})")

    tracks = service.search(query, 5)
    print(f"[search] {len(tracks)} result(s) for {query!r}")
    for track in tracks:
        print(
            f"   - {track['title']!r} by {track['artist']!r} "
            f"({track['duration_sec']}s) album={track['album']!r} id={track['video_id']}"
        )
    if not tracks:
        print("[search] no results — stopping", file=sys.stderr)
        return 1

    resolved = service.resolve(tracks[0]["video_id"])
    play_url = service.play_url(
        resolved["stream_url"],
        {
            "video_id": resolved["video_id"],
            "title": resolved["title"],
            "artist": resolved["artist"],
            "duration_sec": resolved["duration_sec"],
            "artwork_url": resolved["artwork_url"],
        },
    )
    print(
        f"[play] {resolved['title']!r} by {resolved['artist']!r} "
        f"({resolved['duration_sec']}s, {resolved['mime_type']})"
    )
    print(f"       play_url={play_url[:140]}…")

    request = urllib.request.Request(play_url, headers={"Range": "bytes=0-131071", "accept-encoding": "identity"})
    with urllib.request.urlopen(request, timeout=30) as response:
        audio = response.read()
        print(
            f"[stream] HTTP {response.status} content-type={response.headers.get('content-type')} "
            f"bytes={len(audio)} first4={audio[:4]!r}"
        )
        if response.status not in (200, 206) or len(audio) < 1024:
            print("[stream] OpenDeck did not serve audio bytes", file=sys.stderr)
            return 1

    playlists = service.library("playlists", "", 5)
    likes = service.library("likes", "", 5)
    history = service.library("history", "", 5)
    stats = service.library("stats", "", 5)
    print(
        f"[library] playlists={playlists['count']} likes={likes['count']} "
        f"history={history['count']} total_plays={stats['count']}"
    )
    print("[ok] every live step succeeded")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

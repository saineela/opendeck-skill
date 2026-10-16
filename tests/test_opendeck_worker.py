#!/usr/bin/env python3
"""Tests for the OpenDeck skill worker, against a fake OpenDeck instance."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.join(HERE, "..", "skills", "opendeck")
sys.path.insert(0, os.path.abspath(SKILL_DIR))
sys.path.insert(0, HERE)

# The worker persists the play queue and the "now playing" track. Keep these
# tests out of the real files under /root/data.
os.environ.setdefault(
    "NIX_OPENDECK_QUEUE_FILE",
    os.path.join(tempfile.gettempdir(), "opendeck-test-queue-%d.json" % os.getpid()),
)
os.environ.setdefault(
    "NIX_OPENDECK_NOW_PLAYING_FILE",
    os.path.join(tempfile.gettempdir(), "opendeck-test-now-playing-%d.json" % os.getpid()),
)

import fake_opendeck  # noqa: E402
import opendeck_worker  # noqa: E402
from fake_opendeck import API_KEY, FakeOpenDeck  # noqa: E402
from opendeck_worker import OpenDeckService  # noqa: E402

WORKER = os.path.join(SKILL_DIR, "opendeck_worker.py")
MANIFEST = json.load(open(os.path.join(SKILL_DIR, "skill.json"), encoding="utf-8"))
RESULT_SCHEMA = MANIFEST["tools"][0]["result_schema"]
INPUT_SCHEMA = MANIFEST["tools"][0]["input_schema"]


# ── a small validator for the bounded schema subset NIX uses ────────────────
def assert_schema(value, schema, path="result"):
    if "oneOf" in schema:
        matched = False
        for alternative in schema["oneOf"]:
            try:
                assert_schema(value, alternative, path)
                matched = True
                break
            except AssertionError:
                continue
        assert matched, f"{path}: value matched no oneOf alternative: {value!r}"
    kind = schema["type"]
    if kind == "object":
        assert isinstance(value, dict), f"{path}: expected object"
        for key in schema.get("required", []):
            assert key in value, f"{path}: missing required key {key!r}"
        if schema.get("additionalProperties") is False:
            extra = set(value) - set(schema.get("properties", {}))
            assert not extra, f"{path}: undeclared keys {sorted(extra)}"
        for key, child in (schema.get("properties") or {}).items():
            if key in value:
                assert_schema(value[key], child, f"{path}.{key}")
    elif kind == "array":
        assert isinstance(value, list), f"{path}: expected array"
        assert len(value) <= schema.get("maxItems", 10**9), f"{path}: too many items"
        for index, item in enumerate(value):
            assert_schema(item, schema["items"], f"{path}[{index}]")
    elif kind == "string":
        assert isinstance(value, str), f"{path}: expected string"
        assert len(value) <= schema.get("maxLength", 10**9), f"{path}: too long"
        if "enum" in schema:
            assert value in schema["enum"], f"{path}: {value!r} not in enum"
    elif kind == "integer":
        assert isinstance(value, int) and not isinstance(value, bool), f"{path}: expected integer"
        assert schema.get("minimum", value) <= value <= schema.get("maximum", value), f"{path}: out of range"
    elif kind == "number":
        assert isinstance(value, (int, float)) and not isinstance(value, bool), f"{path}: expected number"
    elif kind == "boolean":
        assert isinstance(value, bool), f"{path}: expected boolean"


class WorkerTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.fake = FakeOpenDeck()
        self.fake.__enter__()
        self.addCleanup(self.fake.__exit__, None, None, None)
        self.service = OpenDeckService()
        self.service.initialize({"server_url": self.fake.base_url, "api_key": API_KEY})
        # "Nothing has been played yet" and an empty queue must be
        # reproducible per test.
        for path in (
            opendeck_worker.NOW_PLAYING_FILE,
            opendeck_worker.QUEUE_FILE,
            opendeck_worker.LIBRARY_CACHE_FILE,
        ):
            try:
                os.remove(path)
            except OSError:
                pass

    def library_requests(self) -> list[str]:
        """Every library read the fake instance has served, as `method path`."""
        return [entry["path"] for entry in self.fake.requests if entry["path"].startswith("/api/library")]

    def cache_entries(self) -> dict:
        """The worker's cached reads, keyed by `kind:playlist_id:limit`."""
        try:
            with open(opendeck_worker.LIBRARY_CACHE_FILE, "r", encoding="utf-8") as handle:
                return json.load(handle)["entries"]
        except (OSError, json.JSONDecodeError):
            return {}

    def cache_entry_for(self, prefix: str) -> dict:
        """The one cached read whose key starts with this prefix."""
        entries = {key: value for key, value in self.cache_entries().items() if key.startswith(prefix)}
        self.assertEqual(len(entries), 1, f"expected exactly one cached read for {prefix}: {sorted(self.cache_entries())}")
        return list(entries.values())[0]

    def age_cache_entries(self, seconds: float | None = None) -> None:
        """Push cached reads past their TTL, as a session an hour old would be.

        A stale copy is the interesting case for both the refresh and the
        backing-off behaviour, and time travel is not available to the worker.
        """
        amount = opendeck_worker.LIBRARY_TTL_SECONDS + 1 if seconds is None else seconds
        entries = self.cache_entries()
        for entry in entries.values():
            entry["saved_at"] -= amount
        with open(opendeck_worker.LIBRARY_CACHE_FILE, "w", encoding="utf-8") as handle:
            json.dump({"entries": entries}, handle)

    def seed_queue(self, titles: list[str], *, current_index: int = -1) -> None:
        """Write a queue of distinct tracks so reorder assertions are exact."""
        items = [
            {
                "video_id": "vid%07d" % index,
                "title": title,
                "artist": "Artist %d" % index,
                "album": "",
                "duration_sec": 0,
                "artwork_url": "",
            }
            for index, title in enumerate(titles)
        ]
        with open(opendeck_worker.QUEUE_FILE, "w", encoding="utf-8") as handle:
            json.dump({"items": items, "current_index": current_index}, handle)

    def execute(self, arguments: dict) -> dict:
        validated = OpenDeckService._validate_tool_arguments(arguments)
        assert_schema(validated, INPUT_SCHEMA, "arguments")
        response = asyncio.run(
            self.service.handle("execute", {"tool": "opendeck_music", "arguments": validated})
        )
        result = response["result"]
        assert_schema(result, RESULT_SCHEMA, "result")
        return result

    # ── setup ─────────────────────────────────────────────────────────────
    def test_initialize_authenticates_and_reports_the_account(self):
        self.assertTrue(self.service.connected)
        self.assertEqual(self.service.user_name, "Ada Lovelace")
        self.assertTrue(self.service.youtube_linked)

    def test_initialize_rejects_a_bad_key_and_missing_fields(self):
        service = OpenDeckService()
        with self.assertRaises(RuntimeError):
            service.initialize({"server_url": self.fake.base_url, "api_key": "odk_wrong"})
        with self.assertRaises(ValueError):
            service.initialize({"server_url": "", "api_key": API_KEY})
        with self.assertRaises(ValueError):
            service.initialize({"server_url": self.fake.base_url, "api_key": ""})
        with self.assertRaises(ValueError):
            service.initialize({"server_url": "ftp://nope", "api_key": API_KEY})

    def test_server_url_accepts_host_port_and_keeps_path_free(self):
        service = OpenDeckService()
        service.initialize({"server_url": self.fake.base_url + "/", "api_key": API_KEY})
        self.assertEqual(service.base_url, self.fake.base_url)

    # ── catalog ───────────────────────────────────────────────────────────
    def test_search_returns_parsed_tracks(self):
        result = self.execute({"action": "search", "query": "never gonna give you up"})
        self.assertEqual(result["count"], 2)
        first = result["tracks"][0]
        self.assertEqual(first["video_id"], "lYBUbBu4W08")
        self.assertEqual(first["title"], "Never Gonna Give You Up")
        self.assertEqual(first["artist"], "Rick Astley")
        self.assertEqual(first["album"], "Whenever You Need Somebody")
        self.assertEqual(first["duration_sec"], 213)
        self.assertTrue(first["artwork_url"].startswith("http"))

    def test_catalog_calls_are_anonymous_and_account_calls_are_authenticated(self):
        self.execute({"action": "search", "query": "anything"})
        catalog = self.fake.catalog_requests()
        self.assertTrue(catalog, "expected the worker to use OpenDeck's proxy")
        for entry in catalog:
            self.assertFalse(entry["authorized"], "catalog calls must not carry the API key")
            self.assertNotIn("authorization", entry["headers"])
        whoami = [item for item in self.fake.requests if item["path"] == "/api/auth/whoami"]
        self.assertTrue(whoami and whoami[0]["authorized"])

    # ── playback ──────────────────────────────────────────────────────────
    def test_play_resolves_a_stream_on_the_instance(self):
        result = self.execute({"action": "play", "query": "never gonna give you up"})
        self.assertEqual(result["video_id"], "lYBUbBu4W08")
        self.assertEqual(result["title"], "Never Gonna Give You Up")
        # The catalog's artist wins over the player's "… - Topic" channel.
        self.assertEqual(result["artist"], "Rick Astley")
        self.assertEqual(result["duration_sec"], 214)
        self.assertEqual(result["mime_type"], "audio/mp4")
        self.assertTrue(result["play_url"].startswith(self.fake.base_url + "/api/media/stream?"))
        self.assertIn("videoId=lYBUbBu4W08", result["play_url"])
        self.assertIn("itag%3D139", result["play_url"])

    def test_play_url_streams_audio_from_opendeck(self):
        result = self.execute({"action": "play", "query": "never gonna give you up"})
        request = urllib.request.Request(result["play_url"], headers={"Range": "bytes=0-1023"})
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers.get("content-type"), "audio/mp4")
            body = response.read()
        self.assertEqual(body, fake_opendeck.AUDIO_BYTES)
        media = [item for item in self.fake.requests if item["path"].startswith("/api/media/stream")]
        self.assertTrue(media, "the device's fetch must reach the OpenDeck stream endpoint")

    def test_play_by_video_id_skips_search(self):
        result = self.execute({"action": "play", "video_id": "cTHakk3Lnjk"})
        self.assertEqual(result["video_id"], "cTHakk3Lnjk")
        self.assertEqual(result["artist"], "Rick Astley")  # "Rick Astley - Topic" cleaned
        self.assertFalse([item for item in self.fake.catalog_requests() if "/search" in str(item.get("inner_url") or "")])
        players = [item for item in self.fake.catalog_requests() if "/player" in item["inner_url"]]
        self.assertTrue(players)
        self.assertIn(b"cTHakk3Lnjk", players[0]["inner_body"])

    # ── lyrics ────────────────────────────────────────────────────────────
    def test_lyrics_returns_synced_lines_through_the_proxy(self):
        result = self.execute({"action": "lyrics", "title": "Bohemian Rhapsody", "artist": "Queen", "duration_sec": 354})
        self.assertEqual(result["lyrics_timing"], "synced")
        self.assertEqual(result["lyrics_source"], "LRCLIB")
        self.assertEqual(result["count"], 4)
        self.assertEqual(result["lyrics"][0], {"time_sec": 0.5, "text": "Is this the real life?"})
        self.assertEqual(result["lyrics"][1]["time_sec"], 4.25)
        # One source line with two stamps becomes two timed lines.
        self.assertEqual([line["text"] for line in result["lyrics"][2:]], ["Caught in a landslide", "Caught in a landslide"])
        self.assertEqual([line["time_sec"] for line in result["lyrics"][2:]], [8.0, 12.0])
        proxy = [item for item in self.fake.catalog_requests() if "lrclib.net" in item["inner_url"]]
        self.assertTrue(proxy, "lyrics must go through OpenDeck's allowlisted proxy")
        self.assertIn("track_name=Bohemian+Rhapsody", proxy[0]["inner_url"])
        self.assertIn("duration=354", proxy[0]["inner_url"])
        for item in proxy:
            self.assertFalse(item["authorized"], "the lyrics lookup is anonymous")

    def test_lyrics_without_a_match_reports_none(self):
        result = self.execute({"action": "lyrics", "title": "nothing here", "artist": "Nobody"})
        self.assertEqual(result["lyrics"], [])
        self.assertEqual(result["lyrics_timing"], "none")
        self.assertEqual(result["count"], 0)
        self.assertIn("No lyrics", result["message"])

    def test_lyrics_returns_the_words_the_provider_has_without_timings(self):
        """A plain-only match is an answer: the words, not "no lyrics".

        LRCLIB has timings for only part of its catalog. Discarding an entry that
        has words but no stamps threw away the answer for every one of those
        tracks, so the page said "no lyrics are available" about a song whose
        words the provider was holding.
        """
        result = self.execute({"action": "lyrics", "title": "Words Alone", "artist": "The Testers", "duration_sec": 200})
        self.assertEqual(result["lyrics_timing"], "plain")
        self.assertEqual(result["lyrics"], [])
        self.assertEqual(result["lyrics_plain"], "These are the words\nof a plain song")
        self.assertEqual(result["lyrics_source"], "LRCLIB")

    def test_lyrics_picks_this_track_out_of_a_search_of_others(self):
        """Name and length decide, not the order the provider returned them in.

        The fake answers a search for "Words Alone" with a same-length entry for
        a different song (before the right one) and with a live take of the right
        name whose length gives it away. Taking the first entry whose words could
        be parsed put another song's timings on screen, marked as a success.
        """
        result = self.execute({"action": "lyrics", "title": "Words Alone", "artist": "The Testers", "duration_sec": 200})
        self.assertNotIn("different song's words", result["lyrics_plain"])
        self.assertEqual(result["lyrics"], [], "the decoy's timings must not be shown")
        searches = [item for item in self.fake.catalog_requests()
                    if "lrclib.net" in item["inner_url"] and "/api/search" in item["inner_url"]]
        self.assertTrue(searches, "a plain-only exact match still gets a search behind it")

    def test_lyrics_named_by_id_resolves_the_track_it_names(self):
        """A video id alone is resolved, and the name it resolves to is looked up."""
        result = self.execute({"action": "lyrics", "video_id": "lYBUbBu4W08"})
        lookups = [item for item in self.fake.catalog_requests() if "lrclib.net" in item["inner_url"]]
        self.assertIn("track_name=Never+Gonna+Give+You+Up", lookups[0]["inner_url"])
        # The length the player reported travels with the lookup: the provider's
        # exact endpoint needs it, and it is what rejects another song's words.
        self.assertIn("duration=214", lookups[0]["inner_url"])
        self.assertEqual(result["lyrics_timing"], "none")

    def test_lyrics_parser_ignores_metadata_and_sorts(self):
        parsed = OpenDeckService.parse_synced_lyrics("[00:10.00] second\nnot a line\n[00:05.50] first\n[ar:Queen]\n[00:12.00] third")
        self.assertEqual(parsed, [
            {"time_sec": 5.5, "text": "first"},
            {"time_sec": 10.0, "text": "second"},
            {"time_sec": 12.0, "text": "third"},
        ])

    def test_lyrics_accepts_an_empty_target_as_the_current_track(self):
        # "show me the lyrics" names no track: that is valid, and the handler
        # answers for the track this worker last handed over.
        self.assertEqual(
            OpenDeckService._validate_tool_arguments({"action": "lyrics"}),
            {"action": "lyrics", "video_id": ""},
        )
        validated = OpenDeckService._validate_tool_arguments({"action": "lyrics", "video_id": "lYBUbBu4W08", "duration_sec": 213})
        self.assertEqual(validated, {"action": "lyrics", "video_id": "lYBUbBu4W08", "duration_sec": 213})

    def test_lyrics_without_a_track_answers_for_the_last_played_track(self):
        self.execute({"action": "play", "video_id": "lYBUbBu4W08"})
        result = self.execute({"action": "lyrics"})
        lookups = [item for item in self.fake.catalog_requests() if "lrclib.net" in item["inner_url"]]
        self.assertTrue(lookups, "a bare lyrics request must look up the last played track")
        self.assertIn("track_name=Never+Gonna+Give+You+Up", lookups[0]["inner_url"])
        self.assertIn("duration=214", lookups[0]["inner_url"])
        # The fake's only lyrics are a 354s track while this one is 214s, so
        # the duration guard declines them instead of showing the wrong song.
        self.assertEqual(result["lyrics_timing"], "none")
        self.assertIn("Never Gonna Give You Up", result["message"])

    def test_lyrics_without_a_track_and_nothing_played_reports_plainly(self):
        with self.assertRaisesRegex(ValueError, "nothing has been played yet"):
            self.execute({"action": "lyrics"})

    def test_lyrics_falls_back_to_a_video_id_lookup(self):
        result = self.execute({"action": "lyrics", "video_id": "lYBUbBu4W08"})
        players = [item for item in self.fake.catalog_requests() if "/player" in item["inner_url"]]
        self.assertTrue(players, "a bare video_id must be resolved through the player first")
        lookups = [item for item in self.fake.catalog_requests() if "lrclib.net" in item["inner_url"]]
        self.assertTrue(lookups, "the resolved track must be looked up by name")
        self.assertIn("track_name=Never+Gonna+Give+You+Up", lookups[0]["inner_url"])
        # The fake's only lyrics are Bohemian Rhapsody (354s) while this track is
        # 214s, so the duration guard rejects them instead of showing the wrong song.
        self.assertEqual(result["lyrics_timing"], "none")
        self.assertEqual(result["lyrics"], [])

    # ── queue reorder, priority, and now-playing ─────────────────────────
    def test_queue_move_swaps_positions_and_follows_the_playing_track(self):
        # Track B (index 1) is playing; move the first entry to the end.
        self.seed_queue(["A", "B", "C"], current_index=1)
        moved = self.execute({"action": "queue", "op": "move", "index": 0, "to": 2})
        self.assertEqual([item["title"] for item in moved["queue"]], ["B", "C", "A"])
        # The playing marker follows the track it pointed at, not the old slot.
        self.assertEqual(moved["queue"][moved["queue_index"]]["title"], "B")

    def test_queue_front_moves_a_queued_track_to_the_front(self):
        self.seed_queue(["A", "B", "C"])
        result = self.execute({"action": "queue", "op": "front", "index": 2})
        self.assertEqual([item["title"] for item in result["queue"]], ["C", "A", "B"])
        self.assertIn("front", result["message"])

    def test_queue_next_up_puts_a_track_right_after_the_playing_one(self):
        self.seed_queue(["A", "B", "C", "D"], current_index=0)
        result = self.execute({"action": "queue", "op": "next_up", "index": 3})
        self.assertEqual([item["title"] for item in result["queue"]], ["A", "D", "B", "C"])

    # ── a track that has had its turn leaves the queue ────────────────────
    def test_an_advance_drops_the_track_it_leaves_behind(self):
        """A song that finished (or was skipped) has had its turn, so it stops
        being listed: the queue is what is left to play, not a record of what
        has already played."""
        self.seed_queue(["A", "B", "C"], current_index=0)
        ended = self.execute({"action": "queue", "op": "next", "auto": True})
        self.assertEqual([item["title"] for item in ended["queue"]], ["B", "C"])
        self.assertEqual(ended["count"], 2)
        self.assertEqual(ended["queue"][ended["queue_index"]]["title"], "B")

        # A skip is the same: the song being left does not come back.
        skipped = self.execute({"action": "queue", "op": "next"})
        self.assertEqual([item["title"] for item in skipped["queue"]], ["C"])
        self.assertEqual(skipped["queue_index"], 0)

    def test_repeat_modes_keep_the_track_so_repeat_still_works(self):
        """Repeat-all has to be able to wrap back to a track and repeat-one has
        to be able to play it again, so both keep what the others drop."""
        self.seed_queue(["A", "B", "C"], current_index=1)
        self.execute({"action": "queue", "op": "repeat", "mode": "all"})
        wrapped = self.execute({"action": "queue", "op": "next", "auto": True})
        self.assertEqual([item["title"] for item in wrapped["queue"]], ["A", "B", "C"])
        self.assertEqual(wrapped["queue_index"], 2)

        self.execute({"action": "queue", "op": "repeat", "mode": "one"})
        again = self.execute({"action": "queue", "op": "next", "auto": True})
        self.assertEqual([item["title"] for item in again["queue"]], ["A", "B", "C"])
        self.assertEqual(again["queue_index"], 2)

    # ── a song and everything under it ────────────────────────────────────
    def test_add_range_queues_a_playlist_from_one_song_to_the_end(self):
        """The button on a playlist row: this song and every song under it.
        Nothing above the chosen song is queued, which is the point of it.

        A real playlist, browsed from the catalog, because that is what the
        button sits in; the two linked songs are both in it, and the second one
        is chosen so there is a song above it to leave out."""
        browsed = self.service.browse_playlist("PL-fake-ultimate")
        self.assertGreaterEqual(len(browsed), 2, "the fake playlist has songs to queue")
        chosen = browsed[1]
        result = self.execute({
            "action": "queue", "op": "add_range",
            "playlist_id": "PL-fake-ultimate", "video_id": chosen["video_id"],
        })
        queued = [item["video_id"] for item in result["queue"]]
        self.assertEqual(queued, [track["video_id"] for track in browsed[1:]],
                         "the tail of the playlist, from the chosen song on")
        self.assertNotIn(browsed[0]["video_id"], queued, "nothing above it is queued")
        self.assertEqual(result["video_id"], chosen["video_id"])
        self.assertIn(str(len(browsed) - 1), result["message"])

    def test_add_range_appends_to_what_is_already_queued(self):
        self.seed_queue(["A"], current_index=-1)
        liked = self.execute({"action": "library", "kind": "likes"})["tracks"]
        result = self.execute({
            "action": "queue", "op": "add_range",
            "playlist_id": "LM", "video_id": liked[0]["video_id"],
        })
        self.assertEqual([item["title"] for item in result["queue"]][0], "A")
        self.assertEqual(result["count"], 1 + len(liked))

    def test_add_range_refuses_a_song_that_is_not_in_the_playlist(self):
        with self.assertRaises(RuntimeError):
            self.execute({
                "action": "queue", "op": "add_range",
                "playlist_id": "PL-fake-ultimate", "video_id": "notinthislist",
            })

    def test_add_range_needs_the_playlist_it_came_from(self):
        with self.assertRaises(ValueError):
            OpenDeckService._validate_tool_arguments({"action": "queue", "op": "add_range"})

    # ── shuffle and repeat ────────────────────────────────────────────────
    def test_queue_shuffle_keeps_the_playing_track_and_restores_the_order(self):
        self.seed_queue(["A", "B", "C", "D", "E", "F"], current_index=1)
        shuffled = self.execute({"action": "queue", "op": "shuffle"})
        self.assertTrue(shuffled["shuffle"])
        self.assertEqual(shuffled["repeat"], "off")
        # Every track is still queued and the playing one did not move; only
        # what waits behind it is reordered.
        self.assertEqual(sorted(item["title"] for item in shuffled["queue"]), list("ABCDEF"))
        self.assertEqual(shuffled["queue"][0]["title"], "A")
        self.assertEqual(shuffled["queue"][shuffled["queue_index"]]["title"], "B")
        restored = self.execute({"action": "queue", "op": "shuffle", "on": False})
        self.assertFalse(restored["shuffle"])
        self.assertEqual([item["title"] for item in restored["queue"]], list("ABCDEF"))
        self.assertEqual(restored["queue_index"], 1)
        # The state is on disk, so a later read reports the same two flags.
        self.assertFalse(self.execute({"action": "queue", "op": "list"})["shuffle"])

    def test_queue_shuffle_keeps_a_track_added_while_shuffled(self):
        self.seed_queue(["A", "B", "C"], current_index=0)
        self.execute({"action": "queue", "op": "shuffle"})
        added = self.execute({"action": "queue", "op": "add", "video_id": "lYBUbBu4W08"})
        self.assertEqual(added["count"], 4)
        restored = self.execute({"action": "queue", "op": "shuffle", "on": False})
        titles = [item["title"] for item in restored["queue"]]
        # The queued order comes back, and the track added while shuffled keeps
        # its place at the end instead of being lost.
        self.assertEqual(titles[:3], ["A", "B", "C"])
        self.assertEqual(titles[3], "Never Gonna Give You Up")

    def test_queue_repeat_one_restarts_a_finished_track_but_a_skip_moves_on(self):
        self.seed_queue(["A", "B", "C"], current_index=1)
        self.execute({"action": "queue", "op": "repeat", "mode": "one"})
        # `auto` is the console noticing the track ended, not a skip.
        repeated = self.execute({"action": "queue", "op": "next", "auto": True})
        self.assertEqual(repeated["queue_index"], 1)
        self.assertEqual(repeated["repeat"], "one")
        self.assertTrue(repeated["play_url"])
        skipped = self.execute({"action": "queue", "op": "next"})
        self.assertEqual(skipped["queue_index"], 2)

    def test_queue_repeat_all_wraps_and_off_stops_at_the_end(self):
        self.seed_queue(["A", "B"], current_index=1)
        stopped = self.execute({"action": "queue", "op": "next", "auto": True})
        self.assertEqual(stopped["queue_index"], 1)
        self.assertEqual(stopped["play_url"], "")
        self.assertIn("no next track", stopped["message"])
        self.execute({"action": "queue", "op": "repeat", "mode": "all"})
        wrapped = self.execute({"action": "queue", "op": "next", "auto": True})
        self.assertEqual(wrapped["queue_index"], 0)
        self.assertEqual(wrapped["repeat"], "all")
        self.assertTrue(wrapped["play_url"])

    def test_queue_shuffle_and_repeat_arguments_are_validated(self):
        self.assertEqual(
            OpenDeckService._validate_tool_arguments({"action": "queue", "op": "shuffle", "on": False}),
            {"action": "queue", "op": "shuffle", "on": False},
        )
        self.assertEqual(
            OpenDeckService._validate_tool_arguments({"action": "queue", "op": "repeat", "mode": "all"}),
            {"action": "queue", "op": "repeat", "mode": "all"},
        )
        for arguments in (
            {"action": "queue", "op": "shuffle", "on": "yes"},
            {"action": "queue", "op": "repeat", "mode": "sometimes"},
            {"action": "queue", "op": "next", "auto": "yes"},
            {"action": "queue", "op": "rewind"},
        ):
            with self.assertRaises(ValueError, msg=f"{arguments} should be rejected"):
                OpenDeckService._validate_tool_arguments(arguments)

    def test_now_playing_reports_the_current_track(self):
        empty = self.execute({"action": "now_playing"})
        self.assertIn("Nothing is playing", empty["message"])
        self.execute({"action": "play", "video_id": "lYBUbBu4W08"})
        result = self.execute({"action": "now_playing"})
        self.assertEqual(result["title"], "Never Gonna Give You Up")
        self.assertIn("is playing on OpenDeck", result["message"])

    # ── library ───────────────────────────────────────────────────────────
    def test_library_kinds(self):
        playlists = self.execute({"action": "library", "kind": "playlists"})
        # Liked songs are an auto playlist in the linked library, so they lead
        # the list the way OpenDeck's own client lists them, followed by the
        # account's playlists and then this instance's own store.
        self.assertEqual(
            playlists["playlists"][0],
            {
                "playlist_id": "LM",
                "name": "Liked Music",
                "track_count": 2,
                "artwork_url": "http://art.example/hq.jpg",
            },
        )
        self.assertEqual(
            [item["playlist_id"] for item in playlists["playlists"]],
            ["LM", "PL-fake-ultimate", "pl-road"],
        )
        self.assertEqual(playlists["playlists"][1]["name"], "Ultimate")
        self.assertEqual(playlists["playlists"][2]["name"], "Road Trip")
        self.assertEqual(playlists["playlists"][2]["track_count"], 2)
        # Every playlist carries its cover, so the page can show the picture the
        # provider has instead of drawing a placeholder for each one. A playlist
        # stored without artwork reports an empty URL rather than dropping the
        # field: the result schema declares it for every entry.
        self.assertEqual(playlists["playlists"][1]["artwork_url"], "http://art.example/120.jpg")
        self.assertEqual(playlists["playlists"][2]["artwork_url"], "")
        for item in playlists["playlists"]:
            self.assertIn("artwork_url", item)

        liked_music = self.execute({"action": "library", "kind": "playlist", "playlist_id": "LM"})
        self.assertEqual(liked_music["count"], 2)
        self.assertEqual(liked_music["tracks"][0]["video_id"], "lYBUbBu4W08")
        self.assertEqual(liked_music["tracks"][0]["duration_sec"], 214)

        playlist = self.execute({"action": "library", "kind": "playlist", "playlist_id": "pl-road"})
        self.assertEqual(playlist["tracks"][0]["video_id"], "lYBUbBu4W08")

        linked = self.execute({"action": "library", "kind": "playlist", "playlist_id": "PL-fake-ultimate"})
        self.assertEqual([item["video_id"] for item in linked["tracks"]], ["lYBUbBu4W08", "cTHakk3Lnjk"])
        # A playlist of the linked account lives in YouTube, not in the store,
        # so it is browsed anonymously through the catalog proxy; the duration
        # of those rows arrives in a fixed column of its own.
        browse = [item for item in self.fake.catalog_requests() if "/youtubei/v1/browse" in item["inner_url"]]
        self.assertTrue(browse, "a linked playlist must be browsed through the proxy")
        self.assertIn("VLPL-fake-ultimate", browse[0]["inner_body"].decode("utf-8"))
        self.assertFalse(browse[0]["authorized"], "the catalog browse is anonymous")
        self.assertEqual(linked["tracks"][0]["duration_sec"], 213)
        self.assertEqual(linked["tracks"][1]["duration_sec"], 215)

        likes = self.execute({"action": "library", "kind": "likes"})
        self.assertEqual(likes["count"], 2)
        self.assertEqual(likes["tracks"][1]["artist"], "TheRealSullyG")

        history = self.execute({"action": "library", "kind": "history"})
        self.assertEqual(history["tracks"][0]["title"], "Never Gonna Give You Up")

        stats = self.execute({"action": "library", "kind": "stats"})
        self.assertEqual(stats["count"], 13)
        self.assertEqual(stats["title"], "Never Gonna Give You Up")

    def test_most_played_is_ranked_from_the_play_log(self):
        """The songs this account plays most, in that order and with the count.

        The instance's own stats rank its ten most played; the play log holds the
        whole picture, so this read ranks it here. It is what the wall display's
        "Frequently played" shelf is built from, so the count and the cover the
        log recorded travel with each track.
        """
        # The ranking is read from the whole log, which is what the wall display
        # asks for when it fills its "Frequently played" shelf.
        frequent = self.execute({"action": "library", "kind": "frequent", "limit": 200})
        self.assertEqual(
            [item["video_id"] for item in frequent["tracks"][:3]],
            ["lYBUbBu4W08", "cTHakk3Lnjk", "kXYiU_JCYtU"],
            "the songs are ranked by how often they were played",
        )
        self.assertEqual(frequent["tracks"][0]["plays"], 3, "a song played three times says so")
        self.assertEqual(frequent["tracks"][1]["plays"], 2)
        self.assertEqual(frequent["tracks"][2]["plays"], 1, "a song played once says once")
        self.assertEqual(frequent["count"], len(fake_opendeck.PLAY_LOG_SONGS), "the count is songs, not plays")
        self.assertEqual(frequent["tracks"][0]["artwork_url"], "http://art.example/hq.jpg")

        # A page of them is a page: the reader's own limit is what cuts it.
        one = self.execute({"action": "library", "kind": "frequent", "limit": 1})
        self.assertEqual(
            [item["video_id"] for item in one["tracks"]],
            ["lYBUbBu4W08"],
            "the ranking is cut to the size the reader asked for",
        )

    def test_a_library_read_is_a_list_not_a_page_of_search_results(self):
        """A longer list than one search page comes back whole.

        Found live: every result's `tracks` list was cut to MAX_RESULTS (12), which
        is the right size for the songs a search answers with but not for a list
        somebody is browsing. The wall display's "See all" on a 439-song playlist
        came back twelve songs long with the shelf under it still saying 439, and a
        history read of fifty plays was twelve of them. The fixture's own play log
        is longer than that page on purpose, so this is the case it can catch.
        """
        self.assertGreater(
            len(fake_opendeck.HISTORY_PLAYS), opendeck_worker.MAX_RESULTS,
            "the fixture has to hold more than the cut for this check to mean anything",
        )
        log = self.execute({"action": "library", "kind": "history", "limit": 50})
        self.assertEqual(len(log["tracks"]), len(fake_opendeck.HISTORY_PLAYS),
                         "every play the log holds is listed")
        self.assertEqual(log["count"], len(fake_opendeck.HISTORY_PLAYS))

        # The ranking is a list too: more songs than a search page, in order.
        frequent = self.execute({"action": "library", "kind": "frequent", "limit": 200})
        self.assertEqual(len(frequent["tracks"]), len(fake_opendeck.PLAY_LOG_SONGS),
                         "every song the log names is ranked")
        self.assertGreater(len(frequent["tracks"]), opendeck_worker.MAX_RESULTS)
        self.assertEqual([item["plays"] for item in frequent["tracks"][:3]], [3, 2, 1])

        # A search is still a page of answers, and the page is still twelve.
        searched = self.execute({"action": "search", "query": "Never Gonna Give You Up", "limit": 12})
        self.assertLessEqual(len(searched["tracks"]), opendeck_worker.MAX_RESULTS)

    def test_library_reads_are_cached_and_refreshed_not_repeated(self):
        """A repeat read is answered from disk; a stale one is refetched.

        The Music page paints a cached list and then asks again, and the
        assistant asks for the same playlists in the same conversation, so the
        second read of an unchanged library must not cost another browse of a
        linked account (seconds, on a real instance).
        """
        first = self.execute({"action": "library", "kind": "playlists"})
        reads = len(self.library_requests())
        self.assertTrue(reads, "the first read goes out to the provider")
        self.assertTrue(os.path.exists(opendeck_worker.LIBRARY_CACHE_FILE), "the read is cached")

        again = self.execute({"action": "library", "kind": "playlists"})
        self.assertEqual(again["playlists"], first["playlists"])
        self.assertEqual(len(self.library_requests()), reads, "a fresh copy is served from the cache")

        # The same read from a second service instance (a new request in the
        # console) is still a cache hit: the cache belongs to the worker's data
        # directory, not to one process.
        other = OpenDeckService()
        other.initialize({"server_url": self.fake.base_url, "api_key": API_KEY})
        response = asyncio.run(
            other.handle("execute", {"tool": "opendeck_music", "arguments": {"action": "library", "kind": "playlists"}})
        )
        self.assertEqual(response["result"]["playlists"], first["playlists"])
        self.assertEqual(len(self.library_requests()), reads, "a restarted worker reuses the cache")

        # Age the entry past its TTL: the next read refreshes it.
        self.age_cache_entries()
        refreshed = self.execute({"action": "library", "kind": "playlists"})
        self.assertGreater(len(self.library_requests()), reads, "a stale copy is refreshed")
        self.assertEqual(refreshed["playlists"], first["playlists"])

    def test_a_stale_library_copy_outlasts_an_unreachable_provider(self):
        """When OpenDeck cannot answer, the page keeps the list it had.

        A speaker's host going away (or the instance restarting) must not empty
        the Music page: slightly old playlists are a far better answer than an
        error, and the copy is dropped as soon as its age makes it misleading.
        """
        first = self.execute({"action": "library", "kind": "playlists"})
        self.age_cache_entries()

        # The instance is gone: the port is closed, so every read fails. Its own
        # server is stopped rather than the whole fake, which the assertions
        # below still need for the failure half of this test.
        unavailable = OpenDeckService()
        unavailable.initialize({"server_url": self.fake.base_url, "api_key": API_KEY})
        self.fake.server.shutdown()
        self.fake.server.server_close()

        stale = asyncio.run(
            unavailable.handle(
                "execute", {"tool": "opendeck_music", "arguments": {"action": "library", "kind": "playlists"}}
            )
        )
        self.assertEqual(stale["result"]["playlists"], first["playlists"], "the stale copy is still served")

        # With no copy to fall back on, the same read must report the failure
        # instead of inventing an empty library.
        os.remove(opendeck_worker.LIBRARY_CACHE_FILE)
        with self.assertRaises(RuntimeError):
            asyncio.run(
                unavailable.handle(
                    "execute", {"tool": "opendeck_music", "arguments": {"action": "library", "kind": "playlists"}}
                )
            )

    def test_a_write_drops_the_cached_reads_it_changed(self):
        """A like changes the liked songs, not the history the user is browsing.

        This cache is shared by every surface (the Music page, the PUCA Panel, the
        assistant), and a write used to drop all of it — so one like cost the next
        browse of the library its cache, and the panel's own refresh was another
        multi-second browse of a linked account. A write now drops the reads that
        answer with what it changed; an unrecognised write still drops everything.
        """
        self.execute({"action": "library", "kind": "likes"})
        self.execute({"action": "library", "kind": "history"})
        keys = sorted(self.cache_entries())
        self.assertTrue([key for key in keys if key.startswith("likes:")], f"the liked songs are cached: {keys}")
        self.assertTrue([key for key in keys if key.startswith("history:")], f"the history is cached: {keys}")

        self.execute({"action": "save", "kind": "like", "video_id": "lYBUbBu4W08", "title": "Song"})

        keys = sorted(self.cache_entries())
        self.assertFalse([key for key in keys if key.startswith("likes:")], f"the liked songs are forgotten: {keys}")
        self.assertTrue([key for key in keys if key.startswith("history:")], f"an unrelated read survives: {keys}")

        # ...and the forgotten read really does go back to the provider, rather
        # than being served from a copy that is now wrong. Counted over every
        # request, because the liked songs come from the linked account's own
        # library rather than from the instance's store.
        reads = len(self.fake.requests)
        self.execute({"action": "library", "kind": "likes"})
        self.assertGreater(len(self.fake.requests), reads, "the changed read is fetched again")

    def test_a_failed_refresh_is_not_retried_on_every_read(self):
        """A provider that is down is not browsed again on every poll.

        Measured live: the console's own cache serves the list it holds and asks
        this worker to refresh it in the background, so a single open Music page
        (or two panels) reached a failing provider over and over — the same
        multi-second browse, once per poll, for as long as the screen stayed
        open. The failure is recorded, the stale copy is served as-is, and the
        provider is left alone until the backing-off window has passed.
        """
        first = self.execute({"action": "library", "kind": "playlists"})
        self.age_cache_entries()

        unavailable = OpenDeckService()
        unavailable.initialize({"server_url": self.fake.base_url, "api_key": API_KEY})
        self.fake.server.shutdown()
        self.fake.server.server_close()

        def read() -> dict:
            return asyncio.run(
                unavailable.handle(
                    "execute", {"tool": "opendeck_music", "arguments": {"action": "library", "kind": "playlists"}}
                )
            )["result"]

        self.assertEqual(read()["playlists"], first["playlists"], "the copy is still served when the provider is down")
        entry = self.cache_entry_for("playlists:")
        self.assertEqual(entry["attempts"], 1, "the failed refresh is recorded")
        self.assertTrue(entry["last_error"], "and says what went wrong")
        self.assertEqual(entry["payload"]["playlists"], first["playlists"], "the stored copy is not damaged by the failure")

        recorded = float(entry["last_attempt"])
        for _ in range(3):
            self.assertEqual(read()["playlists"], first["playlists"])
        waiting = self.cache_entry_for("playlists:")
        self.assertEqual(waiting["attempts"], 1, "no further attempt is made while the refresh is backing off")
        self.assertEqual(float(waiting["last_attempt"]), recorded, "and the failure is not re-recorded either")

        # Once the window has passed, the provider is tried again — and here it
        # is still down, so the copy is served and the failure noted once more.
        entries = self.cache_entries()
        for cached in entries.values():
            cached["last_attempt"] = float(cached["last_attempt"] or 0) - opendeck_worker.CACHE_RETRY_AFTER - 1
        with open(opendeck_worker.LIBRARY_CACHE_FILE, "w", encoding="utf-8") as handle:
            json.dump({"entries": entries}, handle)
        self.assertEqual(read()["playlists"], first["playlists"])
        self.assertEqual(self.cache_entry_for("playlists:")["attempts"], 2, "the provider is tried again after the window")

    def seed_playing(self, video_id: str, title: str) -> None:
        """Make the worker believe this track is the one playing.

        That is what a spoken "this song" means, and the worker reads it from
        its own now-playing state rather than being handed an id.
        """
        with open(opendeck_worker.NOW_PLAYING_FILE, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "video_id": video_id,
                    "title": title,
                    "artist": "Ada Lovelace",
                    "album": "",
                    "duration_sec": 214,
                    "artwork_url": "",
                },
                handle,
            )

    def test_add_this_song_to_a_playlist_by_name(self):
        """"add this to my Road Trip playlist" reaches the right playlist.

        A person names a playlist; only a lookup would produce its id. The name
        is matched against the playlists the page already lists — the linked
        account's, then this instance's store — without regard to case, and the
        track is the one that is playing.
        """
        self.seed_playing("lYBUbBu4W08", "Never Gonna Give You Up")
        response = self.execute({"action": "save", "kind": "playlist_add", "name": "road trip"})
        self.assertIn("Road Trip", response["message"])
        self.assertEqual(response["count"], 3)
        posted = [entry["path"] for entry in self.fake.requests if entry["method"] == "POST"]
        self.assertIn("/api/library/playlists/pl-road/tracks", posted)
        self.assertNotIn("/api/library/playlists", posted, "an existing playlist is not created twice")
        add = next(entry for entry in self.fake.requests if entry["path"].endswith("/tracks"))
        body = json.loads(add["body"].decode("utf-8"))
        self.assertEqual(body["tracks"][0]["id"], "lYBUbBu4W08", "the playing track is added")
        self.assertEqual(body["tracks"][0]["title"], "Never Gonna Give You Up")

    def test_a_playlist_named_out_loud_is_created_when_it_is_new(self):
        """A name nothing matches becomes a playlist, named as the user said it."""
        self.seed_playing("lYBUbBu4W08", "Never Gonna Give You Up")
        response = self.execute(
            {"action": "save", "kind": "playlist_add", "name": "my Late Night playlist"}
        )
        creates = [
            entry for entry in self.fake.requests
            if entry["method"] == "POST" and entry["path"] == "/api/library/playlists"
        ]
        self.assertEqual(len(creates), 1, "the playlist is created once")
        self.assertEqual(
            json.loads(creates[0]["body"].decode("utf-8"))["name"],
            "Late Night",
            "the possessive and the word 'playlist' are not part of the name",
        )
        posted = [entry["path"] for entry in self.fake.requests if entry["method"] == "POST"]
        self.assertIn("/api/library/playlists/pl-new/tracks", posted)
        self.assertIn("created", response["message"])
        self.assertEqual(response["title"], "Late Night")
        self.assertEqual(
            [item["playlist_id"] for item in response["playlists"]],
            ["pl-new"],
            "the playlist this call created is reported back",
        )

    def test_adding_to_liked_music_is_a_like(self):
        """"add this to my Liked Music" fills the like list, not a playlist.

        Liked Music is an auto playlist: OpenDeck refuses a write to it, and the
        like control is what fills it, so the request is answered as a like.
        """
        self.seed_playing("lYBUbBu4W08", "Never Gonna Give You Up")
        response = self.execute({"action": "save", "kind": "playlist_add", "name": "liked music"})
        self.assertEqual(response["count"], 3, "the like list grew")
        methods = [(entry["method"], entry["path"]) for entry in self.fake.requests]
        self.assertIn(("PUT", "/api/library/likes/lYBUbBu4W08"), methods)
        self.assertFalse(
            [path for method, path in methods if path.endswith("/tracks")],
            "nothing is written to the Liked Music auto playlist",
        )

    def test_liking_or_adding_without_a_track_is_refused(self):
        """Nothing playing and no video_id is an answerable failure, not a guess."""
        with self.assertRaises(ValueError):
            self.execute({"action": "save", "kind": "like"})
        with self.assertRaises(ValueError):
            self.execute({"action": "save", "kind": "playlist_add", "name": "Focus"})
        with self.assertRaises(ValueError):
            self.execute({"action": "save", "kind": "playlist_add", "video_id": "lYBUbBu4W08"})

    def test_spoken_queue_requests_are_matched_to_the_right_op(self):
        """What a person says about the queue, and the op it becomes."""
        service = OpenDeckService()
        cases = {
            "add the song believer to the queue": {"action": "queue", "op": "add", "query": "believer"},
            "add believer to my queue": {"action": "queue", "op": "add", "query": "believer"},
            "queue up believer": {"action": "queue", "op": "add", "query": "believer"},
            "queue believer": {"action": "queue", "op": "add", "query": "believer"},
            # The track that is playing, which the queue handler resolves.
            "add this to the queue": {"action": "queue", "op": "add", "query": ""},
            "play the song believer next": {"action": "queue", "op": "next_up", "query": "believer"},
            "play believer first": {"action": "queue", "op": "front", "query": "believer"},
            # The queue's own next entry, which is an advance, not a prioritise.
            "play the next queued track": {"action": "queue", "op": "next"},
            "play next": {"action": "queue", "op": "next"},
            "skip this track": {"action": "queue", "op": "next"},
            "what's in my queue": {"action": "queue", "op": "list"},
            "show my queue": {"action": "queue", "op": "list"},
            "clear the queue": {"action": "queue", "op": "clear"},
            "remove believer from the queue": {"action": "queue", "op": "remove", "query": "believer"},
            "remove track 2 from the queue": {"action": "queue", "op": "remove", "index": 1},
            # Shuffle and repeat are the queue's own preferences. Said out loud
            # they switch on (the page's button is the toggle), and an off word
            # turns them back off.
            "shuffle the queue": {"action": "queue", "op": "shuffle", "on": True},
            "shuffle my music": {"action": "queue", "op": "shuffle", "on": True},
            "turn on shuffle": {"action": "queue", "op": "shuffle", "on": True},
            "turn shuffle off": {"action": "queue", "op": "shuffle", "on": False},
            "stop shuffling": {"action": "queue", "op": "shuffle", "on": False},
            "repeat this song": {"action": "queue", "op": "repeat", "mode": "one"},
            "loop this track": {"action": "queue", "op": "repeat", "mode": "one"},
            # The same requests with manners on them: the polite frame is not a
            # track title, so it comes off before the words are read.
            "can you shuffle the queue": {"action": "queue", "op": "shuffle", "on": True},
            "shuffle the queue please": {"action": "queue", "op": "shuffle", "on": True},
            "could you repeat this song please": {"action": "queue", "op": "repeat", "mode": "one"},
            "repeat the queue": {"action": "queue", "op": "repeat", "mode": "all"},
            "repeat everything": {"action": "queue", "op": "repeat", "mode": "all"},
            "stop repeating": {"action": "queue", "op": "repeat", "mode": "off"},
            # No mode named: the handler cycles, which is what one word means.
            "repeat": {"action": "queue", "op": "repeat"},
        }
        for phrase, expected in cases.items():
            self.assertEqual(service._arguments(phrase), expected, phrase)
        # A request that names a track is not a queue preference, however it is
        # worded: those words are not all preference words, so it stays a search
        # or a play for the caller to resolve.
        for named in ("search for shuffle", "repeat believer", "repeat forever"):
            self.assertNotEqual(service._arguments(named).get("op"), "shuffle", named)
            self.assertNotEqual(service._arguments(named).get("op"), "repeat", named)

    def test_spoken_shuffle_and_repeat_run_against_the_queue(self):
        """The phrases, executed: both preferences come back on every reply."""
        service = self.service
        self.execute(service._arguments("queue up believer"))
        self.execute(service._arguments("queue up born to run"))

        shuffled = self.execute(service._arguments("shuffle the queue"))
        self.assertTrue(shuffled["shuffle"])
        self.assertEqual(shuffled["count"], 2, "shuffling keeps every track")

        repeated = self.execute(service._arguments("repeat this song"))
        self.assertEqual(repeated["repeat"], "one")
        self.assertTrue(repeated["shuffle"], "repeating leaves shuffle as it was")

        # "stop" is a state, not a no-op: it comes back switched off.
        self.assertFalse(self.execute(service._arguments("turn shuffle off"))["shuffle"])
        self.assertEqual(self.execute(service._arguments("stop repeating"))["repeat"], "off")
        # The snapshot the page and the app read carries the same two fields.
        snapshot = self.execute({"action": "now_playing"})
        self.assertIn("shuffle", snapshot)
        self.assertIn("repeat", snapshot)

    def test_spoken_queue_requests_run_against_the_queue(self):
        """The same phrases, executed: queue Believer, list it, then drop it."""
        service = self.service
        add = service._arguments("add the song believer to the queue")
        queued = self.execute(add)
        self.assertEqual(queued["count"], 1)
        self.assertEqual(queued["queue"][0]["video_id"], "lYBUbBu4W08")

        listed = self.execute(service._arguments("what's in my queue"))
        self.assertEqual(listed["count"], 1)
        self.assertEqual(listed["queue"][0]["title"], "Never Gonna Give You Up")

        # A second entry, then the named removal drops one of them — by name,
        # not by guessing a position. (This fake answers every catalog search
        # with the same track, so which of the two goes is not distinguishable
        # here; that the named form resolves and removes exactly one is.)
        second = self.execute(service._arguments("queue born to run"))
        self.assertEqual(second["count"], 2)
        remaining = self.execute(service._arguments("remove never gonna give you up from the queue"))
        self.assertEqual(remaining["count"], 1)
        self.assertIn("Removed", remaining["message"])

        cleared = self.execute(service._arguments("clear the queue"))
        self.assertEqual(cleared["count"], 0)
        empty = self.execute(service._arguments("what's in my queue"))
        self.assertEqual(empty["message"], "The queue is empty.")

    def test_removing_a_queue_position_that_does_not_exist_is_reported(self):
        """An unanswerable removal says so instead of dropping some other track.

        (The named form resolves through the catalog, and this fake answers every
        search with the same track, so the out-of-range form is the one that can
        be exercised here; the named form is covered above.)
        """
        self.execute(self.service._arguments("queue never gonna give you up"))
        with self.assertRaises(RuntimeError):
            self.execute({"action": "queue", "op": "remove", "index": 4})
        kept = self.execute(self.service._arguments("what's in my queue"))
        self.assertEqual(kept["count"], 1, "nothing was dropped by the refused removal")

    def test_spoken_save_requests_are_matched_to_the_right_action(self):
        """What the user says out loud, and what the worker does about it."""
        cases = {
            "add this song to my liked music": {"action": "save", "kind": "like"},
            "save this to my likes": {"action": "save", "kind": "like"},
            "like this song": {"action": "save", "kind": "like", "title": "like this song"},
            "add this song to my Late Night playlist": {
                "action": "save", "kind": "playlist_add", "name": "Late Night"
            },
            "save it to Focus": {"action": "save", "kind": "playlist_add", "name": "Focus"},
            "add that track into my Road Trip playlist": {
                "action": "save", "kind": "playlist_add", "name": "Road Trip"
            },
        }
        for phrase, expected in cases.items():
            self.assertEqual(self.service._arguments(phrase), expected, phrase)
        # A phrase that names a song rather than the one playing is not a save:
        # the track has to be found first, so it stays a search or a play.
        named = self.service._arguments("add Bohemian Rhapsody to Focus")
        self.assertNotEqual(named.get("action"), "save", named)

    def test_library_falls_back_to_the_store_without_a_linked_account(self):
        with FakeOpenDeck(youtube_linked=False) as fake:
            service = OpenDeckService()
            service.initialize({"server_url": fake.base_url, "api_key": API_KEY})
            self.assertFalse(service.youtube_linked)

            def execute(arguments: dict) -> dict:
                response = asyncio.run(
                    service.handle("execute", {"tool": "opendeck_music", "arguments": arguments})
                )
                result = response["result"]
                assert_schema(result, RESULT_SCHEMA, "result")
                return result

            playlists = execute({"action": "library", "kind": "playlists"})
            self.assertEqual([item["playlist_id"] for item in playlists["playlists"]], ["LM", "pl-road"])
            # The auto playlist still leads the list, sized by the store's likes.
            self.assertEqual(playlists["playlists"][0]["track_count"], 1)

            liked_music = execute({"action": "library", "kind": "playlist", "playlist_id": "LM"})
            self.assertEqual(liked_music["count"], 1)
            self.assertEqual(liked_music["tracks"][0]["album"], "Whenever You Need Somebody")

            likes = execute({"action": "library", "kind": "likes"})
            self.assertEqual(likes["count"], 1)

            self.assertFalse(
                [item for item in fake.requests if item["path"] == "/api/youtube/library"],
                "an unlinked instance is never asked for a YouTube library",
            )

    def test_library_playlist_requires_an_id(self):
        with self.assertRaises(ValueError):
            self.execute({"action": "library", "kind": "playlist"})

    # ── writes ────────────────────────────────────────────────────────────
    def test_save_like_and_unlike(self):
        liked = self.execute({"action": "save", "kind": "like", "video_id": "lYBUbBu4W08", "title": "Never Gonna Give You Up", "artist": "Rick Astley"})
        self.assertEqual(liked["count"], 3)
        put = [item for item in self.fake.requests if item["method"] == "PUT"]
        self.assertTrue(put and put[0]["authorized"])
        payload = json.loads(put[0]["body"].decode("utf-8"))
        self.assertEqual(payload["id"], "lYBUbBu4W08")
        self.assertEqual(payload["title"], "Never Gonna Give You Up")

        unliked = self.execute({"action": "save", "kind": "unlike", "video_id": "lYBUbBu4W08"})
        self.assertEqual(unliked["count"], 2)
        self.assertTrue([item for item in self.fake.requests if item["method"] == "DELETE"])

    def test_save_playlist_create_and_add(self):
        created = self.execute({"action": "save", "kind": "playlist_create", "name": "Late Night"})
        self.assertEqual(created["title"], "Late Night")
        self.assertEqual(created["playlists"][0]["playlist_id"], "pl-new")
        added = self.execute({"action": "save", "kind": "playlist_add", "playlist_id": "pl-new", "video_id": "lYBUbBu4W08", "title": "Never Gonna Give You Up"})
        self.assertEqual(added["count"], 3)

    # ── argument validation ───────────────────────────────────────────────
    def test_arguments_are_bounded(self):
        for arguments in (
            {"action": "download"},
            {"action": "search"},
            {"action": "search", "query": "x", "limit": 99},
            {"action": "search", "query": "x", "extra": 1},
            {"action": "play"},
            {"action": "play", "video_id": "no"},
            {"action": "library", "kind": "everything"},
            {"action": "save", "kind": "delete_everything", "video_id": "lYBUbBu4W08"},
            # A playlist add with no destination at all is unanswerable. A like
            # or a playlist add that names no track is *not* rejected here any
            # more: "like this song" and "add this to my Focus playlist" mean
            # the track that is playing, which the handler resolves (and
            # reports as nothing playing when there is none). A destination of
            # Liked Music is likewise answered as a like rather than refused.
            {"action": "save", "kind": "playlist_add", "video_id": "lYBUbBu4W08"},
            {"action": "save", "kind": "playlist_create"},
            {"action": "now_playing", "query": "x"},
            {"action": "queue", "op": "move", "index": 1},
            {"action": "queue", "op": "move", "to": 1},
            {"action": "queue", "op": "sideways"},
        ):
            with self.assertRaises(ValueError, msg=f"{arguments} should be rejected"):
                OpenDeckService._validate_tool_arguments(arguments)

    def test_now_playing_and_queue_reorder_arguments_are_validated(self):
        self.assertEqual(
            OpenDeckService._validate_tool_arguments({"action": "now_playing"}),
            {"action": "now_playing"},
        )
        # "play this next" names no track: the current one is prioritised.
        self.assertEqual(
            OpenDeckService._validate_tool_arguments({"action": "queue", "op": "next_up"}),
            {"action": "queue", "op": "next_up", "query": "", "video_id": ""},
        )
        self.assertEqual(
            OpenDeckService._validate_tool_arguments(
                {"action": "queue", "op": "move", "index": 2, "to": 0}
            ),
            {"action": "queue", "op": "move", "index": 2, "to": 0},
        )

    def test_free_text_match_fallback(self):
        service = OpenDeckService()
        cases = {
            "play some jazz": {"action": "play", "query": "some jazz"},
            "play music: Bohemian Rhapsody on OpenDeck": {"action": "play", "query": "Bohemian Rhapsody"},
            "could you play Hotel California from my OpenDeck please": {
                "action": "play",
                "query": "Hotel California",
            },
            "put on some jazz": {"action": "play", "query": "some jazz"},
            # "queue <song>" queues it: the verb names the queue, and the
            # documented phrase for lining a track up is "Queue <song>".
            "queue Never Gonna Give You Up": {
                "action": "queue", "op": "add", "query": "Never Gonna Give You Up"
            },
            "what are my playlists": {"action": "library", "kind": "playlists"},
            "show my OpenDeck playlists": {"action": "library", "kind": "playlists"},
            "show my liked songs on OpenDeck": {"action": "library", "kind": "likes"},
            "what did I listen to": {"action": "library", "kind": "history"},
            "list my listening history on OpenDeck": {"action": "library", "kind": "history"},
            # Asking what is played most is a ranking of the log, not the log: the
            # order is the answer, so it is its own kind.
            "what do I play the most": {"action": "library", "kind": "frequent"},
            "show me my most played songs": {"action": "library", "kind": "frequent"},
            "my top tracks": {"action": "library", "kind": "frequent"},
            "show me OpenDeck search results for Miles Davis": {"action": "search", "query": "Miles Davis"},
            "Bohemian Rhapsody": {"action": "search", "query": "Bohemian Rhapsody"},
            # A lyrics request with no track names the current track, so the
            # fallback must not look up a song called "show me the lyrics".
            "show me the lyrics": {"action": "lyrics"},
            "sing along": {"action": "lyrics"},
            "what are the lyrics to Bohemian Rhapsody": {"action": "lyrics", "title": "Bohemian Rhapsody"},
            "the words to Hotel California": {"action": "lyrics", "title": "Hotel California"},
            # A question about the current track reads state, not plays.
            "what's playing": {"action": "now_playing"},
            "what song is playing": {"action": "now_playing"},
            "what am I listening to": {"action": "now_playing"},
            # Reorder and prioritise the queue from free text.
            "play Bohemian Rhapsody next": {"action": "queue", "op": "next_up", "query": "Bohemian Rhapsody"},
            "play Hotel California first": {"action": "queue", "op": "front", "query": "Hotel California"},
            "play this next": {"action": "queue", "op": "next_up"},
            "move track 2 to 1": {"action": "queue", "op": "move", "index": 1, "to": 0},
        }
        for text, expected in cases.items():
            self.assertEqual(service._arguments(text), expected, text)

    def test_free_text_match_names_a_new_playlist(self):
        service = OpenDeckService()
        self.assertEqual(
            service._arguments("make me a playlist called Late Night on OpenDeck"),
            {"action": "save", "kind": "playlist_create", "name": "Late Night"},
        )


class FakeQueueService:
    """The independent queue service, as the worker talks to it.

    The real one is nix_core/music_queue_service.py; this answers its routes
    with the shape of its replies, so the worker's forwarding is checked against
    the contract rather than against that service's own implementation.
    """

    def __init__(self) -> None:
        self.items: list[dict] = []
        self.index = -1
        self.shuffle = False
        self.repeat = "off"
        self.calls: list[tuple[str, dict]] = []
        self.limits: dict = {}
        service = self

        class Handler(SimpleHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # the tests are quiet on purpose
                pass

            def _reply(self, payload: dict) -> None:
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _state(self) -> dict:
                return {
                    "ok": True, "queue": list(service.items), "offset": 0,
                    "count": len(service.items), "total": len(service.items),
                    "index": service.index, "shuffle": service.shuffle,
                    "repeat": service.repeat, "revision": len(service.calls),
                    "unchanged": False,
                }

            def do_GET(self):  # noqa: N802
                path = self.path.split("?")[0]
                service.calls.append(("GET " + path, {}))
                if path == "/state":
                    return self._reply(self._state())
                if path == "/pending":
                    return self._reply({"ok": True, "pending": []})
                return self._reply({"ok": False, "error": "not found"})

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                path = self.path.split("?")[0]
                service.calls.append(("POST " + path, body))
                if path == "/add":
                    for track in body.get("tracks") or []:
                        service.items.append({
                            "video_id": track["video_id"], "title": track.get("title", ""),
                            "artist": track.get("artist", ""), "album": track.get("album", ""),
                            "duration_sec": track.get("duration_sec", 0),
                            "artwork_url": track.get("artwork_url", ""),
                        })
                    return self._reply({"ok": True, "accepted": len(body.get("tracks") or []),
                                        "refused": 0, "total": len(service.items),
                                        "revision": len(service.calls)})
                if path == "/limits":
                    service.limits = body.get("limits") or {}
                    return self._reply({"ok": True, "limits": service.limits})
                if path == "/ops":
                    return self._reply(service.op(body))
                return self._reply({"ok": False, "error": "not found"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d" % self.server.server_address[1]

    def op(self, body: dict) -> dict:
        op = body.get("op")
        index = body.get("index")
        if op == "set_index":
            self.index = index
            return {"ok": True, "index": index, "total": len(self.items)}
        if op == "next":
            if self.index + 1 >= len(self.items):
                return {"ok": False, "code": "queue_end", "total": len(self.items),
                        "index": self.index, "message": "The queue has no next track to play."}
            self.index += 1
            return {"ok": True, "index": self.index, "total": len(self.items),
                    "track": self.items[self.index], "repeat": self.repeat, "shuffle": self.shuffle}
        if op == "remove":
            removed = self.items.pop(index)
            return {"ok": True, "total": len(self.items), "index": -1,
                    "message": "Removed %s." % removed["video_id"]}
        if op == "front":
            self.items.insert(0, self.items.pop(index))
            return {"ok": True, "total": len(self.items), "index": self.index, "position": 0}
        if op == "shuffle":
            self.shuffle = bool(body.get("on", not self.shuffle))
            return {"ok": True, "shuffle": self.shuffle, "total": len(self.items)}
        if op == "repeat":
            self.repeat = body.get("mode", "off")
            return {"ok": True, "repeat": self.repeat, "total": len(self.items)}
        if op == "clear":
            self.items = []
            self.index = -1
            return {"ok": True, "total": 0, "index": -1}
        return {"ok": False, "error": "unknown op"}

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class QueueServiceForwardingTestCase(unittest.TestCase):
    """The worker with an independent queue service behind it.

    Setting NIX_MUSIC_QUEUE_URL makes the service the queue: the worker forwards
    the assistant's own queue requests there, so the page and the assistant are
    reading one line-up — and the worker's JSON file is no longer it. This case
    deliberately does not inherit the local-queue tests: with a service behind
    it there is no local queue to exercise, and the same requests are checked
    above against the worker's own.
    """

    def setUp(self) -> None:
        self.fake = FakeOpenDeck()
        self.fake.__enter__()
        self.addCleanup(self.fake.__exit__, None, None, None)
        self.service = OpenDeckService()
        self.service.initialize({"server_url": self.fake.base_url, "api_key": API_KEY})
        for path in (
            opendeck_worker.NOW_PLAYING_FILE,
            opendeck_worker.QUEUE_FILE,
            opendeck_worker.LIBRARY_CACHE_FILE,
        ):
            try:
                os.remove(path)
            except OSError:
                pass
        self.queue_service = FakeQueueService()
        self.addCleanup(self.queue_service.close)
        patcher = mock.patch.object(opendeck_worker, "QUEUE_SERVICE_URL", self.queue_service.url)
        patcher.start()
        self.addCleanup(patcher.stop)

    def seed_queue(self, titles: list[str], *, current_index: int = -1) -> None:
        with open(opendeck_worker.QUEUE_FILE, "w", encoding="utf-8") as handle:
            json.dump({"items": [
                {"video_id": "file%07d" % index, "title": title, "artist": "", "album": "",
                 "duration_sec": 0, "artwork_url": ""} for index, title in enumerate(titles)
            ], "current_index": current_index}, handle)

    def execute(self, arguments: dict) -> dict:
        validated = OpenDeckService._validate_tool_arguments(arguments)
        assert_schema(validated, INPUT_SCHEMA, "arguments")
        response = asyncio.run(
            self.service.handle("execute", {"tool": "opendeck_music", "arguments": validated})
        )
        result = response["result"]
        assert_schema(result, RESULT_SCHEMA, "result")
        return result

    def test_the_assistant_reads_the_service_s_queue_not_the_worker_s_file(self):
        # A queue in the worker's own file, and a different one in the service:
        # the service is what is reported, because it is what is playing.
        self.seed_queue(["Only In The File"])
        self.queue_service.items = [
            {"video_id": "svc0000001", "title": "From The Service", "artist": "A",
             "album": "", "duration_sec": 200, "artwork_url": ""},
        ]
        self.queue_service.index = 0
        result = self.execute({"action": "queue", "op": "list"})
        self.assertEqual([item["title"] for item in result["queue"]], ["From The Service"])
        self.assertEqual(result["queue_index"], 0)
        self.assertEqual(result["count"], 1)
        self.assertIn("/state", self.queue_service.calls[0][0])

    def test_queueing_by_name_resolves_through_the_provider_then_writes_to_the_service(self):
        # The provider is still what knows a song by its name; the service is
        # what holds the line-up. Both are reached, once each.
        result = self.execute({"action": "queue", "op": "add", "query": "Never Gonna Give You Up"})
        # The id is the provider's own answer for that name, and it is what the
        # service was handed — the worker did not invent a track of its own.
        self.assertEqual(self.queue_service.items[0]["video_id"], result["video_id"])
        self.assertEqual(self.queue_service.items[0]["title"], "Never Gonna Give You Up")
        self.assertIn("Never Gonna Give You Up", result["message"])
        adds = [body for name, body in self.queue_service.calls if name == "POST /add"]
        self.assertEqual(len(adds), 1, "one write, not one per field")

    def test_a_skip_plays_the_track_the_service_handed_over(self):
        self.queue_service.items = [
            {"video_id": "dQw4w9WgXcQ", "title": "Never Gonna Give You Up", "artist": "Rick Astley",
             "album": "", "duration_sec": 214, "artwork_url": ""},
        ]
        self.queue_service.index = -1
        result = self.execute({"action": "queue", "op": "next"})
        self.assertTrue(result["play_url"], "the provider resolved a stream URL for it")
        self.assertEqual(result["video_id"], "dQw4w9WgXcQ")
        self.assertEqual(result["queue_index"], 0)
        self.assertIn("Playing queued track 1 of 1", result["message"])
        # The queue itself is the service's, and it is what moved.
        self.assertEqual(self.queue_service.index, 0)

    def test_a_track_named_instead_of_numbered_is_found_in_the_service(self):
        self.queue_service.items = [
            {"video_id": "dQw4w9WgXcQ", "title": "Never Gonna Give You Up", "artist": "Rick Astley",
             "album": "", "duration_sec": 214, "artwork_url": ""},
            {"video_id": "abc12345678", "title": "Another Song", "artist": "Someone",
             "album": "", "duration_sec": 200, "artwork_url": ""},
        ]
        self.execute({"action": "queue", "op": "remove", "query": "Never Gonna Give You Up"})
        removes = [body for name, body in self.queue_service.calls if name == "POST /ops"]
        self.assertEqual([body["index"] for body in removes if body["op"] == "remove"], [0],
                         "the name was resolved to the position the service holds it at")
        self.assertEqual([item["title"] for item in self.queue_service.items], ["Another Song"])

    def test_the_worker_leaves_its_own_queue_file_untouched(self):
        self.seed_queue(["Only In The File"])
        self.execute({"action": "queue", "op": "add", "query": "Never Gonna Give You Up"})
        with open(opendeck_worker.QUEUE_FILE, "r", encoding="utf-8") as handle:
            saved = json.load(handle)
        self.assertEqual([item["title"] for item in saved["items"]], ["Only In The File"],
                         "the service owns the queue, so the file is not a second one")

    def test_the_address_published_in_the_data_directory_is_found(self):
        """NIX starts a skill worker with almost no environment on purpose, so
        the queue service's published address is how a worker finds it."""
        published = os.path.join(tempfile.gettempdir(), "opendeck-test-queue-service-%d.json" % os.getpid())
        self.addCleanup(lambda: os.path.exists(published) and os.remove(published))
        with mock.patch.object(opendeck_worker, "QUEUE_SERVICE_URL", ""), \
                mock.patch.object(opendeck_worker, "QUEUE_SERVICE_FILE", published):
            self.assertEqual(opendeck_worker._queue_service_address(), ("", ""),
                             "nothing published yet, so there is no queue service")
            with open(published, "w", encoding="utf-8") as handle:
                json.dump({"url": self.queue_service.url + "/", "token": "secret", "at": 1}, handle)
            self.assertEqual(opendeck_worker._queue_service_address(),
                             (self.queue_service.url, "secret"))

    def test_a_published_address_is_the_queue_the_worker_uses(self):
        published = os.path.join(tempfile.gettempdir(), "opendeck-test-queue-service-%d.json" % os.getpid())
        self.addCleanup(lambda: os.path.exists(published) and os.remove(published))
        with open(published, "w", encoding="utf-8") as handle:
            json.dump({"url": self.queue_service.url, "token": "", "at": 1}, handle)
        with mock.patch.object(opendeck_worker, "QUEUE_SERVICE_URL", ""), \
                mock.patch.object(opendeck_worker, "QUEUE_SERVICE_FILE", published):
            self.seed_queue(["Only In The File"])
            self.queue_service.items = [
                {"video_id": "published01", "title": "From The Published Queue", "artist": "",
                 "album": "", "duration_sec": 0, "artwork_url": ""},
            ]
            result = self.execute({"action": "queue", "op": "list"})
        self.assertEqual([item["title"] for item in result["queue"]], ["From The Published Queue"])

    def test_a_queue_service_that_is_not_there_is_reported_rather_than_guessed_at(self):
        with mock.patch.object(opendeck_worker, "QUEUE_SERVICE_URL", "http://127.0.0.1:1"):
            with self.assertRaises(RuntimeError) as failure:
                self.service.queue({"op": "list"})
        self.assertIn("not reachable", str(failure.exception).lower())


class WorkerProtocolTestCase(unittest.TestCase):
    """The JSONL contract the NIX runtime actually speaks to the worker."""

    def test_jsonl_round_trip(self):
        with FakeOpenDeck() as fake:
            process = subprocess.Popen(
                [sys.executable, WORKER, "--nix-skill-worker"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.addCleanup(process.kill)

            def call(request: dict) -> dict:
                assert process.stdin and process.stdout
                process.stdin.write(json.dumps(request) + "\n")
                process.stdin.flush()
                line = process.stdout.readline()
                self.assertTrue(line, "worker closed its output")
                return json.loads(line)

            ready = call({"id": "1", "op": "initialize", "config": {"server_url": fake.base_url, "api_key": API_KEY}})
            self.assertEqual(ready, {"id": "1", "ok": True, "ready": True})

            matched = call({"id": "2", "op": "match", "text": "play never gonna give you up"})
            self.assertEqual(matched["match"], {"action": "play", "query": "never gonna give you up"})

            executed = call({"id": "3", "op": "execute", "tool": "opendeck_music", "arguments": matched["match"]})
            self.assertTrue(executed["ok"])
            assert_schema(executed["result"], RESULT_SCHEMA, "result")
            self.assertTrue(executed["result"]["play_url"].startswith(fake.base_url))

            refused = call({"id": "4", "op": "execute", "tool": "control_ring", "arguments": {"action": "on"}})
            self.assertFalse(refused["ok"])
            self.assertIn("opendeck_music", refused["error"])

            bad_setup = call({"id": "5", "op": "initialize", "config": {"server_url": fake.base_url, "api_key": "odk_nope"}})
            self.assertFalse(bad_setup["ok"])
            self.assertIn("RuntimeError", bad_setup["error"])


class PlayChoiceTestCase(unittest.TestCase):
    """A play request is answered, or handed back as a choice for the user.

    Playing the first search hit is only right when the request names something:
    the skill used to do it unconditionally, which is how "play that song from
    the film" became whatever the catalog happened to rank first.
    """

    @staticmethod
    def track(video_id: str, title: str, artist: str = "Artist") -> dict:
        return {
            "video_id": video_id,
            "title": title,
            "artist": artist,
            "album": "",
            "duration_sec": 200,
            "artwork_url": "",
        }

    def test_a_title_the_request_names_outright_plays(self):
        chosen, contenders = opendeck_worker._play_choice(
            "bohemian rhapsody",
            [self.track("a", "Bohemian Rhapsody"), self.track("b", "Radio Ga Ga")],
        )
        self.assertIsNotNone(chosen)
        self.assertEqual(chosen["video_id"], "a")
        self.assertEqual(contenders, [])

    def test_the_same_title_is_not_a_choice_the_user_has_to_make(self):
        """Two uploads of one song are ordered by the provider, not the user."""
        chosen, contenders = opendeck_worker._play_choice(
            "never gonna give you up",
            [
                self.track("a", "Never Gonna Give You Up", "Rick Astley"),
                self.track("b", "Never Gonna Give You Up", "TheRealSullyG"),
                self.track("c", "Never Gonna Give You Up (Official Video)"),
            ],
        )
        self.assertIsNotNone(chosen)
        self.assertEqual(chosen["video_id"], "a")
        self.assertEqual(contenders, [])

    def test_several_different_titles_that_fit_equally_well_become_a_choice(self):
        chosen, contenders = opendeck_worker._play_choice(
            "midnight",
            [
                self.track("a", "Midnight City", "M83"),
                self.track("b", "Midnight Sun"),
                self.track("c", "Midnight Rambler"),
            ],
        )
        self.assertIsNone(chosen, "nothing may be played when the request is unclear")
        self.assertEqual([item["video_id"] for item in contenders], ["a", "b", "c"])

    def test_a_scattered_word_overlap_is_never_confident(self):
        """Words merely shared with a title are not the user naming that title."""
        chosen, contenders = opendeck_worker._play_choice(
            "song about rain",
            [
                self.track("a", "Rain on Me"),
                self.track("b", "Purple Rain"),
            ],
        )
        self.assertIsNone(chosen)
        self.assertEqual(len(contenders), 2)

    def test_the_choice_names_every_option_in_the_declared_fields(self):
        option = opendeck_worker._play_option(self.track("a", "A Song", "Someone"))
        self.assertEqual(
            sorted(option),
            ["album", "artist", "artwork_url", "duration_sec", "title", "video_id"],
        )

    def test_a_bracketed_aside_does_not_make_a_second_title(self):
        self.assertEqual(
            opendeck_worker._title_key("Never Gonna Give You Up (Official Video)"),
            opendeck_worker._title_key("Never Gonna Give You Up"),
        )
        self.assertNotEqual(
            opendeck_worker._title_key("Midnight City"),
            opendeck_worker._title_key("Midnight Sun"),
        )


class AmbiguousPlayTestCase(WorkerTestCase):
    """The whole play path, over the real (fake-instance) service."""

    def test_an_unclear_request_comes_back_as_the_options_and_plays_nothing(self):
        self.service.search = lambda query, limit: [
            {"video_id": "aaa", "title": "Midnight City", "artist": "M83", "album": "", "duration_sec": 240, "artwork_url": "http://art.example/a.jpg"},
            {"video_id": "bbb", "title": "Midnight Sun", "artist": "Someone", "album": "", "duration_sec": 200, "artwork_url": ""},
        ]
        result = self.execute({"action": "play", "query": "midnight"})
        self.assertTrue(result["ambiguous"])
        self.assertEqual(result["query"], "midnight")
        self.assertEqual([option["video_id"] for option in result["options"]], ["aaa", "bbb"])
        self.assertEqual(result["options"][0]["title"], "Midnight City")
        self.assertEqual(result["play_url"], "", "a choice must not resolve a stream")
        self.assertIn("which one did you mean", result["message"])

    def test_a_named_title_still_plays_and_offers_no_choice(self):
        result = self.execute({"action": "play", "query": "never gonna give you up"})
        self.assertFalse(result["ambiguous"])
        self.assertEqual(result["options"], [])
        self.assertTrue(result["play_url"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

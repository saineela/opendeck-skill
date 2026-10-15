#!/usr/bin/env python3
"""Contract tests against the real NIX PUCA core.

These run PUCA's own validators over this package — the same code the Skills
marketplace uses — so a packaged skill cannot pass here and fail on install.
They skip when the core is not on this machine (set NIX_CORE_PATH to point at
a checkout).
"""
from __future__ import annotations

import asyncio
import atexit
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SKILL_DIR = os.path.join(REPO, "skills", "opendeck")
NIX_CORE = os.environ.get("NIX_CORE_PATH", "/root/nix_core")

sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(SKILL_DIR))
sys.path.insert(0, os.path.join(REPO, "scripts"))

# The play queue persists to a JSON file; keep the tests out of the real one.
_QUEUE_FILE = os.path.join(REPO, ".pytest-opendeck-queue-%d.json" % os.getpid())
os.environ.setdefault("NIX_OPENDECK_QUEUE_FILE", _QUEUE_FILE)


def _remove_queue_file() -> None:
    """Leave the checkout clean: the pid-scoped queue file is test scratch."""
    try:
        os.unlink(_QUEUE_FILE)
    except OSError:
        pass


atexit.register(_remove_queue_file)

from fake_opendeck import API_KEY, FakeOpenDeck  # noqa: E402
from opendeck_worker import OpenDeckService  # noqa: E402
from package_skill import build_zip  # noqa: E402


def style_selectors(css: str) -> list[str]:
    """Every rule selector in a stylesheet, including rules inside @media.

    Keyframe steps (`from`, `50%`) are not selectors and are skipped, and an
    unbalanced brace count raises, so a broken stylesheet cannot pass a test
    that only looks for substrings.
    """
    text = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    selectors: list[str] = []
    prelude = ""
    stack: list[str] = []
    index = 0
    while index < len(text):
        character = text[index]
        if character == "{":
            block = prelude.strip()
            prelude = ""
            inside_keyframes = any(entry.lstrip().startswith("@keyframes") for entry in stack)
            if not inside_keyframes and not block.startswith("@"):
                selectors.append(block)
            stack.append(block)
        elif character == "}":
            if not stack:
                raise AssertionError("stylesheet has an unmatched closing brace")
            stack.pop()
            prelude = ""
        elif character == ";" and not stack:
            prelude = ""
        else:
            prelude += character
        index += 1
    if stack:
        raise AssertionError("stylesheet has an unclosed block: " + ", ".join(stack))
    return [selector for selector in selectors if selector]


@unittest.skipUnless(os.path.isdir(NIX_CORE), "NIX PUCA core is not available")
class PucaContractTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        sys.path.insert(0, NIX_CORE)
        import console  # type: ignore
        import skill_runtime  # type: ignore

        cls.console = console
        cls.skill_runtime = skill_runtime
        with open(os.path.join(SKILL_DIR, "skill.json"), encoding="utf-8") as handle:
            cls.manifest = json.load(handle)
        cls.parsed = console._parse_skill_manifest(
            cls.manifest, "skills/opendeck/skill.json", "NIX Community Skills"
        )

    def test_puca_accepts_the_manifest(self):
        self.assertEqual(self.parsed["slug"], "opendeck")
        self.assertEqual(self.parsed["runtime"]["protocol"], "nix-skill-jsonl-v1")
        self.assertEqual([field["id"] for field in self.parsed["setup_fields"]], ["server_url", "api_key"])
        self.assertEqual([tool["name"] for tool in self.parsed["tools"]], ["opendeck_music"])
        for name in self.parsed["files"]:
            self.assertTrue(os.path.isfile(os.path.join(SKILL_DIR, *name.split("/"))), name)

    def test_puca_accepts_the_packaged_zip(self):
        out_path, _manifest = build_zip(SKILL_DIR, os.path.join(REPO, "dist"))
        with open(out_path, "rb") as handle:
            parsed, contents = self.console._read_skill_zip(handle.read())
        self.assertEqual(parsed["slug"], "opendeck")
        self.assertEqual(sorted(name for name, _body in contents), sorted(self.parsed["files"]))

    def test_the_panel_page_only_asks_for_files_it_ships(self):
        """Every asset the panel page asks for has to be in the package.

        The panel is served from the package folder, so a stylesheet or an image
        the manifest does not declare is a file        the console cannot hand out (and one a ZIP would drop). The logo beside panel.html is
        exactly the kind of one-file addition that is easy to forget in the manifest.
        """
        with open(os.path.join(SKILL_DIR, "PUCA-Panel", "panel.html"), encoding="utf-8") as handle:
            page = handle.read()
        declared = set(self.parsed["files"])
        wanted = [
            name
            for name in re.findall(r'(?:src|href)="([^"#]+)"', page)
            if not re.match(r"[a-z][a-z0-9+.-]*:", name)
        ]
        self.assertIn("panel.css", wanted)
        self.assertIn("panel.js", wanted)
        self.assertIn("puca-logo.png", wanted, "the brand wears the NIX PUCA logo")
        for name in wanted:
            self.assertIn("PUCA-Panel/" + name, declared, name)
            self.assertTrue(
                os.path.isfile(os.path.join(SKILL_DIR, "PUCA-Panel", *name.split("/"))), name
            )

    def test_the_logo_carries_its_own_transparency(self):
        """The logo is drawn straight onto the panel, so it must not be a white box.

        It used to sit on a light plate of its own; the plate is gone, and the
        artwork is tinted into the theme's foreground instead. That only works
        while the file carries alpha — the PNG that was first bundled was black
        ink on an opaque white background, which on the dark panel is a white
        rectangle around the mark.
        """
        with open(os.path.join(SKILL_DIR, "PUCA-Panel", "puca-logo.png"), "rb") as handle:
            data = handle.read()
        self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"), "the logo is a PNG")
        # IHDR is the first chunk: 8 bytes of header, then length, "IHDR", the
        # width and height, the bit depth, and the colour type at offset 25.
        self.assertEqual(data[12:16], b"IHDR")
        self.assertIn(
            data[25],
            (4, 6),
            "greyscale+alpha (4) or truecolour+alpha (6), not an opaque background",
        )

    def test_music_page_coalesces_rapid_volume_changes(self):
        """The page must send the level the user settled on, not one request per tap.

        Dragging the dial or tapping the stepper previews locally and commits at
        most one control request at a time, so a burst of clicks cannot pile up
        requests (or report a failure for a level that was already replaced).
        """
        with open(os.path.join(SKILL_DIR, "ui", "music.js"), encoding="utf-8") as handle:
            script = handle.read()
        self.assertIn("window.NixMusicPage = { mount: mount };", script)
        self.assertIn("let volumeInFlight = false;", script)
        self.assertIn("let volumePending = false;", script)
        self.assertIn("if (volumeInFlight) { volumePending = true; return; }", script)
        self.assertIn("if (volumePending) commitVolume();", script)
        # The graphical dial replaces the range input: a settled drag and a
        # settled stepper both funnel through the same coalescing commit.
        self.assertIn('volWheel.addEventListener("pointerup", function () {', script)
        self.assertIn('volUp.addEventListener("click", function () { nudgeVolume(VOLUME_STEP); });', script)
        self.assertIn("settleVolume(280);", script)
        self.assertNotIn('input[type="range"]', script)
        self.assertNotIn("volumeSlider", script)

    def test_music_page_has_a_queue_without_a_separate_pause_or_stop(self):
        """One transport, inside the wheel's hub; queueing is its own action.

        The play/pause toggle is the whole transport — a second Pause button
        repeated it and a Stop button only meant "pause a moment" — and it sits
        in the same round control hub as the volume wheel, so the page shows one
        play/pause control and one mute control and nothing else. A queue the
        assistant can fill is its own card, with an add control beside each row
        (a sibling, never nested inside the row button).
        """
        with open(os.path.join(SKILL_DIR, "ui", "music.js"), encoding="utf-8") as handle:
            script = handle.read()
        self.assertIn('const hub = element("div", "music-hub music-controls");', script)
        self.assertIn("hub.append(playButton, volWheel, muteButton);", script)
        self.assertNotIn("pauseButton", script)
        self.assertNotIn("stopButton", script)
        # The phone mini bar leads back to the hub instead of repeating its
        # controls, and the mute button is a round control of the same family.
        self.assertNotIn("miniToggle", script)
        self.assertNotIn("miniMute", script)
        self.assertIn('element("button", "music-round music-mute")', script)
        self.assertIn('muteButton.append(speakerGlyph(), element("span", "music-round-label", "Mute"));', script)
        self.assertIn("const queueCard = element(\"section\", \"music-card music-queue-card\");", script)
        self.assertIn("function renderQueue(payload)", script)
        self.assertIn('api.post("/queue", { action: "add", video_id: track.video_id })', script)
        self.assertIn('api.post("/queue", { action: "next" })', script)
        self.assertIn('wrap.append(row, queueButton);', script)

    def test_music_page_reorders_the_queue_by_dragging_a_row(self):
        """The queue is arranged by dragging, and it sits under the player.

        A queue the assistant fills is only half a queue if the user cannot
        rearrange it: each row is carried by a pointer, the drop position is
        drawn before the row is released, and the whole arrangement is one
        `move` call to the provider. The gesture is a pointer drag rather than
        HTML5 drag-and-drop, because `dragstart` never fires for a finger in the
        phone webview this page runs in. The card itself belongs to the player's
        column, directly under the now-playing card.
        """
        with open(os.path.join(SKILL_DIR, "ui", "music.js"), encoding="utf-8") as handle:
            script = handle.read()
        self.assertIn('api.post("/queue", { action: "move", index: from, to: to })', script)
        self.assertIn("function queueSlotAt(clientY)", script)
        self.assertIn("function queueInsertIndex(from, slot)", script)
        self.assertIn("function paintQueueDrop(slot)", script)
        self.assertIn("function beginQueueDrag(event)", script)
        self.assertIn("function finishQueueDrag(event, commit)", script)
        # One handler on the list carries mouse, touch and pen, and a release
        # outside it still ends the drag.
        for event in ("pointerdown", "pointermove", "pointerup", "pointercancel"):
            self.assertIn(f'queueList.addEventListener("{event}"', script)
        # Nothing about the gesture depends on HTML5 drag-and-drop, which never
        # fires from touch, so no row carries `draggable` or its events.
        self.assertNotIn("row.draggable", script)
        for event in ("dragstart", "dragover", "dragend"):
            self.assertNotIn(f'{event}"', script)
        self.assertIn('queueDrag.row.classList.add("is-dragging");', script)
        self.assertIn('rows[rows.length - 1].classList.add("is-drop-after");', script)
        self.assertIn('rows[slot].classList.add("is-drop-before");', script)
        # A finger has to be able to start the drag without scrolling the list,
        # so the row carries a grip whose own touch-action keeps the gesture.
        self.assertIn('element("span", "music-queue-grip"', script)
        self.assertIn('row.append(grip, play, artNode(item.artwork_url, "♪"), copy, end);', script)
        # The queue is the column beside the player — the wall display's own
        # shape, which this page is the desk-size copy of — and it goes back
        # under the player on a narrow screen. The four cards are the grid's own
        # children and the stylesheet places them by name, so neither direction
        # needs the markup to be nested one way.
        self.assertIn("grid.append(nowCard, queueCard, browseCard, lyricsCard);", script)
        with open(os.path.join(SKILL_DIR, "ui", "music.css"), encoding="utf-8") as handle:
            styles = handle.read()
        self.assertIn('"player queue"', styles, styles[:400])
        self.assertIn(".music-app .music-queue-card { grid-area: queue; }", styles)
        self.assertIn('"player"\n      "queue"', styles, "the queue drops under the player on a phone")

    def test_music_page_keeps_the_lyrics_on_the_current_line(self):
        """The lyric box must scroll to the active line, not past it.

        Centring with `offsetTop` aimed the box at the page instead of at the
        scrolling lyrics container (offsetTop is measured against the nearest
        *positioned* ancestor), and a fresh smooth `scrollTo` per line made the
        box fall behind on a fast track. Both are replaced by one retargeting
        animation computed from the two rects — but that animation must never be
        the only way the box moves: a kiosk WebView with no requestAnimationFrame
        would then move the highlight while the box stood still, so the box is
        placed outright when no frame arrives.
        """
        with open(os.path.join(SKILL_DIR, "ui", "music.js"), encoding="utf-8") as handle:
            script = handle.read()
        self.assertIn("lyricsBox.getBoundingClientRect()", script)
        self.assertIn("line.getBoundingClientRect()", script)
        self.assertIn("Math.min(target, lyricsBox.scrollHeight - lyricsBox.clientHeight)", script)
        self.assertIn("lyricTarget = lyricTop(activeLine);", script)
        self.assertIn("lyricFrame = lyricRequest(step);", script)
        self.assertIn('if (typeof raf !== "function" || lyricFrameStalled) {', script)
        self.assertIn("settleLyrics();", script)
        self.assertIn("lyricsBox.scrollTop = 0;", script)
        self.assertNotIn("activeLine.offsetTop", script)
        self.assertNotIn('behavior: "smooth"', script)

    def test_music_page_styles_are_scoped_and_responsive(self):
        """The page stylesheet adapts to the screen and never leaks out of its mount.

        The console appends this file to a shared dashboard, so an unscoped
        selector would restyle the whole console; every rule must stay inside
        .music-app. The layout itself has to work on a phone without JavaScript
        measuring the viewport: fluid type, one column below 1080px, tap targets
        of at least 44px, a scrolling chip row, list scrolling handed back to the
        page on phones, a safe-area-aware sticky mini bar, and a reduced-motion
        path.
        """
        with open(os.path.join(SKILL_DIR, "ui", "music.css"), encoding="utf-8") as handle:
            styles = handle.read()

        selectors = style_selectors(styles)
        self.assertTrue(selectors)
        for selector in selectors:
            self.assertIn(".music-app", selector, selector)

        for query in (
            "@media (max-width: 1080px)",
            "@media (max-width: 760px)",
            "@media (max-width: 520px)",
            "@media (hover: hover)",
            "@media (prefers-reduced-motion: reduce)",
        ):
            self.assertIn(query, styles)

        self.assertIn("clamp(", styles)
        self.assertIn("aspect-ratio: 1 / 1", styles)
        self.assertIn("min-height: 44px", styles)
        self.assertIn("overflow-x: auto", styles)
        self.assertIn("-webkit-overflow-scrolling: touch", styles)
        self.assertIn("content-visibility: auto", styles)
        self.assertIn("env(safe-area-inset-bottom", styles)
        self.assertIn(".music-app .music-mini", styles)
        # A nested scroll container under a nested scroll container is what makes
        # a phone page feel stuck; the list becomes plain page scrolling instead.
        self.assertIn(".music-app .music-list { max-height: none; overflow-y: visible; }", styles)

    def test_music_page_answers_a_tap_without_waiting_for_the_speaker(self):
        """Typing, tapping and volume changes must feel instant.

        A tap marks the row pending before the request is sent, already-fetched
        results come back from a short-lived cache with no spinner, typing is
        debounced and a superseded search is aborted instead of racing the newer
        one, and after an action the 13ms snapshot endpoint is polled at 260ms
        until the speaker agrees rather than waiting for the shell's slow poll.
        """
        with open(os.path.join(SKILL_DIR, "ui", "music.js"), encoding="utf-8") as handle:
            script = handle.read()

        self.assertIn("const SEARCH_DEBOUNCE_MS = 280;", script)
        self.assertIn("state.searchTimer = window.setTimeout(fire, SEARCH_DEBOUNCE_MS);", script)
        self.assertIn("new AbortController()", script)
        self.assertIn('error.name === "AbortError"', script)
        self.assertIn("cacheRead(cacheKey, SEARCH_TTL_MS)", script)
        self.assertIn("cacheWrite(cacheKey, payload, SEARCH_TTL_MS)", script)
        self.assertIn("const LIBRARY_TTL_MS = 20_000;", script)
        self.assertIn('row.classList.add("is-pending")', script)
        self.assertIn("const CONFIRM_DELAY_MS = 260;", script)
        self.assertIn("function followUp(videoId)", script)
        self.assertIn("mini.hidden = false;", script)
        self.assertIn('if (event.key === "/")', script)
        # Superseded work is dropped, not queued: the in-flight search and the
        # confirmation loop are both cancelled when the page unmounts.
        self.assertIn("if (state.searchRequest) { state.searchRequest.abort(); state.searchRequest = null; }", script)
        self.assertIn("stopFollowing();", script)
        # Layout is CSS-only, so a resize or rotation needs no JavaScript at all.
        self.assertNotIn("innerWidth", script)
        self.assertNotIn("matchMedia", script)

    def test_worker_results_validate_against_the_declared_schema(self):
        tool = self.parsed["tools"][0]
        with FakeOpenDeck() as fake:
            service = OpenDeckService()
            service.initialize({"server_url": fake.base_url, "api_key": API_KEY})
            for arguments in (
                {"action": "search", "query": "never gonna give you up"},
                {"action": "library", "kind": "playlists"},
                {"action": "library", "kind": "stats"},
                {"action": "play", "query": "never gonna give you up"},
                {"action": "play", "video_id": "lYBUbBu4W08"},
                {"action": "save", "kind": "like", "video_id": "lYBUbBu4W08", "title": "Never Gonna Give You Up"},
                {"action": "save", "kind": "playlist_create", "name": "Late Night"},
                {"action": "queue", "op": "add", "video_id": "lYBUbBu4W08"},
                {"action": "queue", "op": "list"},
                {"action": "queue", "op": "next"},
                {"action": "queue", "op": "clear"},
            ):
                self.skill_runtime.validate_json_schema(arguments, tool["input_schema"])
                response = asyncio.run(
                    service.handle("execute", {"tool": "opendeck_music", "arguments": arguments})
                )
                result = response["result"]
                self.skill_runtime.validate_json_schema(result, tool["result_schema"])

    def test_puca_rejects_undeclared_arguments(self):
        tool = self.parsed["tools"][0]
        with self.assertRaises(Exception):
            self.skill_runtime.validate_json_schema(
                {"action": "search", "query": "x", "shell": "rm -rf /"}, tool["input_schema"]
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)

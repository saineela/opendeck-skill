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


def style_declarations(css: str, selector: str) -> str:
    """Everything a stylesheet declares for one exact selector.

    Every rule with that selector, top level only, joined together — the union of
    what an element matching it is told, so a test can ask what the page actually
    gets rather than whether a fragment appears anywhere in the file. A selector
    that is not there comes back empty, so a missing rule fails the assertion
    that wanted it instead of passing on an unrelated match.
    """
    text = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    declarations: list[str] = []
    prelude = ""
    stack: list[str] = []
    index = 0
    while index < len(text):
        character = text[index]
        if character == "{":
            block = prelude.strip()
            prelude = ""
            if not stack and block == selector:
                depth = 1
                start = index + 1
                index += 1
                while index < len(text) and depth:
                    if text[index] == "{":
                        depth += 1
                    elif text[index] == "}":
                        depth -= 1
                    index += 1
                declarations.append(text[start:index - 1])
                continue
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
    return "\n".join(declarations)


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

        The panel's slider previews locally and commits at most one control
        request at a time, so a burst of drags or wheel steps cannot pile up
        requests (or report a failure for a level that was already replaced): the
        gesture settles, and what it settled on is what is sent.
        """
        with open(os.path.join(SKILL_DIR, "ui", "music.js"), encoding="utf-8") as handle:
            script = handle.read()
        self.assertIn("window.NixMusicPage = { mount: mount };", script)
        self.assertIn("if (state.volumeInFlight) { state.volumePending = true; return; }", script)
        self.assertIn("state.volumeInFlight = true;", script)
        self.assertIn("if (state.volumePending) commitVolume();", script)
        # One slider, three gestures: a pointer drag and the arrow keys preview
        # and commit, and a wheel step settles on the same 280ms timer, so the
        # level sent is always the last one the user chose.
        self.assertIn("function volFromPointer(event)", script)
        self.assertIn("function previewVolume(level)", script)
        self.assertIn("function settleVolume(ms)", script)
        self.assertIn('volSlider.addEventListener("pointerup", function () {', script)
        self.assertIn("settleVolume(280);", script)
        # The graphical slider replaces a range input, whose own value would
        # paint over the level that is still in flight.
        self.assertNotIn('input[type="range"]', script)
        self.assertNotIn("volumeSlider", script)

    def test_music_page_has_a_queue_without_a_separate_pause_or_stop(self):
        """One transport, one mute control, and a queue the assistant can fill.

        The play/pause control is the whole transport — a second Pause button
        repeated it and a Stop button only ever meant "pause a moment" — and the
        mute control is the speaker's own, so the page shows exactly one of each.
        A queue the assistant can fill is its own card beside the player, and
        each sleeve carries its own add control as a *sibling*, never inside the
        tile: one button inside another swallows the tap.
        """
        with open(os.path.join(SKILL_DIR, "ui", "music.js"), encoding="utf-8") as handle:
            script = handle.read()
        self.assertIn('const playButton = element("button", "round play music-play");', script)
        self.assertIn('const muteButton = element("button", "vol music-mute");', script)
        # The transport is driven from the snapshot the speaker reports, so
        # there is no second play control and nothing to stop.
        self.assertNotIn("pauseButton", script)
        self.assertNotIn("stopButton", script)
        self.assertIn('const side = element("section", "side music-queue-card");', script)
        self.assertIn("function renderQueue(payload)", script)
        self.assertIn('api.post("/queue", { action: "add", video_id: track.video_id })', script)
        self.assertIn('api.post("/queue", { action: "next" })', script)
        self.assertIn('api.post("/queue", { action: "remove", index: index })', script)
        self.assertIn('api.post("/queue", { action: "clear" })', script)
        self.assertIn("wrap.append(tile, queueButton);", script)

    def test_music_page_reorders_the_queue_by_dragging_a_row(self):
        """The queue is arranged by dragging, and it sits beside the player.

        A queue the assistant fills is only half a queue if the user cannot
        rearrange it: each row is carried by a pointer, the drop position is
        drawn before the row is released, and the whole arrangement is one
        `move` call to the provider. The gesture is a pointer drag rather than
        HTML5 drag-and-drop, because `dragstart` never fires for a finger in the
        phone webview this page runs in. The card is the column beside the
        player — the wall display's own shape, which this page is the desk-size
        copy of — and on a narrow screen the page becomes the scroller and the
        card moves to where a thumb can still reach it.
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
        self.assertNotIn("draggable", script)
        for event in ("dragstart", "dragover", "dragend"):
            self.assertNotIn(event, script)
        self.assertIn('queueDrag.row.classList.add("is-dragging");', script)
        self.assertIn('rows[rows.length - 1].classList.add("is-drop-after");', script)
        self.assertIn('rows[slot].classList.add("is-drop-before");', script)
        # A finger has to be able to start the drag without scrolling the list,
        # so the row carries a grip whose own touch-action keeps the gesture.
        self.assertIn('element("span", "music-queue-grip"', script)
        self.assertIn("row.append(grip, cover, copy, end);", script)
        # The queue is the grid's own second column, and the stylesheet places
        # it — beside the player on a desk, above it on a phone — so neither
        # direction depends on how the markup is nested.
        self.assertIn("grid.append(left, side);", script)
        with open(os.path.join(SKILL_DIR, "ui", "music.css"), encoding="utf-8") as handle:
            styles = handle.read()
        self.assertIn("grid-template-columns: minmax(0, 1fr) minmax(240px, 24vw);", styles)
        self.assertIn("position: sticky; top: var(--gap);", styles)
        self.assertIn(".music-app .grid { grid-template-columns: minmax(0, 1fr); }", styles,
                      "one column: on a phone the page is the scroller")
        self.assertIn("cursor: grabbing;", styles)
        self.assertIn("touch-action: none;", styles)

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
        self.assertIn("const box = lyrScroller.getBoundingClientRect();", script)
        self.assertIn("const rect = line.getBoundingClientRect();", script)
        self.assertIn("Math.min(target, lyrScroller.scrollHeight - lyrScroller.clientHeight)", script)
        self.assertIn("state.lyricTarget = lyricTop(state.activeLine);", script)
        self.assertIn("state.lyricFrame = lyricRequest(step);", script)
        self.assertIn('if (typeof raf !== "function" || state.lyricFrameStalled) {', script)
        self.assertIn("settleLyrics();", script)
        self.assertIn("lyrScroller.scrollTop = 0;", script)
        self.assertNotIn("activeLine.offsetTop", script)
        self.assertNotIn('behavior: "smooth"', script)

    def test_music_page_styles_are_scoped_and_responsive(self):
        """The panel's stylesheet, scoped to the page, is the page's whole layout.

        The console appends this file to a shared dashboard, so an unscoped
        selector would restyle the whole console; every rule must stay inside
        .music-app. The design is the panel's own: sizes are a floor, a share of
        the glass and a ceiling, so the page needs no breakpoint to stay readable
        and no JavaScript to measure the viewport. On a narrow screen the grid
        folds to one column and the page — never a nested scroller — is what
        scrolls, and there is a reduced-motion path.
        """
        with open(os.path.join(SKILL_DIR, "ui", "music.css"), encoding="utf-8") as handle:
            styles = handle.read()

        selectors = style_selectors(styles)
        self.assertTrue(selectors)
        for selector in selectors:
            self.assertIn(".music-app", selector, selector)

        for query in (
            "@media (max-width: 900px)",
            "@media (max-width: 620px)",
            "@media (hover: none)",
            "@media (prefers-reduced-motion: reduce)",
        ):
            self.assertIn(query, styles)

        # Fluid sizing, with a floor under the controls a thumb lands on.
        self.assertIn("clamp(", styles)
        self.assertIn("aspect-ratio: 1", styles)
        self.assertIn("width: clamp(52px, 4.48vw, 87px); aspect-ratio: 1;", styles)
        # The shelves and the sheet are rails that slide sideways.
        self.assertIn("overflow-x: auto", styles)
        self.assertIn("scroll-snap-type", styles)
        # The queue card is the page's own column while there is room for it.
        self.assertIn("grid-template-columns: minmax(0, 1fr) minmax(240px, 24vw);", styles)
        self.assertIn("position: sticky; top: var(--gap);", styles)
        # A nested scroll container under a nested scroll container is what makes
        # a phone page feel stuck; there the page itself scrolls instead.
        self.assertIn(".music-app .grid { grid-template-columns: minmax(0, 1fr); }", styles)
        self.assertIn(".music-app .side {\n    position: static; max-height: none;", styles)
        self.assertIn("animation: none !important;", styles)

    def test_music_page_paints_its_own_surface(self):
        """The page's root paints the panel's surface: the dashboard owns the document.

        On the wall the palette's background comes from `body` in
        PUCA-Panel/panel.css. The page cannot use that rule — the console's
        dashboard owns the document here, so this design is scoped to
        `.music-app` — and a theme that sets a foreground without a surface
        paints white words on the dashboard's white page: with the night page's
        text measuring 1:1 against what was actually behind it, the page is not
        merely unstyled, it is blank. So the root paints the surface itself,
        with the panel's own wash, padding and corner.
        """
        with open(os.path.join(SKILL_DIR, "ui", "music.css"), encoding="utf-8") as handle:
            styles = handle.read()

        surface = style_declarations(styles, ".music-app")
        self.assertIn("background-color: var(--bg)", surface,
                      "the page root paints the theme's own background")
        self.assertIn("radial-gradient", surface, "the panel's wash goes over it")
        self.assertIn("color: var(--text)", surface, "and its foreground is the theme's")
        self.assertIn("padding: var(--pad)", surface, "inside the panel's own frame")
        self.assertIn("border-radius: var(--radius)", surface)

    def test_music_page_answers_a_tap_without_waiting_for_the_speaker(self):
        """Typing, tapping and volume changes must feel instant.

        A tap marks the sleeve it came from pending before the request is sent
        and the sheet paints its skeleton at once, already-fetched results come
        back from a short-lived cache with no spinner, typing is debounced and a
        superseded search is aborted instead of racing the newer one, and after
        an action the cheap snapshot endpoint is re-read every 260ms until the
        speaker agrees rather than waiting for the shell's slow poll.
        """
        with open(os.path.join(SKILL_DIR, "ui", "music.js"), encoding="utf-8") as handle:
            script = handle.read()

        self.assertIn("const SEARCH_DEBOUNCE_MS = 280;", script)
        self.assertIn("state.searchTimer = window.setTimeout(fire, SEARCH_DEBOUNCE_MS);", script)
        self.assertIn("new AbortController()", script)
        self.assertIn('error && error.name === "AbortError"', script)
        self.assertIn("cacheRead(key, SEARCH_TTL_MS)", script)
        self.assertIn("cacheWrite(key, payload, SEARCH_TTL_MS)", script)
        self.assertIn("const LIBRARY_TTL_MS = 20_000;", script)
        # The tap is acknowledged on the sleeve it came from, and the answer has
        # somewhere to land before the provider has replied.
        self.assertIn('if (node) node.classList.add("is-pending");', script)
        self.assertIn('element("div", "music-skeleton")', script)
        self.assertIn("sheetOpen(true);", script)
        self.assertIn("const CONFIRM_DELAY_MS = 260;", script)
        self.assertIn("function followUp(videoId)", script)
        self.assertIn("state.confirmTimers.push(window.setTimeout(step, CONFIRM_DELAY_MS));", script)
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

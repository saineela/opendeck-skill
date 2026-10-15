#!/usr/bin/env python3
"""Run the jsdom behaviour harness for the music page.

The page's behaviour (instant tap feedback, debounced and cached search, aborted
superseded requests, coalesced volume, shortcuts) is JavaScript, so it is checked
by mounting the real ui/music.js in a DOM and driving it, not by matching strings
in the source. The harness skips when Node or jsdom is unavailable on this
machine (exit code 77), and jsdom is a test-only dependency: point
NIX_JSDOM_ROOT at an install if it is not in a local node_modules.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.join(HERE, "music_page_dom.mjs")


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class MusicPageDomTestCase(unittest.TestCase):
    def test_music_page_behaviour_in_a_dom(self):
        completed = subprocess.run(
            ["node", HARNESS],
            cwd=os.path.dirname(HERE),
            capture_output=True,
            text=True,
            timeout=180,
        )
        if completed.returncode == 77:
            self.skipTest(completed.stdout.strip() or "jsdom is not installed")
        self.assertEqual(
            completed.returncode,
            0,
            completed.stdout + completed.stderr,
        )
        self.assertIn("music page checks passed", completed.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)

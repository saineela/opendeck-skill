#!/usr/bin/env python3
"""Run the jsdom behaviour harness for the PUCA Panel.

The panel's behaviour (the theme following the console's clock, the lyrics
opening by themselves, a spoken request becoming the same call the assistant
makes, an unclear one becoming a choice the user taps) is JavaScript, so it is
checked by mounting the real PUCA-Panel/panel.js and panel.html in a DOM and
driving them, not by matching strings in the source. The harness skips when Node
or jsdom is unavailable on this machine (exit code 77), and jsdom is a
test-only dependency: point NIX_JSDOM_ROOT at an install if it is not in a local
node_modules.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.join(HERE, "puca_panel_dom.mjs")


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class PucaPanelDomTestCase(unittest.TestCase):
    def test_the_panel_behaves_in_a_dom(self):
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
        self.assertIn("PUCA Panel checks passed", completed.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)

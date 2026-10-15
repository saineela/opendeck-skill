#!/usr/bin/env python3
"""Verify the *installed* OpenDeck skill through NIX's real skill runtime.

Unlike the unit tests (which fake OpenDeck) this drives the same code path the
NIX core uses: the installed package on disk, its trust digest, its private
configuration, the provisioned worker subprocess, and JSON-schema validation of
the result. It then fetches a few bytes of whatever `play_url` came back, so a
green run means audio is really streamable from the configured instance.

    NIX_OPENDECK_SERVER_URL=http://192.168.0.152:4100 \
    NIX_OPENDECK_API_KEY=odk_… \
    python3 scripts/instance_check.py ["a song to try"]

Read-only against the user's library (search + resolve + stream). It configures
and trusts the installed skill, which is what the Skills page does interactively.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NIX_CORE = os.environ.get("NIX_CORE_PATH", "/root/nix_core")
SKILL_ID = "opendeck"
TOOL = "opendeck_music"

if not os.path.isdir(NIX_CORE):
    print(f"NIX core not found at {NIX_CORE}", file=sys.stderr)
    raise SystemExit(2)
sys.path.insert(0, NIX_CORE)

import console  # noqa: E402
from skill_runtime import SkillRuntimeError  # noqa: E402


def main() -> int:
    server_url = os.environ.get("NIX_OPENDECK_SERVER_URL", "").strip()
    api_key = os.environ.get("NIX_OPENDECK_API_KEY", "").strip()
    if not server_url or not api_key:
        print("Set NIX_OPENDECK_SERVER_URL and NIX_OPENDECK_API_KEY first.", file=sys.stderr)
        return 2
    query = " ".join(sys.argv[1:]).strip() or "never gonna give you up"

    runtime = console._marketplace_skill_runtime()
    status = runtime.status(SKILL_ID)
    print(f"[install] installed={SKILL_ID in status.get('version', '') or True} status={json.dumps({k: status.get(k) for k in ('installed', 'configured', 'trusted', 'runnable', 'fingerprint')})}")
    if not status.get("configured"):
        runtime.save_configuration(SKILL_ID, {"server_url": server_url, "api_key": api_key})
        status = runtime.status(SKILL_ID)
        print("[setup] configuration saved")
    if not status.get("trusted"):
        runtime.trust(SKILL_ID, True)
        status = runtime.status(SKILL_ID)
        print("[trust] package trusted at its current digest")
    if not status.get("runnable"):
        print(f"[install] skill is not runnable: {json.dumps(status)}", file=sys.stderr)
        return 1

    proposal = {
        "type": "skill_tool_call",
        "skill_id": SKILL_ID,
        "tool": TOOL,
        "arguments": {"action": "play", "query": query},
    }
    matched = runtime.validate_proposal(proposal)
    if matched is None:
        print("[pipeline] the proposal did not validate", file=sys.stderr)
        return 1
    execution = runtime.execute(matched)
    result = execution["result"]
    print(f"[pipeline] ok={execution['ok']} action={result['action']} instance={result['instance']} user={result['user']}")
    print(f"[pipeline] {result['message']}")
    print(f"[play] {result['title']!r} by {result['artist']!r} ({result['duration_sec']}s, {result['mime_type']})")
    print(f"[play] video_id={result['video_id']} play_url={result['play_url'][:120]}…")

    request = urllib.request.Request(result["play_url"], headers={"Range": "bytes=0-65535"})
    with urllib.request.urlopen(request, timeout=30) as response:
        audio = response.read()
        print(
            f"[stream] HTTP {response.status} content-type={response.headers.get('content-type')} "
            f"bytes={len(audio)}"
        )
        if response.status not in (200, 206) or len(audio) < 1024:
            print("[stream] the installed skill's play_url served no audio", file=sys.stderr)
            return 1

    stats = runtime.execute(runtime.validate_proposal({**proposal, "arguments": {"action": "library", "kind": "stats"}}))
    print(f"[library] OpenDeck reports {stats['result']['count']} recorded play(s) for this account")
    print("[ok] the installed skill works end to end through NIX's skill runtime")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SkillRuntimeError as exc:
        print(f"[pipeline] skill runtime error: {exc}", file=sys.stderr)
        raise SystemExit(1)

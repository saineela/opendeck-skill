#!/usr/bin/env python3
"""Run natural-language prompts through the installed OpenDeck skill.

This drives the same path a spoken request takes inside NIX: the runtime's
trigger matcher picks the installed skill, the worker turns the sentence into
tool arguments, the arguments are validated against the manifest schema, and
the worker executes them. For listening prompts it then fetches a byte range
from the returned `play_url`, so a green run proves OpenDeck really serves the
audio the device would play.

    python3 scripts/prompt_check.py [--skill github:…:opendeck] ["a prompt"] …

Read-only for the account: it searches, resolves and streams. The stream fetch
is unauthenticated, so it does not change the account's OpenDeck play history.
"""
from __future__ import annotations

import argparse
import os
import sys
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NIX_CORE = os.environ.get("NIX_CORE_PATH", "/root/nix_core")
if not os.path.isdir(NIX_CORE):
    print(f"NIX core not found at {NIX_CORE}", file=sys.stderr)
    raise SystemExit(2)
sys.path.insert(0, NIX_CORE)

import console  # noqa: E402
from skill_runtime import SkillRuntimeError  # noqa: E402

# Wording NIX's deterministic trigger gate accepts (a direct verb plus a
# declared term). Other phrasings — "what are my playlists?", "put some jazz
# on", "queue …" — are the model planner's job and are reported as unrouted.
DEFAULT_PROMPTS = [
    "play Bohemian Rhapsody on OpenDeck",
    "play music: Hotel California on OpenDeck",
    "play some jazz on OpenDeck",
    "play Never Gonna Give You Up on OpenDeck",
    "show my OpenDeck playlists",
    "show my liked songs on OpenDeck",
    "show my listening history on OpenDeck",
    "show me OpenDeck search results for Miles Davis",
]


def installed_opendeck_ids() -> list[str]:
    state = console._read_skills_state()
    return [item for item in state.get("installed", []) if str(item).split(":")[-1] == "opendeck"]


def stream_probe(play_url: str, limit: int = 65536) -> str:
    request = urllib.request.Request(play_url, headers={"Range": f"bytes=0-{limit - 1}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            audio = response.read()
            ok = response.status in (200, 206) and len(audio) >= 1024
            return (
                f"HTTP {response.status} {response.headers.get('content-type')} "
                f"{len(audio)} bytes {'AUDIO OK' if ok else 'NO AUDIO'}"
            )
    except urllib.error.HTTPError as exc:
        return f"HTTP {exc.code} (no audio)"
    except urllib.error.URLError as exc:
        return f"unreachable: {exc.reason}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill", default="", help="installed skill id (auto-detected by default)")
    parser.add_argument("--no-stream", action="store_true", help="skip the audio fetch on play results")
    parser.add_argument("prompts", nargs="*", help="prompts to run (defaults to a built-in suite)")
    args = parser.parse_args()

    runtime = console._marketplace_skill_runtime()
    skill_id = args.skill or next(iter(installed_opendeck_ids()), "")
    if not skill_id:
        print("no installed opendeck skill found; install it first", file=sys.stderr)
        return 1
    status = runtime.status(skill_id)
    print(f"skill: {skill_id}")
    print(
        "status: "
        f"configured={status.get('configured')} trusted={status.get('trusted')} "
        f"runnable={status.get('runnable')} digest={str(status.get('fingerprint'))[:12]}…"
    )
    if not status.get("runnable"):
        print(f"the skill is not runnable yet: {status.get('runtime_error')}", file=sys.stderr)
        return 1

    prompts = args.prompts or DEFAULT_PROMPTS
    failures, plays, unrouted = 0, 0, 0
    for index, prompt in enumerate(prompts, 1):
        print(f"\n[{index}/{len(prompts)}] “{prompt}”")
        try:
            matched = runtime.match(prompt)
        except SkillRuntimeError as exc:
            failures += 1
            print(f"    match error: {exc}")
            continue
        if matched is None:
            unrouted += 1
            print("    not routed by the deterministic matcher (the model planner path owns this wording)")
            continue
        arguments = matched["arguments"]
        print(f"    → skill={matched['skill_id'].split(':')[-1]} tool={matched['tool']['name']} args={arguments}")
        try:
            result = runtime.execute(matched)["result"]
        except SkillRuntimeError as exc:
            failures += 1
            print(f"    execute error: {exc}")
            continue
        print(f"    ← {result['message']}")
        if result.get("play_url"):
            plays += 1
            if not args.no_stream:
                probe = stream_probe(result["play_url"])
                print(f"    play_url {probe}")
                if "AUDIO OK" not in probe:
                    failures += 1
        else:
            print(
                f"    ← {result['action']}: count={result['count']} "
                f"tracks={len(result['tracks'])} playlists={len(result['playlists'])}"
            )

    print("\n=== summary ===")
    print(f"prompts={len(prompts)} listening={plays} unrouted={unrouted} failures={failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SkillRuntimeError as exc:
        print(f"skill runtime error: {exc}", file=sys.stderr)
        raise SystemExit(1)

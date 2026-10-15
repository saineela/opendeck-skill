#!/usr/bin/env python3
"""Package the skill and upload it to a local NIX console (the dev loop).

    python3 scripts/upload_skill.py [--console http://127.0.0.1:49117] [--skill opendeck]

It validates the archive with NIX's own reader, uploads it through the
documented ``POST /api/skills {"action":"upload_zip"}`` action, and prints the
installed skill. Re-uploading the same id fails by design, so an existing
installation of that id is uninstalled first (the ZIP is a manual-update
package; uninstall/reinstall is how it is refreshed).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from package_skill import build_zip, validate_with_nix  # noqa: E402


def post_console(console: str, payload: dict) -> tuple[int, dict]:
    request = urllib.request.Request(
        f"{console.rstrip('/')}/api/skills",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        body = exc.read()
        try:
            return exc.code, json.loads(body or b"{}")
        except json.JSONDecodeError:
            return exc.code, {"error": body.decode("utf-8", "replace")[:200]}


def release_upload_reservation(state_path: str, skill_id: str) -> tuple[str, int]:
    """Drop a ZIP package's catalog reservation from the local skills state.

    NIX keeps the ``upload/<id>`` repository entry after uninstalling a ZIP
    package, so its id can never be re-uploaded through the API. Re-uploading
    during development therefore needs this one scoped edit; the previous state
    file is backed up next to it first.
    """
    with open(state_path, encoding="utf-8") as handle:
        state = json.load(handle)
    if not isinstance(state, dict):
        raise SystemExit(f"unexpected skills state in {state_path}")
    backup = f"{state_path}.backup-{int(time.time())}"
    with open(backup, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2)
    os.chmod(backup, 0o600)

    def is_this_package(repo: dict) -> bool:
        if not isinstance(repo, dict):
            return False
        if repo.get("key") == f"upload/{skill_id}":
            return True
        if repo.get("source_type") != "upload":
            return False
        return any(
            isinstance(item, dict) and item.get("id") == skill_id
            for item in (repo.get("skills") or [])
        )

    repositories = state.get("repositories") or []
    kept = [repo for repo in repositories if not is_this_package(repo)]
    removed = len(repositories) - len(kept)
    state["repositories"] = kept
    state["installed"] = [item for item in (state.get("installed") or []) if item != skill_id]
    for key in ("trusted", "auto_updates", "installed_versions", "device_names"):
        section = state.get(key)
        if isinstance(section, dict):
            section.pop(skill_id, None)
    temporary = f"{state_path}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2)
    os.chmod(temporary, 0o600)
    os.replace(temporary, state_path)
    return backup, removed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--console", default=os.environ.get("NIX_CONSOLE_URL", "http://127.0.0.1:49117"))
    parser.add_argument("--skill", default="opendeck")
    parser.add_argument("--out", default=os.path.join(REPO, "dist"))
    parser.add_argument("--no-uninstall", action="store_true")
    parser.add_argument(
        "--force-replace",
        action="store_true",
        help="clear a previous ZIP upload's catalog reservation so the same skill id can be re-uploaded",
    )
    parser.add_argument(
        "--state",
        default=os.environ.get("NIX_SKILLS_STATE_PATH", "/root/data/skills.json"),
        help="local NIX skills state file (only used by --force-replace)",
    )
    args = parser.parse_args()

    skill_dir = os.path.join(REPO, "skills", args.skill)
    out_path, manifest = build_zip(skill_dir, args.out)
    print(f"packaged {manifest['id']} v{manifest['version']} ({os.path.getsize(out_path)} bytes)")
    print(f"nix zip validation: {validate_with_nix(out_path)}")

    with open(out_path, "rb") as handle:
        encoded = base64.b64encode(handle.read()).decode("ascii")
    status, payload = post_console(args.console, {"action": "upload_zip", "zip_base64": encoded})
    if status >= 400 or payload.get("ok") is False:
        error = str(payload.get("error") or "")
        if "already exists" in error:
            if not args.no_uninstall:
                print(f"skill {manifest['id']} is already installed — uninstalling first")
                post_console(args.console, {"action": "uninstall", "skill_id": manifest["id"]})
                status, payload = post_console(args.console, {"action": "upload_zip", "zip_base64": encoded})
                error = str(payload.get("error") or "")
            if "already exists" in error and args.force_replace:
                backup, removed = release_upload_reservation(args.state, manifest["id"])
                print(f"released {removed} upload reservation(s) in {args.state} (backup: {backup})")
                status, payload = post_console(args.console, {"action": "upload_zip", "zip_base64": encoded})
                error = str(payload.get("error") or "")
            if "already exists" in error:
                print(
                    "upload failed: this skill id is already reserved on the instance. Re-run with "
                    "--force-replace to clear the previous ZIP upload's reservation.",
                    file=sys.stderr,
                )
                return 1
        if status >= 400 or payload.get("ok") is False:
            print(f"upload failed (HTTP {status}): {payload.get('error')}", file=sys.stderr)
            return 1

    skills = payload.get("skills") if isinstance(payload.get("skills"), list) else []
    found = next((item for item in skills if isinstance(item, dict) and item.get("id") == manifest["id"]), None)
    print(f"upload accepted (HTTP {status})")
    if found is None:
        print("the uploaded skill is not in the marketplace listing", file=sys.stderr)
        return 1
    print(
        "installed skill: "
        + json.dumps(
            {key: found.get(key) for key in ("id", "name", "version", "trusted", "configured", "installed", "source_type")}
        )
    )
    if found.get("installed") is not True:
        print("warning: the skill is not installed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

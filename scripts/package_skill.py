#!/usr/bin/env python3
"""Package skills/<id>/ into the ZIP form NIX's Skills page accepts.

The archive contains exactly the files the manifest declares (`skill.json` at
the root), because NIX rejects any ZIP whose file set does not match its
manifest. With ``--validate`` the archive is re-read through NIX's own
``console._read_skill_zip`` so a broken package is caught before uploading.

    python3 scripts/package_skill.py [--skill opendeck] [--out dist] [--validate]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SKILL_DIR = os.path.join(REPO, "skills")


def build_zip(skill_dir: str, out_dir: str) -> tuple[str, dict]:
    manifest_path = os.path.join(skill_dir, "skill.json")
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise SystemExit("skill.json declares no files.")
    if "opendeck_worker.py" in files and manifest.get("runtime", {}).get("entrypoint") not in files:
        raise SystemExit("runtime entrypoint must be listed in files.")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("skill.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        for name in files:
            path = os.path.join(skill_dir, *name.split("/"))
            if not os.path.isfile(path):
                raise SystemExit(f"declared file is missing: {name}")
            with open(path, "rb") as handle:
                archive.writestr(name, handle.read())
    archive_bytes = buffer.getvalue()
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{manifest['id']}-{manifest['version']}.zip")
    with open(out_path, "wb") as handle:
        handle.write(archive_bytes)
    return out_path, manifest


def validate_with_nix(out_path: str) -> str:
    """Re-read the archive through NIX's own ZIP reader when the core is available."""
    nix_core = os.environ.get("NIX_CORE_PATH", "/root/nix_core")
    if not os.path.isdir(nix_core):
        return "skipped (NIX core not found)"
    sys.path.insert(0, nix_core)
    try:
        import console  # type: ignore
    except Exception as exc:  # pragma: no cover - environment dependent
        return f"skipped ({type(exc).__name__})"
    with open(out_path, "rb") as handle:
        parsed, contents = console._read_skill_zip(handle.read())
    return (
        f"ok — NIX accepted it as {parsed['slug']} v{parsed['version']} "
        f"with {len(contents)} declared file(s)"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill", default="opendeck")
    parser.add_argument("--out", default=os.path.join(REPO, "dist"))
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    skill_dir = os.path.join(args.skill if os.path.isdir(args.skill) else DEFAULT_SKILL_DIR, args.skill)
    if not os.path.isdir(skill_dir):
        skill_dir = args.skill
    out_path, manifest = build_zip(skill_dir, args.out)
    print(f"packaged {manifest['id']} v{manifest['version']} -> {out_path}")
    if args.validate:
        print(f"nix zip validation: {validate_with_nix(out_path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

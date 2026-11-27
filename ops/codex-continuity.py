#!/usr/bin/env python3
"""Install a small ContextKeep instruction block without replacing owner instructions."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time

START = b"<!-- contextkeep-continuity:start -->"
END = b"<!-- contextkeep-continuity:end -->"
MAX_BYTES = 1024 * 1024
DEFAULT_FRAGMENT = Path(__file__).resolve().parents[1] / "docs/mcp/codex-continuity-agents.md"


class InstallError(Exception):
    pass


def read_file(path: Path) -> tuple[bytes, os.stat_result | None]:
    """Bound reads and reject symlinks/non-files instead of following them."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    except FileNotFoundError:
        return b"", None
    except OSError as exc:
        raise InstallError(f"Cannot safely read {path.name}: {exc.strerror}") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise InstallError(f"{path.name} must be a regular file with one link")
        if info.st_size > MAX_BYTES:
            raise InstallError(f"{path.name} exceeds the {MAX_BYTES}-byte safety limit")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise InstallError(f"{path.name} exceeds the read limit")
        data.decode("utf-8")
        return data, info
    except UnicodeDecodeError as exc:
        raise InstallError(f"{path.name} must contain UTF-8 text") from exc
    finally:
        os.close(fd)


def block_span(data: bytes) -> tuple[int, int] | None:
    if data.count(START) != data.count(END) or data.count(START) > 1:
        raise InstallError("Managed block markers are incomplete or duplicated")
    if START not in data:
        return None
    lines = data.splitlines(keepends=True)
    offset = 0
    found = {}
    for line in lines:
        value = line.rstrip(b"\r\n")
        if value in (START, END):
            found[value] = (offset, offset + len(line))
        offset += len(line)
    if START not in found or END not in found or found[START][0] >= found[END][0]:
        raise InstallError("Managed block markers must be ordered, separate lines")
    return found[START][0], found[END][1]


def render(data: bytes, fragment: bytes | None) -> bytes:
    span = block_span(data)
    if fragment is None:
        return data if span is None else data[:span[0]] + data[span[1]:]
    if not fragment.strip() or START in fragment or END in fragment:
        raise InstallError("Fragment is empty or contains managed markers")
    fragment.decode("utf-8")
    newline = b"\r\n" if b"\r\n" in data else b"\n"
    body = fragment.replace(b"\r\n", b"\n").strip(b"\n")
    block = START + b"\n" + body + b"\n" + END + b"\n"
    block = block.replace(b"\n", newline)
    if span is not None:
        return data[:span[0]] + block + data[span[1]:]
    separator = b"" if not data else (newline if data.endswith(b"\n") else newline * 2)
    return data + separator + block


def fingerprint(info: os.stat_result | None):
    if info is None:
        return None
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def ensure_unshadowed(profile: Path):
    override, _ = read_file(profile / "AGENTS.override.md")
    if override:
        raise InstallError("Non-empty AGENTS.override.md shadows AGENTS.md; reconcile it explicitly first")


@contextlib.contextmanager
def profile_lock(profile: Path):
    # Cooperating installers serialize. A final identity/content check also
    # catches an owner/editor change observed before the atomic replacement.
    path = profile / ".contextkeep-continuity.lock"
    try:
        fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    except OSError as exc:
        raise InstallError(f"Cannot safely open installation lock: {exc.strerror}") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise InstallError("Installation lock must be a regular file with one link")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    except BlockingIOError as exc:
        raise InstallError("Another continuity installer holds the profile lock") from exc
    finally:
        os.close(fd)


def apply(profile: Path, action: str, fragment: bytes | None) -> dict:
    if action not in ("check", "install", "remove"):
        raise InstallError("Unsupported action")
    if action != "remove" and fragment is None:
        raise InstallError("Install/check requires the versioned fragment")
    if not profile.is_dir():
        raise InstallError("Codex profile directory does not exist; select an existing profile")
    target = profile / "AGENTS.md"

    def prepare():
        if action != "remove":
            ensure_unshadowed(profile)
        before, info = read_file(target)
        after = render(before, None if action == "remove" else fragment)
        if len(after) > MAX_BYTES:
            raise InstallError("Result exceeds the instruction file safety limit")
        return before, info, after

    if action == "check":
        before, _, after = prepare()
        return {"status": "current" if before == after else "missing_or_outdated",
                "changed": False, "instruction_bytes": len(before)}

    with profile_lock(profile):
        before, info, after = prepare()
        if before == after:
            return {"status": "unchanged", "changed": False, "instruction_bytes": len(after)}
        backup = None
        if info is not None:
            digest = hashlib.sha256(before).hexdigest()[:12]
            backup = profile / f"AGENTS.md.contextkeep-backup-{time.time_ns()}-{digest}"
            backup_fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(backup_fd, "wb") as stream:
                stream.write(before)
                stream.flush()
                os.fsync(stream.fileno())
        temp_name = None
        try:
            fd, temp_name = tempfile.mkstemp(prefix=".contextkeep-agents-", dir=profile)
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode) if info else 0o600)
                stream.write(after)
                stream.flush()
                os.fsync(stream.fileno())
            current, current_info = read_file(target)
            if fingerprint(current_info) != fingerprint(info) or current != before:
                raise InstallError("AGENTS.md changed during preparation; no replacement made")
            if action != "remove":
                ensure_unshadowed(profile)
            os.replace(temp_name, target)
            temp_name = None
            directory_fd = os.open(profile, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if temp_name is not None:
                os.unlink(temp_name)
        return {"status": "installed" if action == "install" else "removed",
                "changed": True, "instruction_bytes": len(after),
                "backup": str(backup) if backup else None}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "install", "remove"))
    parser.add_argument("--codex-home", type=Path,
                        default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))),
                        help="Existing Codex profile directory (default: CODEX_HOME or ~/.codex)")
    args = parser.parse_args(argv)
    try:
        fragment = None
        if args.action != "remove":
            fragment, info = read_file(DEFAULT_FRAGMENT)
            if info is None:
                raise InstallError("Versioned instruction fragment is missing")
        result = apply(args.codex_home.expanduser(), args.action, fragment)
        print(json.dumps(result, sort_keys=True))
        return 1 if result["status"] == "missing_or_outdated" else 0
    except (InstallError, OSError, UnicodeError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

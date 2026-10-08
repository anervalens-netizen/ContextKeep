#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile
from typing import Any

SNAPSHOT_RE = re.compile(r"snapshot-(\d{8})T(\d{6})Z\.tar\.gz$")
RUNTIME_RE = re.compile(r"runtime-[A-Za-z0-9._-]+\.tar\.gz$")
SHA_RE = re.compile(r"[0-9a-f]{64}$")
POLICY_TEXT = "NAS: 1 verified snapshot + matching runtime; server/Dell: 4 recent + 1/day for previous 3 days"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def snapshot_key(path: Path) -> tuple[dt.datetime, str]:
    match = SNAPSHOT_RE.fullmatch(path.name)
    if not match:
        raise ValueError(f"Unsafe snapshot name: {path.name}")
    stamp = dt.datetime.strptime("".join(match.groups()), "%Y%m%d%H%M%S").replace(tzinfo=dt.timezone.utc)
    return stamp, path.name


def read_manifest(archive: Path) -> dict[str, Any]:
    if not archive.is_file() or archive.is_symlink():
        raise ValueError(f"Unsafe snapshot: {archive}")
    with tarfile.open(archive, "r:gz") as bundle:
        try:
            manifest_member = bundle.getmember("manifest.json")
            database_member = bundle.getmember("store.sqlite")
        except KeyError as exc:
            raise ValueError(f"Incomplete snapshot: {archive.name}") from exc
        if not manifest_member.isfile() or manifest_member.size > 1_000_000 or not database_member.isfile():
            raise ValueError(f"Unsafe snapshot members: {archive.name}")
        manifest_stream = bundle.extractfile(manifest_member)
        database_stream = bundle.extractfile(database_member)
        if manifest_stream is None or database_stream is None:
            raise ValueError(f"Unreadable snapshot: {archive.name}")
        manifest = json.load(manifest_stream)
        actual_db = hashlib.file_digest(database_stream, "sha256").hexdigest()
    expected_db = manifest.get("db_sha256")
    runtime_name = manifest.get("runtime_kit")
    runtime_sha = manifest.get("runtime_sha256")
    if actual_db != expected_db or not isinstance(runtime_name, str) or not RUNTIME_RE.fullmatch(runtime_name):
        raise ValueError(f"Snapshot integrity mismatch: {archive.name}")
    if not isinstance(runtime_sha, str) or not SHA_RE.fullmatch(runtime_sha):
        raise ValueError(f"Invalid runtime identity: {archive.name}")
    return manifest


def selected_snapshots(root: Path) -> list[Path]:
    rows = sorted(root.glob("snapshot-????????T??????Z.tar.gz"), key=snapshot_key, reverse=True)
    if not rows:
        raise ValueError(f"No ContextKeep snapshots in {root}")
    keep: list[Path] = rows[:4]
    latest_day = snapshot_key(rows[0])[0].date()
    prior_days: set[dt.date] = set()
    for archive in rows[4:]:
        day = snapshot_key(archive)[0].date()
        if day == latest_day or day in prior_days:
            continue
        keep.append(archive)
        prior_days.add(day)
        if len(prior_days) >= 3:
            break
    return keep


def prune_root(root: Path, *, runtime_root: Path | None = None, dry_run: bool = False) -> dict[str, Any]:
    root = root.resolve(strict=True)
    runtime_root = (runtime_root or root).resolve(strict=True)
    lock_path = root / "backup.lock"
    lock_path.touch(exist_ok=True)
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        all_snapshots = sorted(root.glob("snapshot-????????T??????Z.tar.gz"), key=snapshot_key, reverse=True)
        keep = selected_snapshots(root)
        keep_set = set(keep)
        runtime_refs: dict[str, str] = {}
        verified: list[dict[str, Any]] = []
        for archive in keep:
            manifest = read_manifest(archive)
            runtime_name = manifest["runtime_kit"]
            runtime_sha = manifest["runtime_sha256"]
            old = runtime_refs.setdefault(runtime_name, runtime_sha)
            if old != runtime_sha:
                raise ValueError(f"Conflicting runtime identity: {runtime_name}")
            runtime = runtime_root / runtime_name
            if not runtime.is_file() or runtime.is_symlink() or digest(runtime) != runtime_sha:
                raise ValueError(f"Runtime integrity mismatch: {runtime_name}")
            verified.append({"snapshot": archive.name, "runtime": runtime_name, "db_sha256": manifest["db_sha256"]})
        delete_snapshots = [path for path in all_snapshots if path not in keep_set]
        delete_runtimes = [
            path for path in runtime_root.glob("runtime-*.tar.gz")
            if path.name not in runtime_refs and path.is_file() and not path.is_symlink()
        ]
        before = sum(path.stat().st_size for directory in {root, runtime_root} for path in directory.iterdir() if path.is_file())
        if not dry_run:
            for path in delete_snapshots + delete_runtimes:
                path.unlink()
            (root / ".runtime-prune-last").touch()
        after = before if dry_run else sum(path.stat().st_size for directory in {root, runtime_root} for path in directory.iterdir() if path.is_file())
        return {
            "root": str(root),
            "dry_run": dry_run,
            "before_bytes": before,
            "after_bytes": after,
            "freed_bytes": 0 if dry_run else before - after,
            "kept_snapshots": [path.name for path in keep],
            "kept_runtimes": sorted(runtime_refs),
            "verified": verified,
            "deleted": [path.name for path in delete_snapshots + delete_runtimes],
        }


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(payload, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def run(command: list[str], *, input_text: str | None = None) -> str:
    result = subprocess.run(command, input=input_text, text=True, capture_output=True, check=True)
    return result.stdout


def orchestrate(config_path: Path, *, dry_run: bool = False) -> dict[str, Any]:
    config = json.loads(config_path.read_text())
    local_root = Path(config["backup_dir"])
    local = prune_root(local_root, runtime_root=Path(config.get("runtime_kit_dir", config["backup_dir"])), dry_run=dry_run)
    remote = config["dell_target"]
    remote_root = config["dell_dir"]
    helper = str(Path(config["home_dir"]) / ".local/bin/contextkeep-minimal-retention.py")
    remote_command = [
        "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", remote,
        "python3 " + shlex.quote(helper) + " --root " + shlex.quote(remote_root) + (" --dry-run" if dry_run else "") + " --json",
    ]
    dell = json.loads(run(remote_command))
    result = {"policy": POLICY_TEXT, "server": local, "dell": dell, "dry_run": dry_run}
    if dry_run:
        return result
    status_path = local_root / "status.json"
    status = json.loads(status_path.read_text())
    status["retention"] = POLICY_TEXT
    status["retention_policy"] = {
        "recent_snapshots": 4,
        "daily_snapshots_previous_days": 3,
        "nas_snapshots": 1,
    }
    status["retention_verified_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    status["retention_copies"] = {
        "server": {"snapshots": len(local["kept_snapshots"]), "runtimes": len(local["kept_runtimes"])},
        "dell": {"snapshots": len(dell["kept_snapshots"]), "runtimes": len(dell["kept_runtimes"])},
        "nas": {"snapshots": 1},
    }
    atomic_json(status_path, status)
    run(["rsync", "-a", "--timeout=60", str(status_path), remote + ":" + shlex.quote(remote_root + "/")])
    remote_status_hash = run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", remote,
                              "sha256sum -- " + shlex.quote(remote_root + "/status.json")]).split()[0]
    local_status_hash = digest(status_path)
    if remote_status_hash != local_status_hash:
        raise ValueError("Dell status publication hash mismatch")
    nas_mount = config["nas_mount"]
    if not os.path.ismount(nas_mount):
        raise RuntimeError("NAS mount missing during retention status publication")
    nas_status = Path(config["nas_dir"]) / "status.json"
    temporary = nas_status.with_suffix(".partial")
    shutil.copyfile(status_path, temporary)
    os.replace(temporary, nas_status)
    if digest(nas_status) != local_status_hash:
        raise ValueError("NAS status publication hash mismatch")
    result["status_sha256"] = local_status_hash
    return result


def self_test() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="ck-retention-selftest-") as directory:
        root = Path(directory)
        runtime_a = root / "runtime-a.tar.gz"
        runtime_b = root / "runtime-b.tar.gz"
        runtime_a.write_bytes(b"runtime-a")
        runtime_b.write_bytes(b"runtime-b")
        runtime_hashes = {runtime_a.name: digest(runtime_a), runtime_b.name: digest(runtime_b)}
        base = dt.datetime(2026, 10, 8, 12, 0, tzinfo=dt.timezone.utc)
        for index in range(12):
            created = base - dt.timedelta(hours=index * 6)
            runtime = runtime_a if index < 8 else runtime_b
            database = f"database-{index}".encode()
            manifest = {
                "db_sha256": hashlib.sha256(database).hexdigest(),
                "runtime_kit": runtime.name,
                "runtime_sha256": runtime_hashes[runtime.name],
            }
            archive = root / created.strftime("snapshot-%Y%m%dT%H%M%SZ.tar.gz")
            with tarfile.open(archive, "w:gz") as bundle:
                db_info = tarfile.TarInfo("store.sqlite")
                db_info.size = len(database)
                bundle.addfile(db_info, io.BytesIO(database))
                payload = json.dumps(manifest).encode()
                mf_info = tarfile.TarInfo("manifest.json")
                mf_info.size = len(payload)
                bundle.addfile(mf_info, io.BytesIO(payload))
        result = prune_root(root)
        if len(result["kept_snapshots"]) != 7 or len(list(root.glob("snapshot-*.tar.gz"))) != 7:
            raise AssertionError(result)
        if not runtime_a.exists() or not runtime_b.exists():
            raise AssertionError("Referenced runtime removed")
        result["self_test"] = "PASS"
        return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path)
    parser.add_argument("--runtime-root", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--orchestrate", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        result = self_test()
    elif args.orchestrate:
        if args.config is None:
            parser.error("--orchestrate requires --config")
        result = orchestrate(args.config, dry_run=args.dry_run)
    elif args.root is not None:
        result = prune_root(args.root, runtime_root=args.runtime_root, dry_run=args.dry_run)
    else:
        parser.error("choose --self-test, --orchestrate, or --root")
    print(json.dumps(result, indent=None if args.json else 2, sort_keys=True))


if __name__ == "__main__":
    main()

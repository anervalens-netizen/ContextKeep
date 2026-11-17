#!/usr/bin/env python3
"""Read-only, private-journal SQLite capacity observation; no DB or WAL mutation.

The configured database path is private input, never printed in this event.
The fixed event schema contains no customer/project/client identifiers.
"""
from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import sys
from urllib.parse import quote

EVENT = "contextkeep_sqlite_capacity_v1"
MAX_DB_PATH = 4096


def nonnegative(value: object) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("Invalid numeric capacity result")
    return value


def safe_size(path: Path) -> int:
    try:
        return nonnegative(path.stat().st_size)
    except FileNotFoundError:
        return 0


def sample(database: Path) -> dict[str, object]:
    """One bounded, read-only metadata observation; absence fails, never writes."""
    if not database.is_absolute() or len(str(database)) > MAX_DB_PATH:
        raise ValueError("Invalid database configuration")
    if database.is_symlink() or not database.is_file():
        raise ValueError("SQLite database missing or invalid")
    # SQLite URI quotes arbitrary path characters, preventing query injection.
    uri = "file:" + quote(str(database), safe="/") + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=0.5)
    try:
        connection.execute("PRAGMA query_only=ON")
        page_size = nonnegative(connection.execute("PRAGMA page_size").fetchone()[0])
        page_count = nonnegative(connection.execute("PRAGMA page_count").fetchone()[0])
        freelist = nonnegative(connection.execute("PRAGMA freelist_count").fetchone()[0])
        if not 512 <= page_size <= 65536 or page_count < freelist:
            raise ValueError("Invalid SQLite page counters")
        journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        if journal_mode not in ("wal", "delete", "truncate", "persist", "memory", "off"):
            raise ValueError("Invalid SQLite journal mode")
        # dbstat is optional; never confuse an unavailable index value with zero.
        index_bytes: int | None = None
        try:
            value = connection.execute(
                "SELECT COALESCE(SUM(pgsize),0) FROM dbstat "
                "WHERE name IN (SELECT name FROM sqlite_master WHERE type='index')"
            ).fetchone()[0]
            index_bytes = nonnegative(value)
        except sqlite3.Error:
            pass
    finally:
        connection.close()
    fs = os.statvfs(database.parent)
    free_bytes = nonnegative(fs.f_bavail * fs.f_frsize)
    total_bytes = nonnegative(fs.f_blocks * fs.f_frsize)
    if total_bytes == 0 or free_bytes > total_bytes:
        raise ValueError("Invalid volume counters")
    return {
        "event": EVENT,
        "source": "local_readonly_sqlite",
        "captured_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "main_bytes": safe_size(database),
        "wal_bytes": safe_size(Path(str(database) + "-wal")),
        "shm_bytes": safe_size(Path(str(database) + "-shm")),
        "page_bytes": page_size,
        "pages": page_count,
        "free_pages": freelist,
        "index_bytes": index_bytes,
        "fs_available_bytes": free_bytes,
        "fs_total_bytes": total_bytes,
        "journal_mode": journal_mode,
    }


def main() -> int:
    raw = os.environ.get("CK_CAPACITY_DB", "")
    try:
        value = sample(Path(raw))
    except (OSError, sqlite3.Error, ValueError, TypeError) as exc:
        # No path, SQLite error body or source material escapes into the journal.
        print(f"CK_CAPACITY_ERROR {type(exc).__name__}", file=sys.stderr)
        return 1
    print("CK_CAPACITY_METRIC " + json.dumps(value, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

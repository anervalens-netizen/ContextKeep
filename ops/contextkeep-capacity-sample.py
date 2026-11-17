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
import stat
import sys
from urllib.parse import quote

EVENT = "contextkeep_sqlite_capacity_v1"
MAX_DB_PATH = 4096
MAX_DBSTAT_DATABASE_BYTES = 256 * 1024 * 1024


def nonnegative(value: object) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("Invalid numeric capacity result")
    return value


def sidecar_info(path: Path) -> os.stat_result | None:
    """Do not follow sidecar symlinks or report external file sizes as WAL."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("Invalid SQLite sidecar")
    return info


def safe_size(path: Path) -> int:
    info = sidecar_info(path)
    return 0 if info is None else nonnegative(info.st_size)


def _single_regular_file(path: Path) -> bool:
    try:
        item = path.lstat()
        return stat.S_ISREG(item.st_mode) and item.st_nlink == 1
    except FileNotFoundError:
        return False


def _is_readable_quiescent_wal(database: Path) -> bool:
    """Validate a clean stopped WAL main file without writing its sidecars.

    The caller holds the application's shared restore lease and a true
    read-only mount. This is a bounded schema check, not full data integrity.
    """
    size = database.stat().st_size
    with database.open("rb") as stream:
        header = stream.read(101)
    if (len(header) != 101 or header[:16] != b"SQLite format 3\x00"
            or header[18:20] != b"\x02\x02"):
        return False
    encoded_size = int.from_bytes(header[16:18], "big")
    page_size = 65536 if encoded_size == 1 else encoded_size
    if (not 512 <= page_size <= 65536 or page_size & (page_size - 1)
            or header[100] not in (0x05, 0x0D)):
        return False
    header_pages = int.from_bytes(header[28:32], "big")
    if header_pages < 1 or size != header_pages * page_size:
        return False
    # Mode=ro&immutable=1 opens the checkpointed main file without WAL/SHM
    # creation. If its schema cannot be read, fail instead of file_only.
    uri = "file:" + quote(str(database), safe="/") + "?mode=ro&immutable=1"
    try:
        readonly = sqlite3.connect(uri, uri=True, timeout=0.2)
    except sqlite3.Error:
        return False
    try:
        readonly.execute("PRAGMA query_only=ON")
        count = readonly.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table'"
        ).fetchone()[0]
        return type(count) is int and count > 0
    except sqlite3.Error:
        return False
    finally:
        readonly.close()


def sample(database: Path) -> dict[str, object]:
    """Read-only snapshot with the existing restore exclusion lease held.

    Production requires a genuinely read-only mount namespace, not merely a
    SQLite read-only URI. This prevents WAL/SHM creation or updates, even when
    the last writer has closed and SQLite would otherwise create sidecars.
    """
    if not database.is_absolute() or len(str(database)) > MAX_DB_PATH:
        raise ValueError("Invalid database configuration")
    if not _single_regular_file(database):
        raise ValueError("SQLite database missing or invalid")
    if database.stat().st_size < 100:
        raise ValueError("SQLite main file uninitialized or truncated")
    volume = os.statvfs(database.parent)
    if not volume.f_flag & os.ST_RDONLY:
        raise ValueError("Capacity observer requires a read-only filesystem mount")
    # The application and restore both coordinate through this permanent
    # SQLite DELETE-journal lock database. A concurrent exclusive restore
    # prevents acquiring the shared lease and must fail the sample closed.
    lease_file = database.parent / ".contextkeep-lock.sqlite"
    if not _single_regular_file(lease_file):
        raise ValueError("Shared database directory lease unavailable")
    def uri(path: Path) -> str:
        return "file:" + quote(str(path), safe="/") + "?mode=ro"
    lease = sqlite3.connect(uri(lease_file), uri=True, timeout=0.05)
    try:
        lease.execute("PRAGMA query_only=ON")
        lease.execute("BEGIN")
        lease.execute("SELECT COUNT(*) FROM directory_lease").fetchone()
        # Keep the lease through every logical and filesystem observation,
        # so a restore cannot replace the pathname mid-sample. A quiescent
        # WAL store may lack SHM and cannot be opened on the read-only mount.
        # Emit an explicit file-only observation rather than fabricating
        # logical SQLite counters or silently leaving a gap in storage trend.
        page_size = page_count = freelist = index_bytes = journal_mode = None
        query_available = False
        index_measurement = "unavailable"
        try:
            connection = sqlite3.connect(uri(database), uri=True, timeout=0.5)
            try:
                connection.execute("PRAGMA query_only=ON")
                # Pin a single read snapshot across PRAGMA metadata and dbstat;
                # no write transaction is started.
                connection.execute("BEGIN")
                page_size = nonnegative(connection.execute("PRAGMA page_size").fetchone()[0])
                page_count = nonnegative(connection.execute("PRAGMA page_count").fetchone()[0])
                freelist = nonnegative(connection.execute("PRAGMA freelist_count").fetchone()[0])
                if not 512 <= page_size <= 65536 or page_count < freelist:
                    raise ValueError("Invalid SQLite page counters")
                journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
                if journal_mode not in ("wal", "delete", "truncate", "persist", "memory", "off"):
                    raise ValueError("Invalid SQLite journal mode")
                query_available = True
                # A dbstat scan visits index pages. Bound the total logical
                # database bytes to avoid holding the shared restore lease
                # for unbounded time as a store grows.
                if page_count * page_size > MAX_DBSTAT_DATABASE_BYTES:
                    index_measurement = "skipped_large_database"
                else:
                    try:
                        value = connection.execute(
                            "SELECT COALESCE(SUM(pgsize),0) FROM dbstat "
                            "WHERE name IN (SELECT name FROM sqlite_master WHERE type='index')"
                        ).fetchone()[0]
                        index_bytes = nonnegative(value)
                        index_measurement = "measured"
                    except sqlite3.Error:
                        index_measurement = "dbstat_unavailable"
            finally:
                connection.close()
        except sqlite3.OperationalError as error:
            # Busy/locked/IO errors and unclassified errors are not a
            # stopped WAL store. A zero-length WAL is harmless if SHM is
            # absent; any nonempty WAL or rollback journal refuses fallback.
            code = getattr(error, "sqlite_errorcode", None)
            wal = sidecar_info(Path(str(database) + "-wal"))
            shm = sidecar_info(Path(str(database) + "-shm"))
            rollback = sidecar_info(Path(str(database) + "-journal"))
            if (type(code) is not int or (code & 0xFF) != sqlite3.SQLITE_CANTOPEN
                    or shm is not None or rollback is not None
                    or (wal is not None and wal.st_size > 0)):
                raise
            # CANTOPEN alone is insufficient: permissions/invalid DB could
            # also trigger it. Require readable SQLite magic + WAL header.
            if not _is_readable_quiescent_wal(database):
                raise
            query_available = False
            page_size = page_count = freelist = index_bytes = journal_mode = None
            index_measurement = "unavailable"
        free_bytes = nonnegative(volume.f_bavail * volume.f_frsize)
        total_bytes = nonnegative(volume.f_blocks * volume.f_frsize)
        if total_bytes == 0 or free_bytes > total_bytes:
            raise ValueError("Invalid volume counters")
        sizes = {name: safe_size(path) for name, path in (
            ("main", database), ("wal", Path(str(database) + "-wal")),
            ("shm", Path(str(database) + "-shm"))
        )}
        return {
            "event": EVENT,
            "source": "local_readonly_sqlite" if query_available else "local_readonly_filesystem",
            "observation": "sqlite" if query_available else "file_only",
            "captured_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "main_bytes": sizes["main"],
            "wal_bytes": sizes["wal"],
            "shm_bytes": sizes["shm"],
            "page_bytes": page_size,
            "pages": page_count,
            "free_pages": freelist,
            "index_bytes": index_bytes,
            "index_measurement": index_measurement,
            "fs_available_bytes": free_bytes,
            "fs_total_bytes": total_bytes,
            "journal_mode": journal_mode,
        }

    finally:
        lease.close()


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

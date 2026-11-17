"""Synthetic read-only regression for the private-journal SQLite capacity sampler."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import types
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest import mock

SOURCE = Path(__file__).with_name("contextkeep-capacity-sample.py")
spec = importlib.util.spec_from_file_location("contextkeep_capacity_sample", SOURCE)
assert spec and spec.loader
sampler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sampler)


class CapacitySamplerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "fixture.sqlite"
        conn = sqlite3.connect(self.db)
        conn.execute("CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT)")
        conn.execute("CREATE INDEX fixture_value ON fixture(value)")
        conn.executemany("INSERT INTO fixture (value) VALUES (?)", [(str(n) * 40,) for n in range(300)])
        conn.commit()
        conn.close()
        self.lockfile = Path(self.temp.name) / ".contextkeep-lock.sqlite"
        lock = sqlite3.connect(self.lockfile)
        lock.execute("PRAGMA journal_mode=DELETE")
        lock.execute("CREATE TABLE directory_lease (id INTEGER PRIMARY KEY)")
        lock.commit()
        lock.close()

    def read_only_namespace(self):
        # Simulate systemd ProtectSystem=strict for local synthetic fixtures.
        volume = os.statvfs(self.db.parent)
        return mock.patch.object(sampler.os, "statvfs",
            return_value=types.SimpleNamespace(
                f_flag=volume.f_flag | os.ST_RDONLY,
                f_bavail=volume.f_bavail, f_frsize=volume.f_frsize,
                f_blocks=volume.f_blocks))

    def test_valid_sample_reads_metadata_without_modifying_database_or_private_path_leak(self):
        before = (self.db.stat().st_size, self.db.stat().st_mtime_ns, self.db.read_bytes())
        with self.read_only_namespace():
            observed = sampler.sample(self.db)
        after = (self.db.stat().st_size, self.db.stat().st_mtime_ns, self.db.read_bytes())
        self.assertEqual(before, after)
        self.assertEqual(observed["event"], "contextkeep_sqlite_capacity_v1")
        self.assertEqual(observed["source"], "local_readonly_sqlite")
        self.assertEqual(observed["main_bytes"], before[0])
        self.assertEqual(observed["journal_mode"], "delete")
        self.assertGreater(observed["pages"], 0)
        self.assertGreater(observed["page_bytes"], 0)
        self.assertGreater(observed["fs_available_bytes"], 0)
        self.assertIsInstance(observed["index_bytes"], (int, type(None)))
        text = json.dumps(observed)
        self.assertNotIn(str(self.db), text)
        self.assertNotIn("fixture_value", text)
        self.assertNotIn("value", json.dumps(list(observed)))

    def test_environment_cli_emits_one_fixed_prefix_and_no_paths(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {"CK_CAPACITY_DB": str(self.db)}), self.read_only_namespace(), redirect_stdout(out), redirect_stderr(err):
            status = sampler.main()
        self.assertEqual(status, 0)
        self.assertEqual(err.getvalue(), "")
        lines = out.getvalue().strip().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("CK_CAPACITY_METRIC "))
        self.assertEqual(json.loads(lines[0].split(" ", 1)[1])["main_bytes"], self.db.stat().st_size)
        self.assertNotIn(str(self.db), out.getvalue())

    def test_writable_mount_is_rejected_before_sqlite_can_create_wal_sidecars(self):
        connection = sqlite3.connect(self.db)
        try:
            self.assertEqual(connection.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
            connection.execute("INSERT INTO fixture (value) VALUES ('wal fixture')")
            connection.commit()
        finally:
            connection.close()
        before = {suffix: Path(str(self.db) + suffix).exists() for suffix in ("-wal", "-shm")}
        initial = self.db.stat().st_mtime_ns
        with self.assertRaisesRegex(ValueError, "read-only filesystem"):
            sampler.sample(self.db)
        self.assertEqual(before, {suffix: Path(str(self.db) + suffix).exists() for suffix in ("-wal", "-shm")})
        self.assertEqual(self.db.stat().st_mtime_ns, initial)

    def test_exclusive_restore_lease_blocks_sample_before_reading_database(self):
        locker = sqlite3.connect(self.lockfile, isolation_level=None, timeout=0)
        try:
            locker.execute("BEGIN EXCLUSIVE")
            with self.read_only_namespace(), self.assertRaises(sqlite3.OperationalError):
                sampler.sample(self.db)
        finally:
            locker.rollback()
            locker.close()

    def test_missing_directory_lease_fails_without_creating_another_lock(self):
        self.lockfile.unlink()
        with self.read_only_namespace(), self.assertRaisesRegex(ValueError, "lease unavailable"):
            sampler.sample(self.db)
        self.assertFalse(self.lockfile.exists())

    def test_running_wal_mode_is_observed_with_existing_sidecars(self):
        writer = sqlite3.connect(self.db)
        try:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("INSERT INTO fixture (value) VALUES ('live WAL fixture')")
            writer.commit()
            self.assertTrue(Path(str(self.db) + "-shm").exists())
            with self.read_only_namespace():
                value = sampler.sample(self.db)
            self.assertEqual(value["observation"], "sqlite")
            self.assertEqual(value["journal_mode"], "wal")
            self.assertGreater(value["wal_bytes"], 0)
            self.assertGreater(value["shm_bytes"], 0)
        finally:
            writer.close()

    def test_quiescent_wal_failure_returns_explicit_file_only_partial_sample(self):
        writer = sqlite3.connect(self.db)
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("INSERT INTO fixture (value) VALUES ('closed WAL fixture')")
        writer.commit()
        writer.close()
        before = self.db.read_bytes()
        real_connect = sampler.sqlite3.connect
        def stopped_open(location, *args, **kwargs):
            if "fixture.sqlite?" in str(location):
                raise sqlite3.OperationalError("readonly WAL has no shared memory")
            return real_connect(location, *args, **kwargs)
        with self.read_only_namespace(), mock.patch.object(sampler.sqlite3, "connect", side_effect=stopped_open):
            value = sampler.sample(self.db)
        self.assertEqual(value["source"], "local_readonly_filesystem")
        self.assertEqual(value["observation"], "file_only")
        self.assertIsNone(value["pages"])
        self.assertIsNone(value["page_bytes"])
        self.assertIsNone(value["journal_mode"])
        self.assertIsNone(value["index_bytes"])
        self.assertEqual(value["main_bytes"], len(before))
        self.assertEqual(self.db.read_bytes(), before)

    def test_large_database_skips_unbounded_index_scan_explicitly(self):
        with self.read_only_namespace(), mock.patch.object(sampler, "MAX_DBSTAT_DATABASE_BYTES", 1024):
            value = sampler.sample(self.db)
        self.assertEqual(value["observation"], "sqlite")
        self.assertIsNone(value["index_bytes"])
        self.assertEqual(value["index_measurement"], "skipped_large_database")

    def test_dbstat_unavailable_remains_null_not_zero(self):
        real_connect = sampler.sqlite3.connect
        class ConnectionProxy:
            def __init__(self, delegate): self.delegate = delegate
            def execute(self, sql, *args):
                if "FROM dbstat" in sql:
                    raise sqlite3.OperationalError("dbstat unavailable")
                return self.delegate.execute(sql, *args)
            def close(self): return self.delegate.close()
        def open_proxy(location, *args, **kwargs):
            conn = real_connect(location, *args, **kwargs)
            return ConnectionProxy(conn) if "fixture.sqlite?" in str(location) else conn
        with self.read_only_namespace(), mock.patch.object(sampler.sqlite3, "connect", side_effect=open_proxy):
            value = sampler.sample(self.db)
        self.assertIsNone(value["index_bytes"])
        self.assertEqual(value["index_measurement"], "dbstat_unavailable")

    def test_missing_invalid_or_symlink_never_claims_healthy_sample(self):
        link = Path(self.temp.name) / "link.sqlite"
        link.symlink_to(self.db)
        for candidate in (link, Path(self.temp.name) / "missing.sqlite", Path("relative.sqlite")):
            with self.subTest(candidate=candidate.name):
                with self.assertRaises(ValueError):
                    sampler.sample(candidate)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {"CK_CAPACITY_DB": str(link)}), redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(sampler.main(), 1)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("CK_CAPACITY_ERROR", err.getvalue())
        self.assertNotIn(str(link), err.getvalue())


if __name__ == "__main__":
    unittest.main()

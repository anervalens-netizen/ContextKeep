"""Synthetic read-only regression for the private-journal SQLite capacity sampler."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
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

    def test_valid_sample_reads_metadata_without_modifying_database_or_private_path_leak(self):
        before = (self.db.stat().st_size, self.db.stat().st_mtime_ns, self.db.read_bytes())
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
        with mock.patch.dict(os.environ, {"CK_CAPACITY_DB": str(self.db)}), redirect_stdout(out), redirect_stderr(err):
            status = sampler.main()
        self.assertEqual(status, 0)
        self.assertEqual(err.getvalue(), "")
        lines = out.getvalue().strip().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("CK_CAPACITY_METRIC "))
        self.assertEqual(json.loads(lines[0].split(" ", 1)[1])["main_bytes"], self.db.stat().st_size)
        self.assertNotIn(str(self.db), out.getvalue())

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

"""Safety contracts for the opt-in Codex instruction installer."""
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name("codex-continuity.py")
SPEC = importlib.util.spec_from_file_location("codex_continuity", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class ContinuityInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.profile = Path(self.temp.name)
        self.target = self.profile / "AGENTS.md"
        self.fragment = b"## ContextKeep continuity\nUse the existing task.\n"

    def install(self):
        return module.apply(self.profile, "install", self.fragment)

    def test_install_preserves_owner_text_and_mode_and_backups_are_private(self):
        before = b"# Owner rules\r\nKeep this instruction.\r\n"
        self.target.write_bytes(before)
        self.target.chmod(0o640)
        result = self.install()
        self.assertTrue(self.target.read_bytes().startswith(before))
        self.assertIn(module.START, self.target.read_bytes())
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o640)
        backup = Path(result["backup"])
        self.assertEqual(backup.read_bytes(), before)
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
        self.assertNotIn(b"\n", self.target.read_bytes().replace(b"\r\n", b""))

    def test_idempotent_install_does_not_replace_or_create_another_backup(self):
        self.target.write_text("Owner instructions")
        self.install()
        before = self.target.read_bytes(), self.target.stat().st_ino
        backups = list(self.profile.glob("AGENTS.md.contextkeep-backup-*"))
        result = self.install()
        self.assertEqual(result["status"], "unchanged")
        self.assertEqual((self.target.read_bytes(), self.target.stat().st_ino), before)
        self.assertEqual(list(self.profile.glob("AGENTS.md.contextkeep-backup-*")), backups)
        self.assertEqual(module.apply(self.profile, "check", self.fragment)["status"], "current")

    def test_upgrade_and_remove_preserve_both_unmanaged_sides(self):
        old = module.START + b"\nOld instructions\n" + module.END + b"\n"
        prefix, suffix = b"Owner prefix\n\n", b"\nOwner suffix without newline"
        self.target.write_bytes(prefix + old + suffix)
        self.install()
        expected = module.render(old, self.fragment)
        self.assertEqual(self.target.read_bytes(), prefix + expected + suffix)
        result = module.apply(self.profile, "remove", None)
        self.assertEqual(result["status"], "removed")
        self.assertEqual(self.target.read_bytes(), prefix + suffix)

    def test_corrupt_or_duplicate_markers_fail_without_changing_file(self):
        cases = [
            module.START + b"\nunfinished",
            module.END + b"\n" + module.START + b"\n",
            module.START + b"\n" + module.END + b"\n" + module.START + b"\n" + module.END,
            b"inline " + module.START + b"\n" + module.END + b"\n",
        ]
        for data in cases:
            with self.subTest(data=data):
                self.target.write_bytes(data)
                with self.assertRaises(module.InstallError):
                    self.install()
                self.assertEqual(self.target.read_bytes(), data)
        self.assertEqual(list(self.profile.glob("AGENTS.md.contextkeep-backup-*")), [])

    def test_symlink_and_hardlink_targets_are_not_followed_or_replaced(self):
        other = self.profile / "owner.md"
        other.write_text("Owner private instructions")
        self.target.symlink_to(other)
        with self.assertRaises(module.InstallError):
            self.install()
        self.assertTrue(self.target.is_symlink())
        self.target.unlink()
        os.link(other, self.target)
        with self.assertRaises(module.InstallError):
            self.install()
        self.assertEqual(other.read_text(), "Owner private instructions")
        self.assertEqual(self.target.stat().st_ino, other.stat().st_ino)

    def test_shadowing_override_is_explicit_and_unchanged(self):
        self.target.write_text("Owner instructions")
        override = self.profile / "AGENTS.override.md"
        override.write_text("Effective override")
        for action in ("check", "install"):
            with self.subTest(action=action), self.assertRaisesRegex(module.InstallError, "shadows"):
                module.apply(self.profile, action, self.fragment)
        self.assertEqual(self.target.read_text(), "Owner instructions")
        self.assertEqual(override.read_text(), "Effective override")

    def test_concurrent_owner_edit_is_preserved_and_temp_file_removed(self):
        self.target.write_text("Original")
        real_read = module.read_file
        reads = 0

        def changing_read(path):
            nonlocal reads
            if path == self.target:
                reads += 1
                if reads == 2:
                    self.target.write_text("Concurrent owner edit")
            return real_read(path)

        with mock.patch.object(module, "read_file", side_effect=changing_read):
            with self.assertRaisesRegex(module.InstallError, "changed during preparation"):
                self.install()
        self.assertEqual(self.target.read_text(), "Concurrent owner edit")
        self.assertEqual(list(self.profile.glob(".contextkeep-agents-*")), [])

    def test_cli_reports_retained_backup_when_concurrent_edit_aborts_install(self):
        self.target.write_text("Original owner instructions")
        real_read = module.read_file
        reads = 0

        def changing_read(path):
            nonlocal reads
            if path == self.target:
                reads += 1
                if reads == 2:
                    self.target.write_text("Concurrent owner edit")
            return real_read(path)

        error = io.StringIO()
        with mock.patch.object(module, "read_file", side_effect=changing_read), \
                mock.patch.object(module.sys, "stderr", error):
            code = module.main(["install", "--codex-home", str(self.profile)])
        self.assertEqual(code, 2)
        result = json.loads(error.getvalue())
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"], "AGENTS.md changed during preparation; no replacement made")
        backup = Path(result["backup"])
        self.assertEqual(list(self.profile.glob("AGENTS.md.contextkeep-backup-*")), [backup])
        self.assertEqual(backup.read_text(), "Original owner instructions")
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
        self.assertEqual(self.target.read_text(), "Concurrent owner edit")
        self.assertEqual(list(self.profile.glob(".contextkeep-agents-*")), [])
        with module.profile_lock(self.profile):
            pass  # Failure released the lock; a later owner action can acquire it.

    def test_replace_failure_preserves_original_and_recovery_backup(self):
        self.target.write_text("Original")
        with mock.patch.object(module.os, "replace", side_effect=OSError("injected failure")):
            with self.assertRaises(OSError):
                self.install()
        self.assertEqual(self.target.read_text(), "Original")
        backups = list(self.profile.glob("AGENTS.md.contextkeep-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), "Original")
        self.assertEqual(list(self.profile.glob(".contextkeep-agents-*")), [])

    def test_missing_profile_and_missing_fragment_do_not_create_target(self):
        with self.assertRaises(module.InstallError):
            module.apply(self.profile / "absent", "install", self.fragment)
        with self.assertRaises(module.InstallError):
            module.apply(self.profile, "install", None)
        self.assertFalse(self.target.exists())

    def test_check_is_read_only_and_cli_round_trip_uses_shipped_fragment(self):
        def run(action):
            return subprocess.run(
                [sys.executable, str(SCRIPT), action, "--codex-home", str(self.profile)],
                capture_output=True, text=True, check=False,
            )
        checked = run("check")
        self.assertEqual(checked.returncode, 1)
        self.assertEqual(list(self.profile.iterdir()), [])
        installed = run("install")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.assertEqual(json.loads(installed.stdout)["status"], "installed")
        checked = run("check")
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(json.loads(checked.stdout)["status"], "current")
        removed = run("remove")
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(self.target.read_bytes(), b"")


if __name__ == "__main__":
    unittest.main()

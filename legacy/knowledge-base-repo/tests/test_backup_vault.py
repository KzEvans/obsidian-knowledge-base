import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "scripts/backup_vault.py"
spec = importlib.util.spec_from_file_location("backup_vault_test", MODULE)
B = importlib.util.module_from_spec(spec)
spec.loader.exec_module(B)


class BackupTests(unittest.TestCase):
    def test_unchanged_snapshot_retries_failed_push_and_verifies_restore(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            source, repo, remote = base / "source", base / "backup", base / "remote.git"
            for folder in (source / "sources", source / "wiki", repo):
                folder.mkdir(parents=True)
            (source / "AGENTS.md").write_text("Test fixture")
            (source / "wiki/note.md").write_text("Human knowledge")
            (repo / ".backup-excludes").write_text(".git/\n*.key\n")
            subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True)
            B.git(repo, "config", "user.name", "Fixture")
            B.git(repo, "config", "user.email", "fixture@example.invalid")
            B.git(repo, "remote", "add", "origin", str(base / "missing.git"))
            with self.assertRaises(subprocess.CalledProcessError):
                B.backup(source, repo)
            first_head = B.git(repo, "rev-parse", "HEAD")
            subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
            B.git(repo, "remote", "set-url", "origin", str(remote))
            B.backup(source, repo)
            self.assertEqual(B.git(repo, "rev-parse", "HEAD"), first_head)
            self.assertEqual(B.git(repo, "ls-remote", "origin", "refs/heads/main").split()[0], first_head)
            restore = base / "restore"
            subprocess.run(["git", "clone", "--branch", "main", str(remote), str(restore)], check=True, capture_output=True)
            B.verify(restore)
            (restore / "vault/wiki/note.md").write_text("Corrupted")
            with self.assertRaisesRegex(RuntimeError, "integrity"):
                B.verify(restore)

    def test_placeholder_blocks_before_mutating_snapshot(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            source, repo = base / "source", base / "backup"
            for directory in (source / "sources", source / "wiki", repo):
                directory.mkdir(parents=True)
            (source / "AGENTS.md").write_text("Fixture")
            (source / ".paper.pdf.icloud").touch()
            (repo / ".backup-excludes").write_text("*.icloud\n")
            subprocess.run(["git", "init", str(repo)], check=True, capture_output=True)
            with self.assertRaisesRegex(RuntimeError, "placeholders"):
                B.backup(source, repo)
            self.assertFalse((repo / "vault").exists())


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Snapshot an Obsidian vault and verify that the backup HEAD reached its remote."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


def git(repository: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repository), *args], text=True).strip()


def inventory(root: Path) -> dict[str, str]:
    result = {}
    for file in sorted(root.rglob("*")):
        if file.is_symlink():
            raise RuntimeError(f"Snapshot contains a symlink; resolve it before backup: {file}")
        if not file.is_file():
            continue
        if file.stat().st_size > 95 * 1024 * 1024:
            raise RuntimeError(f"File exceeds 95 MiB; configure Git LFS first: {file}")
        digest = hashlib.sha256()
        with file.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        result[file.relative_to(root).as_posix()] = digest.hexdigest()
    return result


def verify(repository: Path) -> None:
    expected = json.loads((repository / "snapshot-manifest.json").read_text())
    actual = inventory(repository / "vault")
    if actual != expected:
        raise RuntimeError("Snapshot integrity check failed: missing, changed or unexpected files")


def backup(source: Path, repository: Path) -> None:
    source, repository = source.resolve(), repository.resolve()
    if source in {Path("/"), Path.home()} or source == repository or source in repository.parents or repository in source.parents:
        raise RuntimeError("Source and backup must be distinct, non-nested directories")
    if not all((source / name).exists() for name in ("AGENTS.md", "sources", "wiki")):
        raise RuntimeError("Source does not match the knowledge vault layout; snapshot left unchanged")
    if Path(git(repository, "rev-parse", "--show-toplevel")).resolve() != repository:
        raise RuntimeError("Backup destination must be the exact Git repository root")
    excludes = repository / ".backup-excludes"
    if not excludes.is_file():
        raise RuntimeError("Missing .backup-excludes; refusing to risk committing private runtime data")
    lock_path = Path(git(repository, "rev-parse", "--absolute-git-dir")) / "vault-backup.lock"
    with lock_path.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        placeholders = list(source.rglob("*.icloud"))
        if placeholders:
            raise RuntimeError(f"iCloud placeholders remain; download the vault first: {placeholders[0]}")
        # Never mirror deletions into the last snapshot until a complete candidate
        # has been copied and every included file has been read successfully.
        with tempfile.TemporaryDirectory(prefix="vault-backup-", dir=repository.parent) as directory:
            candidate = Path(directory)
            subprocess.run(["/usr/bin/rsync", "-a", f"--exclude-from={excludes}", f"{source}/", f"{candidate}/"], check=True)
            files = inventory(candidate)
            previous = json.loads((repository / "snapshot-manifest.json").read_text()) if (repository / "snapshot-manifest.json").exists() else inventory(repository / "vault")
            removed = set(previous) - set(files)
            if len(removed) > max(5, len(previous) * .3):
                raise RuntimeError(f"Unexpected mass deletion ({len(removed)} files); previous snapshot retained for inspection")
            snapshot = repository / "vault"
            snapshot.mkdir(exist_ok=True)
            subprocess.run(["/usr/bin/rsync", "-a", "--delete", f"{candidate}/", f"{snapshot}/"], check=True)
            (repository / "snapshot-manifest.json").write_text(json.dumps(files, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
        verify(repository)
        git(repository, "add", "--all")
        if git(repository, "diff", "--cached", "--name-only"):
            subprocess.run(["git", "-C", str(repository), "commit", "-m", "Backup verified vault snapshot"], check=True)
        # Always push, including after an earlier commit succeeded but push failed.
        branch = git(repository, "symbolic-ref", "--short", "HEAD")
        subprocess.run(["git", "-C", str(repository), "push", "origin", f"HEAD:refs/heads/{branch}"], check=True)
        head = git(repository, "rev-parse", "HEAD")
        remote = git(repository, "ls-remote", "origin", f"refs/heads/{branch}").split()
        if not remote or remote[0] != head:
            raise RuntimeError("Remote HEAD does not match the verified local snapshot")
        print(f"Backup verified locally and remotely: {head}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True, type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    if args.verify_only:
        verify(args.repository)
        print("Snapshot integrity verified; restore into a new empty vault, then run scan to rebuild queue state.")
    elif args.source:
        backup(args.source, args.repository)
    else:
        parser.error("--source is required unless --verify-only is used")


if __name__ == "__main__":
    main()

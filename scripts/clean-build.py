#!/usr/bin/env python3
"""Prune unused builds; optionally archive old evidence without touching live apps."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
from zoneinfo import ZoneInfo

parser = argparse.ArgumentParser()
parser.add_argument('--dry-run', action='store_true')
parser.add_argument('--archive-evidence', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
build = root/'build'
if not build.is_dir():
    raise SystemExit(0)

# Mapped executable paths follow renamed .app directories; process argv does not.
opened = subprocess.run(['/usr/sbin/lsof', '-n', '-Fn', '+D', str(build)], capture_output=True, text=True)
if opened.returncode not in (0, 1) or (not opened.stdout and opened.stderr.strip()):
    print(json.dumps({'cleanup': 'skipped', 'reason': 'Could not verify open build files'}))
    raise SystemExit(0)
open_paths = [Path(line[1:].removesuffix(' (deleted)')) for line in opened.stdout.splitlines() if line.startswith('n/')]

def in_use(path):
    return any(value == path or value.is_relative_to(path) for value in open_paths)

backups = sorted(build.glob('RemoteCodex-previous-*.app'), key=lambda p: p.name, reverse=True)
keep = {build/'RemoteCodex.app'} | set(backups[:1])
delete_apps = [p for p in backups if p not in keep and not in_use(p)]
archive_items = []
if args.archive_evidence:
    evidence = build/'evidence'
    if evidence.is_dir():
        archive_items += [p for p in evidence.iterdir() if not p.name.startswith(('inbox-', 'build-cleanup')) and not in_use(p)]
    archive_items += [p for p in build.iterdir() if p.name != 'evidence' and not p.name.endswith('.app') and not in_use(p)]
    archive_items += [p for p in build.glob('*.app') if not p.name.startswith('RemoteCodex') and not in_use(p)]

report = {'dryRun': args.dry_run, 'deleteUnusedApps': [p.name for p in delete_apps],
          'retainedApps': [p.name for p in build.glob('*.app') if p not in delete_apps and p not in archive_items],
          'archiveItems': [str(p.relative_to(build)) for p in archive_items]}
if args.dry_run:
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0)

def remove(path):
    assert path.parent == build or path.parent == build/'evidence'
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)

if archive_items:
    destination = root/'artifacts'
    destination.mkdir(mode=0o700, exist_ok=True)
    name = 'build-evidence-' + datetime.now(ZoneInfo('Asia/Manila')).strftime('%Y%m%d-%H%M%S') + '.tar.gz'
    archive = destination/name
    with tarfile.open(archive, 'x:gz') as out:
        for path in archive_items:
            out.add(path, arcname=str(path.relative_to(build)), recursive=True)
    archive.chmod(0o600)
    with tarfile.open(archive, 'r:gz') as saved:
        names = set(saved.getnames())
        assert all(str(p.relative_to(build)) in names for p in archive_items), 'Archive verification failed'
    for path in archive_items:
        if not in_use(path):
            remove(path)
    report['archive'] = str(archive.relative_to(root))
for path in delete_apps:
    if not in_use(path):
        remove(path)
report['deletedAppCount'] = len(delete_apps)
report['archivedItemCount'] = len(archive_items)
if args.archive_evidence:
    (build/'evidence').mkdir(exist_ok=True)
    (build/'evidence/build-cleanup.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps({k: v for k, v in report.items() if k not in ('archiveItems', 'deleteUnusedApps')}, ensure_ascii=False))

"""Collect exact Alpine origin sources via installed APK commit metadata.

Run only in guest-sources.Dockerfile on an isolated runner. APKBUILD is executable
packaging code; this intentionally never runs on the user's host. Each source
package is fetched and checksum-verified by abuild before packaging.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import io


def installed_records(text):
    result = []
    for block in text.strip().split('\n\n'):
        fields = {}
        for line in block.splitlines():
            if len(line) > 2 and line[1] == ':' and line[0] not in fields:
                fields[line[0]] = line[2:]
        if not fields.get('P'):
            continue
        record = {key: fields.get(field) for key, field in
                  [('name', 'P'), ('version', 'V'), ('origin', 'o'), ('commit', 'c'),
                   ('license', 'L'), ('architecture', 'A'), ('apkChecksum', 'C')]}
        if not all(record[k] for k in ('version', 'origin', 'commit', 'license')):
            raise ValueError(f'Incomplete installed metadata for {record["name"]}')
        if not re.fullmatch(r'[a-zA-Z0-9+_.-]+', record['origin']):
            raise ValueError('Invalid package origin')
        if not re.fullmatch(r'[0-9a-f]{40}', record['commit']):
            raise ValueError(f'Unpinned aports commit: {record["name"]}')
        result.append(record)
    if not result:
        raise ValueError('No installed packages')
    return result


def run(*args, cwd=None, env=None):
    return subprocess.check_output(args, cwd=cwd, env=env, text=True).strip()


def collect(installed, versions, output):
    packages = installed_records(installed.read_text())
    expected = set(versions.read_text().splitlines())
    actual = {f'{p["name"]}-{p["version"]}' for p in packages}
    if expected != actual:
        raise ValueError(f'Installed metadata does not match guest package list: {expected ^ actual}')
    output.mkdir(parents=True)
    shutil.copy2(installed, output / 'apk-installed.txt')
    shutil.copy2(versions, output / 'package-versions.txt')
    repository = Path('/aports')
    run('git', 'init', str(repository))
    # Official Alpine GitHub mirror; exact commits, never the current branch tip.
    run('git', '-C', str(repository), 'remote', 'add', 'origin', 'https://github.com/alpinelinux/aports.git')
    groups = {}
    for package in packages:
        groups.setdefault((package['origin'], package['version'], package['commit']), []).append(package['name'])
    fetched = set()
    origins = []
    for (origin, version, commit), names in sorted(groups.items()):
        if commit not in fetched:
            run('git', '-C', str(repository), 'fetch', '--depth=1', '--filter=blob:none', 'origin', commit)
            fetched.add(commit)
        candidates = [f'{repo}/{origin}' for repo in ('main', 'community', 'testing')]
        paths = run('git', '-C', str(repository), 'ls-tree', '--name-only', commit, *candidates).splitlines()
        if len(paths) != 1:
            raise RuntimeError(f'Expected one source directory for {origin} at {commit}: {paths}')
        package_path = paths[0]
        directory = output / 'origins' / f'{origin}-{version}-{commit[:12]}'
        directory.mkdir(parents=True)
        recipe = subprocess.check_output(['git', '-C', str(repository), 'archive', '--format=tar', commit, package_path])
        (directory / 'aports-recipe.tar').write_bytes(recipe)
        with tarfile.open(fileobj=io.BytesIO(recipe)) as archive:
            archive.extractall(directory / 'recipe', filter='data')
        working = directory / 'recipe' / package_path
        env = dict(os.environ, REPODEST=str(directory), SRCDEST='/source-cache', CARCH='x86_64',
                   DISTFILES_MIRROR='https://distfiles.alpinelinux.org/distfiles/v3.21')
        # verify is explicit: srcpkg itself calls fetch but does not verify.
        # Alpine 3.21's sumcheck changes cwd to srcdir; a separate invocation
        # restores startdir before srcpkg packages local install/trigger files.
        run('abuild', '-F', 'fetch', 'verify', cwd=working, env=env)
        run('abuild', '-F', 'srcpkg', cwd=working, env=env)
        # abuild srcpkg uses "$pkgname-$pkgver-$pkgrel", while APK versions
        # include the literal -r before pkgrel.
        source_version = re.sub(r'-r([0-9]+)$', r'-\1', version)
        source_archive = directory / 'src' / f'{origin}-{source_version}.src.tar.gz'
        if not source_archive.is_file():
            raise RuntimeError(f'APKBUILD version does not match installed metadata: {source_archive}')
        if source_archive.stat().st_size >= 1_900_000_000:
            raise RuntimeError(f'Source archive exceeds release asset size limit: {source_archive}')
        origins.append({'origin': origin, 'version': version, 'aportsCommit': commit,
                        'aportsPath': package_path, 'packages': names,
                        'archive': str(source_archive.relative_to(output)),
                        'sha256': hashlib.file_digest(source_archive.open('rb'), 'sha256').hexdigest()})
        # Keep the original recipe tar and verified srcpkg, not duplicate copies
        # of upstream archives or temporary symlinks into the download cache.
        shutil.rmtree(directory / 'recipe')
    result = {'schema': 1, 'packages': packages, 'origins': origins,
              'collectorAbuildVersion': run('abuild', '-V'), 'reviewRequired': True,
              'note': 'Fetched upstream source and patches at installed package commits; not a claim of independently reproduced Alpine binary bytes.'}
    (output / 'source-manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    checksums = []
    for filename in sorted(output.rglob('*')):
        if filename.is_file():
            checksums.append(f'{hashlib.file_digest(filename.open("rb"), "sha256").hexdigest()}  {filename.relative_to(output)}\n')
    (output / 'SHA256SUMS').write_text(''.join(checksums))


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: collect-guest-sources.py APK_INSTALLED PACKAGE_VERSIONS OUTPUT')
    collect(*(Path(value).resolve() for value in sys.argv[1:]))

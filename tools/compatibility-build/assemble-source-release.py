"""Verify and package sources for an exact compatibility runtime/guest release.

Read-only inputs; creates a new output directory. Does not publish, execute
package recipes, alter host configuration, or include an optional Java pack.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

ASSET_LIMIT = 1_900_000_000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(filename):
    with filename.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe_path(root, relative):
    item = PurePosixPath(relative)
    require(not item.is_absolute() and '..' not in item.parts and '\\' not in relative
            and ':' not in relative, f'Unsafe archive path: {relative}')
    path = root.joinpath(*item.parts)
    require(path.resolve().is_relative_to(root.resolve()), f'Path escaped input: {relative}')
    require(path.is_file() and not path.is_symlink(), f'Missing/linked input: {relative}')
    return path


def verify_checksums(root, filename='SHA256SUMS'):
    records = {}
    for line in (root / filename).read_text().splitlines():
        digest, relative = line.split('  ', 1)
        require(re.fullmatch('[0-9a-f]{64}', digest), f'Invalid digest: {relative}')
        require(relative not in records, f'Duplicate checksum: {relative}')
        path = safe_path(root, relative)
        require(sha256(path) == digest, f'Checksum mismatch: {path}')
        records[relative] = digest
    require(records, f'Empty checksums in {root}')
    return records


def json_file(path):
    return json.loads(path.read_text())


def build_provenance(root):
    provenance = json_file(root / 'provenance.json')
    require(provenance.get('predicateType') == 'https://slsa.dev/provenance/v1',
            f'Unexpected build provenance: {root}')
    subjects = {}
    for item in provenance['subject']:
        name, digest = item['name'], item['digest']['sha256']
        require(name not in subjects, f'Duplicate build subject: {name}')
        require(sha256(safe_path(root, name)) == digest, f'Build subject differs: {name}')
        subjects[name] = digest
    revisions = set()

    def find_revision(item):
        if isinstance(item, dict):
            if 'vcs:revision' in item:
                revisions.add(item['vcs:revision'])
            for child in item.values():
                find_revision(child)
        elif isinstance(item, list):
            for child in item:
                find_revision(child)

    find_revision(provenance)
    require(len(revisions) == 1, f'Expected one build source revision: {revisions}')
    revision = revisions.pop()
    require(re.fullmatch('[0-9a-f]{40}', revision), 'Build revision is not pinned')
    return {'projectCommit': revision, 'subjects': subjects,
            'attestationSha256': sha256(root / 'provenance.json'),
            'note': 'Hash-checked local BuildKit attestation; no signature identity assertion.'}


def tar_member(archive, suffix):
    with tarfile.open(archive, 'r:gz') as source:
        members = [item for item in source.getmembers() if item.name.endswith(suffix)]
        require(len(members) == 1 and members[0].isfile(), f'Expected one source member: {suffix}')
        return source.extractfile(members[0]).read()


def verify_runtime(runtime, sources):
    checksums = verify_checksums(sources)
    manifest = json_file(sources / 'source-manifest.json')
    wasm = sha256(runtime / 'runtime/qemu-system-x86_64.wasm')
    require(manifest.get('runtimeArtifactVerified') is True and manifest['runtimeSha256'] == wasm,
            'Runtime source collection does not match selected Wasm')
    lock = json_file(runtime / 'provenance/source-lock.json')
    require(manifest['qemuCommit'] == lock['qemuCommit'], 'QEMU source commit mismatch')
    firmware = json_file(runtime / 'provenance/firmware/source-manifest.json')
    require(firmware['qemuCommit'] == lock['qemuCommit'], 'Firmware/QEMU commit mismatch')
    archive_records = {record['archive']: record for record in manifest['archives']}
    for name, record in firmware['firmware'].items():
        require(sha256(safe_path(runtime, 'pack/' + name)) == record['sha256'],
                f'Firmware mismatch: {name}')
    for component in firmware['components']:
        collected = archive_records[component['id'] + '.tar.gz']
        require(collected['commit'] == component['commit'], 'Firmware source commit mismatch')
    for record in manifest['archives']:
        require(checksums.get(record['archive']) == record['sha256'], 'Source manifest checksum mismatch')
    patch = json_file(runtime / 'provenance/9p-errno-patch.json')
    qemu_archive = sources / 'qemu-build-and-sources.tar.gz'
    for suffix, key in [('/hw/9pfs/9p-util.h', 'outputSha256'),
                        ('/hw/9pfs/9p-errno-emscripten.h', 'helperSha256')]:
        require(hashlib.sha256(tar_member(qemu_archive, suffix)).hexdigest() == patch[key],
                f'Patched source mismatch: {suffix}')
    return manifest


def verify_guest(guest, sources):
    verify_checksums(guest)
    checksums = verify_checksums(sources)
    for name in ('apk-installed.txt', 'package-versions.txt'):
        require((guest / name).read_bytes() == (sources / name).read_bytes(),
                f'Final guest package inventory differs: {name}; recollect its sources')
    manifest = json_file(sources / 'source-manifest.json')
    packages = {item['name']: item for item in manifest['packages']}
    require(len(packages) == len(manifest['packages']), 'Duplicate installed package')
    installed = {}
    for block in (guest / 'apk-installed.txt').read_text().strip().split('\n\n'):
        fields = {}
        for line in block.splitlines():
            if len(line) > 2 and line[1] == ':' and line[0] not in fields:
                fields[line[0]] = line[2:]
        if fields.get('P'):
            installed[fields['P']] = fields
    require(set(installed) == set(packages), 'Source manifest package names differ from APK database')
    for name, package in packages.items():
        for key, field in [('version', 'V'), ('origin', 'o'), ('commit', 'c'), ('license', 'L')]:
            require(package[key] == installed[name].get(field), f'APK metadata mismatch: {name}/{key}')
    original_guest = dict(line.split('  ', 1)[::-1] for line in
                          (sources / 'guest-artifact-SHA256SUMS').read_text().splitlines())
    require(sha256(guest / 'apk-repositories.txt') == original_guest.get('apk-repositories.txt'),
            'Guest package repository inventory changed')
    versions = {f'{item["name"]}-{item["version"]}' for item in packages.values()}
    require(versions == set((guest / 'package-versions.txt').read_text().splitlines()),
            'Source package manifest differs from installed package list')
    covered = set()
    for origin in manifest['origins']:
        require(checksums.get(origin['archive']) == origin['sha256'], 'Guest source manifest mismatch')
        for name in origin['packages']:
            require(name in packages and name not in covered, f'Invalid package coverage: {name}')
            package = packages[name]
            require((package['origin'], package['version'], package['commit']) ==
                    (origin['origin'], origin['version'], origin['aportsCommit']),
                    f'Wrong source origin/version/commit: {name}')
            covered.add(name)
    require(covered == set(packages), 'Guest package source closure incomplete')
    return manifest


def pack_directory(source, destination):
    # Inputs already contain compressed upstream sources. Plain tar avoids
    # expensive recompression and preserves every source/archive byte.
    files = sorted(item for item in source.rglob('*') if item.is_file())
    require(sum(item.stat().st_size for item in files) < ASSET_LIMIT, 'Source bundle too large')
    with tarfile.open(destination, 'w', format=tarfile.PAX_FORMAT) as archive:
        for item in files:
            require(not item.is_symlink(), f'Refusing linked source file: {item}')
            info = archive.gettarinfo(str(item), arcname=item.relative_to(source).as_posix())
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ''
            info.mode = 0o644
            with item.open('rb') as stream:
                archive.addfile(info, stream)
    require(destination.stat().st_size < ASSET_LIMIT, 'Packaged source bundle too large')


def git(project, *args):
    return subprocess.check_output(['git', '-c', f'safe.directory={project.as_posix()}',
                                    '-C', str(project), *args])


def assemble(args):
    runtime, guest = args.runtime.resolve(), args.guest.resolve()
    runtime_sources, guest_sources = args.runtime_sources.resolve(), args.guest_sources.resolve()
    project, output = args.project.resolve(), args.output.resolve()
    require(not output.exists(), 'Output must be a new directory; existing release was preserved')
    runtime_provenance, guest_provenance = build_provenance(runtime), build_provenance(guest)
    runtime_manifest = verify_runtime(runtime, runtime_sources)
    guest_manifest = verify_guest(guest, guest_sources)
    commit = git(project, 'rev-parse', args.project_ref + '^{commit}').decode().strip()
    # Git archive uses exact committed sources, never incidental browser profiles
    # or unrelated working files. Explicit project-ref selects the intended UI.
    revisions = {'runtime-build': runtime_provenance['projectCommit'],
                 'guest-build': guest_provenance['projectCommit'], 'project': commit}
    for revision in revisions.values():
        git(project, 'cat-file', '-e', revision + '^{commit}')
    output.mkdir(parents=True)
    pack_directory(runtime_sources, output / 'browser-linux-runtime-sources.tar')
    pack_directory(guest_sources, output / 'browser-linux-guest-sources.tar')
    for name, revision in revisions.items():
        with (output / f'browser-linux-{name}-source.tar.gz').open('wb') as stream:
            subprocess.run(['git', '-c', f'safe.directory={project.as_posix()}', '-C', str(project),
                            'archive', '--format=tar.gz', revision], stdout=stream, check=True)
    require(all(item.stat().st_size < ASSET_LIMIT for item in output.iterdir()),
            'Release source asset exceeds bounded size')
    manifest = {
        'schema': 1, 'scope': 'Browser Linux x86-64 runtime and Alpine/Weston guest; optional Java excluded',
        'projectCommit': commit, 'runtime': runtime_provenance, 'guest': guest_provenance,
        'qemuCommit': runtime_manifest['qemuCommit'],
        'runtimeWasmSha256': runtime_manifest['runtimeSha256'],
        'guestPackageCount': len(guest_manifest['packages']),
        'guestSourceOriginCount': len(guest_manifest['origins']),
        'sourceCollectionVerified': True, 'published': False,
        'verificationLimits': [
            'Source collection and binary/source identity checked; no independent clean rebuild of all Alpine package binaries.',
            'Firmware source pins/notices and ROM hashes checked; bundled ROM bytes were not independently reproduced.',
            'Archive notices retained; component licensing/release review is separate from hash verification.',
            'UI source is the selected project commit; separately built UI assets require their own final build checksums.',
        ],
        'sourceAssets': [{'name': item.name, 'bytes': item.stat().st_size, 'sha256': sha256(item)}
                         for item in sorted(output.iterdir())],
    }
    (output / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (output / 'SOURCE-README.md').write_text(
        '# Browser Linux corresponding source package\n\n'
        'This staged release contains the sources, patches, configuration, recipes and notices '
        'for the runtime and Alpine package inventories identified in release-manifest.json. '
        'The optional Java runtime is not part of this release.\n\n'
        'Verify SHA256SUMS before extracting. Each source tar contains its own source-manifest.json '
        'and checksum list. Runtime sources include actual patched QEMU and linked dependency trees; '
        'guest sources contain checksum-verified upstream archives and the original Alpine recipes. '
        'The separate project/build source archives provide exact application and image scripts.\n\n'
        'Follow tools/compatibility-build/SOURCE-RELEASE.md and the build workflows in the project '
        'archive. Builds run in disposable Linux containers, without altering the target browser device. '
        'Keep all component notices. Firmware build correspondence and independent package reproduction '
        'limits are recorded in release-manifest.json.\n\n'
        'Publish these source assets alongside permanent binary download links and link this manifest '
        'from the download page. Expiring CI artifacts alone are not the intended public source location.\n')
    (output / 'SHA256SUMS').write_text(''.join(
        f'{sha256(item)}  {item.name}\n' for item in sorted(output.iterdir()) if item.is_file()))
    print(json.dumps({'output': str(output), 'assets': len(manifest['sourceAssets']),
                      'runtimeWasmSha256': manifest['runtimeWasmSha256'],
                      'guestPackages': manifest['guestPackageCount'], 'published': False}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('runtime', 'guest', 'runtime-sources', 'guest-sources', 'output'):
        parser.add_argument('--' + flag, type=Path, required=True)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--project-ref', default='HEAD')
    assemble(parser.parse_args())

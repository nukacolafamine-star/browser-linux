"""Collect the actual runtime build inputs. Run inside the isolated build stage.

Archives retain generated build configuration alongside source and patches. The
whole application can be rebuilt; binary caches and objects are inventoried but
not bundled as if they were source. This does not publish anything.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile

OUT = Path('/source-output')
OUT.mkdir()
records = []


def sha256(filename):
    digest = hashlib.sha256()
    with Path(filename).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def archive(name, source, exclude=(), skip_binaries=False):
    source = Path(source)
    if not source.exists():
        raise RuntimeError(f'Missing source input: {source}')
    destination = OUT / f'{name}.tar.gz'
    def included(entry):
        relative = Path(entry.name).parts[1:]
        if '.git' in relative or any(relative[:len(prefix)] == prefix for prefix in exclude):
            return None
        if skip_binaries and (entry.name.endswith(('.o', '.a', '.wasm', '.pyc'))
                              or '.so' in Path(entry.name).name
                              or Path(entry.name).name == 'qemu-system-x86_64'):
            return None
        return entry
    with tarfile.open(destination, 'w:gz', dereference=False, compresslevel=3) as output:
        output.add(source, arcname=name, filter=included)
    digest = sha256(destination)
    records.append({'name': name, 'archive': destination.name, 'bytes': destination.stat().st_size,
                    'sha256': digest, 'inputPath': str(source)})
    if destination.stat().st_size >= 1_900_000_000:
        raise RuntimeError(f'Source archive exceeds conservative release asset size: {destination}')


def checkout(name, repository, commit):
    if len(commit) != 40 or any(c not in '0123456789abcdef' for c in commit):
        raise RuntimeError(f'Unpinned commit for {name}')
    directory = Path('/source-checkouts') / name
    directory.mkdir(parents=True)
    run('git', 'init', str(directory))
    run('git', '-C', str(directory), 'remote', 'add', 'origin', repository)
    run('git', '-C', str(directory), 'fetch', '--depth=1', 'origin', commit)
    run('git', '-C', str(directory), 'checkout', '--detach', 'FETCH_HEAD')
    assert run('git', '-C', str(directory), 'rev-parse', 'HEAD') == commit
    # Git archives omit nested submodules; collect their pinned trees too.
    run('git', '-C', str(directory), 'submodule', 'update', '--init', '--recursive', '--depth=1')
    submodules = run('git', '-C', str(directory), 'submodule', 'status', '--recursive')
    archive(name, directory)
    records[-1].update(repository=repository, commit=commit, submoduleStatus=submodules)


qemu_commit = run('git', '-C', '/qemu', 'rev-parse', 'HEAD')
firmware = json.loads(Path('/out/provenance/firmware/source-manifest.json').read_text())
assert qemu_commit == firmware['qemuCommit']

# Meson may fetch QEMU subprojects or initialize source submodules at configure
# time. Retain the actual tree, config-host files, meson logs and npm lock.
archive('qemu-build-and-sources', '/qemu', skip_binaries=True)
for dependency in ('zlib', 'libffi', 'glib', 'pixman', 'resolver-stub', 'build-config'):
    archive(dependency, Path('/source-trees') / dependency, skip_binaries=True)
archive('generated-library-headers-config', '/glib-emscripten', skip_binaries=True)
libraries = []
library_sources = {
    'libz.a': 'zlib', 'libffi.a': 'libffi', 'libpixman-1.a': 'pixman',
    'libresolv.a': 'resolver-stub', 'libglib-2.0.a': 'glib',
    'libgmodule-2.0.a': 'glib', 'libgobject-2.0.a': 'glib',
    'libgthread-2.0.a': 'glib', 'libgio-2.0.a': 'glib',
    'libpcre2-8.a': 'glib', 'libpcre2-posix.a': 'glib',
}
for library in sorted(Path('/glib-emscripten').rglob('*.a')):
    if library.name not in library_sources:
        raise RuntimeError(f'Unaccounted static library: {library}')
    libraries.append({'path': str(library), 'sha256': sha256(library), 'sourceArchive': library_sources[library.name]})
for required in ('pcre2*', 'gvdb*'):
    if not any(p.is_dir() for p in Path('/source-trees/glib/subprojects').glob(required)):
        raise RuntimeError(f'Missing actual GLib fallback source: {required}')

# Includes musl/compiler-rt/libc++/emmalloc/JS runtime sources and their notices.
# Compiler caches are deliberately excluded; their source is retained instead.
archive('emscripten', '/emsdk/upstream/emscripten', exclude=(('cache',), ('node_modules',)))
ports = run('em-config', 'PORTS')
archive('emscripten-ports', ports, skip_binaries=True)
archive('build-recipe', '/source-recipe', exclude=(('generated', 'source-input'),))
archive('runtime-provenance', '/out/provenance')

for component in firmware['components']:
    checkout(component['id'], component['repository'], component['commit'])
checkout('xterm-pty-source', 'https://github.com/mame/xterm-pty.git',
         'cfcbc7e2145d03a0afef45939e3971becb2b4443')
package = json.loads(Path('/qemu/build/node_modules/xterm-pty/package.json').read_text())
assert package['version'] == '0.10.1'

manifest = {
    'schema': 1, 'qemuCommit': qemu_commit,
    'runtimeSha256': sha256('/out/runtime/qemu-system-x86_64.wasm'),
    'emscriptenVersion': run('emcc', '--version'),
    'qemuSubmodules': run('git', '-C', '/qemu', 'submodule', 'status', '--recursive'),
    'staticLibraryInventory': libraries,
    'archives': records,
    'reviewRequired': True,
    'remainingChecks': [
        'Confirm every linked library in the final linker command is covered by these archives.',
        'Inspect licenses/notices and ensure the deployed browser UI/vendor dependencies are also covered.',
        'Confirm firmware source version correspondence against upstream ROM build records; source gitlinks alone do not prove reproducible ROM bytes.',
        'Verify rebuilding/relinking from this release in a clean pinned toolchain.',
        'Collect the matching guest sources and custom project/guest build scripts before publication.',
    ],
}
(OUT / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
(OUT / 'SHA256SUMS').write_text(''.join(f"{r['sha256']}  {r['archive']}\n" for r in records))
print(f'Collected {len(records)} archives; manual release verification remains required.')

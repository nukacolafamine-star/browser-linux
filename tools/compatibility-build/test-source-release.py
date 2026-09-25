"""Regression checks for release identity and archive path guards."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('source_release', Path(__file__).with_name('assemble-source-release.py'))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def checksum_tree(root):
    (root / 'SHA256SUMS').write_text(''.join(
        f'{release.sha256(item)}  {item.relative_to(root).as_posix()}\n'
        for item in sorted(root.rglob('*')) if item.is_file() and item.name != 'SHA256SUMS'))


class SourceReleaseTests(unittest.TestCase):
    def test_checksum_tampering_and_escaping_paths_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'source.tar').write_bytes(b'original')
            checksum_tree(root)
            self.assertEqual(len(release.verify_checksums(root)), 1)
            (root / 'source.tar').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
                release.verify_checksums(root)
            for relative in ('../source.tar', '/source.tar', 'C:/source.tar', 'dir\\source.tar'):
                with self.assertRaises(ValueError):
                    release.safe_path(root, relative)

    def test_guest_package_commit_and_source_coverage_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            guest, sources = root / 'guest', root / 'sources'
            guest.mkdir()
            sources.mkdir()
            package = {'name': 'example-libs', 'version': '1.0-r0', 'origin': 'example',
                       'commit': 'a' * 40, 'license': 'MIT'}
            installed = 'P:example-libs\nV:1.0-r0\no:example\nc:' + 'a' * 40 + '\nL:MIT\n'
            for folder in (guest, sources):
                (folder / 'apk-installed.txt').write_text(installed)
                (folder / 'package-versions.txt').write_text('example-libs-1.0-r0\n')
            (guest / 'apk-repositories.txt').write_text('https://example.invalid/pinned-repo\n')
            checksum_tree(guest)
            (sources / 'guest-artifact-SHA256SUMS').write_bytes((guest / 'SHA256SUMS').read_bytes())
            (sources / 'source.tar.gz').write_bytes(b'source placeholder')
            origin = {'origin': 'example', 'version': '1.0-r0', 'aportsCommit': 'a' * 40,
                      'packages': ['example-libs'], 'archive': 'source.tar.gz',
                      'sha256': release.sha256(sources / 'source.tar.gz')}
            manifest = {'packages': [package], 'origins': [origin]}

            def update():
                (sources / 'source-manifest.json').write_text(json.dumps(manifest))
                checksum_tree(sources)

            update()
            self.assertEqual(release.verify_guest(guest, sources), manifest)
            package['commit'] = 'b' * 40
            update()
            with self.assertRaisesRegex(ValueError, 'APK metadata mismatch'):
                release.verify_guest(guest, sources)
            package['commit'] = 'a' * 40
            origin['packages'] = []
            update()
            with self.assertRaisesRegex(ValueError, 'closure incomplete'):
                release.verify_guest(guest, sources)

    def test_attestation_does_not_allow_different_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'runtime.wasm'
            binary.write_bytes(b'wasm fixture')
            proof = {'predicateType': 'https://slsa.dev/provenance/v1',
                     'subject': [{'name': binary.name, 'digest': {'sha256': release.sha256(binary)}}],
                     'predicate': {'request': {'vcs:revision': 'a' * 40}}}
            (root / 'provenance.json').write_text(json.dumps(proof))
            self.assertEqual(release.build_provenance(root)['projectCommit'], 'a' * 40)
            binary.write_bytes(b'different runtime')
            with self.assertRaisesRegex(ValueError, 'Build subject differs'):
                release.build_provenance(root)


if __name__ == '__main__':
    unittest.main()

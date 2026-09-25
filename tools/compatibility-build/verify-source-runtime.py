"""Reject source collections that rebuild a different runtime binary."""
import hashlib
import json
from pathlib import Path
import sys

artifact, sources = (Path(value) for value in sys.argv[1:])
expected = hashlib.file_digest((artifact / 'runtime/qemu-system-x86_64.wasm').open('rb'), 'sha256').hexdigest()
manifest = json.loads((sources / 'source-manifest.json').read_text())
if manifest['runtimeSha256'] != expected:
    raise SystemExit('Source collection does not match the tested runtime bytes; do not publish it as corresponding source.')
manifest['runtimeArtifactVerified'] = True
(sources / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Runtime source collection matches Wasm SHA256 {expected}. Remaining source/license review is still required.')

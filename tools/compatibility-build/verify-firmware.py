"""Match the firmware inventory to the exact QEMU tree and exported ROM bytes."""
import hashlib
import json
from pathlib import Path
import subprocess

target = Path('/out/provenance/firmware/source-manifest.json')
manifest = json.loads(target.read_text())
actual_commit = subprocess.check_output(['git', '-C', '/qemu', 'rev-parse', 'HEAD'], text=True).strip()
assert actual_commit == manifest['qemuCommit'], 'QEMU source commit changed'
for component in manifest['components']:
    entry = subprocess.check_output(['git', '-C', '/qemu', 'ls-tree', 'HEAD', component['qemuPath']], text=True).split()
    assert entry[:3] == ['160000', 'commit', component['commit']], (component['id'], entry)
for name, record in manifest['firmware'].items():
    payload = (Path('/out/pack') / name).read_bytes()
    record.update(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
target.write_text(json.dumps(manifest, indent=2) + '\n')

"""Specialize Emscripten's EGL calls for QEMU's single canvas-owning pthread.

Equivalent source-level change to the generated-JS workaround reported at
https://github.com/emscripten-core/emscripten/issues/24792 . This is deliberately
not presented as a general EGL threading fix. Other worker-owned contexts must
not use this runtime without a new audit.
"""
import hashlib
import json
from pathlib import Path
import re

target = Path('/emsdk/upstream/emscripten/src/lib/libegl.js')
original = target.read_bytes()
expected = 'd53cd806fad0c531b30f7754b3be333ee0711d82ef47746d9698d9bb7250a179'
assert hashlib.sha256(original).hexdigest() == expected, 'Unsupported Emscripten EGL source'
text = original.decode()
pattern = r"^  (egl[A-Za-z0-9]+)__proxy: 'sync',\n"
names = re.findall(pattern, text, flags=re.MULTILINE)
assert len(names) == 25, names
patched = re.sub(pattern, '', text, flags=re.MULTILINE)
target.write_text(patched)
Path('/tmp/browser-linux-egl-patch.json').write_text(json.dumps({
    'upstream': 'emscripten 4.0.10',
    'issue': 'https://github.com/emscripten-core/emscripten/issues/24792',
    'inputSha256': expected,
    'outputSha256': hashlib.sha256(patched.encode()).hexdigest(),
    'changedProxyDeclarations': names,
    'scope': 'one SDL canvas owned by the QEMU main pthread',
}, indent=2) + '\n')

"""Apply one guarded portability fix to the pinned QEMU-Wasm source tree."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

INPUT_SHA256 = '2b6fc72eb69351837a6603d0bf4b98d03502312d78aa979bbbca979d6dad3d9d'


def transform(original):
    if hashlib.sha256(original).hexdigest() != INPUT_SHA256:
        raise ValueError('Refusing errno patch: pinned QEMU 9p-util.h input hash mismatch')
    text = original.decode()
    include = '#include "qemu/error-report.h"\n'
    branch = '#if defined(CONFIG_LINUX) || defined(EMSCRIPTEN)\n    /* nothing to translate (Linux -> Linux) */'
    if text.count(include) != 1 or text.count(branch) != 1:
        raise ValueError('Refusing errno patch: expected source pattern absent or ambiguous')
    text = text.replace(include, include + '\n#ifdef EMSCRIPTEN\n#include "9p-errno-emscripten.h"\n#endif\n')
    text = text.replace(branch,
        '#if defined(EMSCRIPTEN)\n    return browser_linux_errno_to_dotl(err);\n'
        '#elif defined(CONFIG_LINUX)\n    /* nothing to translate (Linux -> Linux) */')
    return text.encode()


if __name__ == '__main__':
    target = Path(sys.argv[1]) / 'hw/9pfs/9p-util.h'
    patched = transform(target.read_bytes())
    helper = Path(__file__).with_name('9p-errno-emscripten.h')
    shutil.copyfile(helper, target.with_name(helper.name))
    target.write_bytes(patched)
    record = {
        'qemuCommit': '8604ed49a3cde392890b014a8d5a959c8a2fe72a',
        'file': 'hw/9pfs/9p-util.h', 'inputSha256': INPUT_SHA256,
        'outputSha256': hashlib.sha256(patched).hexdigest(),
        'helperSha256': hashlib.sha256(helper.read_bytes()).hexdigest(),
        'effect': 'Translate Emscripten/WASI errno values to Linux 9P2000.L error numbers',
        'unknownErrno': 'Linux EIO, preserving failure',
    }
    record_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('/tmp/9p-errno-patch.json')
    record_path.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record))

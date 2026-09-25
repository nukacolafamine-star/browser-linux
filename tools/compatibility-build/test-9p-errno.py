"""Check patch guards and preserve other hosts using the actual pinned source."""
import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('patch_errno', Path(__file__).with_name('patch-9p-errno.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = Path(sys.argv.pop()).read_bytes()


class PatchTest(unittest.TestCase):
    def test_wrong_input_rejected(self):
        with self.assertRaises(ValueError):
            module.transform(original + b'\n')

    def test_exact_scope_and_other_hosts(self):
        patched = module.transform(original)
        self.assertIn(b'return browser_linux_errno_to_dotl(err);', patched)
        reverted = patched.replace(b'\n#ifdef EMSCRIPTEN\n#include "9p-errno-emscripten.h"\n#endif\n', b'')
        reverted = reverted.replace(
            b'#if defined(EMSCRIPTEN)\n    return browser_linux_errno_to_dotl(err);\n#elif defined(CONFIG_LINUX)',
            b'#if defined(CONFIG_LINUX) || defined(EMSCRIPTEN)')
        self.assertEqual(reverted, original)
        with self.assertRaises(ValueError):
            module.transform(patched)


unittest.main()

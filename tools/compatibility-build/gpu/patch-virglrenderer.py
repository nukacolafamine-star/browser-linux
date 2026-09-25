#!/usr/bin/env python3
"""Build virglrenderer's OpenGL renderer with Emscripten.

Emscripten's libc is musl with Linux system interfaces, so Mesa's utility
code can use its Linux paths (sysconf, pthread_setname_np, ...).
"""
import pathlib
import sys

root = pathlib.Path(sys.argv[1])


def patch(relative, old, new):
    path = root / relative
    source = path.read_text()
    if source.count(old) != 1:
        raise SystemExit(f"virglrenderer source changed: {relative}")
    path.write_text(source.replace(old, new))


patch("src/mesa/util/detect_os.h", "#if defined(__linux__)\n", "#if defined(__linux__) || defined(__EMSCRIPTEN__)\n")
# Emscripten's headers trigger pedantic diagnostics unrelated to this code.
patch("meson.build", "   '-Werror=pedantic',\n", "")
print("patched virglrenderer for Emscripten")

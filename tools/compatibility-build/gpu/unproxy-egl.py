#!/usr/bin/env python3
"""Run Emscripten's EGL functions on the calling thread.

With PROXY_TO_PTHREAD and OFFSCREENCANVAS_SUPPORT, QEMU's thread owns the
canvas, but Emscripten 4.0.10 still proxies every EGL call to the page's
main thread, which can no longer use the transferred canvas. Upstream issue:
https://github.com/emscripten-core/emscripten/issues/24792
"""
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
source = path.read_text()
pattern = re.compile(r"(function _egl\w+\([^)]*\)\s*\{\s*\n)(\s*if \(ENVIRONMENT_IS_PTHREAD\)\s*return proxyToMainThread\([^;]*\);\s*\n)")
source, count = pattern.subn(r"\1", source)
if count == 0:
    raise SystemExit("no proxied EGL functions found; the generated JavaScript changed")
path.write_text(source)
print(f"EGL functions now run on the calling thread: {count}")

#!/usr/bin/env python3
"""Build virglrenderer's OpenGL renderer with Emscripten.

Emscripten is a POSIX system (musl libc) but not Linux: Linux-only paths
such as kcmp() must stay disabled. Treat it as a generic Unix and add it to
the few platform switches that only need sysconf().
"""
import pathlib
import sys

root = pathlib.Path(sys.argv[1])


def patch(relative, old, new, count=1):
    path = root / relative
    source = path.read_text()
    if source.count(old) != count:
        raise SystemExit(f"virglrenderer source changed: {relative}: {old!r}")
    path.write_text(source.replace(old, new))


patch("src/mesa/util/detect_os.h",
      "#ifndef DETECT_OS_UNIX\n#define DETECT_OS_UNIX 0\n#endif\n",
      "/* Emscripten: POSIX with musl libc, but not Linux. */\n"
      "#if defined(__EMSCRIPTEN__) && !defined(DETECT_OS_UNIX)\n#define DETECT_OS_UNIX 1\n#endif\n"
      "#ifndef DETECT_OS_UNIX\n#define DETECT_OS_UNIX 0\n#endif\n")
patch("src/mesa/util/os_misc.c",
      "DETECT_OS_LINUX || DETECT_OS_CYGWIN || DETECT_OS_SOLARIS || DETECT_OS_HURD\n",
      "DETECT_OS_LINUX || DETECT_OS_CYGWIN || DETECT_OS_SOLARIS || DETECT_OS_HURD || defined(__EMSCRIPTEN__)\n",
      count=2)
# Emscripten's headers trigger pedantic diagnostics unrelated to this code.
patch("meson.build", "   '-Werror=pedantic',\n", "")
print("patched virglrenderer for Emscripten")

#!/usr/bin/env python3
"""Fix Emscripten 4.0.10's socket scatter/gather I/O before linking QEMU.

recvmsg() wrote the n-th iovec at iov_base + (bytes already read) instead of
iov_base, so any socket read split across buffers (QEMU's NBD client reads
disk data straight into guest pages) corrupted memory and left the real
buffers untouched. sendmsg() copied one byte per JavaScript call; copy each
iovec at once instead.
"""
import pathlib
import sys

path = pathlib.Path(sys.argv[1]) / "src" / "lib" / "libsyscall.js"
source = path.read_bytes().decode()


def replace(old, new):
    global source
    if source.count(old) != 1:
        raise SystemExit(f"Emscripten source changed; expected one match for:\n{old}")
    source = source.replace(old, new)


replace("      HEAPU8.set(buf, iovbase + bytesRead);\n", "      HEAPU8.set(buf, iovbase);\n")
replace("""      for (var j = 0; j < iovlen; j++) {
        view[offset++] = {{{ makeGetValue('iovbase', 'j', 'i8') }}};
      }
""", """      view.set(HEAPU8.subarray(iovbase, iovbase + iovlen), offset);
      offset += iovlen;
""")
path.write_bytes(source.encode())
print("patched Emscripten recvmsg/sendmsg scatter-gather I/O")

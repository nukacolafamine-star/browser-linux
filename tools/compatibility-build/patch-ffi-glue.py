#!/usr/bin/env python3
"""Make libffi's JavaScript glue address memory above 2 GiB.

QEMU's interpreter calls helpers through libffi. The Emscripten port of
libffi indexes the heap with signed shifts (HEAPU32[(ptr >> 2) + i]), which
turn any pointer at or above 2 GiB negative. With 2 GiB or more of guest
memory, argument blocks and thread stacks live there, so helper calls read
garbage. Rewrite those shifts as unsigned (>>>) inside libffi's functions.
"""
import re
import sys

FUNCTIONS = ("unbox_small_structs", "ffi_call_js")

path = sys.argv[1]
with open(path, encoding="utf-8", newline="") as handle:
    source = handle.read()

total = 0
for name in FUNCTIONS:
    start = source.find(f"\nfunction {name}(")
    if start < 0:
        raise SystemExit(f"{name}() not found; the generated JavaScript changed")
    end = source.find("\n}\n", start)
    body = source[start:end]
    fixed, count = re.subn(r" >> ([123])\)", r" >>> \1)", body)
    if count == 0:
        raise SystemExit(f"no signed pointer shifts in {name}(); the generated JavaScript changed")
    source = source[:start] + fixed + source[end:]
    total += count

with open(path, "w", encoding="utf-8", newline="") as handle:
    handle.write(source)
print(f"libffi glue: {total} pointer shifts made unsigned")

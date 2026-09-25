#!/usr/bin/env python3
"""Draws the launcher's panel icon: a generic block, not a Mojang asset."""
import struct
import sys
import zlib

SIZE = 32
rows = []
for y in range(SIZE):
    row = bytearray([0])
    for x in range(SIZE):
        edge = x in (0, SIZE - 1) or y in (0, SIZE - 1)
        if edge:
            pixel = (20, 24, 30, 255)
        elif y < 11:
            pixel = (88, 170, 72, 255) if (x * 7 + y * 3) % 5 else (70, 140, 58, 255)
        else:
            pixel = (134, 96, 67, 255) if (x * 5 + y * 11) % 7 else (112, 78, 52, 255)
        row.extend(pixel)
    rows.append(bytes(row))


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))
with open(sys.argv[1], "wb") as target:
    target.write(png)

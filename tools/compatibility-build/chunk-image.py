#!/usr/bin/env python3
"""Publish a raw disk image as lazily loaded, content-addressed chunks.

Output directory:
  disk.json          {"schema":1,"size":N,"chunkSize":C,"chunks":[[index, sha256, gzipBytes], ...]}
  chunks/<sha>.gz    gzip of the raw chunk; sha256 is of the uncompressed bytes

All-zero chunks are omitted: the browser reads them as zeros without a
download, so a large, mostly empty filesystem costs only its used blocks.
"""
import errno
import gzip
import hashlib
import json
import os
import sys

CHUNK = 1 << 20


def data_regions(fd, size):
    """Yield chunk indexes that may contain data, skipping filesystem holes."""
    if not hasattr(os, "SEEK_DATA"):
        yield from range(size // CHUNK)
        return
    offset = 0
    while offset < size:
        try:
            start = os.lseek(fd, offset, os.SEEK_DATA)
        except OSError as error:
            if error.errno == errno.ENXIO:
                return
            if error.errno in (errno.EINVAL, errno.EOPNOTSUPP):
                yield from range(offset // CHUNK, size // CHUNK)
                return
            raise
        try:
            end = os.lseek(fd, start, os.SEEK_HOLE)
        except OSError:
            end = size
        first, last = start // CHUNK, (end + CHUNK - 1) // CHUNK
        yield from range(first, last)
        offset = last * CHUNK


def main():
    image, out = sys.argv[1], sys.argv[2]
    size = os.path.getsize(image)
    if size % CHUNK:
        raise SystemExit(f"image size {size} is not a multiple of {CHUNK}")
    chunks_dir = os.path.join(out, "chunks")
    os.makedirs(chunks_dir, exist_ok=True)
    zero = bytes(CHUNK)
    entries, unique, packed, raw_used = [], 0, 0, 0
    with open(image, "rb") as handle:
        for index in data_regions(handle.fileno(), size):
            handle.seek(index * CHUNK)
            chunk = handle.read(CHUNK)
            if chunk == zero:
                continue
            digest = hashlib.sha256(chunk).hexdigest()
            path = os.path.join(chunks_dir, digest + ".gz")
            if not os.path.exists(path):
                blob = gzip.compress(chunk, compresslevel=9, mtime=0)
                with open(path, "wb") as target:
                    target.write(blob)
                unique += 1
                packed += len(blob)
            entries.append([index, digest, os.path.getsize(path)])
            raw_used += CHUNK
    manifest = {"schema": 1, "size": size, "chunkSize": CHUNK, "compression": "gzip", "hash": "sha256", "chunks": entries}
    with open(os.path.join(out, "disk.json"), "w", encoding="utf-8") as target:
        json.dump(manifest, target, separators=(",", ":"))
    print(json.dumps({"sizeBytes": size, "chunksWithData": len(entries), "uniqueChunks": unique,
                      "usedBytes": raw_used, "downloadBytesIfAllRead": packed}))


if __name__ == "__main__":
    main()

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {ChunkStore} from '../public/disk/chunk-store.js';

const chunker = fileURLToPath(new URL('../tools/compatibility-build/chunk-image.py', import.meta.url));
const MiB = 1 << 20;

function python() {
  for (const candidate of ['python3', 'python']) {
    try {execFileSync(candidate, ['--version'], {stdio: 'ignore'}); return candidate;} catch {}
  }
  return null;
}

class MemoryFile {
  constructor() {this.bytes = new Uint8Array(0);}
  read(buffer, offset) {
    const count = Math.max(0, Math.min(buffer.length, this.bytes.length - offset));
    buffer.set(this.bytes.subarray(offset, offset + count));
    return count;
  }
  write(buffer, offset) {
    if (offset + buffer.length > this.bytes.length) {const grown = new Uint8Array(offset + buffer.length); grown.set(this.bytes); this.bytes = grown;}
    this.bytes.set(buffer, offset);
    return buffer.length;
  }
  flush() {}
}

test('published chunks reproduce the original image through the browser chunk store', {skip: !python() && 'Python is not installed'}, async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-linux-disk-'));
  try {
    const image = new Uint8Array(12 * MiB);
    image.set(randomBytes(MiB), 1 * MiB);
    image.set(image.subarray(MiB, 2 * MiB), 7 * MiB);           // duplicate chunk content
    image.set(randomBytes(4096), 5 * MiB + 12345);                 // partially filled chunk
    image[11 * MiB + MiB - 1] = 0x5a;                              // single byte at the end
    await fs.writeFile(path.join(work, 'disk.img'), image);
    execFileSync(python(), [chunker, path.join(work, 'disk.img'), path.join(work, 'out')], {stdio: 'pipe'});
    const manifest = JSON.parse(await fs.readFile(path.join(work, 'out', 'disk.json'), 'utf8'));
    assert.equal(manifest.size, image.length);
    assert.deepEqual(manifest.chunks.map(entry => entry[0]), [1, 5, 7, 11], 'zero chunks are omitted');
    assert.equal(manifest.chunks[0][1], manifest.chunks[2][1], 'identical chunks share one content address');
    const files = await fs.readdir(path.join(work, 'out', 'chunks'));
    assert.equal(files.length, 3);

    const base = new Map(manifest.chunks.map(([index, sha256, bytes]) => [index, {sha256, bytes}]));
    const store = new ChunkStore({size: manifest.size, chunkSize: manifest.chunkSize, base,
      data: new MemoryFile(), map: new MemoryFile(),
      fetchChunk: async index => {
        const {sha256, bytes} = base.get(index);
        const packed = await fs.readFile(path.join(work, 'out', 'chunks', sha256 + '.gz'));
        assert.equal(packed.length, bytes);
        const raw = new Uint8Array(gunzipSync(packed));
        assert.equal(createHash('sha256').update(raw).digest('hex'), sha256);
        return raw;
      }});
    const read = await store.read(0, image.length);
    assert.equal(createHash('sha256').update(read).digest('hex'), createHash('sha256').update(image).digest('hex'));
  } finally {
    await fs.rm(work, {recursive: true, force: true});
  }
});

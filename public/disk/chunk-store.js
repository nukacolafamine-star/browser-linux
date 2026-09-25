// SPDX-License-Identifier: GPL-2.0-only
// Copy-on-write block store for the guest disk. The read-only base image is
// published as fixed-size chunks and fetched only when the guest reads them.
// Fetched and modified chunks live in a local slot file, so the disk keeps
// its contents across sessions without being loaded into memory.
//
// Files (browser OPFS in production, memory in tests):
//   data  slot i holds one chunk at offset i * chunkSize
//   map   two alternating copies of the chunk table, each with a generation
//         number and checksum, so a torn write never loses the older copy
//
// A chunk table entry is 0 (use the base image), ZERO (reads as zeros), or
// slot + 1, with DIRTY set once the guest has written to that chunk.
export const ZERO = 0xffffffff;
export const DIRTY = 0x80000000;
const MAP_MAGIC = 0x4d4c4252; // "RBLM"
const HEADER_BYTES = 16;

function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const slotOf = entry => (entry & ~DIRTY) - 1;

export class ChunkStore {
  // base: Map of chunk index -> descriptor for chunks with non-zero content.
  // fetchChunk(index) resolves to exactly chunkSize verified bytes.
  constructor({size, chunkSize, base, data, map, fetchChunk, prefetch = 3}) {
    if (!Number.isSafeInteger(size) || size <= 0 || size % chunkSize) throw new Error('Disk size must be a whole number of chunks');
    this.size = size;
    this.chunkSize = chunkSize;
    this.count = size / chunkSize;
    this.base = base;
    this.data = data;
    this.mapFile = map;
    this.fetchChunk = fetchChunk;
    this.prefetchCount = prefetch;
    this.table = new Uint32Array(this.count);
    this.generation = 0;
    this.tableChanged = false;
    this.pending = new Map();
    this.free = [];
    this.quarantine = [];
    this.nextSlot = 0;
    this.stats = {fetchedChunks: 0, fetchedBytes: 0, readRequests: 0, writeRequests: 0, flushes: 0};
    this.#load();
  }

  #regionBytes() {return HEADER_BYTES + this.count * 4;}

  #load() {
    const regionBytes = this.#regionBytes();
    let best = null;
    for (let copy = 0; copy < 2; copy++) {
      const region = new Uint8Array(regionBytes);
      if (this.mapFile.read(region, copy * regionBytes) !== regionBytes) continue;
      const header = new DataView(region.buffer);
      if (header.getUint32(0, true) !== MAP_MAGIC || header.getUint32(12, true) !== this.count) continue;
      const entries = region.subarray(HEADER_BYTES);
      if (fnv1a(entries) !== header.getUint32(8, true)) continue;
      const generation = header.getUint32(4, true);
      if (!best || generation > best.generation) best = {generation, entries: entries.slice()};
    }
    if (best) {
      this.table = new Uint32Array(best.entries.buffer);
      this.generation = best.generation;
    }
    const used = new Set();
    for (const entry of this.table) {
      if (entry && entry !== ZERO) {
        const slot = slotOf(entry);
        used.add(slot);
        this.nextSlot = Math.max(this.nextSlot, slot + 1);
      }
    }
    for (let slot = 0; slot < this.nextSlot; slot++) if (!used.has(slot)) this.free.push(slot);
  }

  // Slots released since the last flush may still be referenced by the table
  // on storage. They are reused only after the new table is durable.
  #allocate() {
    return this.free.length ? this.free.pop() : this.nextSlot++;
  }

  #release(entry) {
    if (entry && entry !== ZERO) this.quarantine.push(slotOf(entry));
  }

  #hasBase(index) {return this.base.has(index);}

  async #materialize(index) {
    const existing = this.table[index];
    if (existing && existing !== ZERO) return slotOf(existing);
    let promise = this.pending.get(index);
    if (!promise) {
      promise = (async () => {
        const bytes = await this.fetchChunk(index);
        if (bytes.length !== this.chunkSize) throw new Error(`Chunk ${index} has the wrong size`);
        const current = this.table[index];
        if (current && current !== ZERO) return slotOf(current);
        const slot = this.#allocate();
        this.data.write(bytes, slot * this.chunkSize);
        this.table[index] = slot + 1;
        this.tableChanged = true;
        this.stats.fetchedChunks++;
        this.stats.fetchedBytes += bytes.length;
        return slot;
      })();
      this.pending.set(index, promise);
      promise.finally(() => this.pending.delete(index)).catch(() => {});
    }
    return promise;
  }

  #prefetch(index) {
    for (let next = index + 1; next <= index + this.prefetchCount && next < this.count; next++) {
      if (!this.table[next] && this.#hasBase(next) && !this.pending.has(next)) this.#materialize(next).catch(() => {});
    }
  }

  #check(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) {
      throw Object.assign(new Error('Request outside the disk'), {errno: 22});
    }
  }

  async read(offset, length, output = new Uint8Array(length)) {
    this.#check(offset, length);
    this.stats.readRequests++;
    for (let done = 0; done < length;) {
      const at = offset + done, index = Math.floor(at / this.chunkSize), within = at % this.chunkSize;
      const part = Math.min(length - done, this.chunkSize - within);
      const target = output.subarray(done, done + part);
      let entry = this.table[index];
      if (!entry && this.#hasBase(index)) {
        await this.#materialize(index);
        this.#prefetch(index);
        entry = this.table[index];
      }
      if (entry && entry !== ZERO) {
        if (this.data.read(target, slotOf(entry) * this.chunkSize + within) !== part) target.fill(0);
      } else {
        target.fill(0);
      }
      done += part;
    }
    return output;
  }

  async write(offset, bytes) {
    this.#check(offset, bytes.length);
    this.stats.writeRequests++;
    for (let done = 0; done < bytes.length;) {
      const at = offset + done, index = Math.floor(at / this.chunkSize), within = at % this.chunkSize;
      const part = Math.min(bytes.length - done, this.chunkSize - within);
      const entry = this.table[index];
      let slot;
      if (entry && entry !== ZERO) {
        slot = slotOf(entry);
      } else if (part === this.chunkSize || entry === ZERO || !this.#hasBase(index)) {
        slot = this.#allocate();
        if (part !== this.chunkSize) this.data.write(new Uint8Array(this.chunkSize), slot * this.chunkSize);
      } else {
        slot = await this.#materialize(index);
      }
      this.data.write(bytes.subarray(done, done + part), slot * this.chunkSize + within);
      this.table[index] = (slot + 1) | DIRTY;
      this.tableChanged = true;
      done += part;
    }
  }

  // Zeroes a range. Whole chunks become ZERO table entries and give back their
  // slots; partial chunks are overwritten with zeros unless `discard` is set.
  async zero(offset, length, {discard = false} = {}) {
    this.#check(offset, length);
    for (let done = 0; done < length;) {
      const at = offset + done, index = Math.floor(at / this.chunkSize), within = at % this.chunkSize;
      const part = Math.min(length - done, this.chunkSize - within);
      if (part === this.chunkSize) {
        const entry = this.table[index];
        const next = this.#hasBase(index) ? ZERO : 0;
        if (entry !== next) {
          this.#release(entry);
          this.table[index] = next;
          this.tableChanged = true;
        }
      } else if (!discard) {
        await this.write(at, new Uint8Array(part));
      }
      done += part;
    }
  }

  async flush() {
    this.stats.flushes++;
    this.data.flush();
    if (!this.tableChanged) return;
    this.tableChanged = false;
    this.generation = (this.generation + 1) >>> 0;
    const regionBytes = this.#regionBytes();
    const region = new Uint8Array(regionBytes);
    const entries = new Uint8Array(this.table.buffer, this.table.byteOffset, this.table.byteLength);
    region.set(entries, HEADER_BYTES);
    const header = new DataView(region.buffer);
    header.setUint32(0, MAP_MAGIC, true);
    header.setUint32(4, this.generation, true);
    header.setUint32(8, fnv1a(entries), true);
    header.setUint32(12, this.count, true);
    const quarantined = this.quarantine.splice(0);
    this.mapFile.write(region, (this.generation % 2) * regionBytes);
    this.mapFile.flush();
    this.free.push(...quarantined);
  }

  usage() {
    let cached = 0, dirty = 0, zero = 0;
    for (const entry of this.table) {
      if (entry === ZERO) zero++;
      else if (entry & DIRTY) dirty++;
      else if (entry) cached++;
    }
    return {chunkSize: this.chunkSize, chunks: this.count, baseChunks: this.base.size, cached, dirty, zero,
      slots: this.nextSlot, storedBytes: this.nextSlot * this.chunkSize};
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {ChunkStore, ZERO, DIRTY} from '../public/disk/chunk-store.js';
import {NbdServer} from '../public/disk/nbd-server.js';

const CHUNK = 4096;

class MemoryFile {
  constructor() {this.bytes = new Uint8Array(0); this.flushes = 0;}
  read(buffer, offset) {
    const count = Math.max(0, Math.min(buffer.length, this.bytes.length - offset));
    buffer.set(this.bytes.subarray(offset, offset + count));
    return count;
  }
  write(buffer, offset) {
    if (offset + buffer.length > this.bytes.length) {
      const grown = new Uint8Array(offset + buffer.length);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes.set(buffer, offset);
    return buffer.length;
  }
  flush() {this.flushes++;}
}

function baseImage(chunks, present) {
  const image = new Uint8Array(chunks * CHUNK);
  for (const index of present) for (let i = 0; i < CHUNK; i++) image[index * CHUNK + i] = (index * 7 + i) & 255;
  return image;
}

function makeStore({image, present, data = new MemoryFile(), map = new MemoryFile(), fail = false, prefetch = 0}) {
  const fetched = [];
  const base = new Map(present.map(index => [index, {}]));
  const store = new ChunkStore({size: image.length, chunkSize: CHUNK, base, data, map, prefetch,
    fetchChunk: async index => {
      fetched.push(index);
      await new Promise(resolve => setTimeout(resolve, 1));
      if (fail) throw new Error('offline');
      return image.slice(index * CHUNK, (index + 1) * CHUNK);
    }});
  return {store, fetched, data, map};
}

test('reads fetch only non-zero base chunks, once', async () => {
  const image = baseImage(8, [1, 2, 5]);
  const {store, fetched} = makeStore({image, present: [1, 2, 5]});
  assert.deepEqual(await store.read(0, 8 * CHUNK), image);
  assert.deepEqual(fetched.sort(), [1, 2, 5]);
  assert.deepEqual(await store.read(CHUNK + 100, 3 * CHUNK), image.slice(CHUNK + 100, 4 * CHUNK + 100));
  assert.equal(fetched.length, 3, 'cached chunks are not fetched again');
  assert.equal(store.usage().cached, 3);
});

test('concurrent reads of one chunk share a single fetch', async () => {
  const image = baseImage(4, [2]);
  const {store, fetched} = makeStore({image, present: [2]});
  const [a, b] = await Promise.all([store.read(2 * CHUNK, 10), store.read(2 * CHUNK + 10, 10)]);
  assert.deepEqual(a, image.slice(2 * CHUNK, 2 * CHUNK + 10));
  assert.deepEqual(b, image.slice(2 * CHUNK + 10, 2 * CHUNK + 20));
  assert.deepEqual(fetched, [2]);
});

test('prefetches following base chunks after a miss', async () => {
  const image = baseImage(8, [1, 2, 3, 6]);
  const {store, fetched} = makeStore({image, present: [1, 2, 3, 6], prefetch: 3});
  await store.read(CHUNK, 16);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(fetched.sort(), [1, 2, 3]);
});

test('writes are copy-on-write and persist after flush', async () => {
  const image = baseImage(6, [0, 1, 2]);
  const first = makeStore({image, present: [0, 1, 2]});
  await first.store.write(CHUNK + 10, new Uint8Array([9, 9, 9]));      // partial write to a base chunk
  await first.store.write(3 * CHUNK, new Uint8Array(CHUNK).fill(4));    // whole chunk: no fetch needed
  await first.store.write(5 * CHUNK + 1, new Uint8Array([7]));           // partial write to a zero chunk
  assert.deepEqual(first.fetched, [1]);
  await first.store.flush();
  const expected = image.slice();
  expected.set([9, 9, 9], CHUNK + 10); expected.fill(4, 3 * CHUNK, 4 * CHUNK); expected[5 * CHUNK + 1] = 7;
  const reopened = makeStore({image, present: [0, 1, 2], data: first.data, map: first.map});
  assert.deepEqual(await reopened.store.read(0, image.length), expected);
  assert.deepEqual(reopened.fetched.sort(), [0, 2], 'only never-cached base chunks are fetched');
  const usage = reopened.store.usage();
  assert.equal(usage.dirty, 3);
});

test('writes that were never flushed are not referenced after a restart', async () => {
  const image = baseImage(4, [0]);
  const first = makeStore({image, present: [0]});
  await first.store.write(0, new Uint8Array([1, 2, 3]));
  await first.store.flush();
  await first.store.write(2 * CHUNK, new Uint8Array(CHUNK).fill(8));
  const reopened = makeStore({image, present: [0], data: first.data, map: first.map});
  const expected = image.slice(); expected.set([1, 2, 3], 0);
  assert.deepEqual(await reopened.store.read(0, image.length), expected);
});

test('trim returns whole chunks and reuses slots only after the table is durable', async () => {
  const image = baseImage(4, [0, 1]);
  const {store, data, map} = makeStore({image, present: [0, 1]});
  await store.write(0, new Uint8Array(CHUNK).fill(1));
  await store.write(CHUNK, new Uint8Array(CHUNK).fill(2));
  await store.flush();
  await store.zero(0, CHUNK + 100, {discard: true});                    // chunk 0 whole, chunk 1 partial
  assert.deepEqual(await store.read(0, CHUNK), new Uint8Array(CHUNK));
  assert.equal(store.table[0], ZERO);
  assert.notEqual(store.table[1] & DIRTY, 0, 'partial discard leaves data in place');
  await store.write(2 * CHUNK, new Uint8Array(CHUNK).fill(3));
  assert.equal(store.usage().slots, 3, 'released slot is not reused before flush');
  // A crash here must still find chunk 0's old data where the durable table points.
  const crashed = makeStore({image, present: [0, 1], data, map});
  assert.deepEqual(await crashed.store.read(0, CHUNK), new Uint8Array(CHUNK).fill(1));
  await store.flush();
  await store.write(3 * CHUNK, new Uint8Array(CHUNK).fill(5));
  assert.equal(store.usage().slots, 3, 'released slot reused after flush');
  await store.flush();
  const reopened = makeStore({image, present: [0, 1], data, map});
  assert.deepEqual(await reopened.store.read(0, CHUNK), new Uint8Array(CHUNK));
  assert.deepEqual(await reopened.store.read(3 * CHUNK, CHUNK), new Uint8Array(CHUNK).fill(5));
});

test('write-zeroes on part of a base chunk zeroes exactly that range', async () => {
  const image = baseImage(2, [0]);
  const {store} = makeStore({image, present: [0]});
  await store.zero(100, 50);
  const expected = image.slice(); expected.fill(0, 100, 150);
  assert.deepEqual(await store.read(0, 2 * CHUNK), expected);
});

test('a torn chunk table write falls back to the previous copy', async () => {
  const image = baseImage(4, []);
  const {store, data, map} = makeStore({image, present: []});
  await store.write(0, new Uint8Array([1]));
  await store.flush();
  await store.write(CHUNK, new Uint8Array([2]));
  await store.flush();
  // Corrupt the newest copy, as if the browser stopped during its write.
  const regionBytes = 16 + 4 * 4;
  map.bytes[(store.generation % 2) * regionBytes + 20] ^= 0xff;
  const reopened = makeStore({image, present: [], data, map});
  assert.equal((await reopened.store.read(0, 1))[0], 1);
  assert.equal((await reopened.store.read(CHUNK, 1))[0], 0, 'the lost generation is not visible');
});

test('fetch failures surface as errors and requests outside the disk are rejected', async () => {
  const image = baseImage(2, [1]);
  const {store} = makeStore({image, present: [1], fail: true});
  await assert.rejects(store.read(CHUNK, 1), /offline/);
  await assert.rejects(store.read(2 * CHUNK - 1, 2), error => error.errno === 22);
});

// Minimal client following QEMU's negotiation order.
class Client {
  constructor(store, size) {
    this.incoming = new Uint8Array(0);
    this.closed = false;
    this.server = new NbdServer({store, size, send: bytes => this.#push(bytes), close: () => {this.closed = true;}});
    this.waiter = null;
  }
  #push(bytes) {
    const joined = new Uint8Array(this.incoming.length + bytes.length);
    joined.set(this.incoming); joined.set(bytes, this.incoming.length);
    this.incoming = joined;
    this.waiter?.();
  }
  async take(length) {
    while (this.incoming.length < length) await new Promise(resolve => {this.waiter = resolve;});
    const out = this.incoming.slice(0, length);
    this.incoming = this.incoming.slice(length);
    return new DataView(out.buffer);
  }
  option(option, data = new Uint8Array(0)) {
    const message = new Uint8Array(16 + data.length);
    const view = new DataView(message.buffer);
    view.setBigUint64(0, 0x49484156454f5054n); view.setUint32(8, option); view.setUint32(12, data.length);
    message.set(data, 16);
    this.server.receive(message);
  }
  async optionReply() {
    const header = await this.take(20);
    assert.equal(header.getBigUint64(0), 0x0003e889045565a9n);
    const length = header.getUint32(16);
    return {option: header.getUint32(8), type: header.getUint32(12), data: await this.take(length)};
  }
  request(type, offset, length, payload, flags = 0, cookie = 1n) {
    const message = new Uint8Array(28 + (payload ? payload.length : 0));
    const view = new DataView(message.buffer);
    view.setUint32(0, 0x25609513); view.setUint16(4, flags); view.setUint16(6, type);
    view.setBigUint64(8, cookie); view.setBigUint64(16, BigInt(offset)); view.setUint32(24, length);
    if (payload) message.set(payload, 28);
    // Deliver in two pieces to exercise reassembly.
    this.server.receive(message.subarray(0, 5));
    this.server.receive(message.subarray(5));
  }
  async reply(dataLength = 0) {
    const header = await this.take(16);
    assert.equal(header.getUint32(0), 0x67446698);
    return {error: header.getUint32(4), cookie: header.getBigUint64(8),
      data: dataLength ? new Uint8Array((await this.take(dataLength)).buffer) : null};
  }
}

test('NBD negotiation matches QEMU: structured replies declined, GO with block sizes', async () => {
  const image = baseImage(8, [0, 3]);
  const {store} = makeStore({image, present: [0, 3]});
  const client = new Client(store, image.length);
  client.server.start();
  const greeting = await client.take(18);
  assert.equal(greeting.getBigUint64(0), 0x4e42444d41474943n);
  assert.equal(greeting.getBigUint64(8), 0x49484156454f5054n);
  assert.equal(greeting.getUint16(16) & 3, 3);
  client.server.receive(new Uint8Array([0, 0, 0, 3]));
  client.option(8); // STRUCTURED_REPLY
  assert.equal((await client.optionReply()).type, 0x80000001);
  const name = new TextEncoder().encode('root');
  const go = new Uint8Array(4 + name.length + 4);
  const goView = new DataView(go.buffer);
  goView.setUint32(0, name.length); go.set(name, 4); goView.setUint16(4 + name.length, 1); goView.setUint16(6 + name.length, 3);
  client.option(7, go);
  const exportInfo = await client.optionReply();
  assert.equal(exportInfo.type, 3);
  assert.equal(exportInfo.data.getUint16(0), 0);
  assert.equal(exportInfo.data.getBigUint64(2), BigInt(image.length));
  assert.equal(exportInfo.data.getUint16(10) & 1, 1);
  const sizes = await client.optionReply();
  assert.equal(sizes.data.getUint16(0), 3);
  assert.equal(sizes.data.getUint32(2), 1);
  assert.equal((await client.optionReply()).type, 1);

  client.request(0, 3 * CHUNK - 5, 10, null, 0, 42n);
  const read = await client.reply(10);
  assert.equal(read.error, 0);
  assert.equal(read.cookie, 42n);
  assert.deepEqual(read.data, image.slice(3 * CHUNK - 5, 3 * CHUNK + 5));

  client.request(1, 100, 3, new Uint8Array([5, 6, 7]), 1 /* FUA */, 43n);
  assert.deepEqual(await client.reply(), {error: 0, cookie: 43n, data: null});
  client.request(3, 0, 0, null, 0, 44n);
  assert.equal((await client.reply()).error, 0);
  client.request(0, 99, 5, null, 0, 45n);
  assert.deepEqual([...(await client.reply(5)).data], [image[99], 5, 6, 7, image[103]]);
  client.request(6, 0, CHUNK, null, 0, 46n); // WRITE_ZEROES
  assert.equal((await client.reply()).error, 0);
  client.request(0, 0, 8, null, 0, 47n);
  assert.deepEqual([...(await client.reply(8)).data], [0, 0, 0, 0, 0, 0, 0, 0]);
  client.request(0, image.length - 4, 8, null, 0, 48n);
  assert.equal((await client.reply()).error, 22);
  client.request(1, image.length, 1, new Uint8Array([1]), 0, 49n);
  assert.equal((await client.reply()).error, 28);
  client.request(2, 0, 0);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(client.closed, true);
});

test('NBD EXPORT_NAME negotiation without zero padding', async () => {
  const image = baseImage(2, []);
  const {store} = makeStore({image, present: []});
  const client = new Client(store, image.length);
  client.server.start();
  await client.take(18);
  client.server.receive(new Uint8Array([0, 0, 0, 3]));
  client.option(1, new TextEncoder().encode('root'));
  const info = await client.take(10);
  assert.equal(info.getBigUint64(0), BigInt(image.length));
  client.request(0, 0, 4, null, 0, 7n);
  assert.deepEqual((await client.reply(4)).data, new Uint8Array(4));
});

// SPDX-License-Identifier: GPL-2.0-only
// Owns one guest disk. Chunks of the published base image are downloaded
// only when Linux reads them, verified, and kept with Linux's own changes in
// the browser's origin-private file system. QEMU reaches this worker through
// its NBD client; the "connection" never leaves the browser.
import {ChunkStore} from './disk/chunk-store.js';
import {NbdServer} from './disk/nbd-server.js';

let store = null, base = null, chunkSize = 0, entries = null, handles = [], flushTimer = 0, statusTimer = 0;
const servers = new Map();
const state = {downloading: 0, waiting: null, errors: 0};

const post = (message, transfer) => self.postMessage(message, transfer || []);
const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class SyncFile {
  constructor(handle) {this.handle = handle;}
  read(buffer, offset) {return this.handle.read(buffer, {at: offset});}
  write(buffer, offset) {
    let written = 0;
    while (written < buffer.length) written += this.handle.write(buffer.subarray(written), {at: offset + written});
    return written;
  }
  flush() {this.handle.flush();}
  close() {this.handle.close();}
}

class MemoryFile {
  constructor() {this.bytes = new Uint8Array(0);}
  read(buffer, offset) {
    const count = Math.max(0, Math.min(buffer.length, this.bytes.length - offset));
    buffer.set(this.bytes.subarray(offset, offset + count));
    return count;
  }
  write(buffer, offset) {
    if (offset + buffer.length > this.bytes.length) {
      const grown = new Uint8Array(Math.max(offset + buffer.length, this.bytes.length * 2));
      grown.set(this.bytes); this.bytes = grown;
    }
    this.bytes.set(buffer, offset);
    return buffer.length;
  }
  flush() {}
  close() {}
}

async function fetchChunk(index) {
  const entry = entries.get(index);
  const url = new URL('chunks/' + entry.sha256 + '.gz', base);
  state.downloading++;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        // Stored in the disk's own files; a second HTTP cache copy would only use more space.
        const response = await fetch(url, {cache: 'no-store'});
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const packed = await response.arrayBuffer();
        if (packed.byteLength !== entry.bytes) throw new Error('unexpected size');
        const raw = new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
        if (raw.length !== chunkSize || hex(await crypto.subtle.digest('SHA-256', raw)) !== entry.sha256) throw new Error('integrity check failed');
        if (state.waiting) {state.waiting = null; report();}
        return raw;
      } catch (error) {
        state.errors++;
        if (attempt >= 9) throw new Error('Linux disk data could not be downloaded: ' + error.message);
        state.waiting = error.message;
        report();
        await sleep(Math.min(30000, 500 * 2 ** attempt));
      }
    }
  } finally {
    state.downloading--;
  }
}

function report() {
  if (!store) return;
  post({type: 'status', stats: {...store.stats}, usage: store.usage(), downloading: state.downloading, waiting: state.waiting});
}

async function open({manifest, manifestSha256, baseURL, namespace, temporary}) {
  if (manifest.schema !== 1 || !Number.isSafeInteger(manifest.size) || manifest.chunkSize !== 1048576) throw new Error('Unsupported disk layout');
  base = new URL(baseURL);
  chunkSize = manifest.chunkSize;
  entries = new Map();
  for (const [index, sha256, bytes] of manifest.chunks) {
    if (!Number.isSafeInteger(index) || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(bytes)) throw new Error('Invalid disk chunk list');
    entries.set(index, {sha256, bytes});
  }
  let data, map;
  if (temporary) {
    data = new MemoryFile(); map = new MemoryFile();
  } else {
    if (!/^[a-z0-9-]{8,80}$/.test(namespace)) throw new Error('Invalid disk name');
    const root = await navigator.storage.getDirectory();
    const disks = await root.getDirectoryHandle('browser-linux-disks', {create: true});
    const directory = await disks.getDirectoryHandle(namespace, {create: true});
    try {
      data = new SyncFile(await (await directory.getFileHandle('data.bin', {create: true})).createSyncAccessHandle());
      map = new SyncFile(await (await directory.getFileHandle('map.bin', {create: true})).createSyncAccessHandle());
    } catch (error) {
      data?.close();
      if (error.name === 'NoModificationAllowedError' || error.name === 'InvalidStateError') {
        throw new Error('This Linux disk is already open in another tab or window. Close that session first.');
      }
      throw error;
    }
    const meta = await (await directory.getFileHandle('meta.json', {create: true})).createSyncAccessHandle();
    try {
      const existing = new Uint8Array(meta.getSize());
      meta.read(existing, {at: 0});
      const previous = existing.length ? JSON.parse(new TextDecoder().decode(existing)) : null;
      if (previous && previous.base !== manifestSha256) throw new Error('This saved disk belongs to a different Linux image.');
      const record = new TextEncoder().encode(JSON.stringify({schema: 1, base: manifestSha256, size: manifest.size,
        chunkSize, created: previous?.created || new Date().toISOString(), opened: new Date().toISOString()}));
      meta.truncate(0); meta.write(record, {at: 0}); meta.flush();
    } finally {meta.close();}
    handles = [data, map];
  }
  store = new ChunkStore({size: manifest.size, chunkSize, base: entries, data, map, fetchChunk, prefetch: 4});
  // Guest flushes make its writes durable. Periodic flushes also record
  // downloaded chunks, so a reload does not download them again.
  flushTimer = setInterval(() => {if (store.tableChanged) store.flush().catch(error => post({type: 'error', message: error.message}));}, 5000);
  statusTimer = setInterval(report, 1000);
  return {usage: store.usage(), persistent: !temporary};
}

async function close() {
  clearInterval(flushTimer); clearInterval(statusTimer);
  for (const server of servers.values()) server.close();
  servers.clear();
  if (store) await store.flush();
  for (const handle of handles) handle.close();
  handles = []; store = null;
}

const transferable = bytes => bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();

self.onmessage = async ({data: message}) => {
  try {
    if (message.type === 'open') {
      post({type: 'opened', id: message.id, ...(await open(message))});
    } else if (message.type === 'nbd-open') {
      const server = new NbdServer({store, size: store.size, exportName: 'root',
        send: bytes => {const copy = transferable(bytes); post({type: 'nbd-data', id: message.id, bytes: copy}, [copy.buffer]);},
        close: () => {servers.delete(message.id); post({type: 'nbd-closed', id: message.id});},
        onError: error => post({type: 'disk-error', message: error.message})});
      servers.set(message.id, server);
      server.start();
    } else if (message.type === 'nbd-data') {
      servers.get(message.id)?.receive(message.bytes);
    } else if (message.type === 'nbd-close') {
      const server = servers.get(message.id);
      servers.delete(message.id);
      server?.close();
      await store?.flush();
    } else if (message.type === 'flush') {
      await store?.flush();
      post({type: 'flushed', id: message.id});
    } else if (message.type === 'close') {
      await close();
      post({type: 'closed', id: message.id});
    }
  } catch (error) {
    post({type: 'error', id: message.id, message: error.message});
  }
};

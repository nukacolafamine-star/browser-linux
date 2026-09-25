// SPDX-License-Identifier: GPL-2.0-only
// Page-side handle for a guest disk served by compatibility-disk-worker.js,
// and the list of disks saved in this browser.
const DISK_DIRECTORY = 'browser-linux-disks';

export class GuestDisk {
  static async open({manifest, manifestSha256, baseURL, namespace, temporary, onStatus = () => {}, onError = () => {}}) {
    const disk = new GuestDisk(onStatus, onError);
    const opened = await disk.#request({type: 'open', manifest, manifestSha256, baseURL: String(baseURL), namespace, temporary});
    disk.persistent = opened.persistent;
    disk.usage = opened.usage;
    return disk;
  }

  constructor(onStatus, onError) {
    this.worker = new Worker(new URL('./compatibility-disk-worker.js', import.meta.url), {type: 'module'});
    this.pending = new Map();
    this.sockets = new Map();
    this.nextId = 1;
    this.worker.onmessage = ({data}) => {
      if (data.type === 'status') {this.usage = data.usage; onStatus(data); return;}
      if (data.type === 'nbd-data') {this.sockets.get(data.id)?.deliver(data.bytes); return;}
      if (data.type === 'nbd-closed') {this.sockets.get(data.id)?.remoteClosed(); this.sockets.delete(data.id); return;}
      if (data.type === 'disk-error') {onError(new Error(data.message)); return;}
      const waiter = this.pending.get(data.id);
      if (waiter) {
        this.pending.delete(data.id);
        if (data.type === 'error') waiter.reject(new Error(data.message)); else waiter.resolve(data);
      } else if (data.type === 'error') {
        onError(new Error(data.message));
      }
    };
    this.worker.onerror = event => {event.preventDefault?.(); onError(new Error(event.message || 'The disk worker stopped'));};
  }

  #request(message) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.worker.postMessage({...message, id});
    });
  }

  // A WebSocket-shaped endpoint for Emscripten's socket layer. QEMU's NBD
  // client connects to it as if it were a network server.
  createSocket(url) {
    const id = this.nextId++;
    const socket = new ChannelSocket(url, {
      send: bytes => this.worker.postMessage({type: 'nbd-data', id, bytes}, [bytes.buffer]),
      close: () => {this.worker.postMessage({type: 'nbd-close', id}); this.sockets.delete(id);},
    });
    this.sockets.set(id, socket);
    this.worker.postMessage({type: 'nbd-open', id});
    return socket;
  }

  flush() {return this.#request({type: 'flush'});}

  async close() {
    try {await this.#request({type: 'close'});}
    finally {this.worker.terminate();}
  }

  terminate() {this.worker.terminate();}
}

// Implements the subset of the WebSocket interface Emscripten's SOCKFS uses.
export class ChannelSocket {
  constructor(url, endpoint) {
    Object.assign(this, {CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3});
    this.url = url;
    this.protocol = 'binary';
    this.binaryType = 'arraybuffer';
    this.readyState = 0;
    this.endpoint = endpoint;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    // SOCKFS attaches its handlers right after construction.
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({type: 'open'});
    });
  }

  send(data) {
    if (this.readyState !== 1) throw new DOMException('The socket is not open', 'InvalidStateError');
    const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    this.endpoint.send(view.slice());
  }

  deliver(bytes) {
    if (this.readyState !== 1) return;
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    this.onmessage?.({type: 'message', data: buffer});
  }

  remoteClosed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({type: 'close', code: 1000, wasClean: true});
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.endpoint.close();
    this.onclose?.({type: 'close', code: 1000, wasClean: true});
  }
}

// QEMU is given these private addresses; they never reach a real network.
export const DISK_ENDPOINT = {host: '10.254.0.1', port: 10809};
export const NETWORK_ENDPOINT = {host: '10.254.0.2', port: 8765};
export const MONITOR_ENDPOINT = {host: '10.254.0.3', port: 4444};

// Emscripten creates every emulated socket through the page's WebSocket
// constructor. Route the disk to its worker, the network card to the local
// relay and the QEMU monitor to the page; refuse anything else.
export function installSocketRouter({disk, networkURL, monitor}) {
  const NativeWebSocket = window.WebSocket;
  function RoutedWebSocket(url, protocols) {
    const target = new URL(url);
    const port = Number(target.port);
    if (target.hostname === DISK_ENDPOINT.host && port === DISK_ENDPOINT.port) return disk.createSocket(url);
    if (target.hostname === NETWORK_ENDPOINT.host && port === NETWORK_ENDPOINT.port && networkURL) {
      return new NativeWebSocket(networkURL, protocols);
    }
    if (target.hostname === MONITOR_ENDPOINT.host && port === MONITOR_ENDPOINT.port && monitor) {
      const socket = new ChannelSocket(url, {send: bytes => monitor.receive(bytes), close: () => monitor.closed()});
      monitor.attach({push: bytes => socket.deliver(bytes)});
      return socket;
    }
    throw new Error('Unexpected emulator connection to ' + target.host);
  }
  Object.assign(RoutedWebSocket, {CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3});
  window.WebSocket = RoutedWebSocket;
  return () => {window.WebSocket = NativeWebSocket;};
}

export async function listSavedDisks() {
  if (!navigator.storage?.getDirectory) return [];
  const root = await navigator.storage.getDirectory();
  let directory;
  try {directory = await root.getDirectoryHandle(DISK_DIRECTORY);} catch {return [];}
  const disks = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== 'directory') continue;
    let bytes = 0, meta = null;
    for await (const [file, entry] of handle.entries()) {
      if (entry.kind !== 'file') continue;
      const blob = await entry.getFile();
      bytes += blob.size;
      if (file === 'meta.json') {try {meta = JSON.parse(await blob.text());} catch {}}
    }
    disks.push({name, bytes, meta});
  }
  return disks;
}

export async function deleteSavedDisk(name) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(DISK_DIRECTORY);
  await directory.removeEntry(name, {recursive: true});
}

// Local relay for guest networking: the development server answers 426 with
// a marker header; static hosting without it answers 404.
export async function probeNetworkRelay() {
  try {
    const response = await fetch(new URL('net', location.href), {cache: 'no-store'});
    if (response.status === 426 && response.headers.get('X-Browser-Linux-Network') === 'available') {
      const url = new URL('net', location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return url.href;
    }
  } catch {}
  return null;
}

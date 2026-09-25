// SPDX-License-Identifier: GPL-2.0-only
// Minimal RFC 6455 server endpoint for the loopback development server. It
// only exchanges binary messages; it has no dependencies to install.
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 4 * 1024 * 1024;

export class WebSocketConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', data => this.#receive(data));
    socket.on('drain', () => this.emit('drain'));
    socket.on('close', () => this.#finish());
    socket.on('error', error => {this.emit('error', error); this.#finish();});
    if (this.buffer.length) queueMicrotask(() => this.#receive(Buffer.alloc(0)));
  }

  get writableLength() {return this.socket.writableLength;}

  send(data) {
    if (this.closed) return false;
    return this.#frame(0x2, data);
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.#frame(0x8, payload);
    this.socket.end();
    this.#finish();
  }

  #finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  #frame(opcode, data) {
    const length = data.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.socket.write(header);
    return this.socket.write(data);
  }

  #receive(data) {
    if (data.length) this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    while (!this.closed && this.buffer.length >= 2) {
      const first = this.buffer[0], second = this.buffer[1];
      const fin = (first & 0x80) !== 0, opcode = first & 0x0f;
      if (first & 0x70) return this.#fail(1002, 'reserved bits set');
      if (!(second & 0x80)) return this.#fail(1002, 'client frames must be masked');
      let length = second & 0x7f, offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.#fail(1009, 'message too large');
        length = Number(big); offset = 10;
      }
      if (length > MAX_MESSAGE) return this.#fail(1009, 'message too large');
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = this.buffer.subarray(offset + 4 + length);
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {this.#frame(0xA, payload); continue;}
      if (opcode === 0xA) continue;
      if (opcode === 0x1) return this.#fail(1003, 'binary messages only');
      if (opcode !== 0x0 && opcode !== 0x2) return this.#fail(1002, 'unknown opcode');
      if (opcode === 0x2 && this.fragments.length) return this.#fail(1002, 'unexpected new message');
      if (opcode === 0x0 && !this.fragments.length) return this.#fail(1002, 'unexpected continuation');
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > MAX_MESSAGE) return this.#fail(1009, 'message too large');
      if (fin) {
        const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
        this.fragments = []; this.fragmentBytes = 0;
        this.emit('message', message);
      }
    }
  }

  #fail(code, reason) {
    this.emit('error', new Error('WebSocket protocol error: ' + reason));
    this.close(code);
  }
}

// Completes the opening handshake, or answers with an HTTP error and returns
// null. `protocols` lists acceptable subprotocols in preference order.
export function acceptWebSocket(request, socket, head, {protocols = []} = {}) {
  const reject = (status, text) => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return null;
  };
  if (request.method !== 'GET') return reject(405, 'Method Not Allowed');
  if (!/\bwebsocket\b/i.test(request.headers.upgrade || '')) return reject(400, 'Bad Request');
  const key = request.headers['sec-websocket-key'];
  if (!key || Buffer.from(key, 'base64').length !== 16) return reject(400, 'Bad Request');
  if (request.headers['sec-websocket-version'] !== '13') return reject(426, 'Upgrade Required');
  const offered = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).filter(Boolean);
  const chosen = protocols.find(protocol => offered.includes(protocol));
  if (offered.length && !chosen) return reject(400, 'Unsupported Subprotocol');
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n` + (chosen ? `Sec-WebSocket-Protocol: ${chosen}\r\n` : '') + '\r\n');
  return new WebSocketConnection(socket, head);
}

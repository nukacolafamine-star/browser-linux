import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomBytes, createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const serverScript = fileURLToPath(new URL('../tools/serve.mjs', import.meta.url));

async function startServer() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [serverScript], {env: {...process.env, PORT: String(port)}, stdio: ['ignore', 'pipe', 'pipe']});
  await new Promise((resolve, reject) => {
    child.stdout.on('data', data => {if (String(data).includes('Browser Linux:')) resolve();});
    child.on('exit', code => reject(new Error('server exited ' + code)));
  });
  return {port, stop: () => child.kill()};
}

// A WebSocket client written against the RFC, independent of the server code.
function connect(port, {origin, protocol = 'binary'} = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    socket.once('connect', () => socket.write(`GET /net HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` + (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '')
      + (origin ? `Origin: ${origin}\r\n` : '') + '\r\n'));
    let buffer = Buffer.alloc(0);
    const onData = data => {
      buffer = Buffer.concat([buffer, data]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const head = buffer.subarray(0, end).toString();
      const status = Number(head.split(' ')[1]);
      if (status !== 101) {socket.destroy(); resolve({status}); return;}
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      assert.match(head, new RegExp('Sec-WebSocket-Accept: ' + accept.replace(/[+/=]/g, '\\$&'), 'i'));
      assert.match(head, /Sec-WebSocket-Protocol: binary/i);
      resolve({status, client: new Client(socket, buffer.subarray(end + 4))});
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

class Client {
  constructor(socket, rest) {
    this.socket = socket; this.buffer = Buffer.from(rest); this.messages = []; this.waiters = [];
    socket.on('data', data => {this.buffer = Buffer.concat([this.buffer, data]); this.parse();});
    this.parse();
  }
  parse() {
    while (this.buffer.length >= 2) {
      let length = this.buffer[1] & 127, offset = 2;
      if (length === 126) {if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4;}
      else if (length === 127) {if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10;}
      if (this.buffer.length < offset + length) return;
      assert.equal(this.buffer[1] & 128, 0, 'server frames are unmasked');
      const opcode = this.buffer[0] & 15, payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      this.messages.push({opcode, payload});
      this.waiters.splice(0).forEach(resolve => resolve());
    }
  }
  frame(opcode, payload, fin = true) {
    const mask = randomBytes(4), masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    let header;
    if (payload.length < 126) header = Buffer.from([(fin ? 128 : 0) | opcode, 128 | payload.length]);
    else if (payload.length < 65536) {header = Buffer.alloc(4); header[0] = (fin ? 128 : 0) | opcode; header[1] = 128 | 126; header.writeUInt16BE(payload.length, 2);}
    else {header = Buffer.alloc(10); header[0] = (fin ? 128 : 0) | opcode; header[1] = 128 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);}
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  async next(opcode) {
    for (;;) {
      const index = this.messages.findIndex(message => message.opcode === opcode);
      if (index >= 0) return this.messages.splice(index, 1)[0].payload;
      await new Promise((resolve, reject) => {this.waiters.push(resolve); setTimeout(() => reject(new Error('timeout')), 5000).unref();});
    }
  }
}

function dhcpDiscoverFrame() {
  const dhcp = Buffer.alloc(300);
  dhcp[0] = 1; dhcp[1] = 1; dhcp[2] = 6; dhcp.writeUInt32BE(0x01020304, 4);
  Buffer.from([0x52, 0x54, 0, 1, 2, 3]).copy(dhcp, 28); dhcp.writeUInt32BE(0x63825363, 236);
  dhcp[240] = 53; dhcp[241] = 1; dhcp[242] = 1; dhcp[243] = 255;
  const frame = Buffer.alloc(42 + dhcp.length);
  frame.fill(255, 0, 6); Buffer.from([0x52, 0x54, 0, 1, 2, 3]).copy(frame, 6); frame.writeUInt16BE(0x0800, 12);
  frame[14] = 0x45; frame.writeUInt16BE(28 + dhcp.length, 16); frame[22] = 64; frame[23] = 17;
  frame.writeUInt32BE(0xffffffff, 30);
  frame.writeUInt16BE(68, 34); frame.writeUInt16BE(67, 36); frame.writeUInt16BE(8 + dhcp.length, 38);
  dhcp.copy(frame, 42);
  return frame;
}

test('relay accepts same-origin guests and exchanges framed Ethernet', async t => {
  const server = await startServer();
  t.after(server.stop);
  const probe = await fetch(`http://127.0.0.1:${server.port}/net`);
  assert.equal(probe.status, 426);
  assert.equal(probe.headers.get('x-browser-linux-network'), 'available');
  assert.equal((await connect(server.port, {origin: 'https://example.com'})).status, 403);
  assert.equal((await connect(server.port, {})).status, 403);
  const {status, client} = await connect(server.port, {origin: `http://127.0.0.1:${server.port}`});
  assert.equal(status, 101);
  // A frame split across a fragmented WebSocket message and a length prefix
  // split from its body must reassemble.
  const frame = dhcpDiscoverFrame();
  const stream = Buffer.concat([Buffer.from([0, 0, frame.length >> 8, frame.length & 255]), frame]);
  client.frame(2, stream.subarray(0, 3), false);
  client.frame(0, stream.subarray(3, 100), false);
  client.frame(0, stream.subarray(100), true);
  client.frame(9, Buffer.from('ping'));
  assert.equal((await client.next(10)).toString(), 'ping');
  const reply = await client.next(2);
  const length = reply.readUInt32BE(0);
  const offer = reply.subarray(4, 4 + length);
  assert.equal(offer.readUInt16BE(12), 0x0800);
  assert.equal(offer.readUInt16BE(36), 68);
  assert.equal(offer.readUInt32BE(42 + 16), 0x0a00020f, 'offers 10.0.2.15');
  client.socket.destroy();
});

test('relay handles large messages with 64-bit lengths', async t => {
  const server = await startServer();
  t.after(server.stop);
  const {client} = await connect(server.port, {origin: `http://localhost:${server.port}`});
  // 70 KB of junk frames: valid framing, ignored as non-IPv4 Ethernet types.
  const frames = [];
  for (let i = 0; i < 50; i++) {const f = Buffer.alloc(1400); f.writeUInt16BE(0x86dd, 12); frames.push(Buffer.from([0, 0, 0x05, 0x78]), f);}
  const frame = dhcpDiscoverFrame();
  frames.push(Buffer.from([0, 0, frame.length >> 8, frame.length & 255]), frame);
  client.frame(2, Buffer.concat(frames));
  const reply = await client.next(2);
  assert.equal(reply.subarray(4).readUInt16BE(36), 68);
  client.socket.destroy();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import {createHash, randomBytes} from 'node:crypto';
import {UserNetwork, ip, isNonPublicAddress, FIN, SYN, RST, PSH, ACK} from '../tools/net/user-network.mjs';

const GUEST_MAC = Buffer.from([0x52, 0x54, 0, 0x12, 0x34, 0x56]);
const GATEWAY_MAC = Buffer.from([0x52, 0x55, 0x0a, 0x00, 0x02, 0x02]);
const GUEST = ip('10.0.2.15'), GATEWAY = ip('10.0.2.2'), DNS = ip('10.0.2.3');

function sum16(buffer, start, end, initial = 0) {
  let sum = initial, i = start;
  for (; i + 1 < end; i += 2) sum += (buffer[i] << 8) | buffer[i + 1];
  if (i < end) sum += buffer[i] << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + Math.floor(sum / 65536);
  return sum;
}
const checksum = (buffer, start, end, initial) => (~sum16(buffer, start, end, initial)) & 0xffff;

function ipv4Frame(src, dst, protocol, payload) {
  const frame = Buffer.alloc(34 + payload.length);
  GATEWAY_MAC.copy(frame, 0); GUEST_MAC.copy(frame, 6);
  frame.writeUInt16BE(0x0800, 12);
  frame[14] = 0x45; frame.writeUInt16BE(20 + payload.length, 16);
  frame.writeUInt16BE(0x4000, 20); frame[22] = 64; frame[23] = protocol;
  frame.writeUInt32BE(src, 26); frame.writeUInt32BE(dst, 30);
  frame.writeUInt16BE(checksum(frame, 14, 34), 24);
  payload.copy(frame, 34);
  if (protocol === 6 || protocol === 17) {
    const pseudo = sum16(frame, 26, 34) + protocol + payload.length;
    const offset = protocol === 6 ? 50 : 40;
    frame.writeUInt16BE(0, offset);
    frame.writeUInt16BE(checksum(frame, 34, frame.length, pseudo) || 0xffff, offset);
  }
  return frame;
}

function udpFrame(src, srcPort, dst, dstPort, data) {
  const udp = Buffer.alloc(8 + data.length);
  udp.writeUInt16BE(srcPort, 0); udp.writeUInt16BE(dstPort, 2); udp.writeUInt16BE(udp.length, 4);
  data.copy(udp, 8);
  return ipv4Frame(src, dst, 17, udp);
}

function tcpFrame({srcPort, dst, dstPort, seq, ack = 0, flags, window = 65535, data = Buffer.alloc(0), options = Buffer.alloc(0)}) {
  const tcp = Buffer.alloc(20 + options.length + data.length);
  tcp.writeUInt16BE(srcPort, 0); tcp.writeUInt16BE(dstPort, 2);
  tcp.writeUInt32BE(seq >>> 0, 4); tcp.writeUInt32BE(ack >>> 0, 8);
  tcp[12] = ((20 + options.length) / 4) << 4; tcp[13] = flags;
  tcp.writeUInt16BE(window, 14);
  options.copy(tcp, 20); data.copy(tcp, 20 + options.length);
  return ipv4Frame(GUEST, dst, 6, tcp);
}

// Parses and validates a frame the network sent to the guest.
function parse(frame) {
  const type = frame.readUInt16BE(12);
  if (type === 0x0806) return {type: 'arp', op: frame.readUInt16BE(20), senderMac: frame.subarray(22, 28), senderIp: frame.readUInt32BE(28)};
  assert.equal(type, 0x0800);
  assert.equal(sum16(frame, 14, 34), 0xffff, 'IPv4 header checksum');
  const protocol = frame[23], src = frame.readUInt32BE(26), dst = frame.readUInt32BE(30);
  const total = frame.readUInt16BE(16);
  assert.equal(total, frame.length - 14);
  const payload = frame.subarray(34);
  if (protocol === 6 || protocol === 17) {
    const pseudo = sum16(frame, 26, 34) + protocol + payload.length;
    assert.equal(sum16(frame, 34, frame.length, pseudo), 0xffff, 'transport checksum');
  }
  if (protocol === 17) return {type: 'udp', src, dst, srcPort: payload.readUInt16BE(0), dstPort: payload.readUInt16BE(2), data: payload.subarray(8)};
  if (protocol === 1) return {type: 'icmp', src, dst, icmpType: payload[0], data: payload.subarray(4)};
  const offset = (payload[12] >> 4) * 4;
  return {type: 'tcp', src, dst, srcPort: payload.readUInt16BE(0), dstPort: payload.readUInt16BE(2),
    seq: payload.readUInt32BE(4), ack: payload.readUInt32BE(8), flags: payload[13], window: payload.readUInt16BE(14),
    options: payload.subarray(20, offset), data: payload.subarray(offset)};
}

function harness(options = {}) {
  const received = [];
  const waiters = [];
  const network = new UserNetwork({...options, send: frame => {
    const packet = parse(frame);
    received.push(packet);
    for (const waiter of [...waiters]) {
      if (waiter.match(packet)) {waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(packet);}
    }
  }});
  const next = (match, timeout = 5000) => {
    const found = received.find(match);
    if (found) {received.splice(received.indexOf(found), 1); return Promise.resolve(found);}
    return new Promise((resolve, reject) => {
      const waiter = {match: packet => {if (!match(packet)) return false; received.splice(received.indexOf(packet), 1); return true;}, resolve};
      waiters.push(waiter);
      setTimeout(() => reject(new Error('timed out waiting for a packet')), timeout).unref();
    });
  };
  return {network, received, next};
}

// Enough of a guest TCP client to exercise the network's TCP termination.
class GuestTcp {
  constructor(h, dst, dstPort, {window = 65535, shift = 7} = {}) {
    Object.assign(this, {h, dst, dstPort, window, shift});
    this.srcPort = 40000 + Math.floor(Math.random() * 20000);
    this.seq = 1000;
    this.received = [];
    this.receivedBytes = 0;
    this.remoteFin = false;
  }
  frame(flags, data = Buffer.alloc(0), options) {
    return tcpFrame({srcPort: this.srcPort, dst: this.dst, dstPort: this.dstPort, seq: this.seq,
      ack: this.ack, flags, window: this.window, data, options});
  }
  mine = packet => packet.type === 'tcp' && packet.dstPort === this.srcPort && packet.srcPort === this.dstPort;
  async connect() {
    this.h.network.receive(this.frame(SYN, undefined, Buffer.from([2, 4, 5, 180, 1, 3, 3, this.shift])));
    this.seq++;
    const synAck = await this.h.next(this.mine);
    return synAck;
  }
  established(synAck) {
    this.ack = (synAck.seq + 1) >>> 0;
    this.h.network.receive(this.frame(ACK));
  }
  send(data) {
    for (let offset = 0; offset < data.length; offset += 1460) {
      const chunk = data.subarray(offset, offset + 1460);
      this.h.network.receive(this.frame(ACK | PSH, chunk));
      this.seq += chunk.length;
    }
  }
  // Receives in-order data until `bytes` arrive or FIN, acknowledging as it goes.
  async receive(bytes, {ackEvery = 1} = {}) {
    let segments = 0;
    while (this.receivedBytes < bytes && !this.remoteFin) {
      const packet = await this.h.next(this.mine, 10000);
      assert.equal(packet.flags & RST, 0, 'unexpected reset');
      if (packet.seq === this.ack && packet.data.length) {
        this.received.push(Buffer.from(packet.data));
        this.receivedBytes += packet.data.length;
        this.ack = (this.ack + packet.data.length) >>> 0;
      }
      if (packet.flags & FIN && ((packet.seq + packet.data.length) >>> 0) === this.ack) {
        this.remoteFin = true; this.ack = (this.ack + 1) >>> 0;
      }
      if (++segments % ackEvery === 0 || this.remoteFin || this.receivedBytes >= bytes) this.h.network.receive(this.frame(ACK));
    }
    return Buffer.concat(this.received);
  }
}

test('non-public destination ranges are recognized', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.1.1', '100.64.0.1', '224.0.0.1', '255.255.255.255'])
    assert.equal(isNonPublicAddress(ip(address)), true, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '140.82.112.3', '172.32.0.1'])
    assert.equal(isNonPublicAddress(ip(address)), false, address);
});

test('answers ARP for the gateway and DNS addresses only', async () => {
  const h = harness();
  const arp = target => {
    const frame = Buffer.alloc(42);
    Buffer.alloc(6, 255).copy(frame, 0); GUEST_MAC.copy(frame, 6); frame.writeUInt16BE(0x0806, 12);
    frame.writeUInt16BE(1, 14); frame.writeUInt16BE(0x0800, 16); frame[18] = 6; frame[19] = 4; frame.writeUInt16BE(1, 20);
    GUEST_MAC.copy(frame, 22); frame.writeUInt32BE(GUEST, 28); frame.writeUInt32BE(target, 38);
    return frame;
  };
  h.network.receive(arp(GATEWAY));
  const reply = await h.next(packet => packet.type === 'arp');
  assert.equal(reply.op, 2);
  assert.deepEqual([...reply.senderMac], [...GATEWAY_MAC]);
  assert.equal(reply.senderIp, GATEWAY);
  h.network.receive(arp(GUEST)); // duplicate-address probe must stay unanswered
  h.network.receive(arp(ip('10.0.2.99')));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.received.length, 0);
  h.network.close();
});

test('serves DHCP offers and acknowledgements', async () => {
  const h = harness();
  const dhcp = type => {
    const message = Buffer.alloc(300);
    message[0] = 1; message[1] = 1; message[2] = 6; message.writeUInt32BE(0xdeadbeef, 4);
    GUEST_MAC.copy(message, 28); message.writeUInt32BE(0x63825363, 236);
    message[240] = 53; message[241] = 1; message[242] = type; message[243] = 255;
    return udpFrame(0, 68, 0xffffffff, 67, message);
  };
  const options = data => {
    const result = {};
    for (let i = 240; i < data.length && data[i] !== 255;) {result[data[i]] = data.subarray(i + 2, i + 2 + data[i + 1]); i += 2 + data[i + 1];}
    return result;
  };
  h.network.receive(dhcp(1));
  const offer = await h.next(packet => packet.type === 'udp' && packet.dstPort === 68);
  assert.equal(offer.data.readUInt32BE(4), 0xdeadbeef);
  assert.equal(offer.data.readUInt32BE(16), GUEST);
  let parsed = options(offer.data);
  assert.equal(parsed[53][0], 2);
  assert.equal(parsed[3].readUInt32BE(0), GATEWAY);
  assert.equal(parsed[6].readUInt32BE(0), DNS);
  h.network.receive(dhcp(3));
  const ack = await h.next(packet => packet.type === 'udp' && packet.dstPort === 68);
  parsed = options(ack.data);
  assert.equal(parsed[53][0], 5);
  assert.equal(parsed[1].readUInt32BE(0), ip('255.255.255.0'));
  h.network.close();
});

test('answers ping to the gateway', async () => {
  const h = harness();
  const echo = Buffer.from([8, 0, 0, 0, 0x12, 0x34, 0, 1, 1, 2, 3, 4]);
  echo.writeUInt16BE(checksum(echo, 0, echo.length), 2);
  h.network.receive(ipv4Frame(GUEST, GATEWAY, 1, echo));
  const reply = await h.next(packet => packet.type === 'icmp');
  assert.equal(reply.icmpType, 0);
  assert.equal(reply.src, GATEWAY);
  assert.deepEqual([...reply.data], [0x12, 0x34, 0, 1, 1, 2, 3, 4]);
  h.network.close();
});

test('forwards DNS queries to the host resolver', async () => {
  const resolver = dgram.createSocket('udp4');
  await new Promise(resolve => resolver.bind(0, '127.0.0.1', resolve));
  resolver.on('message', (query, remote) => resolver.send(Buffer.concat([query, Buffer.from('answer')]), remote.port, remote.address));
  const h = harness({resolvers: [{address: '127.0.0.1', port: resolver.address().port, family: 4}]});
  const query = Buffer.from('0102010000010000000000000765786d706c6503636f6d0000010001', 'hex');
  h.network.receive(udpFrame(GUEST, 5353, DNS, 53, query));
  const answer = await h.next(packet => packet.type === 'udp' && packet.dstPort === 5353);
  assert.equal(answer.src, DNS);
  assert.equal(answer.srcPort, 53);
  assert.equal(answer.data.subarray(query.length).toString(), 'answer');
  h.network.close();
  resolver.close();
});

test('refuses non-public TCP destinations by default', async () => {
  const h = harness();
  const guest = new GuestTcp(h, ip('127.0.0.1'), 22);
  const reply = await guest.connect();
  assert.equal(reply.flags & RST, RST);
  assert.equal(reply.ack, guest.seq);
  assert.equal(h.network.tcp.size, 0);
  h.network.close();
});

test('resets a connection the remote host refuses', async () => {
  const h = harness({allowNonPublic: true});
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const guest = new GuestTcp(h, ip('127.0.0.1'), port);
  const reply = await guest.connect();
  assert.equal(reply.flags & (RST | ACK), RST | ACK);
  assert.equal(reply.ack, guest.seq);
  h.network.close();
});

test('carries bulk TCP data in both directions with flow control and half-close', async () => {
  const download = randomBytes(3 * 1024 * 1024 + 123);
  const upload = randomBytes(2 * 1024 * 1024 + 7);
  const uploaded = [];
  let serverFinished;
  const serverDone = new Promise(resolve => {serverFinished = resolve;});
  const server = net.createServer(socket => {
    socket.on('data', data => uploaded.push(data));
    socket.on('end', () => {
      // Answer only after the guest half-closes, then close our side.
      socket.end(download);
      server.close();
      serverFinished();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const h = harness({allowNonPublic: true});
  const guest = new GuestTcp(h, ip('127.0.0.1'), server.address().port, {window: 32768, shift: 2});
  const synAck = await guest.connect();
  assert.equal(synAck.flags, SYN | ACK);
  assert.equal(synAck.ack, guest.seq);
  assert.deepEqual([...synAck.options.subarray(0, 4)], [2, 4, 5, 180]);
  guest.established(synAck);
  // Send in windowed rounds, waiting for acknowledgements like a real sender.
  for (let offset = 0; offset < upload.length; offset += 65536) {
    guest.send(upload.subarray(offset, offset + 65536));
    const expected = guest.seq;
    await h.next(packet => guest.mine(packet) && packet.ack === expected);
  }
  h.network.receive(guest.frame(FIN | ACK));
  guest.seq++;
  const received = await guest.receive(download.length + 1, {ackEvery: 4});
  await serverDone;
  assert.equal(Buffer.concat(uploaded).length, upload.length);
  assert.equal(createHash('sha256').update(Buffer.concat(uploaded)).digest('hex'), createHash('sha256').update(upload).digest('hex'));
  assert.equal(received.length, download.length);
  assert.equal(createHash('sha256').update(received).digest('hex'), createHash('sha256').update(download).digest('hex'));
  assert.equal(guest.remoteFin, true);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.network.tcp.size, 0, 'connection released after both FINs are acknowledged');
  h.network.close();
});

test('retransmits unacknowledged data', async () => {
  const server = net.createServer(socket => socket.end(Buffer.from('retransmitted payload')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const h = harness({allowNonPublic: true});
  const guest = new GuestTcp(h, ip('127.0.0.1'), server.address().port);
  guest.established(await guest.connect());
  const first = await h.next(packet => guest.mine(packet) && packet.data.length > 0);
  // Drop the first copy: do not acknowledge it. It must be sent again.
  const again = await h.next(packet => guest.mine(packet) && packet.data.length > 0, 4000);
  assert.equal(again.seq, first.seq);
  assert.equal(again.data.toString(), 'retransmitted payload');
  h.network.close();
  server.close();
});

test('relays UDP datagrams and their replies', async () => {
  const echo = dgram.createSocket('udp4');
  await new Promise(resolve => echo.bind(0, '127.0.0.1', resolve));
  echo.on('message', (message, remote) => echo.send(Buffer.concat([Buffer.from('re:'), message]), remote.port, remote.address));
  const h = harness({allowNonPublic: true});
  h.network.receive(udpFrame(GUEST, 34567, ip('127.0.0.1'), echo.address().port, Buffer.from('ping')));
  const reply = await h.next(packet => packet.type === 'udp' && packet.dstPort === 34567);
  assert.equal(reply.src, ip('127.0.0.1'));
  assert.equal(reply.srcPort, echo.address().port);
  assert.equal(reply.data.toString(), 're:ping');
  h.network.close();
  echo.close();
});

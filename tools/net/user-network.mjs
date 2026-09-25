// SPDX-License-Identifier: GPL-2.0-only
// User-mode IPv4 network for the browser's Linux guest, in the spirit of
// QEMU's slirp. The guest sees an ordinary Ethernet segment with DHCP:
//   10.0.2.15 guest, 10.0.2.2 gateway, 10.0.2.3 DNS.
// Guest TCP connections and UDP flows are terminated here and carried by this
// process's own sockets. No guest code runs here; this only forwards traffic.
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import {randomInt} from 'node:crypto';

const ETHERTYPE_IPV4 = 0x0800, ETHERTYPE_ARP = 0x0806;
const ICMP = 1, TCP = 6, UDP = 17;
export const FIN = 0x01, SYN = 0x02, RST = 0x04, PSH = 0x08, ACK = 0x10;
const EMPTY = Buffer.alloc(0);
const BROADCAST_MAC = Buffer.from([255, 255, 255, 255, 255, 255]);

// Data buffered from a remote socket toward the guest, and data accepted from
// the guest that the remote socket has not yet taken.
const SEND_HIGH = 4 * 1024 * 1024, SEND_LOW = 1024 * 1024;
const RECEIVE_WINDOW = 1024 * 1024;
const OUR_WINDOW_SHIFT = 7;
const MAX_MSS = 1460;

export const ip = text => text.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
export const ipText = value => [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
const seqDiff = (a, b) => (a - b) | 0;
const seqAdd = (a, n) => (a + n) >>> 0;

function sum16(buffer, start, end, initial = 0) {
  let sum = initial, i = start;
  for (; i + 1 < end; i += 2) sum += (buffer[i] << 8) | buffer[i + 1];
  if (i < end) sum += buffer[i] << 8;
  return sum;
}
function fold(sum) {
  while (sum > 0xffff) sum = (sum & 0xffff) + Math.floor(sum / 65536);
  return (~sum) & 0xffff;
}

const reserved = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ip(base), bits]);
// Loopback, private, link-local, multicast and other non-public ranges. The
// guest may not reach the user's own machine or local network by default.
export function isNonPublicAddress(address) {
  return reserved.some(([base, bits]) => ((address ^ base) >>> (32 - bits)) === 0);
}

function parseTcpOptions(options) {
  const result = {};
  for (let i = 0; i < options.length;) {
    const kind = options[i];
    if (kind === 0) break;
    if (kind === 1) {i++; continue;}
    const length = options[i + 1];
    if (!length || length < 2 || i + length > options.length) break;
    if (kind === 2 && length === 4) result.mss = options.readUInt16BE(i + 2);
    if (kind === 3 && length === 3) result.wscale = options[i + 2];
    i += length;
  }
  return result;
}

function hostResolvers() {
  const servers = [];
  for (const entry of dns.getServers()) {
    const match = /^\[(.+)\](?::(\d+))?$/.exec(entry);
    const address = match ? match[1] : entry;
    const port = match?.[2] ? Number(match[2]) : 53;
    const family = net.isIP(address.replace(/%.*$/, ''));
    if (family) servers.push({address, port, family});
  }
  servers.sort((a, b) => a.family - b.family);
  return servers.length ? servers : [{address: '1.1.1.1', port: 53, family: 4}];
}

export class UserNetwork {
  constructor({send, allowNonPublic = false, resolvers = hostResolvers(), log = () => {},
    maxTcp = 512, maxUdp = 256, connect = options => net.connect(options)} = {}) {
    this.transmit = send;
    this.allowNonPublic = allowNonPublic;
    this.resolvers = resolvers;
    this.log = log;
    this.maxTcp = maxTcp;
    this.maxUdp = maxUdp;
    this.connect = connect;
    this.gateway = ip('10.0.2.2');
    this.dns = ip('10.0.2.3');
    this.guestAddress = ip('10.0.2.15');
    this.gatewayMac = Buffer.from([0x52, 0x55, 0x0a, 0x00, 0x02, 0x02]);
    this.guestMac = null;
    this.ipId = randomInt(65536);
    this.tcp = new Map();
    this.udp = new Map();
    this.pendingDns = 0;
    this.closed = false;
    this.stats = {framesIn: 0, framesOut: 0, tcpConnections: 0, udpFlows: 0, dnsQueries: 0, refused: 0};
  }

  receive(frame) {
    if (this.closed || frame.length < 14) return;
    this.stats.framesIn++;
    if (!(frame[6] & 1)) this.guestMac = Buffer.from(frame.subarray(6, 12));
    const type = frame.readUInt16BE(12);
    if (type === ETHERTYPE_ARP) this.#arp(frame.subarray(14));
    else if (type === ETHERTYPE_IPV4) this.#ipv4(frame.subarray(14));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const connection of [...this.tcp.values()]) connection.destroy();
    for (const flow of [...this.udp.values()]) this.#closeUdp(flow);
  }

  allowed(address) {
    return this.allowNonPublic || !isNonPublicAddress(address);
  }

  emit(frame) {
    if (this.closed) return;
    this.stats.framesOut++;
    this.transmit(frame);
  }

  #arp(arp) {
    if (arp.length < 28 || arp.readUInt16BE(0) !== 1 || arp.readUInt16BE(2) !== ETHERTYPE_IPV4) return;
    if (arp[4] !== 6 || arp[5] !== 4 || arp.readUInt16BE(6) !== 1) return;
    const target = arp.readUInt32BE(24);
    if (target !== this.gateway && target !== this.dns) return;
    const reply = Buffer.alloc(42);
    arp.copy(reply, 0, 8, 14);
    this.gatewayMac.copy(reply, 6);
    reply.writeUInt16BE(ETHERTYPE_ARP, 12);
    reply.writeUInt16BE(1, 14); reply.writeUInt16BE(ETHERTYPE_IPV4, 16);
    reply[18] = 6; reply[19] = 4; reply.writeUInt16BE(2, 20);
    this.gatewayMac.copy(reply, 22); reply.writeUInt32BE(target, 28);
    arp.copy(reply, 32, 8, 18);
    this.emit(reply);
  }

  #ipv4(packet) {
    if (packet.length < 20 || packet[0] >> 4 !== 4) return;
    const headerLength = (packet[0] & 15) * 4, total = packet.readUInt16BE(2);
    if (headerLength < 20 || total < headerLength || total > packet.length) return;
    if (packet.readUInt16BE(6) & 0x3fff) return; // fragments are not supported
    const src = packet.readUInt32BE(12), dst = packet.readUInt32BE(16), payload = packet.subarray(headerLength, total);
    if (packet[9] === TCP) this.#tcp(src, dst, payload);
    else if (packet[9] === UDP) this.#udp(src, dst, payload);
    else if (packet[9] === ICMP) this.#icmp(src, dst, payload);
  }

  // Ethernet + IPv4 frame with room for `length` transport bytes at offset 34.
  #ipFrame(src, dst, protocol, length) {
    const frame = Buffer.alloc(34 + length);
    (this.guestMac || BROADCAST_MAC).copy(frame, 0);
    this.gatewayMac.copy(frame, 6);
    frame.writeUInt16BE(ETHERTYPE_IPV4, 12);
    frame[14] = 0x45;
    frame.writeUInt16BE(20 + length, 16);
    this.ipId = (this.ipId + 1) & 0xffff;
    frame.writeUInt16BE(this.ipId, 18);
    frame.writeUInt16BE(0x4000, 20);
    frame[22] = 64; frame[23] = protocol;
    frame.writeUInt32BE(src, 26); frame.writeUInt32BE(dst, 30);
    frame.writeUInt16BE(fold(sum16(frame, 14, 34)), 24);
    return frame;
  }

  #transportChecksum(frame, protocol) {
    const pseudo = sum16(frame, 26, 34) + protocol + (frame.length - 34);
    return fold(sum16(frame, 34, frame.length, pseudo));
  }

  sendUdp(src, srcPort, dst, dstPort, data) {
    const frame = this.#ipFrame(src, dst, UDP, 8 + data.length);
    frame.writeUInt16BE(srcPort, 34); frame.writeUInt16BE(dstPort, 36);
    frame.writeUInt16BE(8 + data.length, 38);
    data.copy(frame, 42);
    frame.writeUInt16BE(this.#transportChecksum(frame, UDP) || 0xffff, 40);
    this.emit(frame);
  }

  sendTcp(src, srcPort, dst, dstPort, seq, ack, flags, window, data = EMPTY, options = EMPTY) {
    const headerLength = 20 + options.length;
    const frame = this.#ipFrame(src, dst, TCP, headerLength + data.length);
    frame.writeUInt16BE(srcPort, 34); frame.writeUInt16BE(dstPort, 36);
    frame.writeUInt32BE(seq, 38); frame.writeUInt32BE(ack, 42);
    frame[46] = (headerLength / 4) << 4; frame[47] = flags;
    frame.writeUInt16BE(window, 48);
    options.copy(frame, 54);
    data.copy(frame, 34 + headerLength);
    frame.writeUInt16BE(this.#transportChecksum(frame, TCP), 50);
    this.emit(frame);
  }

  #icmp(src, dst, message) {
    if (message.length < 8 || message[0] !== 8 || (dst !== this.gateway && dst !== this.dns)) return;
    const frame = this.#ipFrame(dst, src, ICMP, message.length);
    message.copy(frame, 34);
    frame[34] = 0;
    frame.writeUInt16BE(0, 36);
    frame.writeUInt16BE(fold(sum16(frame, 34, frame.length)), 36);
    this.emit(frame);
  }

  #udp(src, dst, segment) {
    if (segment.length < 8) return;
    const srcPort = segment.readUInt16BE(0), dstPort = segment.readUInt16BE(2), length = segment.readUInt16BE(4);
    if (length < 8 || length > segment.length) return;
    const data = segment.subarray(8, length);
    if (dstPort === 67 && srcPort === 68) return this.#dhcp(data);
    if (dst === this.dns && dstPort === 53) return this.#dnsQuery(src, srcPort, data);
    if (dst === this.gateway || dst === this.dns) return;
    if (!this.allowed(dst)) {this.stats.refused++; return;}
    this.#udpForward(src, srcPort, dst, dstPort, data);
  }

  #dhcp(request) {
    if (request.length < 240 || request[0] !== 1 || request.readUInt32BE(236) !== 0x63825363) return;
    let type = 0;
    for (let i = 240; i < request.length;) {
      const code = request[i];
      if (code === 255) break;
      if (code === 0) {i++; continue;}
      if (i + 1 >= request.length) break;
      if (code === 53) type = request[i + 2];
      i += 2 + request[i + 1];
    }
    const replyType = type === 1 ? 2 : type === 3 ? 5 : 0; // DISCOVER→OFFER, REQUEST→ACK
    if (!replyType) return;
    const reply = Buffer.alloc(320);
    reply[0] = 2; reply[1] = 1; reply[2] = 6;
    request.copy(reply, 4, 4, 8);
    request.copy(reply, 10, 10, 12);
    reply.writeUInt32BE(this.guestAddress, 16);
    reply.writeUInt32BE(this.gateway, 20);
    request.copy(reply, 28, 28, 44);
    reply.writeUInt32BE(0x63825363, 236);
    let offset = 240;
    const option = (code, bytes) => {reply[offset++] = code; reply[offset++] = bytes.length; for (const byte of bytes) reply[offset++] = byte;};
    const address = value => [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    option(53, [replyType]);
    option(54, address(this.gateway));
    option(51, address(86400));
    option(1, address(ip('255.255.255.0')));
    option(3, address(this.gateway));
    option(6, address(this.dns));
    option(26, [1500 >> 8, 1500 & 255]);
    reply[offset++] = 255;
    this.sendUdp(this.gateway, 67, 0xffffffff, 68, reply.subarray(0, offset));
  }

  #dnsQuery(src, srcPort, query) {
    if (query.length < 12 || this.pendingDns >= 128) return;
    this.stats.dnsQueries++;
    const resolver = this.resolvers[0];
    const socket = dgram.createSocket(resolver.family === 6 ? 'udp6' : 'udp4');
    this.pendingDns++;
    let done = false;
    const finish = () => {if (done) return; done = true; this.pendingDns--; clearTimeout(timer); socket.close();};
    const timer = setTimeout(finish, 5000);
    socket.on('message', (answer, remote) => {
      if (remote.port !== resolver.port) return;
      finish();
      this.sendUdp(this.dns, 53, src, srcPort, answer);
    });
    socket.on('error', finish);
    socket.send(query, resolver.port, resolver.address, error => {if (error) finish();});
  }

  #udpForward(src, srcPort, dst, dstPort, data) {
    let flow = this.udp.get(srcPort);
    if (!flow) {
      if (this.udp.size >= this.maxUdp) {this.stats.refused++; return;}
      const socket = dgram.createSocket('udp4');
      flow = {socket, src, srcPort, peers: new Set(), timer: null};
      socket.on('message', (message, remote) => {
        const address = net.isIPv4(remote.address) ? ip(remote.address) : null;
        if (address === null || !flow.peers.has(address + ':' + remote.port)) return;
        this.#touchUdp(flow);
        this.sendUdp(address, remote.port, flow.src, flow.srcPort, message);
      });
      socket.on('error', () => this.#closeUdp(flow));
      socket.bind(0);
      this.udp.set(srcPort, flow);
      this.stats.udpFlows++;
    }
    flow.peers.add(dst + ':' + dstPort);
    this.#touchUdp(flow);
    flow.socket.send(data, dstPort, ipText(dst));
  }

  #touchUdp(flow) {
    clearTimeout(flow.timer);
    flow.timer = setTimeout(() => this.#closeUdp(flow), 120000);
  }

  #closeUdp(flow) {
    clearTimeout(flow.timer);
    if (this.udp.get(flow.srcPort) === flow) this.udp.delete(flow.srcPort);
    try {flow.socket.close();} catch {}
  }

  #tcp(src, dst, segment) {
    if (segment.length < 20) return;
    const offset = (segment[12] >> 4) * 4;
    if (offset < 20 || offset > segment.length) return;
    const tcp = {
      srcPort: segment.readUInt16BE(0), dstPort: segment.readUInt16BE(2),
      seq: segment.readUInt32BE(4), ack: segment.readUInt32BE(8),
      flags: segment[13], window: segment.readUInt16BE(14),
      options: segment.subarray(20, offset), data: segment.subarray(offset),
    };
    const key = src + ':' + tcp.srcPort + ':' + dst + ':' + tcp.dstPort;
    const existing = this.tcp.get(key);
    if (existing) {existing.receive(tcp); return;}
    if (tcp.flags & RST) return;
    const target = (tcp.flags & (SYN | ACK)) === SYN && this.tcp.size < this.maxTcp && this.#tcpTarget(dst, tcp.dstPort);
    if (!target) {
      this.stats.refused++;
      // RFC 793 reset for a segment that belongs to no connection.
      const length = tcp.data.length + (tcp.flags & SYN ? 1 : 0) + (tcp.flags & FIN ? 1 : 0);
      if (tcp.flags & ACK) this.sendTcp(dst, tcp.dstPort, src, tcp.srcPort, tcp.ack, 0, RST, 0);
      else this.sendTcp(dst, tcp.dstPort, src, tcp.srcPort, 0, seqAdd(tcp.seq, length), RST | ACK, 0);
      return;
    }
    this.stats.tcpConnections++;
    this.tcp.set(key, new TcpConnection(this, key, src, dst, tcp, target));
  }

  #tcpTarget(dst, port) {
    if (dst === this.dns && port === 53) return {host: this.resolvers[0].address, port: this.resolvers[0].port};
    if (dst === this.gateway || dst === this.dns || !this.allowed(dst)) return null;
    return {host: ipText(dst), port};
  }
}

class TcpConnection {
  constructor(network, key, guestIp, remoteIp, syn, target) {
    this.network = network;
    this.key = key;
    this.guestIp = guestIp; this.guestPort = syn.srcPort;
    this.remoteIp = remoteIp; this.remotePort = syn.dstPort;
    const options = parseTcpOptions(syn.options);
    this.mss = Math.min(options.mss || 536, MAX_MSS);
    this.scaling = options.wscale !== undefined;
    this.guestShift = this.scaling ? Math.min(options.wscale, 14) : 0;
    this.ourShift = this.scaling ? OUR_WINDOW_SHIFT : 0;
    this.guestWindow = syn.window;
    this.guestNext = seqAdd(syn.seq, 1);
    this.iss = randomInt(0, 0x100000000);
    this.una = this.iss;
    this.next = seqAdd(this.iss, 1);
    this.state = 'connecting';
    this.queue = []; this.queueBytes = 0; this.sent = 0;
    this.remoteEnded = false; this.finSent = false; this.finAcked = false; this.guestFin = false;
    this.rto = 1000; this.retries = 0; this.timer = null;
    this.socket = network.connect({host: target.host, port: target.port});
    this.socket.setNoDelay?.(true);
    this.socket.on('connect', () => this.#connected());
    this.socket.on('data', data => this.#remoteData(data));
    this.socket.on('end', () => {this.remoteEnded = true; this.#pump(); this.#maybeFinish();});
    this.socket.on('drain', () => this.#sendAck());
    this.socket.on('error', () => {});
    this.socket.on('close', hadError => this.#remoteClosed(hadError));
    this.connectTimer = setTimeout(() => this.abort(), 30000);
  }

  #send(flags, seq, data = EMPTY, options = EMPTY) {
    this.network.sendTcp(this.remoteIp, this.remotePort, this.guestIp, this.guestPort,
      seq, this.guestNext, flags, this.#window(), data, options);
  }

  #window() {
    const free = Math.max(0, RECEIVE_WINDOW - (this.socket.writableLength || 0));
    return Math.min(0xffff, free >>> this.ourShift);
  }

  #sendAck() {
    if (this.state === 'established') this.#send(ACK, this.next);
  }

  #sendSynAck() {
    const options = [2, 4, MAX_MSS >> 8, MAX_MSS & 255];
    if (this.scaling) options.push(1, 3, 3, this.ourShift);
    // The window in a SYN segment is never scaled.
    this.network.sendTcp(this.remoteIp, this.remotePort, this.guestIp, this.guestPort,
      this.iss, this.guestNext, SYN | ACK, Math.min(0xffff, RECEIVE_WINDOW), EMPTY, Buffer.from(options));
    this.#armTimer();
  }

  #connected() {
    clearTimeout(this.connectTimer);
    if (this.state !== 'connecting') return;
    this.state = 'syn-received';
    this.#sendSynAck();
  }

  receive(segment) {
    if (segment.flags & RST) {this.destroy(); return;}
    if (this.state === 'connecting') return; // guest retransmits SYN until the remote answers
    if (segment.flags & SYN) {
      if (this.state === 'syn-received') this.#sendSynAck();
      return;
    }
    if (!(segment.flags & ACK)) return;
    if (this.state === 'syn-received') {
      if (segment.ack !== this.next) return;
      this.state = 'established';
      this.una = this.next;
      this.#clearTimer();
    }
    let reply = false;
    if (segment.data.length) {this.#guestData(segment.seq, segment.data); reply = true;}
    if (segment.flags & FIN) {
      if (seqAdd(segment.seq, segment.data.length) === this.guestNext && !this.guestFin) {
        this.guestFin = true;
        this.guestNext = seqAdd(this.guestNext, 1);
        this.socket.end();
      }
      reply = true;
    }
    this.#acknowledge(segment.ack, segment.window);
    if (reply) this.#sendAck();
    this.#maybeFinish();
  }

  #guestData(seq, data) {
    const already = seqDiff(this.guestNext, seq);
    if (already < 0 || already >= data.length || this.guestFin) return; // gap or duplicate
    const fresh = Buffer.from(data.subarray(already));
    this.guestNext = seqAdd(this.guestNext, fresh.length);
    this.socket.write(fresh);
  }

  #acknowledge(ack, window) {
    const acked = seqDiff(ack, this.una), inFlight = seqDiff(this.next, this.una);
    if (acked < 0 || acked > inFlight) return;
    if (acked > 0) {
      let data = acked;
      if (this.finSent && ack === this.next) {this.finAcked = true; data--;}
      this.#consume(data);
      this.una = ack;
      this.retries = 0; this.rto = 1000;
      this.#clearTimer();
    }
    this.guestWindow = window << this.guestShift;
    if (this.queueBytes < SEND_LOW && this.socket.isPaused?.()) this.socket.resume();
    this.#pump();
  }

  #consume(count) {
    this.queueBytes -= count; this.sent -= count;
    while (count > 0) {
      const first = this.queue[0];
      if (first.length <= count) {count -= first.length; this.queue.shift();}
      else {this.queue[0] = first.subarray(count); count = 0;}
    }
  }

  #remoteData(data) {
    if (this.state === 'closed') return;
    this.queue.push(data); this.queueBytes += data.length;
    if (this.queueBytes > SEND_HIGH) this.socket.pause();
    this.#pump();
  }

  #peek(offset, length) {
    let index = 0;
    while (offset >= this.queue[index].length) {offset -= this.queue[index].length; index++;}
    const first = this.queue[index];
    if (offset + length <= first.length) return first.subarray(offset, offset + length);
    const out = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = this.queue[index++].subarray(offset, offset + length - written);
      chunk.copy(out, written); written += chunk.length; offset = 0;
    }
    return out;
  }

  #pump() {
    if (this.state !== 'established') return;
    while (this.sent < this.queueBytes) {
      const room = this.guestWindow - seqDiff(this.next, this.una);
      if (room <= 0) break;
      const length = Math.min(this.mss, this.queueBytes - this.sent, room);
      this.#send(ACK | PSH, this.next, this.#peek(this.sent, length));
      this.next = seqAdd(this.next, length);
      this.sent += length;
    }
    if (this.remoteEnded && !this.finSent && this.sent === this.queueBytes) {
      this.#send(FIN | ACK, this.next);
      this.next = seqAdd(this.next, 1);
      this.finSent = true;
    }
    if (seqDiff(this.next, this.una) > 0) this.#armTimer();
    else if (this.sent < this.queueBytes) this.#armProbe();
  }

  #armTimer() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (++this.retries > 10) {this.abort(); return;}
      this.rto = Math.min(this.rto * 2, 30000);
      if (this.state === 'syn-received') {this.#sendSynAck(); return;}
      // Go back to the oldest unacknowledged byte and send again.
      this.next = this.una; this.sent = 0;
      if (this.finSent && !this.finAcked) this.finSent = false;
      this.#pump();
    }, this.rto);
  }

  // The guest advertised a zero window. A segment just below its expected
  // sequence number makes it answer with its current window.
  #armProbe() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state !== 'established') return;
      this.#send(ACK, seqAdd(this.next, -1));
      this.#armProbe();
    }, 1000);
  }

  #clearTimer() {clearTimeout(this.timer); this.timer = null;}

  #remoteClosed(hadError) {
    if (this.state === 'closed') return;
    if (hadError || this.state !== 'established') {this.abort(); return;}
    this.remoteEnded = true;
    this.#pump();
    this.#maybeFinish();
  }

  #maybeFinish() {
    if (this.guestFin && this.finAcked) this.destroy();
  }

  abort() {
    if (this.state === 'closed') return;
    this.network.sendTcp(this.remoteIp, this.remotePort, this.guestIp, this.guestPort,
      this.next, this.guestNext, RST | ACK, 0);
    this.destroy();
  }

  destroy() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this.connectTimer);
    this.#clearTimer();
    this.socket.destroy();
    if (this.network.tcp.get(this.key) === this) this.network.tcp.delete(this.key);
  }
}

// Connects a WebSocket carrying QEMU's `-netdev socket` stream (each frame is
// preceded by its 32-bit big-endian length) to a new user-mode network.
export function attachNetwork(ws, options = {}) {
  let pending = EMPTY, outgoing = [], outgoingBytes = 0, scheduled = false;
  const flush = () => {
    scheduled = false;
    if (!outgoing.length) return;
    const message = Buffer.concat(outgoing, outgoingBytes);
    outgoing = []; outgoingBytes = 0;
    ws.send(message);
  };
  const network = new UserNetwork({...options, send: frame => {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(frame.length);
    outgoing.push(header, frame); outgoingBytes += 4 + frame.length;
    if (outgoingBytes >= 262144) flush();
    else if (!scheduled) {scheduled = true; setImmediate(flush);}
  }});
  ws.on('message', data => {
    pending = pending.length ? Buffer.concat([pending, data]) : data;
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0);
      if (length > 65550) {ws.close(1009); network.close(); return;}
      if (pending.length < 4 + length) break;
      network.receive(pending.subarray(4, 4 + length));
      pending = pending.subarray(4 + length);
    }
  });
  ws.on('close', () => network.close());
  return network;
}

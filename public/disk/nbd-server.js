// SPDX-License-Identifier: GPL-2.0-only
// Network Block Device server (fixed newstyle negotiation, simple replies)
// for QEMU's built-in NBD client. The "network" is an in-browser message
// channel; nothing leaves the device. Protocol reference:
// https://github.com/NetworkBlockDevice/nbd/blob/master/doc/proto.md
const NBDMAGIC = 0x4e42444d41474943n, IHAVEOPT = 0x49484156454f5054n, OPTION_REPLY = 0x0003e889045565a9n;
const REQUEST_MAGIC = 0x25609513, SIMPLE_REPLY = 0x67446698;
const OPT = {EXPORT_NAME: 1, ABORT: 2, LIST: 3, INFO: 6, GO: 7};
const REP = {ACK: 1, SERVER: 2, INFO: 3, ERR_UNSUP: 0x80000001, ERR_INVALID: 0x80000003, ERR_UNKNOWN: 0x80000006};
const INFO = {EXPORT: 0, BLOCK_SIZE: 3};
const CMD = {READ: 0, WRITE: 1, DISC: 2, FLUSH: 3, TRIM: 4, WRITE_ZEROES: 6};
const CMD_FLAG_FUA = 1, CMD_FLAG_NO_HOLE = 2;
const FLAGS = 1 | 4 | 8 | 32 | 64; // HAS_FLAGS, SEND_FLUSH, SEND_FUA, SEND_TRIM, SEND_WRITE_ZEROES
const ERR = {EPERM: 1, EIO: 5, EINVAL: 22, ENOSPC: 28, ENOTSUP: 95};

export class NbdServer {
  // store: {read(offset, length), write(offset, bytes), zero(offset, length, options), flush()}
  constructor({store, size, send, close = () => {}, exportName = 'root', maxBlock = 4 * 1024 * 1024, onError = () => {}}) {
    Object.assign(this, {store, size, send, closeTransport: close, exportName, maxBlock, onError});
    this.buffer = new Uint8Array(0);
    this.state = 'client-flags';
    this.noZeroes = false;
    this.queue = Promise.resolve();
    this.closed = false;
  }

  start() {
    const greeting = new DataView(new ArrayBuffer(18));
    greeting.setBigUint64(0, NBDMAGIC);
    greeting.setBigUint64(8, IHAVEOPT);
    greeting.setUint16(16, 1 | 2); // FIXED_NEWSTYLE | NO_ZEROES
    this.send(new Uint8Array(greeting.buffer));
  }

  receive(bytes) {
    if (this.closed) return;
    const joined = new Uint8Array(this.buffer.length + bytes.length);
    joined.set(this.buffer); joined.set(bytes, this.buffer.length);
    this.buffer = joined;
    try {
      while (!this.closed && this.#step());
    } catch (error) {
      this.onError(error);
      this.close();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.closeTransport();
  }

  #take(length) {
    const out = this.buffer.slice(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }

  #step() {
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    if (this.state === 'client-flags') {
      if (this.buffer.length < 4) return false;
      const flags = view.getUint32(0);
      if (!(flags & 1)) throw new Error('NBD client does not support fixed newstyle negotiation');
      this.noZeroes = (flags & 2) !== 0;
      this.#take(4);
      this.state = 'options';
      return true;
    }
    if (this.state === 'options') {
      if (this.buffer.length < 16) return false;
      if (view.getBigUint64(0) !== IHAVEOPT) throw new Error('Bad NBD option magic');
      const option = view.getUint32(8), length = view.getUint32(12);
      if (length > 65536) throw new Error('NBD option too long');
      if (this.buffer.length < 16 + length) return false;
      const data = this.#take(16 + length).subarray(16);
      this.#option(option, data);
      return true;
    }
    if (this.state === 'transmission') {
      if (this.buffer.length < 28) return false;
      if (view.getUint32(0) !== REQUEST_MAGIC) throw new Error('Bad NBD request magic');
      const flags = view.getUint16(4), type = view.getUint16(6);
      const offset = Number(view.getBigUint64(16)), length = view.getUint32(24);
      const payload = type === CMD.WRITE ? length : 0;
      if (payload > this.maxBlock) throw new Error('NBD write larger than the advertised maximum');
      if (this.buffer.length < 28 + payload) return false;
      const packet = this.#take(28 + payload);
      const cookie = packet.slice(8, 16);
      this.queue = this.queue.then(() => this.#request(type, flags, cookie, offset, length, packet.subarray(28)));
      return true;
    }
    return false;
  }

  #optionReply(option, type, data = new Uint8Array(0)) {
    const reply = new Uint8Array(20 + data.length);
    const view = new DataView(reply.buffer);
    view.setBigUint64(0, OPTION_REPLY);
    view.setUint32(8, option);
    view.setUint32(12, type);
    view.setUint32(16, data.length);
    reply.set(data, 20);
    this.send(reply);
  }

  #exportInfo() {
    const info = new DataView(new ArrayBuffer(12));
    info.setUint16(0, INFO.EXPORT);
    info.setBigUint64(2, BigInt(this.size));
    info.setUint16(10, FLAGS);
    return new Uint8Array(info.buffer);
  }

  #option(option, data) {
    if (option === OPT.EXPORT_NAME) {
      if (new TextDecoder().decode(data) !== this.exportName) {this.close(); return;}
      const reply = new Uint8Array(this.noZeroes ? 10 : 134);
      const view = new DataView(reply.buffer);
      view.setBigUint64(0, BigInt(this.size));
      view.setUint16(8, FLAGS);
      this.send(reply);
      this.state = 'transmission';
      return;
    }
    if (option === OPT.ABORT) {this.#optionReply(option, REP.ACK); this.close(); return;}
    if (option === OPT.LIST) {
      const name = new TextEncoder().encode(this.exportName);
      const entry = new Uint8Array(4 + name.length);
      new DataView(entry.buffer).setUint32(0, name.length);
      entry.set(name, 4);
      this.#optionReply(option, REP.SERVER, entry);
      this.#optionReply(option, REP.ACK);
      return;
    }
    if (option === OPT.GO || option === OPT.INFO) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (data.length < 6) {this.#optionReply(option, REP.ERR_INVALID); return;}
      const nameLength = view.getUint32(0);
      if (4 + nameLength + 2 > data.length) {this.#optionReply(option, REP.ERR_INVALID); return;}
      const name = new TextDecoder().decode(data.subarray(4, 4 + nameLength));
      if (name && name !== this.exportName) {this.#optionReply(option, REP.ERR_UNKNOWN); return;}
      this.#optionReply(option, REP.INFO, this.#exportInfo());
      const sizes = new DataView(new ArrayBuffer(14));
      sizes.setUint16(0, INFO.BLOCK_SIZE);
      sizes.setUint32(2, 1);
      sizes.setUint32(6, 4096);
      sizes.setUint32(10, this.maxBlock);
      this.#optionReply(option, REP.INFO, new Uint8Array(sizes.buffer));
      this.#optionReply(option, REP.ACK);
      if (option === OPT.GO) this.state = 'transmission';
      return;
    }
    // STARTTLS, structured replies, metadata contexts and extended headers are
    // optional; QEMU falls back to simple replies when they are unsupported.
    this.#optionReply(option, REP.ERR_UNSUP);
  }

  #reply(cookie, error, data) {
    const reply = new Uint8Array(16 + (data ? data.length : 0));
    const view = new DataView(reply.buffer);
    view.setUint32(0, SIMPLE_REPLY);
    view.setUint32(4, error);
    reply.set(cookie, 8);
    if (data) reply.set(data, 16);
    this.send(reply);
  }

  async #request(type, flags, cookie, offset, length, payload) {
    if (this.closed) return;
    if (type === CMD.DISC) {this.close(); return;}
    if (type !== CMD.FLUSH && (offset + length > this.size)) {
      this.#reply(cookie, type === CMD.WRITE || type === CMD.WRITE_ZEROES ? ERR.ENOSPC : ERR.EINVAL);
      return;
    }
    try {
      if (type === CMD.READ) {
        if (length > this.maxBlock) {this.#reply(cookie, ERR.EINVAL); return;}
        const data = await this.store.read(offset, length);
        this.#reply(cookie, 0, data);
        return;
      }
      if (type === CMD.WRITE) await this.store.write(offset, payload);
      else if (type === CMD.TRIM) await this.store.zero(offset, length, {discard: true});
      else if (type === CMD.WRITE_ZEROES) await this.store.zero(offset, length, {discard: false, noHole: (flags & CMD_FLAG_NO_HOLE) !== 0});
      else if (type === CMD.FLUSH) await this.store.flush();
      else {this.#reply(cookie, ERR.ENOTSUP); return;}
      if (flags & CMD_FLAG_FUA && type !== CMD.FLUSH) await this.store.flush();
      this.#reply(cookie, 0);
    } catch (error) {
      this.onError(error);
      this.#reply(cookie, error.errno === 22 ? ERR.EINVAL : ERR.EIO);
    }
  }
}

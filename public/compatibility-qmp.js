// SPDX-License-Identifier: GPL-2.0-only
// QEMU Machine Protocol client for the page. QEMU connects its QMP monitor to
// an in-page endpoint (see installSocketRouter); nothing leaves the browser.
export class QmpClient {
  constructor({onEvent = () => {}, onReady = () => {}} = {}) {
    this.onEvent = onEvent;
    this.onReady = onReady;
    this.buffer = '';
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.socket = null;
  }

  // Called by the socket router when QEMU opens the monitor connection.
  attach(socket) {
    this.socket = socket;
  }

  receive(bytes) {
    this.buffer += this.decoder.decode(bytes, {stream: true});
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {message = JSON.parse(line);} catch {continue;}
      if (message.QMP) {
        this.#send({execute: 'qmp_capabilities'}).then(() => {this.ready = true; this.onReady();});
      } else if (message.event) {
        this.onEvent(message);
      } else if (message.id !== undefined && this.pending.has(message.id)) {
        const {resolve, reject} = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.desc || message.error.class)); else resolve(message.return);
      }
    }
  }

  #send(command) {
    if (!this.socket) return Promise.reject(new Error('QEMU monitor is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.socket.push(this.encoder.encode(JSON.stringify({...command, id}) + '\n'));
    });
  }

  execute(name, args) {
    if (!this.ready) return Promise.reject(new Error('QEMU monitor is not ready'));
    return this.#send(args === undefined ? {execute: name} : {execute: name, arguments: args});
  }

  hmp(commandLine) {return this.execute('human-monitor-command', {'command-line': commandLine});}

  closed() {
    this.ready = false;
    this.socket = null;
    for (const {reject} of this.pending.values()) reject(new Error('QEMU monitor closed'));
    this.pending.clear();
  }
}

// Relative mouse input for games: while the canvas holds pointer lock,
// movement goes to a separate virtio mouse as relative motion, the way
// games expect, instead of the absolute tablet used for the desktop.
export function connectGameMouse(canvas, qmp, {device = 'gamemouse', onChange = () => {}} = {}) {
  let dx = 0, dy = 0, scheduled = false, active = false;
  const flush = () => {
    scheduled = false;
    if (!dx && !dy) return;
    const events = [];
    if (dx) events.push({type: 'rel', data: {axis: 'x', value: Math.round(dx)}});
    if (dy) events.push({type: 'rel', data: {axis: 'y', value: Math.round(dy)}});
    dx = dy = 0;
    qmp.execute('input-send-event', {device, events}).catch(() => {});
  };
  const move = event => {
    if (!active) return;
    dx += event.movementX; dy += event.movementY;
    if (!scheduled) {scheduled = true; requestAnimationFrame(flush);}
  };
  const button = (event, down) => {
    if (!active) return;
    const name = ['left', 'middle', 'right'][event.button];
    if (!name) return;
    event.preventDefault(); event.stopImmediatePropagation();
    qmp.execute('input-send-event', {device, events: [{type: 'btn', data: {button: name, down}}]}).catch(() => {});
  };
  const wheel = event => {
    if (!active) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const name = event.deltaY < 0 ? 'wheel-up' : 'wheel-down';
    qmp.execute('input-send-event', {device, events: [{type: 'btn', data: {button: name, down: true}}, {type: 'btn', data: {button: name, down: false}}]}).catch(() => {});
  };
  const lockChange = () => {
    active = document.pointerLockElement === canvas;
    onChange(active);
  };
  const down = event => button(event, true), up = event => button(event, false);
  document.addEventListener('pointerlockchange', lockChange);
  document.addEventListener('mousemove', move, true);
  canvas.addEventListener('mousedown', down, true);
  canvas.addEventListener('mouseup', up, true);
  canvas.addEventListener('wheel', wheel, {capture: true, passive: false});
  return {
    capture: () => canvas.requestPointerLock?.({unadjustedMovement: true})?.catch?.(() => canvas.requestPointerLock()),
    release: () => {if (document.pointerLockElement === canvas) document.exitPointerLock();},
    disconnect: () => {
      document.removeEventListener('pointerlockchange', lockChange);
      document.removeEventListener('mousemove', move, true);
      canvas.removeEventListener('mousedown', down, true);
      canvas.removeEventListener('mouseup', up, true);
      canvas.removeEventListener('wheel', wheel, true);
    },
  };
}

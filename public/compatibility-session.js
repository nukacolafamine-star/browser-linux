// SPDX-License-Identifier: GPL-2.0-only
import {detectCapabilities, missingRequirements} from './capabilities.js';
import {DiskStore, makeBaseMetadata} from './compatibility-storage.js';
import {loadCompatibilityImage, imageResponse, retainImageFile, retainImageManifest} from './compatibility-images.js';
import {connectExchange} from './compatibility-exchange.js';
import {connectCanvasKeyboard} from './compatibility-input.js';
const $ = id => document.getElementById(id);
const base = new URL('./compatibility/', location.href);
const started = performance.now();
const report = window.guestReport = {state: 'preparing', serial: '', logs: [], files: [], guestGPU: false, wayland: false};
let engine, term, fit, bootTimer;
let diskStore, diskBase, expectedCurrent = null, poweredOff = false, saving = false, saveRequested = false;
let recoveredPrevious = null;
let canSave = false, shutdownTimer;
let retainImage = false, disconnectExchange;
const moduleURLs = [];
function moduleURL(bytes) {
  const url = URL.createObjectURL(new Blob([bytes], {type: 'text/javascript'}));
  moduleURLs.push(url); return url;
}
function releaseModules() {for (const url of moduleURLs.splice(0)) URL.revokeObjectURL(url);}
const options = new URLSearchParams(location.search);
const exchangeEnabled = options.get('exchange') !== 'off';
const inputTrace = options.get('input-trace') === '1';
const disconnectKeyboard = connectCanvasKeyboard($('canvas'));
if (inputTrace) {
  // Explicit development diagnostics only. Ordinary sessions never record keys.
  report.inputEvents = [];
  for (const type of ['keydown', 'keyup']) window.addEventListener(type, event => {
    if (document.activeElement !== $('canvas')) return;
    report.inputEvents.push({type, code: event.code, shift: event.shiftKey, control: event.ctrlKey,
      repeat: event.repeat, ms: Math.round(performance.now() - started)});
    if (report.inputEvents.length > 600) report.inputEvents.shift();
  }, true);
}
const workers = new Set();
const NativeWorker = window.Worker;
// Every worker in this dedicated session belongs to this guest. Retain handles
// even if module initialization aborts before returning an Emscripten instance.
window.Worker = class extends NativeWorker {
  constructor(...args) {super(...args); workers.add(this);}
  terminate() {workers.delete(this); return super.terminate();}
};
function stopWorkers() {for (const worker of [...workers]) worker.terminate();}
const decoder = new TextDecoder();
function status(message, state = report.state) {
  report.state = state; report.message = message; report.elapsedMs = Math.round(performance.now() - started);
  $('guest-status').textContent = message;
  if (parent !== window) parent.postMessage({type: 'guest-status', message, state}, location.origin);
}
function log(message) {
  report.logs.push(String(message)); if (report.logs.length > (inputTrace ? 1500 : 250)) report.logs.shift();
  $('engine-log').textContent = report.logs.join('\n');
}
function fail(error) {disconnectKeyboard(); clearTimeout(bootTimer); clearTimeout(shutdownTimer); stopWorkers(); releaseModules(); $('save-disk').disabled = true; log(error?.stack || error); status('Linux session stopped: ' + (error?.message || error), 'error');}
const sha256 = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
function safeURL(name) {
  const url = new URL(name, base);
  if (url.origin !== base.origin || !url.href.startsWith(base.href) || !/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').includes('..')) throw new Error('Invalid image file path');
  return url;
}
async function download(file) {
  if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid image checksum metadata');
  status('Downloading ' + file.name, 'downloading');
  const url = safeURL(file.name), response = await imageResponse(url);
  if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
  let bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== file.bytes || await sha256(bytes) !== file.sha256) throw new Error('Image integrity check failed: ' + file.name);
  if (retainImage) {
    try {await retainImageFile(url, bytes, response.headers.get('Content-Type'));}
    catch (error) {throw new Error('The base image could not be retained for disk recovery: ' + error.message + '. Use a temporary session if storage is unavailable.');}
  }
  if (file.encoding === 'gzip') {
    status('Unpacking ' + file.name, 'downloading');
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    if (bytes.length !== file.unpackedBytes || await sha256(bytes) !== file.unpackedSha256) throw new Error('Unpacked image integrity check failed: ' + file.name);
  }
  report.files.push({name: file.name, bytes: file.bytes, sha256: file.sha256});
  return bytes;
}
function serial(bytes) {
  report.serial = (report.serial + decoder.decode(bytes, {stream: true})).slice(-100000);
  if (report.serial.includes('BROWSER_LINUX_EXCHANGE_READY')) {
    report.exchangeReady = true;
    if (!disconnectExchange && engine) disconnectExchange = connectExchange(engine.FS, {
      input: $('exchange-input'), upload: $('exchange-upload'), refresh: $('exchange-refresh'),
      list: $('exchange-files'), message: $('exchange-status'),
    });
    if (canSave && !saveRequested && !poweredOff) $('save-disk').disabled = false;
  }
  if (['error', 'shutting-down', 'saving', 'saved', 'save-error', 'stopped'].includes(report.state)) return;
  if (report.serial.includes('BROWSER_LINUX_WAYLAND_CLIENT_STARTED')) {
    if (!report.wayland) showConsole(false);
    clearTimeout(bootTimer); report.wayland = true;
    status('Wayland is running · CPU rendering', 'running');
  } else if (report.serial.includes('BROWSER_LINUX_GRAPHICS_FAILED') || report.serial.includes('BROWSER_LINUX_WAYLAND_CLIENT_FAILED')) {
    clearTimeout(bootTimer);
    status('Linux terminal is running; Wayland could not start. See the serial terminal.', 'console');
  } else if (report.serial.includes('BROWSER_LINUX_SERIAL_READY') && !report.wayland) {
    status('Linux terminal is ready. Starting Wayland…', 'console');
  } else if (report.state === 'booting') status('Booting x86-64 Linux…', 'booting');
}
function showConsole(show) {
  // SDL measures the canvas layout during initialization and resize. Removing
  // it from layout produces a zero-sized framebuffer, even with HTML dimensions.
  $('console-panel').hidden = !show;
  if (show) requestAnimationFrame(() => {fit?.fit(); term?.focus();});
  else $('canvas').focus();
}
$('show-console').onclick = () => showConsole(true);
$('show-desktop').onclick = () => showConsole(false);
const keys = {escape: '\x1b', tab: '\t', interrupt: '\x03', up: '\x1b[A', down: '\x1b[B'};
document.querySelectorAll('[data-input]').forEach(button => button.onclick = () => {term?.input(keys[button.dataset.input], true); term?.focus();});
window.addEventListener('error', event => fail(new Error(event.message)));
window.addEventListener('unhandledrejection', event => fail(event.reason));
window.addEventListener('pagehide', () => {disconnectKeyboard(); clearTimeout(bootTimer); clearTimeout(shutdownTimer); stopWorkers(); releaseModules();});

async function saveDisk() {
  if (!poweredOff || !canSave || saving) return;
  saving = true; $('save-disk').disabled = true;
  status('Saving the stopped Linux disk. Keep this page open…', 'saving');
  let stream;
  try {
    stream = engine.FS.open('/pack/rootfs.img', 'r');
    const saved = await diskStore.save(diskBase, (offset, length) => {
      const bytes = new Uint8Array(length);
      if (engine.FS.read(stream, bytes, 0, length, offset) !== length) throw new Error('The stopped disk could not be read completely.');
      return bytes;
    }, {expectedCurrent, recoveredPrevious});
    expectedCurrent = saved.id; recoveredPrevious = null; report.savedDisk = saved;
    $('save-disk').textContent = 'Disk saved';
    status('Linux shut down and its disk was saved on this device. You can close the session.', 'saved');
  } catch (error) {
    log(error?.stack || error); report.saveError = error.message;
    $('save-disk').textContent = 'Retry disk save'; $('save-disk').disabled = false;
    status('Disk save failed: ' + error.message + ' The previous save is unchanged. Keep this session open to retry.', 'save-error');
  } finally {
    if (stream) engine.FS.close(stream);
    saving = false;
  }
}
$('save-disk').onclick = async () => {
  if (!canSave || saving) return;
  if (poweredOff) {await saveDisk(); return;}
  if (!report.exchangeReady || saveRequested) return;
  saveRequested = true; $('save-disk').disabled = true;
  status('Shutting Linux down before saving its disk…', 'shutting-down');
  // A dedicated guest control file avoids injecting a command into whichever
  // program happens to own the serial terminal. PID 1 performs normal shutdown.
  engine.FS.writeFile('/exchange/.control/shutdown', new Uint8Array([1]));
  shutdownTimer = setTimeout(() => {
    if (!poweredOff) status('Linux has not finished shutting down. No disk snapshot has been taken; see the serial terminal.', 'shutting-down');
  }, 60000);
};

function exited(code) {
  disconnectKeyboard();
  clearTimeout(bootTimer); clearTimeout(shutdownTimer); stopWorkers();
  releaseModules();
  disconnectExchange?.();
  poweredOff = code === 0; report.exitCode = code;
  // EXIT_RUNTIME=1 invokes this only after QEMU cleanup flushes and closes
  // block devices. MEMFS remains available for bounded reads of the disk.
  if (poweredOff && saveRequested) void saveDisk();
  else {
    status('Linux exited with status ' + code + (canSave && poweredOff ? '. Its stopped disk can now be saved.' : '.'), code ? 'error' : 'stopped');
    $('save-disk').disabled = !poweredOff || !canSave;
    if (canSave && poweredOff) $('save-disk').textContent = 'Save stopped disk';
  }
}

async function boot() {
  const capabilities = await detectCapabilities();
  if (!capabilities.compatibilityEngine) throw new Error('This engine needs ' + missingRequirements(capabilities).join(', '));
  const diskMode = options.get('disk') || 'current';
  if (!['current', 'previous', 'temporary'].includes(diskMode)) throw new Error('Unsupported disk mode');
  const manifest = await loadCompatibilityImage({temporary: diskMode === 'temporary', previous: diskMode === 'previous'});
  if (manifest.schema !== 1 || manifest.architecture !== 'x86_64') throw new Error('Unsupported image manifest');
  if (!Array.isArray(manifest.files) || manifest.files.length > 40) throw new Error('Invalid image files');
  const names = new Set(), paths = new Set();
  for (const file of manifest.files) {
    safeURL(file.name);
    if (!file.name.startsWith(`builds/${manifest.build}/`) || names.has(file.name)) throw new Error('Runtime files must belong to one versioned build');
    names.add(file.name);
    if (file.guestPath) {
      if (!/^\/pack\/[a-zA-Z0-9_.-]+$/.test(file.guestPath) || paths.has(file.guestPath)) throw new Error('Invalid or duplicate guest file path');
      paths.add(file.guestPath);
    }
  }
  report.build = manifest.build; report.architecture = manifest.architecture;
  canSave = manifest.persistentDisk === true && manifest.cleanShutdown === true && diskMode !== 'temporary' && exchangeEnabled;
  retainImage = canSave;
  const byRole = role => {
    const entries = manifest.files.filter(file => file.role === role);
    if (entries.length !== 1) throw new Error('Invalid image manifest: ' + role);
    return entries[0];
  };
  const script = byRole('script'), ptyScript = byRole('pty'), wasm = byRole('wasm');
  for (const [role, path] of [['kernel', '/pack/vmlinuz-virt'], ['initrd', '/pack/initramfs-virt'], ['disk', '/pack/rootfs.img']]) {
    if (byRole(role).guestPath !== path) throw new Error('Incorrect guest path for ' + role);
  }
  const runtimeURL = new URL('./', safeURL(script.name));
  // Verify the runtime before loading code. The payload is served under one build.
  const scriptURL = moduleURL(await download(script)), ptyURL = moduleURL(await download(ptyScript));
  const workerURLs = new Map();
  for (const file of manifest.files.filter(file => file.role === 'worker')) workerURLs.set(file.name.split('/').at(-1), moduleURL(await download(file)));
  const wasmBinary = await download(wasm);
  // Execute the exact verified bytes, including retained copies whose original
  // server URLs may disappear after an update. Do not fetch scripts a second time.
  const imported = await import(ptyURL);
  const openpty = imported.openpty || globalThis.openpty;
  if (typeof openpty !== 'function') throw new Error('Terminal library did not initialize');
  const createQemu = (await import(scriptURL)).default;
  term = window.guestTerminal = new Terminal({fontSize: 13, cursorBlink: true, scrollback: 4000, theme: {background: '#0a0e16', foreground: '#d5deee'}});
  fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open($('guest-terminal'));
  const {master, slave} = openpty(); term.loadAddon(master);
  master.onWrite(([bytes]) => serial(bytes));
  const diskFiles = [];
  for (const file of manifest.files.filter(file => file.guestPath)) {
    if (!/^\/pack\/[a-zA-Z0-9_.-]+$/.test(file.guestPath)) throw new Error('Invalid guest file path');
    diskFiles.push({path: file.guestPath, bytes: await download(file)});
  }
  report.diskMode = diskMode; report.persistentDisk = canSave;
  if (canSave) {
    await retainImageManifest(manifest);
    status('Checking the saved Linux disk…', 'restoring');
    const disk = diskFiles.find(file => file.path === '/pack/rootfs.img'), metadata = byRole('disk');
    diskBase = await makeBaseMetadata(disk.bytes, metadata.encoding === 'gzip' ? metadata.unpackedSha256 : metadata.sha256);
    diskStore = new DiskStore(new URL('./', location.href).href);
    const restored = await diskStore.restore(diskBase, disk.bytes, {previous: diskMode === 'previous'});
    if (diskMode === 'previous' && !restored.restored) throw new Error('There is no previous disk save to recover.');
    expectedCurrent = restored.currentId; recoveredPrevious = restored.source === 'previous' ? restored.id : null; report.restoredDisk = restored;
    $('disk-note').textContent = restored.restored ? 'Your saved disk was restored. Save open documents before shutting down and saving again.' : 'Save open documents, then use Shut down & save to keep installed programs and files on this device.';
  } else {
    $('disk-note').textContent = 'Temporary disk: changes will be discarded when this session closes.';
  }
  $('save-disk').hidden = !canSave;
  const memory = Number(options.get('memory') || 512);
  if (![256, 512].includes(memory)) throw new Error('Unsupported memory budget');
  report.guestMemoryMiB = memory; report.engineMemoryMiB = manifest.engineMemoryMiB;
  status('Starting the instruction translator…', 'starting');
  engine = await createQemu({
    noInitialRun: true, wasmBinary, pty: slave, canvas: $('canvas'),
    mainScriptUrlOrBlob: scriptURL,
    locateFile: name => workerURLs.get(name) || new URL(name, runtimeURL).href,
    print: log, printErr: log, onAbort: message => fail(new Error(String(message))),
    onExit: exited,
    preRun: [module => {
      // Guest Pixman already renders the desktop on its virtual CPU. Presenting
      // that framebuffer through a main-thread canvas avoids requiring worker GL.
      module.ENV.SDL_RENDER_DRIVER = 'software';
      module.ENV.SDL_EMSCRIPTEN_KEYBOARD_ELEMENT = '#canvas';
      if (inputTrace) module.ENV.SDL_EVENT_LOGGING = '1';
      module.FS.mkdir('/pack');
      module.FS.mkdir('/exchange'); module.FS.mkdir('/exchange/.control');
      for (const file of diskFiles) module.FS.writeFile(file.path, file.bytes, {canOwn: true});
      diskFiles.length = 0;
    }],
  });
  window.guestEngine = engine;
  // Upstream QEMU's select loop must see stdin as unreadable between key events.
  const oldPoll = engine.TTY.stream_ops.poll;
  let lastPollResult, nextPollTrace = 0;
  report.terminalIO = {emptyNonblockingReads: 0, recent: []};
  const traceIO = entry => {
    report.terminalIO.recent.push({ms: Math.round(performance.now() - started), ...entry});
    if (report.terminalIO.recent.length > 24) report.terminalIO.recent.shift();
  };
  engine.TTY.stream_ops.poll = function(stream, timeout) {
    const result = slave.readable ? oldPoll.call(this, stream, timeout) : (slave.writable ? 4 : 0);
    if (result !== lastPollResult || performance.now() >= nextPollTrace) {
      traceIO({operation: 'poll', fd: stream.fd, flags: stream.flags, readable: slave.readable, result});
      lastPollResult = result; nextPollTrace = performance.now() + 500;
    }
    return result;
  };
  const oldRead = engine.TTY.stream_ops.read;
  engine.TTY.stream_ops.read = function(stream, buffer, offset, length) {
    report.terminalIO.lastRead = {ms: Math.round(performance.now() - started), fd: stream.fd, flags: stream.flags, readable: slave.readable, length, state: 'entered'};
    traceIO({operation: 'read-enter', ...report.terminalIO.lastRead});
    // xterm-pty 0.10.1 turns an empty read into an infinite PTY wait, including
    // QEMU's nonblocking stdin. Honor O_NONBLOCK (2048) with Emscripten EAGAIN
    // (6); otherwise a readiness race can pause unrelated guest timer/device I/O.
    if (length && (stream.flags & 2048) && !slave.readable) {
      report.terminalIO.emptyNonblockingReads++;
      Object.assign(report.terminalIO.lastRead, {state: 'error', errno: 6});
      traceIO({operation: 'read', fd: stream.fd, flags: stream.flags, readable: false, errno: 6});
      throw new engine.FS.ErrnoError(6);
    }
    try {
      const result = oldRead.call(this, stream, buffer, offset, length);
      Object.assign(report.terminalIO.lastRead, {state: 'returned', result});
      traceIO({operation: 'read', fd: stream.fd, flags: stream.flags, readable: slave.readable, result});
      return result;
    } catch (error) {
      Object.assign(report.terminalIO.lastRead, {state: 'error', errno: error.errno});
      traceIO({operation: 'read', fd: stream.fd, flags: stream.flags, readable: slave.readable, errno: error.errno});
      throw error;
    }
  };
  const args = [
    '-M', 'pc,i8042=off', '-cpu', 'qemu64,-svm,-vmx', '-m', memory + 'M', '-smp', '1', '-accel', 'tcg,tb-size=64', '-nodefaults',
    '-L', '/pack', '-nic', 'none', '-monitor', 'none', '-serial', 'stdio', '-parallel', 'none', '-no-reboot',
    ...(inputTrace ? ['-D', '/input-trace.log', '-msg', 'timestamp=on', '-trace', 'enable=sdl2_process_key',
      '-trace', 'enable=virtio_input_queue_full', '-trace', 'enable=input_event_key_qcode'] : []),
    ...(exchangeEnabled ? ['-virtfs', 'local,path=/exchange,mount_tag=browser,security_model=mapped-file,id=browser'] : []),
    // Emscripten's random device reads crypto.getRandomValues. Give Linux a
    // genuine entropy source instead of relying on virtual hardware timing.
    '-object', 'rng-random,id=browser-rng,filename=/dev/urandom',
    '-device', 'virtio-rng-pci,rng=browser-rng',
    '-display', 'sdl,gl=off', '-vga', 'none', '-device', 'virtio-vga',
    '-device', 'virtio-keyboard-pci', '-device', 'virtio-tablet-pci',
    '-kernel', '/pack/vmlinuz-virt', '-initrd', '/pack/initramfs-virt',
    '-append', 'console=ttyS0 root=/dev/vda rw rootfstype=ext4 modules=virtio_pci,virtio_blk,ext4 quiet',
    '-drive', 'id=root,file=/pack/rootfs.img,format=raw,if=none',
    '-device', 'virtio-blk-pci,drive=root',
  ];
  report.arguments = args;
  status('Booting x86-64 Linux…', 'booting');
  showConsole(true);
  bootTimer = setTimeout(() => {
    if (!report.wayland && report.state !== 'error') status('Startup is still in progress. The serial terminal shows the latest Linux output.');
  }, 120000);
  engine.callMain(args);
}
boot().catch(fail);

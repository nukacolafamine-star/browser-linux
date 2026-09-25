// SPDX-License-Identifier: GPL-2.0-only
import {detectCapabilities, missingRequirements} from './capabilities.js';
import {connectExchange} from './compatibility-exchange.js';
import {connectCanvasKeyboard} from './compatibility-input.js';
import {GuestDisk, installSocketRouter, probeNetworkRelay, DISK_ENDPOINT, NETWORK_ENDPOINT, MONITOR_ENDPOINT} from './compatibility-disk.js';
import {QmpClient, connectGameMouse} from './compatibility-qmp.js';

const $ = id => document.getElementById(id);
const base = new URL('./compatibility/', location.href);
const started = performance.now();
const report = window.guestReport = {state: 'preparing', serial: '', logs: [], files: [], wayland: false, xwayland: false, network: false};
const options = new URLSearchParams(location.search);
const inputTrace = options.get('input-trace') === '1';
let engine, term, fit, disk, uninstallRouter, disconnectExchange, bootTimer, shutdownTimer, gameMouse;
const monitor = window.guestMonitor = new QmpClient({onReady: () => {report.monitor = true; $('game-mouse').disabled = false;}});
let shutdownRequested = false, finished = false;
const moduleURLs = [];
const disconnectKeyboard = connectCanvasKeyboard($('canvas'));

if (inputTrace) {
  // Explicit development diagnostics only. Ordinary sessions never record keys.
  report.inputEvents = [];
  for (const type of ['keydown', 'keyup']) window.addEventListener(type, event => {
    if (document.activeElement !== $('canvas')) return;
    report.inputEvents.push({type, code: event.code, repeat: event.repeat, ms: Math.round(performance.now() - started)});
    if (report.inputEvents.length > 600) report.inputEvents.shift();
  }, true);
}

// Every worker in this dedicated session belongs to this guest. Retain the
// handles even if initialization aborts before QEMU returns an instance.
const workers = new Set();
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(...args) {super(...args); workers.add(this);}
  terminate() {workers.delete(this); return super.terminate();}
};
const stopWorkers = () => {for (const worker of [...workers]) worker.terminate();};
const moduleURL = bytes => {const url = URL.createObjectURL(new Blob([bytes], {type: 'text/javascript'})); moduleURLs.push(url); return url;};
const releaseModules = () => {for (const url of moduleURLs.splice(0)) URL.revokeObjectURL(url);};
const decoder = new TextDecoder();
const mib = bytes => (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0);

function status(message, state = report.state) {
  report.state = state; report.message = message; report.elapsedMs = Math.round(performance.now() - started);
  $('guest-status').textContent = message;
  if (parent !== window) parent.postMessage({type: 'guest-status', message, state}, location.origin);
}
function log(message) {
  report.logs.push(String(message)); if (report.logs.length > (inputTrace ? 1500 : 300)) report.logs.shift();
  $('engine-log').textContent = report.logs.join('\n');
}
function teardown() {
  disconnectKeyboard(); clearTimeout(bootTimer); clearTimeout(shutdownTimer);
  stopWorkers(); releaseModules(); disconnectExchange?.(); uninstallRouter?.(); gameMouse?.release(); gameMouse?.disconnect();
}
function fail(error) {
  if (finished) return;
  finished = true;
  teardown();
  disk?.terminate();
  $('shutdown').disabled = true;
  log(error?.stack || error);
  status('Linux session stopped: ' + (error?.message || error), 'error');
}
window.addEventListener('error', event => fail(new Error(event.message)));
window.addEventListener('unhandledrejection', event => fail(event.reason));
window.addEventListener('pagehide', () => {teardown(); disk?.terminate();});

const sha256 = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
function safeURL(name) {
  const url = new URL(name, base);
  if (url.origin !== base.origin || !url.href.startsWith(base.href) || !/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').includes('..')) throw new Error('Invalid image file path');
  return url;
}
async function download(file) {
  if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid image checksum metadata');
  status('Downloading ' + file.name.split('/').at(-1) + ' (' + mib(file.bytes) + ' MiB)', 'downloading');
  const response = await fetch(safeURL(file.name), {cache: 'no-cache'});
  if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== file.bytes || await sha256(bytes) !== file.sha256) throw new Error('Image integrity check failed: ' + file.name);
  report.files.push({name: file.name, bytes: file.bytes, sha256: file.sha256});
  return bytes;
}

function serial(bytes) {
  report.serial = (report.serial + decoder.decode(bytes, {stream: true})).slice(-200000);
  const text = report.serial;
  if (!report.exchangeReady && text.includes('BROWSER_LINUX_EXCHANGE_READY')) {
    report.exchangeReady = true;
    disconnectExchange = connectExchange(engine.FS, {
      input: $('exchange-input'), upload: $('exchange-upload'), refresh: $('exchange-refresh'),
      list: $('exchange-files'), message: $('exchange-status'),
    });
    $('shutdown').disabled = false;
  }
  if (!report.network && text.includes('BROWSER_LINUX_NETWORK_READY')) report.network = true;
  if (!report.xwayland && text.includes('BROWSER_LINUX_XWAYLAND_READY')) report.xwayland = true;
  if (['error', 'stopping', 'stopped'].includes(report.state)) return;
  if (!report.wayland && text.includes('BROWSER_LINUX_WAYLAND_CLIENT_STARTED')) {
    report.wayland = true;
    clearTimeout(bootTimer);
    report.desktopMs = Math.round(performance.now() - started);
    showConsole(false);
    status(`Desktop ready${report.network ? ' · online' : ''} · Debian 13 on x86-64`, 'running');
  } else if (text.includes('BROWSER_LINUX_GRAPHICS_FAILED') || text.includes('BROWSER_LINUX_WAYLAND_CLIENT_FAILED')) {
    clearTimeout(bootTimer);
    status('The Linux terminal is running, but the desktop could not start. See the serial terminal.', 'console');
  } else if (!report.wayland && text.includes('BROWSER_LINUX_SERIAL_READY')) {
    if (!report.serialMs) report.serialMs = Math.round(performance.now() - started);
    status('Linux is up. Starting the desktop…', 'console');
  } else if (!report.wayland && text.includes('BROWSER_LINUX_GUEST_BOOT')) {
    status('Starting Linux services…', 'booting');
  }
}

function showConsole(show) {
  // SDL measures the canvas layout, so the canvas stays in layout while hidden.
  $('console-panel').hidden = !show;
  $('show-console').setAttribute('aria-pressed', String(show));
  $('show-desktop').setAttribute('aria-pressed', String(!show));
  if (show) requestAnimationFrame(() => {fit?.fit(); term?.focus();});
  else $('canvas').focus();
}
$('show-console').onclick = () => showConsole(true);
$('show-desktop').onclick = () => showConsole(false);
gameMouse = connectGameMouse($('canvas'), monitor, {onChange: active => {
  $('game-mouse').setAttribute('aria-pressed', String(active));
  $('guest-status').textContent = active ? 'Mouse captured for games · press Esc to release' : report.message;
}});
$('game-mouse').onclick = () => {$('canvas').focus(); gameMouse.capture();};
$('fullscreen').onclick = () => $('desktop-panel').requestFullscreen?.().then(() => $('canvas').focus()).catch(error => log(error.message));
const keys = {escape: '\x1b', tab: '\t', interrupt: '\x03', up: '\x1b[A', down: '\x1b[B'};
document.querySelectorAll('[data-input]').forEach(button => button.onclick = () => {term?.input(keys[button.dataset.input], true); term?.focus();});

function diskStatus({stats, usage, downloading, waiting}) {
  report.disk = {stats, usage, downloading, waiting};
  const parts = [`Disk: ${mib(stats.fetchedBytes)} MiB downloaded`];
  if (usage.dirty) parts.push(`${mib(usage.dirty * usage.chunkSize)} MiB of your changes`);
  if (downloading) parts.push('loading…');
  if (waiting) parts.push('waiting for connection (' + waiting + ')');
  $('disk-status').textContent = parts.join(' · ');
}

$('shutdown').onclick = () => {
  if (shutdownRequested || !report.exchangeReady) return;
  shutdownRequested = true;
  $('shutdown').disabled = true;
  status('Shutting Linux down…', 'stopping');
  // A dedicated control file avoids typing into whichever program owns the
  // serial terminal. The guest's init performs a normal shutdown.
  engine.FS.writeFile('/exchange/.control/shutdown', new Uint8Array([1]));
  shutdownTimer = setTimeout(() => {
    if (!finished) status('Linux is still shutting down. See the serial terminal for details.', 'stopping');
  }, 90000);
};

async function exited(code) {
  if (finished) return;
  finished = true;
  teardown();
  report.exitCode = code;
  try {
    await disk?.close();
  } catch (error) {
    log(error.stack || error);
  }
  $('shutdown').disabled = true;
  if (code === 0) status(disk?.persistent ? 'Linux has shut down. Your disk is saved in this browser.' : 'Linux has shut down.', 'stopped');
  else status('Linux exited with status ' + code + '.', 'error');
}

async function boot() {
  const capabilities = await detectCapabilities();
  if (!capabilities.compatibilityEngine) throw new Error('This engine needs ' + missingRequirements(capabilities).join(', '));
  if (typeof DecompressionStream !== 'function') throw new Error('This engine needs the browser gzip decompression API.');
  if (!navigator.storage?.getDirectory) throw new Error('This engine needs the browser origin-private file system for its disk.');
  const memory = Number(options.get('memory') || 2048);
  if (![1024, 2048, 3072].includes(memory)) throw new Error('Unsupported memory size');
  const cpus = Number(options.get('cpus') || 2);
  if (![1, 2, 4].includes(cpus)) throw new Error('Unsupported processor count');
  const temporary = options.get('disk') === 'temporary';
  const wantNetwork = options.get('network') !== 'off';

  const response = await fetch(new URL('manifest.json', base), {cache: 'no-cache'});
  if (!response.ok) throw new Error('No Linux image is installed on this copy yet.');
  const manifest = await response.json();
  if (manifest.schema !== 2 || manifest.architecture !== 'x86_64' || !Array.isArray(manifest.files) || manifest.files.length > 40) throw new Error('Unsupported image manifest');
  for (const file of manifest.files) {
    safeURL(file.name);
    if (!file.name.startsWith(`builds/${manifest.build}/`)) throw new Error('Runtime files must belong to one versioned build');
    if (file.guestPath && !/^\/pack\/[a-zA-Z0-9_.-]+$/.test(file.guestPath)) throw new Error('Invalid guest file path');
  }
  report.build = manifest.build;
  const byRole = role => {
    const entries = manifest.files.filter(file => file.role === role);
    if (entries.length !== 1) throw new Error('Invalid image manifest: ' + role);
    return entries[0];
  };
  const script = byRole('script'), ptyScript = byRole('pty'), wasm = byRole('wasm'), kernel = byRole('kernel');
  if (kernel.guestPath !== '/pack/bzImage') throw new Error('Incorrect guest kernel path');

  // Verify the runtime before loading any of its code.
  const scriptURL = moduleURL(await download(script)), ptyURL = moduleURL(await download(ptyScript));
  const wasmBinary = await download(wasm);
  const packFiles = [];
  for (const file of manifest.files.filter(file => file.guestPath)) packFiles.push({path: file.guestPath, bytes: await download(file)});

  status('Opening the Linux disk…', 'disk');
  const diskManifestFile = manifest.disk;
  const diskManifestBytes = await download({name: diskManifestFile.name, bytes: diskManifestFile.bytes, sha256: diskManifestFile.sha256});
  const diskManifest = JSON.parse(decoder.decode(diskManifestBytes));
  disk = await GuestDisk.open({
    manifest: diskManifest, manifestSha256: diskManifestFile.sha256, baseURL: safeURL(diskManifestFile.name),
    namespace: 'debian13-' + diskManifestFile.sha256.slice(0, 24), temporary,
    onStatus: diskStatus, onError: error => log('Disk: ' + error.message),
  });
  report.diskMode = disk.persistent ? 'saved' : 'temporary';
  $('disk-note').textContent = disk.persistent
    ? (disk.usage.dirty ? 'Continuing your saved Linux disk. Changes are saved in this browser as you work.' : 'A new Linux disk was created in this browser. Changes are saved as you work.')
    : 'Temporary disk: changes are discarded when this session closes.';

  const networkURL = wantNetwork ? await probeNetworkRelay() : null;
  report.networkRelay = !!networkURL;
  uninstallRouter = installSocketRouter({disk, networkURL, monitor});

  const imported = await import(ptyURL);
  const openpty = imported.openpty || globalThis.openpty;
  if (typeof openpty !== 'function') throw new Error('Terminal library did not initialize');
  const createQemu = (await import(scriptURL)).default;
  term = window.guestTerminal = new Terminal({fontSize: 13, cursorBlink: true, scrollback: 5000, theme: {background: '#0a0e16', foreground: '#d5deee'}});
  fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open($('guest-terminal'));
  const {master, slave} = openpty(); term.loadAddon(master);
  master.onWrite(([bytes]) => serial(bytes));

  const tbMiB = memory >= 2048 ? 256 : 128;
  report.guestMemoryMiB = memory; report.cpus = cpus; report.translationCacheMiB = tbMiB;
  status('Starting the x86-64 processor emulator…', 'starting');
  engine = await createQemu({
    noInitialRun: true, wasmBinary, pty: slave, canvas: $('canvas'),
    mainScriptUrlOrBlob: scriptURL,
    locateFile: name => new URL(name, safeURL(script.name)).href,
    print: log, printErr: log, onAbort: message => fail(new Error(String(message))),
    onExit: code => {exited(code);},
    preRun: [module => {
      module.ENV.SDL_RENDER_DRIVER = 'software';
      module.ENV.SDL_EMSCRIPTEN_KEYBOARD_ELEMENT = '#canvas';
      if (inputTrace) module.ENV.SDL_EVENT_LOGGING = '1';
      module.FS.mkdir('/pack');
      module.FS.mkdir('/exchange'); module.FS.mkdir('/exchange/.control');
      for (const file of packFiles) module.FS.writeFile(file.path, file.bytes, {canOwn: true});
      packFiles.length = 0;
    }],
  });
  window.guestEngine = engine;
  patchTerminal(engine, slave);

  const append = ['console=ttyS0', 'root=/dev/vda', 'rw', 'rootfstype=ext4', 'quiet', 'loglevel=3'];
  // The WebAssembly JIT is initialized only by multi-threaded TCG's vCPU
  // threads, so thread=multi is required even with one virtual processor.
  const args = [
    '-M', 'pc,i8042=off', '-cpu', 'max', '-m', memory + 'M', '-smp', String(cpus),
    '-accel', `tcg,thread=multi,tb-size=${tbMiB}`, '-nodefaults', '-no-reboot',
    '-L', '/pack', '-kernel', '/pack/bzImage', '-append', append.join(' '),
    '-blockdev', `driver=nbd,node-name=root,server.type=inet,server.host=${DISK_ENDPOINT.host},server.port=${DISK_ENDPOINT.port},export=root,discard=unmap`,
    '-device', 'virtio-blk-pci,drive=root',
    ...(networkURL ? ['-netdev', `socket,id=net0,connect=${NETWORK_ENDPOINT.host}:${NETWORK_ENDPOINT.port}`,
      '-device', 'virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56'] : []),
    '-serial', 'stdio', '-monitor', 'none', '-parallel', 'none',
    '-vga', 'none', '-device', 'virtio-vga,xres=1280,yres=720', '-display', 'sdl,gl=off',
    '-device', 'virtio-keyboard-pci', '-device', 'virtio-tablet-pci', '-device', 'virtio-mouse-pci,id=gamemouse',
    '-chardev', `socket,id=monitor,host=${MONITOR_ENDPOINT.host},port=${MONITOR_ENDPOINT.port},server=off`,
    '-mon', 'chardev=monitor,mode=control',
    // Emscripten's random device reads crypto.getRandomValues.
    '-object', 'rng-random,id=rng,filename=/dev/urandom', '-device', 'virtio-rng-pci,rng=rng',
    '-virtfs', 'local,path=/exchange,mount_tag=browser,security_model=mapped-file,id=browser',
    ...(inputTrace ? ['-D', '/input-trace.log', '-msg', 'timestamp=on', '-trace', 'enable=sdl2_process_key',
      '-trace', 'enable=virtio_input_queue_full', '-trace', 'enable=input_event_key_qcode'] : []),
  ];
  report.arguments = args;
  status('Booting Debian 13 (x86-64)…', 'booting');
  showConsole(true);
  bootTimer = setTimeout(() => {
    if (!report.wayland && report.state !== 'error') status('Startup is still in progress. The serial terminal shows the latest Linux output.');
  }, 240000);
  engine.callMain(args);
}

// QEMU's select loop must see stdin as unreadable between key events, and
// xterm-pty 0.10.1 turns an empty nonblocking read into an indefinite wait.
function patchTerminal(module, slave) {
  const oldPoll = module.TTY.stream_ops.poll;
  module.TTY.stream_ops.poll = function(stream, timeout) {
    return slave.readable ? oldPoll.call(this, stream, timeout) : (slave.writable ? 4 : 0);
  };
  const oldRead = module.TTY.stream_ops.read;
  module.TTY.stream_ops.read = function(stream, buffer, offset, length) {
    // Honor O_NONBLOCK (2048) with Emscripten's EAGAIN (6).
    if (length && (stream.flags & 2048) && !slave.readable) throw new module.FS.ErrnoError(6);
    return oldRead.call(this, stream, buffer, offset, length);
  };
}

boot().catch(fail);

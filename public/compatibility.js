// SPDX-License-Identifier: GPL-2.0-only
import {detectCapabilities, missingRequirements} from './capabilities.js';
import {loadCompatibilityImage} from './compatibility-images.js';
const $ = id => document.getElementById(id);
let capabilities, manifest, frame;
const isolationKey = 'browser-linux-compatibility-isolation:' + new URL('./', location.href);

async function prepareIsolation() {
  if (crossOriginIsolated || !isSecureContext || !navigator.serviceWorker) return;
  if (navigator.serviceWorker.controller && sessionStorage.getItem(isolationKey)) return;
  $('capability-status').textContent = 'Preparing shared memory. This page will reload once.';
  await navigator.serviceWorker.register('sw.js', {scope: './', updateViaCache: 'none'});
  await new Promise((resolve, reject) => {
    if (navigator.serviceWorker.controller) {resolve(); return;}
    const timer = setTimeout(() => reject(new Error('Browser isolation setup took too long. Reload to retry.')), 90000);
    navigator.serviceWorker.addEventListener('controllerchange', () => {clearTimeout(timer); resolve();}, {once: true});
  });
  sessionStorage.setItem(isolationKey, '1');
  location.reload();
  return true;
}

function availability() {
  $('start-compatibility').disabled = !!frame || !capabilities?.compatibilityEngine || !manifest
    || (manifest.files.some(file => file.encoding === 'gzip') && typeof DecompressionStream !== 'function');
}

async function check() {
  $('check-capabilities').disabled = true;
  try {
    capabilities = await detectCapabilities({graphics: true});
    window.compatibilityCapabilities = capabilities;
    const rows = [
      ['Shared WebAssembly workers', capabilities.workers.available ? 'Verified' : 'Unavailable'],
      ['Browser WebGL 2', capabilities.graphics.webgl2 ? 'Available' : 'Unavailable'],
      ['Browser WebGPU adapter', capabilities.graphics.webgpu ? 'Available' : 'Unavailable'],
      ['Linux GPU acceleration', 'Not implemented'],
      ['Private filesystem API', capabilities.storage.opfsAPI ? 'Available' : 'Unavailable'],
    ];
    $('capability-list').replaceChildren(...rows.flatMap(([label, value]) => {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label; dd.textContent = value; return [dt, dd];
    }));
    $('capability-status').textContent = capabilities.compatibilityEngine
      ? 'The required engine features passed. Memory allocation is checked when Linux starts.'
      : 'This engine needs ' + missingRequirements(capabilities).join(', ') + '.';
  } finally {$('check-capabilities').disabled = false; availability();}
}

async function loadManifest() {
  const mode = $('disk-mode').value;
  const data = await loadCompatibilityImage({temporary: mode === 'temporary', previous: mode === 'previous'});
  if (data.schema !== 1 || data.architecture !== 'x86_64' || !Array.isArray(data.files) || !data.files.length) {
    throw new Error('The compatibility image manifest is not supported.');
  }
  manifest = data;
  const mib = (data.files.reduce((sum, file) => sum + file.bytes, 0) / 1048576).toFixed(1);
  $('image-status').textContent = `${data.name} · x86-64 · ${mib} MiB download. ${data.persistentDisk ? 'The full Linux disk can be saved after shutdown.' : 'This build uses a temporary disk.'}`;
  $('disk-mode').disabled = !data.persistentDisk;
  $('memory-note').textContent = `The engine reserves ${data.engineMemoryMiB} MiB of shared memory, plus disk data and browser overhead. Availability varies by device and current workload.`;
  $('engine-scope').textContent = data.description;
  if (data.files.some(file => file.encoding === 'gzip') && typeof DecompressionStream !== 'function') {
    $('image-status').textContent += ' This image also requires the browser’s gzip decompression API.';
  }
  availability();
}

$('check-capabilities').onclick = () => check().catch(error => {$('capability-status').textContent = error.message;});
$('disk-mode').onchange = () => {
  manifest = null; availability();
  loadManifest().catch(error => {$('image-status').textContent = error.message;});
};
$('start-compatibility').onclick = () => {
  if ($('start-compatibility').disabled) return;
  frame = document.createElement('iframe'); frame.title = 'Real x86-64 Linux session';
  frame.allow = 'cross-origin-isolated; fullscreen';
  frame.src = `compatibility-session.html?memory=${Number($('guest-memory').value)}&disk=${encodeURIComponent($('disk-mode').value)}`;
  // Development diagnostics can isolate the optional virtual file device.
  if (new URLSearchParams(location.search).get('exchange') === 'off') frame.src += '&exchange=off';
  if (new URLSearchParams(location.search).get('input-trace') === '1') frame.src += '&input-trace=1';
  $('session-container').append(frame);
  // Keep the guest visible during startup. Browsers can throttle rendering in
  // offscreen frames; the user should see the desktop as it first paints.
  frame.scrollIntoView({block: 'start'});
  $('guest-memory').disabled = true; $('disk-mode').disabled = true; $('stop-compatibility').hidden = false;
  $('session-status').textContent = 'Downloading and checking the guest image…'; availability();
};
$('stop-compatibility').onclick = () => {
  frame?.remove(); frame = null;
  $('session-status').textContent = 'Session closed. Only changes included in a completed disk save are kept.';
  $('guest-memory').disabled = false; $('disk-mode').disabled = !manifest?.persistentDisk; $('stop-compatibility').hidden = true; availability();
};
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== frame?.contentWindow || event.data?.type !== 'guest-status') return;
  $('session-status').textContent = event.data.message;
  $('stop-compatibility').disabled = event.data.state === 'saving';
  $('stop-compatibility').textContent = event.data.state === 'saved' ? 'Close session' : 'Discard session';
});
try {
  if (!await prepareIsolation()) {
    if (crossOriginIsolated) sessionStorage.removeItem(isolationKey);
    await Promise.allSettled([check(), loadManifest().catch(error => {$('image-status').textContent = error.message;})]);
  }
} catch (error) {$('capability-status').textContent = error.message;}

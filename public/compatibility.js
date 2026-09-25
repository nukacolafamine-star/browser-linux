// SPDX-License-Identifier: GPL-2.0-only
import {detectCapabilities, missingRequirements} from './capabilities.js';
import {listSavedDisks, deleteSavedDisk, probeNetworkRelay} from './compatibility-disk.js';
const $ = id => document.getElementById(id);
let capabilities, manifest, frame, relay = null;
const isolationKey = 'browser-linux-compatibility-isolation:' + new URL('./', location.href);
const mib = bytes => Math.round(bytes / 1048576).toLocaleString();

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
    || typeof DecompressionStream !== 'function' || !capabilities?.storage.opfsAPI;
  for (const id of ['guest-memory', 'guest-cpus', 'disk-mode', 'guest-network', 'guest-gpu']) $(id).disabled = !!frame;
  $('gpu-option').hidden = !(manifest?.engine?.gpuVariant && capabilities?.graphics.webgl2);
  $('guest-network').disabled = !!frame || !relay;
}

async function check() {
  $('check-capabilities').disabled = true;
  try {
    capabilities = await detectCapabilities({graphics: true});
    window.compatibilityCapabilities = capabilities;
    const rows = [
      ['Shared WebAssembly workers', capabilities.workers.available ? 'Verified' : 'Unavailable'],
      ['Browser disk storage (OPFS)', capabilities.storage.opfsAPI ? 'Available' : 'Unavailable'],
      ['Logical processors reported', String(navigator.hardwareConcurrency || 'Unknown')],
      ['Browser WebGL 2', capabilities.graphics.webgl2 ? 'Available' : 'Unavailable'],
      ['Browser WebGPU adapter', capabilities.graphics.webgpu ? 'Available' : 'Unavailable'],
      ['Linux GPU acceleration', 'Not yet available (CPU rendering)'],
    ];
    $('capability-list').replaceChildren(...rows.flatMap(([label, value]) => {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label; dd.textContent = value; return [dt, dd];
    }));
    const missing = missingRequirements(capabilities);
    if (!capabilities.storage.opfsAPI) missing.push('the origin-private file system');
    $('capability-status').textContent = missing.length ? 'This engine needs ' + missing.join(', ') + '.'
      : 'The required engine features passed. Memory allocation is checked when Linux starts.';
    const cores = navigator.hardwareConcurrency || 2;
    for (const option of $('guest-cpus').options) option.disabled = Number(option.value) > Math.max(1, cores - 1);
    if ($('guest-cpus').selectedOptions[0]?.disabled) $('guest-cpus').value = '1';
  } finally {$('check-capabilities').disabled = false; availability();}
}

async function loadManifest() {
  const response = await fetch(new URL('compatibility/manifest.json', location.href), {cache: 'no-cache'});
  if (!response.ok) throw new Error('No Linux image is installed on this copy yet.');
  const data = await response.json();
  if (data.schema !== 2 || data.architecture !== 'x86_64' || !Array.isArray(data.files) || !data.disk) {
    throw new Error('This Linux image manifest is not supported by this page.');
  }
  manifest = data;
  const startBytes = data.files.reduce((sum, file) => sum + file.bytes, 0) + data.disk.bytes;
  $('image-status').textContent = `${data.name} · x86-64 · ${mib(startBytes)} MiB to start, then disk data as Linux reads it (up to ${mib(data.disk.downloadBytes)} MiB).`;
  $('engine-scope').textContent = data.description;
  availability();
}

async function checkRelay() {
  relay = await probeNetworkRelay();
  $('network-note').textContent = relay
    ? 'Linux can reach the Internet through the Browser Linux server on this computer. It cannot reach this computer or your local network.'
    : 'Internet access needs the local Browser Linux server (Start Browser Linux.cmd). Linux will run offline.';
  if (!relay) $('guest-network').checked = false;
  availability();
}

async function showDisks() {
  const disks = await listSavedDisks();
  $('disks-status').textContent = disks.length
    ? 'Stored in this browser for this site. Clearing site data also removes them.'
    : 'No saved Linux disks in this browser yet.';
  if (navigator.storage?.estimate) {
    const {usage, quota} = await navigator.storage.estimate();
    if (quota) $('disks-status').textContent += ` Site storage used: ${mib(usage)} MiB of ${mib(quota)} MiB available to this site.`;
  }
  $('disk-list').replaceChildren(...disks.map(disk => {
    const row = document.createElement('li'), label = document.createElement('span'), button = document.createElement('button');
    const opened = disk.meta?.opened ? ' · last used ' + new Date(disk.meta.opened).toLocaleString() : '';
    label.textContent = `${disk.name} · ${mib(disk.bytes)} MiB${opened}`;
    button.textContent = 'Delete';
    button.disabled = !!frame;
    button.onclick = async () => {
      if (!confirm('Delete this Linux disk and everything saved on it? This cannot be undone.')) return;
      try {await deleteSavedDisk(disk.name);}
      catch (error) {alert('The disk could not be deleted: ' + error.message);}
      showDisks();
    };
    row.append(label, button);
    return row;
  }));
}

$('check-capabilities').onclick = () => check().catch(error => {$('capability-status').textContent = error.message;});
$('start-compatibility').onclick = () => {
  if ($('start-compatibility').disabled) return;
  frame = document.createElement('iframe');
  frame.title = 'Linux desktop session';
  frame.allow = 'cross-origin-isolated; fullscreen';
  const params = new URLSearchParams({memory: $('guest-memory').value, cpus: $('guest-cpus').value,
    disk: $('disk-mode').value, network: $('guest-network').checked ? 'on' : 'off'});
  if ($('guest-gpu').checked && !$('gpu-option').hidden) params.set('gpu', '1');
  if (new URLSearchParams(location.search).get('input-trace') === '1') params.set('input-trace', '1');
  frame.src = 'compatibility-session.html?' + params;
  $('session-container').append(frame);
  // Keep the guest visible: browsers can throttle rendering in offscreen frames.
  frame.scrollIntoView({block: 'start'});
  $('stop-compatibility').hidden = false;
  $('session-status').textContent = 'Downloading and checking the Linux engine…';
  availability(); showDisks();
};
$('stop-compatibility').onclick = () => {
  if (!['stopped', 'error'].includes(frame?.state) &&
      !confirm('Close this Linux session? Use Shut down inside the session first so Linux can finish writing its disk.')) return;
  frame?.remove(); frame = null;
  $('session-status').textContent = 'Session closed.';
  $('stop-compatibility').hidden = true;
  availability(); showDisks();
};
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== frame?.contentWindow || event.data?.type !== 'guest-status') return;
  frame.state = event.data.state;
  $('session-status').textContent = event.data.message;
});
$('guest-memory').onchange = () => {
  $('memory-note').textContent = `The browser tab will use about ${Number($('guest-memory').value) / 1024} GiB for Linux plus the emulator. Close other heavy tabs on smaller devices.`;
};
try {
  if (!await prepareIsolation()) {
    if (crossOriginIsolated) sessionStorage.removeItem(isolationKey);
    await Promise.allSettled([check(), checkRelay(), showDisks().catch(() => {}),
      loadManifest().catch(error => {$('image-status').textContent = error.message;})]);
  }
} catch (error) {$('capability-status').textContent = error.message;}

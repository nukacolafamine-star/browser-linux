// SPDX-License-Identifier: GPL-2.0-only
// Disk snapshots are deltas against an exact base. Retain that base and its
// versioned runtime on explicit guest startup so a later site update can still
// open the user's saved disk. This cache is separate from lightweight precache.
import {DiskStore} from './compatibility-storage.js';
const scope = new URL('./', location.href).href;
const base = new URL('./compatibility/', location.href);
const cacheName = 'browser-linux-image-v1:' + scope;
const manifestKey = sha => new URL('saved-base-' + sha + '.json', base).href;
const diskHash = manifest => {
  const disks = manifest?.files?.filter(file => file.role === 'disk');
  return disks?.length === 1 ? (disks[0].encoding === 'gzip' ? disks[0].unpackedSha256 : disks[0].sha256) : null;
};
export async function loadCompatibilityImage({temporary = false, previous = false} = {}) {
  let saved;
  if (!temporary) {
    const store = new DiskStore(scope);
    try {saved = (await store.describeSnapshot({previous})).snapshot;}
    finally {await store.close();}
  }
  if (saved) {
    const cached = await (await caches.open(cacheName)).match(manifestKey(saved.baseSha256));
    if (cached) {
      const manifest = await cached.json();
      if (diskHash(manifest) !== saved.baseSha256) throw new Error('Saved image metadata does not match the disk. Saved data has been preserved.');
      return manifest;
    }
  }
  const response = await fetch(new URL('manifest.json', base), {cache: 'no-cache'});
  if (!response.ok) throw new Error('No compatibility image is installed on this copy yet.');
  const manifest = await response.json();
  if (saved && diskHash(manifest) !== saved.baseSha256) throw new Error('This saved disk needs its original base image, which is unavailable here. It has been preserved. A temporary session uses the new image separately.');
  return manifest;
}
export async function imageResponse(url) {
  // Hash validation remains mandatory in the caller, including cache hits.
  const cached = typeof caches === 'undefined' ? null : await caches.open(cacheName).then(cache => cache.match(url)).catch(() => null);
  return cached || fetch(url);
}
export async function retainImageFile(url, bytes, contentType) {
  const cache = await caches.open(cacheName);
  await cache.put(url, new Response(bytes, {headers: {'Content-Type': contentType || 'application/octet-stream'}}));
}
export async function retainImageManifest(manifest) {
  const sha = diskHash(manifest);
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('Invalid base image identity.');
  await (await caches.open(cacheName)).put(manifestKey(sha), new Response(JSON.stringify(manifest), {headers: {'Content-Type': 'application/json'}}));
}

// SPDX-License-Identifier: GPL-2.0-only
// Actual browser storage/update tests. Tiny disk bytes are storage fixtures,
// not simulated Linux boots; full guest acceptance has its own test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
process.env.TEMP = process.env.TMP = path.join(root, '.cache/tmp');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.cache/playwright-browsers');
const {chromium, webkit} = await import('playwright');
const modules = new Map(await Promise.all(['compatibility-images.js', 'compatibility-storage.js'].map(async name => [name, await fs.readFile(path.join(root, 'public', name))])));
const newHash = 'f'.repeat(64);
const server = http.createServer((request, response) => {
  const name = new URL(request.url, 'http://local').pathname.slice(1);
  response.setHeader('Cache-Control', 'no-store');
  if (modules.has(name)) {response.setHeader('Content-Type', 'text/javascript'); response.end(modules.get(name));}
  else if (name === 'compatibility/manifest.json') {response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({schema: 1, build: 'new-build', files: [{role: 'disk', sha256: newHash}]}));}
  else if (!name) {response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Image retention tests</title>');}
  else {response.writeHead(404); response.end();}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const report = {scope: 'Image retention and base selection across site updates; no kernel execution', engines: []};
try {
  for (const [name, type, options] of [['chrome', chromium, {channel: 'chrome'}], ['webkit', webkit, {}]]) {
    const browser = await type.launch({headless: true, ...options});
    try {
      const context = await browser.newContext({serviceWorkers: 'block'}), page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const result = await page.evaluate(async () => {
        const {DiskStore, makeBaseMetadata} = await import('./compatibility-storage.js');
        const {retainImageFile, retainImageManifest, imageResponse, loadCompatibilityImage} = await import('./compatibility-images.js');
        const bytes = new Uint8Array(1024), sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
        const base = await makeBaseMetadata(bytes, sha), store = new DiskStore(new URL('./', location.href).href);
        const saved = await store.save(base, (offset, size) => bytes.slice(offset, offset + size), {expectedCurrent: null});
        const manifest = {schema: 1, build: 'original-build', files: [{role: 'disk', name: 'builds/original/disk', sha256: sha}]};
        const url = new URL('compatibility/builds/original/disk', location.href);
        await retainImageFile(url, bytes, 'application/octet-stream'); await retainImageManifest(manifest);
        const cacheBytes = new Uint8Array(await (await imageResponse(url)).arrayBuffer());
        const restoredImage = await loadCompatibilityImage();
        const temporary = await loadCompatibilityImage({temporary: true});
        const cache = await caches.open('browser-linux-image-v1:' + new URL('./', location.href).href);
        const key = new URL('compatibility/saved-base-' + sha + '.json', location.href);
        await cache.delete(key);
        let missingError;
        try {await loadCompatibilityImage();} catch (error) {missingError = error.message;}
        const afterMissing = await store.describe();
        await cache.put(key, new Response(JSON.stringify({...manifest, files: [{role: 'disk', sha256: '0'.repeat(64)}]})));
        let corruptError;
        try {await loadCompatibilityImage();} catch (error) {corruptError = error.message;}
        const afterCorrupt = await store.describe(); await store.close();
        return {cachedBytesExact: cacheBytes.length === bytes.length && cacheBytes.every((value, index) => value === bytes[index]),
          originalSelected: restoredImage.build, temporarySelected: temporary.build, missingError, corruptError,
          savedId: saved.id, afterMissingId: afterMissing.current.id, afterCorruptId: afterCorrupt.current.id};
      });
      assert.equal(result.cachedBytesExact, true);
      assert.equal(result.originalSelected, 'original-build');
      assert.equal(result.temporarySelected, 'new-build');
      assert.match(result.missingError, /original base image/);
      assert.match(result.corruptError, /does not match/);
      assert.equal(result.afterMissingId, result.savedId); assert.equal(result.afterCorruptId, result.savedId);
      report.engines.push({name, version: browser.version(), passed: true, ...result});
      console.log('PASS', name, 'exact cached bytes, pinned image across update, temporary new image, missing/corrupt image preserves disk');
    } finally {await browser.close();}
  }
  report.passed = true;
} catch (error) {report.passed = false; report.error = error.stack; process.exitCode = 1; console.error(error);}
finally {
  await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(root, 'test-results/compatibility-images-report.json'), JSON.stringify(report, null, 2) + '\n');
}

// SPDX-License-Identifier: GPL-2.0-only
// Assemble successful isolated CI artifacts into a versioned, verified build
// under public/compatibility/. Never manufactures a passing test.
//   node tools/compatibility-build/assemble.mjs RUNTIME_ARTIFACT DESKTOP_ARTIFACT [--move-chunks]
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const project = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const moveChunks = args.includes('--move-chunks');
const [runtimeArg, desktopArg] = args.filter(arg => !arg.startsWith('--'));
if (!runtimeArg || !desktopArg) throw new Error('Usage: node tools/compatibility-build/assemble.mjs RUNTIME_ARTIFACT DESKTOP_ARTIFACT [--move-chunks]');
const runtime = path.resolve(runtimeArg), desktop = path.resolve(desktopArg);
const destination = path.join(project, 'public/compatibility');
const staging = path.join(destination, 'builds', '.staging-' + Date.now());
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];

async function add(input, name, role, guestPath) {
  const bytes = await fs.readFile(input);
  await fs.mkdir(path.dirname(path.join(staging, name)), {recursive: true});
  await fs.writeFile(path.join(staging, name), bytes);
  files.push({name, role, bytes: bytes.length, sha256: hash(bytes), ...(guestPath ? {guestPath} : {})});
}

// Verify the guest artifact's own checksum list before using it.
const sums = (await fs.readFile(path.join(desktop, 'SHA256SUMS'), 'utf8')).trim().split('\n');
for (const line of sums) {
  const [expected, name] = line.split(/\s+/);
  if (hash(await fs.readFile(path.join(desktop, name))) !== expected) throw new Error('Guest artifact checksum mismatch: ' + name);
}
const proof = JSON.parse(await fs.readFile(path.join(desktop, 'native-proof/report.json'), 'utf8').catch(() => '{}'));
if (proof.passed !== true) throw new Error('The desktop artifact did not pass its native verification; refusing to assemble it.');

await fs.mkdir(staging, {recursive: true});
await add(path.join(runtime, 'runtime/qemu-system-x86_64.js'), 'runtime/qemu-system-x86_64.js', 'script');
await add(path.join(runtime, 'runtime/qemu-system-x86_64.wasm'), 'runtime/qemu-system-x86_64.wasm', 'wasm');
await add(path.join(runtime, 'runtime/vendor/xterm-pty.js'), 'runtime/vendor/xterm-pty.js', 'pty');
for (const name of ['bios-256k.bin', 'vgabios-virtio.bin', 'kvmvapic.bin', 'linuxboot_dma.bin', 'efi-virtio.rom']) {
  await add(path.join(runtime, 'pack', name), 'pack/' + name, 'rom', '/pack/' + name);
}
await add(path.join(desktop, 'bzImage'), 'pack/bzImage', 'kernel', '/pack/bzImage');

// Disk chunks are content-addressed; their hashes are checked by the browser
// when each is first read. Verify the list and each file's size here.
const diskJsonBytes = await fs.readFile(path.join(desktop, 'disk/disk.json'));
const diskManifest = JSON.parse(diskJsonBytes);
await fs.mkdir(path.join(staging, 'disk/chunks'), {recursive: true});
const seen = new Set();
let downloadBytes = 0;
for (const [, digest, bytes] of diskManifest.chunks) {
  if (seen.has(digest)) continue;
  seen.add(digest);
  const source = path.join(desktop, 'disk/chunks', digest + '.gz'), target = path.join(staging, 'disk/chunks', digest + '.gz');
  const stat = await fs.stat(source);
  if (stat.size !== bytes) throw new Error('Disk chunk has the wrong size: ' + digest);
  if (moveChunks) await fs.rename(source, target); else await fs.copyFile(source, target);
  downloadBytes += bytes;
}
await fs.writeFile(path.join(staging, 'disk/disk.json'), diskJsonBytes);

await fs.cp(path.join(runtime, 'provenance'), path.join(staging, 'provenance/runtime'), {recursive: true});
for (const name of ['packages.txt', 'apt-sources.txt', 'guest-capabilities.json', 'kernel.config', 'kernel-release.txt', 'disk-stats.json', 'SHA256SUMS']) {
  await fs.copyFile(path.join(desktop, name), path.join(staging, 'provenance/guest-' + name)).catch(() => {});
}
await fs.writeFile(path.join(staging, 'provenance/guest-native-proof.json'), JSON.stringify(proof, null, 2) + '\n');
const guest = JSON.parse(await fs.readFile(path.join(desktop, 'guest-capabilities.json'), 'utf8'));
const memory = JSON.parse(await fs.readFile(path.join(runtime, 'provenance/memory.json'), 'utf8').catch(() => '{}'));

const diskSha = hash(diskJsonBytes);
const build = hash(Buffer.from(JSON.stringify(files) + diskSha)).slice(0, 16);
const prefix = `builds/${build}/`;
const manifest = {
  schema: 2, name: 'Debian 13 desktop', architecture: 'x86_64', build,
  description: `Debian 13 with the Weston Wayland desktop, Xwayland for X11 programs, apt, and Linux ${guest.kernel}. `
    + 'Programs run on an emulated x86-64 processor with CPU-rendered graphics. The official Minecraft Launcher can be installed from Mojang inside Linux.',
  engine: {maximumMemoryBytes: memory.maximumBytes || null},
  guest,
  files: files.map(file => ({...file, name: prefix + file.name})),
  disk: {name: prefix + 'disk/disk.json', bytes: diskJsonBytes.length, sha256: diskSha, size: diskManifest.size,
    chunkSize: diskManifest.chunkSize, chunks: diskManifest.chunks.length, downloadBytes},
  verification: {nativeDesktopSeconds: proof.desktopSeconds, openGL: proof.openGL, launcher: proof.launcher ? {opened: proof.launcher.opened} : undefined},
};
const final = path.join(destination, 'builds', build);
await fs.rm(final, {recursive: true, force: true});
await fs.rename(staging, final);
await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({build, startMiB: (files.reduce((sum, file) => sum + file.bytes, 0) / 1048576).toFixed(1),
  diskChunks: diskManifest.chunks.length, diskDownloadMiB: (downloadBytes / 1048576).toFixed(1)}));

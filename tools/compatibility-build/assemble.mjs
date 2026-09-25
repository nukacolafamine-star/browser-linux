// SPDX-License-Identifier: GPL-2.0-only
// Assemble successful isolated CI artifacts. Never manufactures a passing test.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const project = fileURLToPath(new URL('../../', import.meta.url));
const [runtimeArg, guestArg] = process.argv.slice(2);
if (!runtimeArg || !guestArg) throw new Error('Usage: node tools/compatibility-build/assemble.mjs RUNTIME_ARTIFACT GUEST_ARTIFACT');
const runtime = path.resolve(runtimeArg), guest = path.resolve(guestArg);
const output = path.join(project, '.cache/compatibility-assembly', String(Date.now()));
const destination = path.join(project, 'public/compatibility');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
await fs.mkdir(output, {recursive: true});
async function copy(input, name, role, guestPath, compress = false) {
  const raw = await fs.readFile(input);
  const bytes = compress ? gzipSync(raw, {level: 6}) : raw;
  await fs.mkdir(path.dirname(path.join(output, name)), {recursive: true});
  await fs.writeFile(path.join(output, name), bytes);
  files.push({name, role, bytes: bytes.length, sha256: hash(bytes),
    ...(guestPath ? {guestPath} : {}),
    ...(compress ? {encoding: 'gzip', unpackedBytes: raw.length, unpackedSha256: hash(raw)} : {})});
}
await copy(path.join(runtime, 'runtime/qemu-system-x86_64.js'), 'runtime/qemu-system-x86_64.js', 'script');
await copy(path.join(runtime, 'runtime/qemu-system-x86_64.wasm'), 'runtime/qemu-system-x86_64.wasm', 'wasm');
await copy(path.join(runtime, 'runtime/vendor/xterm-pty.js'), 'runtime/vendor/xterm-pty.js', 'pty');
for (const name of await fs.readdir(path.join(runtime, 'runtime'))) {
  if (name.endsWith('.worker.js')) await copy(path.join(runtime, 'runtime', name), 'runtime/' + name, 'worker');
}
for (const name of ['bios-256k.bin', 'vgabios-stdvga.bin', 'vgabios-virtio.bin', 'kvmvapic.bin', 'linuxboot_dma.bin', 'efi-virtio.rom']) {
  await copy(path.join(runtime, 'pack', name), 'pack/' + name, 'rom', '/pack/' + name);
}
await copy(path.join(guest, 'vmlinuz-virt'), 'pack/vmlinuz-virt', 'kernel', '/pack/vmlinuz-virt');
await copy(path.join(guest, 'initramfs-virt'), 'pack/initramfs-virt', 'initrd', '/pack/initramfs-virt');
await copy(path.join(guest, 'rootfs.img'), 'pack/rootfs.img.gz', 'disk', '/pack/rootfs.img', true);
await fs.cp(path.join(runtime, 'provenance'), path.join(output, 'provenance'), {recursive: true});
await fs.copyFile(path.join(guest, 'package-versions.txt'), path.join(output, 'provenance/guest-packages.txt'));
const manifest = {
  schema: 1, name: 'Alpine Linux / Weston compatibility proof', architecture: 'x86_64',
  build: hash(Buffer.from(JSON.stringify(files))).slice(0, 16), engineMemoryMiB: 1024,
  description: 'A full x86-64 Linux guest with the Weston Wayland compositor and a terminal. Guest graphics use CPU rendering. Networking, persistent disks, Java and Minecraft are not included in this proof.',
  guestAcceleration: false, persistentDisk: false, networking: false,
  files,
};
// Versioned URLs prevent a Pages update during download from mixing runtimes.
await fs.mkdir(destination, {recursive: true});
await fs.cp(output, path.join(destination, 'builds', manifest.build), {recursive: true});
for (const file of files) file.name = `builds/${manifest.build}/` + file.name;
await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({build: manifest.build, downloadMiB: files.reduce((sum, file) => sum + file.bytes, 0) / 1048576, files: files.length}));

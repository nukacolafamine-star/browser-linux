// Pinned firmware source/license inventory. Firmware binaries remain unmodified.
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const components = [
  {
    id: 'seabios', qemuPath: 'roms/seabios',
    commit: 'a6ed6b701f0a57db0569ab98b0661c12a6ec3ff8',
    repository: 'https://gitlab.com/qemu-project/seabios.git', mirror: 'coreboot/seabios',
    role: 'BIOS and standard/virtio VGA option ROMs',
    licenses: {COPYING: '94a9ed024d3859793618152ea559a168bbcbb5e2', 'COPYING.LESSER': 'fc8a5de7edf437cdc98a216370faf7c757279bcb'},
  },
  {
    id: 'ipxe', qemuPath: 'roms/ipxe',
    commit: '4bd064de239dab2426b31c9789a1f4d78087dc63',
    repository: 'https://gitlab.com/qemu-project/ipxe.git', mirror: 'ipxe/ipxe',
    role: 'EFI virtio network option ROM',
    licenses: {COPYING: '342330bb98489fc1072461c09d987ec427c279f0', 'COPYING.GPLv2': 'd159169d1050894d3ea3b98e1c965c4058208fe1', 'COPYING.UBDL': '780ddcd775ab2f33e76971ad92485e77efddc11b'},
  },
  {
    id: 'edk2', qemuPath: 'roms/edk2',
    commit: '819cfc6b42a68790a23509e4fcc58ceb70e1965e',
    repository: 'https://gitlab.com/qemu-project/edk2.git', mirror: 'tianocore/edk2',
    role: 'EfiRom packaging build tool; no edk2 platform firmware is shipped',
    licenses: {'License.txt': 'ee840505cb0c041145ee87fa07be69a51fa325b2', 'License-History.txt': '8ab3f67b535b72236c5bb3fdc58ac8a23259e3dc'},
  },
];

export async function prepareFirmwareProvenance(destination, qemuCommit) {
  const records = await Promise.all(components.map(async component => {
    const directory = path.join(destination, component.id);
    await mkdir(directory, {recursive: true});
    const licenses = await Promise.all(Object.entries(component.licenses).map(async ([name, blobId]) => {
      const url = `https://raw.githubusercontent.com/${component.mirror}/${component.commit}/${name}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`License fetch ${url}: ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actualBlob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (actualBlob !== blobId) throw new Error(`Unexpected pinned Git license blob: ${url}`);
      await writeFile(path.join(directory, name), bytes);
      return {name, source: url, gitBlob: blobId, sha256: createHash('sha256').update(bytes).digest('hex')};
    }));
    return {...component, licenses, sourceArchive: `https://github.com/${component.mirror}/archive/${component.commit}.tar.gz`};
  }));
  await writeFile(path.join(destination, 'source-manifest.json'), JSON.stringify({
    qemuCommit,
    note: 'Submodule commits registered by the pinned QEMU tree; this records upstream provenance, not a claim of independently reproduced ROM bytes.',
    firmware: {
      'bios-256k.bin': {component: 'seabios', build: 'roms/config.seabios-256k'},
      'vgabios-stdvga.bin': {component: 'seabios', build: 'roms/config.vga-stdvga'},
      'vgabios-virtio.bin': {component: 'seabios', build: 'roms/config.vga-virtio'},
      'kvmvapic.bin': {component: 'qemu', source: 'pc-bios/optionrom/kvmvapic.S'},
      'linuxboot_dma.bin': {component: 'qemu', source: 'pc-bios/optionrom/linuxboot_dma.c'},
      'efi-virtio.rom': {component: 'ipxe', packagingTool: 'edk2/BaseTools/Source/C/EfiRom'},
    },
    components: records,
    buildInstructions: 'The pinned QEMU sources include roms/Makefile, roms/config.*, pc-bios/optionrom/Makefile and scripts/signrom.py.',
  }, null, 2) + '\n');
}

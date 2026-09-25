// Reproducible build proposal. Downloads source only; does not build/install locally.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {prepareFirmwareProvenance} from './firmware-provenance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = {
  repository: 'https://github.com/container2wasm/container2wasm',
  commit: 'ecb4caa499f19f1d5cfcddd43b80aa78f98e5102',
  dockerfileSha256: 'ffc6daca3e926c3b8e84b0ebf05a6336a329c136aa309598fc4df280e5598cde',
  qemuRepository: 'https://github.com/ktock/qemu-wasm',
  qemuCommit: '8604ed49a3cde392890b014a8d5a959c8a2fe72a',
  emscripten: '4.0.10',
};
const response = await fetch(`https://raw.githubusercontent.com/container2wasm/container2wasm/${source.commit}/Dockerfile`);
if (!response.ok) throw new Error(`Source download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== source.dockerfileSha256) throw new Error('Unexpected upstream Dockerfile');
let dockerfile = bytes.toString('utf8');
// The pinned fork commit may be on a non-default branch; fetch that exact commit.
const oldClone = 'RUN git clone --depth 100 ${QEMU_REPO} /qemu && \\\n    cd /qemu && \\\n    git checkout ${QEMU_REPO_VERSION}';
const newClone = 'RUN git init /qemu && \\\n    cd /qemu && \\\n    git remote add origin ${QEMU_REPO} && \\\n    git fetch --depth=1 origin ${QEMU_REPO_VERSION} && \\\n    git checkout --detach FETCH_HEAD';
if (dockerfile.split(oldClone).length !== 2) throw new Error('Upstream QEMU clone stanza changed');
dockerfile = dockerfile.replace(oldClone, newClone);
dockerfile += '\n' + await readFile(path.join(here, 'runtime-stage.Dockerfile'), 'utf8');
dockerfile += '\n' + await readFile(path.join(here, 'gpu-stage.Dockerfile'), 'utf8');
await mkdir(path.join(here, 'generated'), { recursive: true });
await writeFile(path.join(here, 'generated', 'runtime.Dockerfile'), dockerfile);
await writeFile(path.join(here, 'generated', 'source-lock.json'), JSON.stringify(source, null, 2) + '\n');
await prepareFirmwareProvenance(path.join(here, 'generated', 'firmware'), source.qemuCommit);
console.log('Prepared pinned direct-QEMU runtime build; nothing installed or executed on the host.');
